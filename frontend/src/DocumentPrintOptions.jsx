import React,{useEffect,useState} from 'react';
import {api} from './api.js';
import {Field,FormModal} from './ui.jsx';
export const printedQuotationNumber=row=>{
  const options=typeof row.printOptions==='string'?JSON.parse(row.printOptions):row.printOptions;
  return options?.printedReference||row.reference;
};
const groups=[
  ['Letterhead',{number:'Document number',date:'Document date',logo:'Company logo',companyName:'Letterhead company name',companyDetails:'Letterhead address / contact / tax details'}],
  ['Items and amounts',{unit:'Unit',quantity:'Quantity',rate:'Rate',lineAmounts:'Line amounts',totals:'Totals, subtotals and tax summary',words:'Total amount in words'}],
  ['Document sections',{clientDetails:'Client / supplier and document details',workDetails:'Work / supply details',notes:'Notes / payment mode',methods:'Method statements (quotations)',terms:'Terms and payment terms',bank:'Bank details',signatures:'Signatures',footer:'Company footer'}]
];
export default function DocumentPrintOptions({kind,id,reference,close,reload}){
  const [options,setOptions]=useState(null),[error,setError]=useState('');
  const base=kind==='quotation'?`/qs/quotations/${id}`:`/receivables/invoices/${id}`;
  useEffect(()=>{api(base+'/print-options').then(setOptions).catch(e=>setError(e.message));},[base]);
  return <FormModal title={`${reference} — print options`} close={close} label="Save print options" wide onSubmit={async values=>{
    if(!options)throw new Error('Wait for print options to load.');
    await api(base+'/print-options',{method:'PUT',body:JSON.stringify({...options,printedReference:kind==='quotation'?(values.printedReference||''):''})});
    await reload();
  }}>
    {error&&<p className="form-error wide" role="alert">{error}</p>}
    {options&&<>
      {kind==='quotation'&&<><Field name="printedReference" label="Printed quotation number (optional)" defaultValue={options.printedReference} placeholder={reference} required={false} wide/><p className="form-note wide">You can reuse the same printed number for quotations for the same work. Leave blank to use {reference}.</p></>}
      <div className="wide" style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:16}}>{groups.map(([title,fields])=><fieldset key={title} className="invoice-column-options"><legend>{title}</legend>{Object.entries(fields).filter(([key])=>kind==='quotation'||key!=='methods').map(([key,label])=><label key={key} className="invoice-check"><input type="checkbox" checked={key==='words'&&!options.totals?false:Boolean(options[key])} disabled={key==='words'&&!options.totals} onChange={event=>setOptions(current=>({...current,[key]:event.target.checked}))}/><span>{label}</span></label>)}</fieldset>)}</div>
      <p className="form-note wide">Totals hidden also hides their amount in words. These choices apply to this document's preview and PDF; saved calculations and payments stay as recorded.</p>
    </>}
  </FormModal>;
}
