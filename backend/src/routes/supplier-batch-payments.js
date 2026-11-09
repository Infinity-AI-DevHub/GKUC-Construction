import {createHash} from 'node:crypto';
import {z} from 'zod';
import {transaction,audit} from '../db.js';
import {auth,permit,validate,wrap,fromOptions,fail} from '../lib/http.js';
import {controlNumber,paymentMatch} from '../lib/procurement-controls.js';

const date=z.string().refine(value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value,'Choose a valid payment date');
const schema=z.object({companyId:z.number().int().positive(),supplierId:z.number().int().positive(),
  clientRef:z.string().min(16).max(64),source:z.enum(['Direct','Petty cash']).default('Direct'),
  floatId:z.number().int().positive().optional(),paidDate:date,
  method:z.string().trim().min(1).max(60).default('Cash'),reference:z.string().trim().max(120).optional(),
  bankChangeReason:z.string().trim().max(500).optional(),
  items:z.array(z.object({invoiceId:z.number().int().positive(),amount:z.number().positive().multipleOf(.01)})).min(1).max(100)});

export function installSupplierBatchPayments(router){
 router.post('/supplier-payments/batch',auth,permit('finance.pay'),validate(schema),fromOptions({method:'income.method'}),wrap(async(req,res)=>{
  const b=req.body;
  if(b.method==='Cheque')throw fail(400,'Use Issued cheques for cheque payments.');
  if(new Set(b.items.map(item=>item.invoiceId)).size!==b.items.length)throw fail(400,'Select each invoice only once.');
  if(b.source==='Petty cash'&&!b.floatId)throw fail(400,'Choose a petty cash account.');
  const items=[...b.items].sort((a,c)=>a.invoiceId-c.invoiceId);
  const hash=createHash('sha256').update(JSON.stringify({...b,items})).digest('hex');
  const result=await transaction(async connection=>{
    // A unique client reference makes retries return the original batch, including partial payments.
    await connection.execute(`INSERT INTO supplier_payment_batches(client_ref,request_hash,company_id,supplier_id,created_by)
      VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE id=LAST_INSERT_ID(id)`,[b.clientRef,hash,b.companyId,b.supplierId,req.user.id]);
    const [[batch]]=await connection.execute('SELECT * FROM supplier_payment_batches WHERE client_ref=? FOR UPDATE',[b.clientRef]);
    if(batch.request_hash!==hash||Number(batch.created_by)!==Number(req.user.id))throw fail(409,'This payment reference has already been used for a different payment.');
    const [existing]=await connection.execute('SELECT id,invoice_id invoiceId,amount FROM supplier_payments WHERE batch_id=?',[batch.id]);
    if(existing.length)return {id:batch.id,payments:existing,replayed:true};
    let float=null;
    if(b.source==='Petty cash'){
      const [[row]]=await connection.execute('SELECT * FROM petty_cash_floats WHERE id=? AND active=1 FOR UPDATE',[b.floatId]);float=row;
      if(!float||Number(float.company_id)!==b.companyId||float.account_type==='Salary advance')throw fail(400,'Choose an active expense petty cash account for this company.');
      const [[balance]]=await connection.execute('SELECT COALESCE(SUM(amount),0) amount FROM petty_cash_entries WHERE float_id=?',[float.id]);
      const total=items.reduce((sum,item)=>sum+Math.round(item.amount*100),0)/100;
      if(total>Number(balance.amount)+.001)throw fail(409,'The petty cash account has insufficient funds.');
    }
    const [[supplier]]=await connection.execute('SELECT name,bank_changed_at FROM suppliers WHERE id=? AND active=1',[b.supplierId]);
    if(!supplier)throw fail(400,'Choose an active supplier.');
    const days=await controlNumber('supplier.bank.change.days',14);
    if(supplier.bank_changed_at&&Date.now()-new Date(supplier.bank_changed_at).getTime()<=days*86400000&&(!b.bankChangeReason||b.bankChangeReason.length<10))throw fail(409,'Supplier bank details changed recently. Record how you independently verified them.');
    const payments=[];
    for(const item of items){
      const [[invoice]]=await connection.execute('SELECT * FROM supplier_invoices WHERE id=? FOR UPDATE',[item.invoiceId]);
      if(!invoice||Number(invoice.company_id)!==b.companyId||Number(invoice.supplier_id)!==b.supplierId)throw fail(400,'Every selected invoice must belong to this company and supplier.');
      const match=await paymentMatch(invoice,connection);
      if(invoice.order_id&&!match.matched)throw fail(409,`Payment blocked for ${invoice.invoice_no}: ${match.reason}`);
      if(!invoice.order_id&&!invoice.payment_exception_approved_by)throw fail(409,`Review the no-purchase-order exception for ${invoice.invoice_no} before paying.`);
      const [[reserved]]=await connection.execute(`SELECT COALESCE(SUM(a.allocated_amount),0) amount FROM issued_cheque_invoices a
        JOIN issued_cheques c ON c.id=a.cheque_id WHERE a.invoice_id=? AND c.status IN ('Prepared','Issued')`,[invoice.id]);
      const available=Number(invoice.amount)-Number(invoice.paid_amount)-Number(reserved.amount);
      if(item.amount>available+.001)throw fail(409,`Payment exceeds the available balance on ${invoice.invoice_no}, including pending cheques.`);
      const [[order]]=invoice.order_id?await connection.execute('SELECT project_id FROM purchase_orders WHERE id=?',[invoice.order_id]):[[null]];
      const projectId=order?.project_id||null;
      if(float?.project_id&&Number(float.project_id)!==Number(projectId))throw fail(400,'This petty cash account is restricted to another project.');
      let entryId=null;
      if(float){
        const [entry]=await connection.execute(`INSERT INTO petty_cash_entries(float_id,kind,amount,entry_date,description,category,project_id,payee,recorded_by)
          VALUES (?,'Spend',?,?,?,?,?,?,?)`,[float.id,-item.amount,b.paidDate,`Supplier invoice ${invoice.invoice_no}`,'Supplier payment',projectId,supplier.name,req.user.id]);entryId=entry.insertId;
        await audit(connection,req.user.id,'CREATE','petty_cash_entry',entryId,null,{floatId:float.id,invoiceId:invoice.id,amount:-item.amount,batchId:batch.id},req.ip);
      }
      const paid=Math.round((Number(invoice.paid_amount)+item.amount)*100)/100,status=paid>=Number(invoice.amount)-.001?'Paid':'Partially paid';
      await connection.execute('UPDATE supplier_invoices SET paid_amount=?,status=? WHERE id=?',[paid,status,invoice.id]);
      const [payment]=await connection.execute(`INSERT INTO supplier_payments(invoice_id,amount,paid_date,method,reference,created_by,payment_company_id,batch_id,petty_cash_entry_id)
        VALUES (?,?,?,?,?,?,?,?,?)`,[invoice.id,item.amount,b.paidDate,float?'Cash':b.method,b.reference||null,req.user.id,b.companyId,batch.id,entryId]);
      await audit(connection,req.user.id,'PAYMENT','supplier_invoice',invoice.id,invoice,{paid,status,batchId:batch.id,source:b.source,pettyCashEntryId:entryId,bankChangeReason:b.bankChangeReason||null},req.ip);
      payments.push({id:payment.insertId,invoiceId:invoice.id,amount:item.amount});
    }
    await audit(connection,req.user.id,'CREATE','supplier_payment_batch',batch.id,null,{...b,items},req.ip);
    return {id:batch.id,payments,replayed:false};
  });
  res.status(result.replayed?200:201).json(result);
 }));
}
