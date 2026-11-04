import {auth,permit,validate,wrap} from '../lib/http.js';
import {transaction,getOne,audit} from '../db.js';
import {printOptions,printOptionsSchema} from '../lib/document-print-options.js';
export function installPrintOptions(router,{base,table,permission,readPermission,quotation=false}){
  const load=()=>`SELECT id,company_id,print_options${quotation?',presentation':',invoice_options'} FROM ${table} WHERE id=?`;
  router.get(`${base}/:id/print-options`,auth,permit(permission,readPermission),wrap(async(req,res)=>{
    const row=await getOne(load(),[req.params.id]);if(!row)return res.status(404).json({error:'Document not found'});
    const legacy=!quotation&&!row.print_options?(typeof row.invoice_options==='string'?JSON.parse(row.invoice_options):row.invoice_options)?.columns:null;
    const presentation=quotation?(typeof row.presentation==='string'?JSON.parse(row.presentation):row.presentation):null;
    const identity=presentation?.show?.company;
    const quoteDefaults=identity?{logo:identity.logo!==false,companyName:identity.name!==false,bank:identity.bankDetails!==false}:{};
    res.json(printOptions(row.print_options||legacy||quoteDefaults));
  }));
  router.put(`${base}/:id/print-options`,auth,permit(permission),validate(printOptionsSchema),wrap(async(req,res)=>{
    if(!quotation&&req.body.printedReference)return res.status(400).json({error:'Invoice numbers must keep their registered reference.'});
    await transaction(async connection=>{
      const [[row]]=await connection.execute(load()+' FOR UPDATE',[req.params.id]);
      if(!row)throw Object.assign(new Error('Document not found'),{status:404});
      await connection.execute(`UPDATE ${table} SET print_options=? WHERE id=?`,[JSON.stringify(req.body),row.id]);
      if(!quotation){const options=typeof row.invoice_options==='string'?JSON.parse(row.invoice_options):row.invoice_options||{};options.columns={unit:req.body.unit,quantity:req.body.quantity,rate:req.body.rate};await connection.execute('UPDATE client_invoices SET invoice_options=? WHERE id=?',[JSON.stringify(options),row.id]);}
      await audit(connection,req.user.id,'PRINT_OPTIONS',quotation?'quotation':'client_invoice',row.id,row.print_options,req.body,req.ip);
    });res.status(204).end();
  }));
}
