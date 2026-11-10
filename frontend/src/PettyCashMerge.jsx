import React,{useRef,useState} from 'react';
import {post,rupeesExact} from './api.js';
import {FormModal,Field,TextArea} from './ui.jsx';
import {notice} from './notices.js';
export default function PettyCashMerge({floats,close,reload}){
 const [target,setTarget]=useState(''),[sources,setSources]=useState([]),[review,setReview]=useState(null),[input,setInput]=useState(null),[clientRef]=useState(()=>crypto.randomUUID());
 const previewSubmit=useRef(false),active=floats.filter(f=>Number(f.active)!==0&&!f.mergedIntoId),selected=active.find(f=>String(f.id)===target);
 if(review)return <FormModal key="review" title="Review petty cash account merge" close={close} label="Merge accounts" onSubmit={async values=>{
  const result=await post('/receivables/petty-cash/merge/commit',{...input,digest:review.digest,clientRef,reason:values.reason});
  notice({title:'Petty cash accounts merged',message:`${result.name} · balance at merge ${rupeesExact(result.combinedBalance)}. Previous accounts remain available in merged history.`,severity:'Info'});
  try{await reload();}catch{notice({title:'Merge saved',message:'Refresh petty cash to see the combined account. Do not merge it again.',severity:'Warning'});}
 }}>
  <p className="form-note wide">Keep <strong>{review.name}</strong> as the shared account. Original dates, company attribution and payment links stay intact. The other accounts close for new payments and remain readable in history.</p>
  <div className="wide">{review.summary.map(f=><p key={f.id}><strong>{f.name}</strong> · {rupeesExact(f.balance)} · {f.transactionCount} movements · {Number(f.id)===review.targetId?'Keep active':'Merge and archive'}</p>)}</div>
  <p className="form-note wide"><strong>Combined available balance: {rupeesExact(review.combinedBalance)}</strong><br/>{review.transactionCount} original movements. This creates no additional top-up, spending or expense.</p>
  <button type="button" className="secondary" onClick={()=>setReview(null)}>Change accounts</button>
  <TextArea name="reason" label="Reason for merging"/>
 </FormModal>;
 return <FormModal key="choose" title="Merge petty cash accounts" close={()=>{if(previewSubmit.current)previewSubmit.current=false;else close();}} label="Preview combined balance" onSubmit={async values=>{
  if(!target||!sources.length)throw Error('Choose the account to keep and at least one account to merge into it.');
  const body={targetId:Number(target),sourceIds:sources.map(Number),name:values.name};
  const result=await post('/receivables/petty-cash/merge/preview',body);previewSubmit.current=true;setInput(body);setReview(result);
 }}>
  <label className="wide">Account to keep *<select required value={target} onChange={e=>{setTarget(e.target.value);setSources([]);}}><option value="">Choose shared account</option>{active.map(f=><option key={f.id} value={f.id}>{f.name} · {f.accountType} · {rupeesExact(f.balance)}</option>)}</select></label>
  <Field key={target} name="name" label="Combined account name" defaultValue={input?.targetId===Number(target)?input.name:selected?.name||''} placeholder="Shared fuel petty cash" wide/>
  <div className="wide"><strong>Accounts to merge into it</strong>{selected?active.filter(f=>String(f.id)!==target&&f.accountType===selected.accountType).map(f=><label className="wide" key={f.id}><input type="checkbox" checked={sources.includes(String(f.id))} onChange={e=>setSources(values=>e.target.checked?[...values,String(f.id)]:values.filter(v=>v!==String(f.id)))}/> {f.name} · {rupeesExact(f.balance)}</label>):<p>Choose the account to keep first.</p>}</div>
  <p className="form-note wide">Choose accounts representing the separate company balances you want to combine. Only the same account category can be merged. Review the sum before confirming; no account or payment history is deleted.</p>
 </FormModal>;
}
