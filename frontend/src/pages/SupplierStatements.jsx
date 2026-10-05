import React, { useEffect, useMemo, useState } from 'react';
import { CircleDollarSign, ReceiptText, Wallet } from 'lucide-react';
import { api, rupees, shortDate } from '../api.js';
import { Badge, Row, Summary, Table } from '../ui.jsx';

const COLUMNS=['Date','Activity','Material / reference','Quantity','Rate','Invoice','Cheque / payment','Destination','Debit','Credit','Balance'];
const TEMPLATE='110px 130px minmax(190px,1.4fr) 100px 115px 130px 150px minmax(160px,1fr) 120px 120px 130px';

export default function SupplierStatements({companyId}){
  const [suppliers,setSuppliers]=useState([]),[supplierId,setSupplierId]=useState(''),[statement,setStatement]=useState(null),[error,setError]=useState('');
  useEffect(()=>{setStatement(null);setSupplierId('');setError('');api(`/purchasing/suppliers?companyId=${companyId}`).then(rows=>{setSuppliers(rows);if(rows.length)setSupplierId(String(rows[0].id));}).catch(failure=>setError(failure.message));},[companyId]);
  useEffect(()=>{if(!supplierId)return;setStatement(null);setError('');api(`/purchasing/suppliers/${supplierId}/statement?companyId=${companyId}`).then(setStatement).catch(failure=>setError(failure.message));},[supplierId,companyId]);
  const deliveryTotal=useMemo(()=>statement?.rows.filter(row=>row.type.includes('delivery')).reduce((sum,row)=>sum+Number(row.deliveryValue||0),0)||0,[statement]);
  return <div className="supplier-statement">
    <section className="table-panel supplier-statement-picker"><div><span>Supplier account</span><h2>Delivery-to-payment statement</h2><p>Deliveries provide quantity and destination evidence. Supplier invoices increase the balance; cleared payments reduce it.</p></div><label>Supplier<select value={supplierId} onChange={event=>setSupplierId(event.target.value)}><option value="">Choose supplier…</option>{suppliers.map(supplier=><option key={supplier.id} value={supplier.id}>{supplier.name} · {rupees(supplier.outstanding)} outstanding</option>)}</select></label></section>
    {error&&<p className="form-error">{error}</p>}
    {!supplierId&&!error&&<p className="empty-state">No suppliers are available for this company.</p>}
    {supplierId&&!statement&&!error&&<p className="empty-state">Loading supplier statement…</p>}
    {statement&&<><div className="attendance-summary"><Summary label="Delivered value" value={rupees(deliveryTotal)} icon={ReceiptText}/><Summary label="Supplier invoices" value={rupees(statement.summary.invoiced)} icon={CircleDollarSign}/><Summary label="Payments cleared" value={rupees(statement.summary.paid)} icon={Wallet}/><Summary label="Outstanding" value={rupees(statement.summary.outstanding)} icon={Wallet}/></div>
      {statement.summary.pendingCheques>0&&<p className="form-note">Pending supplier cheques: <strong>{rupees(statement.summary.pendingCheques)}</strong>. They do not reduce the outstanding balance until cleared.</p>}
      <Table columns={COLUMNS} template={TEMPLATE} title={`${statement.supplier.name} · complete supplier statement`} empty="No deliveries, invoices or payments are recorded for this supplier and company.">
        {statement.rows.map(row=><Row template={TEMPLATE} key={row.id}><span>{shortDate(row.date)}</span><Badge tone={row.type==='Invoice'?'pending':row.type.includes('Payment')||row.type==='Cheque cleared'?'active':row.type==='Cheque pending'?'watch':'neutral'}>{row.type}</Badge><div><strong>{row.material||row.orderReference||row.invoiceNo||'—'}</strong><small>{row.orderReference||''}{row.note?`${row.orderReference?' · ':''}${row.note}`:''}</small></div><span>{row.quantity?`${Number(row.quantity).toLocaleString()} ${row.unit||''}`:'—'}</span><span>{row.rate?rupees(row.rate):'—'}</span><strong>{row.invoiceNo||'—'}</strong><span>{row.type.includes('Payment')||row.type.includes('Cheque')?`${row.reference||row.note||'—'}${row.pendingAmount?` · ${rupees(row.pendingAmount)}`:''}`:'—'}</span><div><strong>{row.destination||'—'}</strong><small>{row.project||''}</small></div><span>{row.debit?rupees(row.debit):'—'}</span><span>{row.credit?rupees(row.credit):'—'}</span><strong>{rupees(row.balance)}</strong></Row>)}
      </Table></>}
  </div>;
}
