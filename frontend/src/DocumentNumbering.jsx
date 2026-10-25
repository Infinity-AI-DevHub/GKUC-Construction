import React,{useEffect,useState} from 'react';
import {api,post,openDocument} from './api.js';
import {Field,FormModal,SelectField,Table,Row,Badge} from './ui.jsx';

export function NumberEdit({type,record,close,reload}){
  return <FormModal title="Edit document number" close={close} label="Save number" onSubmit={async values=>{
    await api(`/document-numbering/${type}/${record.id}`,{method:'PATCH',body:JSON.stringify({reference:values.reference,previousReference:record.reference,reason:values.reason})});
    await reload();
  }}>
    <Field name="reference" label="Document number" defaultValue={record.reference} />
    <Field name="reason" label="Reason for change" />
    <p className="form-note wide">Only the document number changes. Amounts and payments stay unchanged. Quotation revisions share the same number.</p>
  </FormModal>;
}

export default function DocumentNumbering({companyId,reloadInvoices}){
  const [data,setData]=useState(null),[error,setError]=useState(''),[configure,setConfigure]=useState(null),[edit,setEdit]=useState(null);
  const load=async()=>{setData(await api(`/document-numbering?companyId=${companyId}`));};
  useEffect(()=>{let live=true;setData(null);api(`/document-numbering?companyId=${companyId}`).then(value=>{if(live)setData(value);}).catch(failure=>{if(live)setError(failure.message);});return()=>{live=false;};},[companyId]);
  const names={QUO:'Quotation',INV:'Invoice',RCPT:'Receipt'};
  return <>
    {error&&<p className="form-error">{error}</p>}
    <section className="table-panel"><div className="table-tools"><h2>Document numbering</h2><div className="row-actions">{Object.entries(names).map(([type,label])=><button className="secondary" key={type} disabled={!data} onClick={()=>setConfigure({type,...data?.settings.find(row=>row.type===type)})}>{label} numbering</button>)}</div></div></section>
    {data&&<Table title="Quotation issue register" columns={['Quotation','Title','Status','Actions']} template="minmax(180px,1fr) minmax(200px,2fr) 110px minmax(200px,1fr)">
      {data.quotations.map(quote=><Row key={quote.id} template="minmax(180px,1fr) minmax(200px,2fr) 110px minmax(200px,1fr)">
        <div><strong>{quote.reference}</strong><small>Revision {quote.revision}</small></div><span>{quote.title}</span><Badge>{quote.status}</Badge>
        <div className="row-actions"><button className="status-button" onClick={()=>setEdit(quote)}>Edit number</button><button className="status-button" onClick={()=>openDocument(`/qs/quotations/${quote.id}/document`)}>PDF</button>
          {quote.status==='Draft'&&<button className="status-button" onClick={async()=>{try{await post(`/qs/quotations/${quote.id}/finalize`);await load();await reloadInvoices();}catch(failure){setError(failure.message);}}}>Issue quotation</button>}
        </div>
      </Row>)}
    </Table>}
    {configure&&<FormModal key={`${companyId}-${configure.type}`} title={`${names[configure.type]} numbering`} close={()=>setConfigure(null)} label="Save numbering" onSubmit={async values=>{
      await api(`/document-numbering/${configure.type}`,{method:'PUT',body:JSON.stringify({companyId,format:values.format,padding:Number(values.padding),nextValue:Number(values.nextValue),reason:values.reason})});await load();
    }}>
      <Field name="format" label="Number format" defaultValue={configure.format||`${configure.type}-{YYYY}-{N}`} />
      <Field name="padding" label="Sequence digits" type="number" min="1" max="10" defaultValue={configure.padding||4} />
      <Field name="nextValue" label="Next sequence number" type="number" min="1" max="999999999" defaultValue={configure.nextValue||1} />
      <Field name="reason" label="Reason for change" />
      <p className="form-note wide">{'Use {N} for the sequence, {YYYY} or {YY} for year, and {MM} for month. Existing documents stay unchanged. Sequence continues until Finance changes it; no automatic yearly reset.'}</p>
    </FormModal>}
    {edit&&<NumberEdit type="QUO" record={edit} close={()=>setEdit(null)} reload={async()=>{await load();await reloadInvoices();}}/>}
  </>;
}
