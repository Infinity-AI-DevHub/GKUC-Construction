import { query } from '../db.js';
import { median } from './statistics.js';

export async function controlNumber(key, fallback) {
  const rows=await query('SELECT value FROM risk_settings WHERE setting_key=?',[key]);
  const value=Number(rows[0]?.value);
  return Number.isFinite(value)&&value>0?value:fallback;
}

const warning=(code,message,evidence)=>({code,message,evidence});

export async function orderWarnings(body) {
  const warnings=[];
  for(const item of body.items){
    const effectiveRate=item.amount==null?Number(item.rate):Number(item.amount)/Number(item.quantity);
    if(item.materialId){
      const history=await query(`SELECT COALESCE(oi.amount_override/NULLIF(oi.quantity,0),oi.rate) rate FROM purchase_order_items oi
        JOIN purchase_orders po ON po.id=oi.order_id
        WHERE po.supplier_id=? AND po.project_id=? AND oi.material_id=? AND po.status<>'Cancelled'
        ORDER BY oi.id DESC LIMIT 20`,[body.supplierId,body.projectId,item.materialId]);
      if(history.length>=3){
        const typical=median(history.map(row=>Number(row.rate)));
        const ratio=await controlNumber('price.warning.multiplier',1.5);
        if(typical>0&&effectiveRate>typical*ratio) warnings.push(warning('unusual_price',
          `${item.description}: LKR ${effectiveRate.toFixed(2)} per unit is over ${ratio}× this supplier's project history (median LKR ${typical}).`,
          {materialId:item.materialId,typical,rate:effectiveRate,printedRate:item.rate,history:history.length}));
      }
      const boq=await query(`SELECT COALESCE(SUM(bi.quantity),0) allowed FROM boq_items bi
        JOIN boqs b ON b.id=bi.boq_id WHERE b.project_id=? AND b.status='Approved'
          AND bi.material_id=?`,[body.projectId,item.materialId]);
      const approved=Number(boq[0]?.allowed||0);
      if(approved>0){
        const issued=await query(`SELECT COALESCE(SUM(oi.quantity),0) committed FROM purchase_order_items oi
          JOIN purchase_orders po ON po.id=oi.order_id
          WHERE po.project_id=? AND po.status<>'Cancelled' AND oi.material_id=? AND po.id<>?`,
        [body.projectId,item.materialId,body.excludeOrderId||0]);
        const remaining=approved-Number(issued[0]?.committed||0);
        if(Number(item.quantity)>remaining+0.001)warnings.push(warning('boq_quantity',
          `${item.description}: requested ${item.quantity} ${item.unit}, but only ${Math.max(0,remaining)} remain against approved BOQ quantities.`,
          {materialId:item.materialId,approved,committed:Number(issued[0]?.committed||0),remaining}));
      }
    }
  }
  return warnings;
}

export async function invoiceWarnings(body,total){
  const days=await controlNumber('duplicate.window.days',30);
  const rows=await query(`SELECT id,invoice_no invoiceNo,amount,invoice_date invoiceDate FROM supplier_invoices
    WHERE supplier_id=? AND (LOWER(TRIM(invoice_no))=LOWER(TRIM(?)) OR
      (ABS(amount-?)<1 AND ABS(DATEDIFF(invoice_date,?))<=?))
    ORDER BY id DESC LIMIT 5`,[body.supplierId,body.invoiceNo,total,body.invoiceDate,days]);
  return rows.map(row=>warning('duplicate_invoice',
    `Possible duplicate of supplier invoice ${row.invoiceNo} (#${row.id}, LKR ${row.amount}). Check the source document before saving.`,row));
}

export async function paymentMatch(invoice,connection){
  if(!invoice.order_id)return {matched:false,reason:'No purchase order is linked. Finance must document the non-PO exception.'};
  const [orders]=await connection.execute('SELECT * FROM purchase_orders WHERE id=? FOR UPDATE',[invoice.order_id]);
  const current=orders[0];
  const snapshot=typeof invoice.po_snapshot==='string'?JSON.parse(invoice.po_snapshot):invoice.po_snapshot;
  const order=current&&snapshot?{...current,...snapshot}:current;
  if(!order||!['Issued','Partially received','Received'].includes(order.status))
    return {matched:false,reason:'The linked purchase order has not completed approval.'};
  if(Number(order.supplier_id)!==Number(invoice.supplier_id)||Number(order.total)+0.01<Number(invoice.net_amount||invoice.amount))
    return {matched:false,reason:'Supplier or total does not match the approved purchase order.'};
  const [receipts]=await connection.execute('SELECT COUNT(*) count FROM goods_receipts WHERE order_id=?',[order.id]);
  const [received]=await connection.execute(`SELECT COALESCE(SUM(COALESCE(received_value,received_quantity*rate)),0) amount
    FROM purchase_order_items WHERE order_id=?`,[order.id]);
  const [billed]=await connection.execute(`SELECT COALESCE(SUM(net_amount),0) amount FROM supplier_invoices
    WHERE order_id=? AND id<>?`,[order.id,invoice.id]);
  if(!Number(receipts[0].count)||Number(received[0].amount)+0.01<Number(billed[0].amount)+Number(invoice.net_amount||invoice.amount))
    return {matched:false,reason:'Received goods do not cover all invoices against this order.'};
  return {matched:true,orderId:order.id,received:Number(received[0].amount),billed:Number(billed[0].amount)+Number(invoice.net_amount||invoice.amount)};
}
