import React, { useEffect, useState } from 'react';
import { api, todayInput, fetchDownload } from '../api.js';
import './FinancialStatements.css';

const amount = value => value === null ? 'Not recorded' : `${value < 0 ? '(' : ''}${Math.abs(value).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${value < 0 ? ')' : ''}`;

export default function FinancialStatements({ companyId, statement }) {
  const [from,setFrom]=useState(todayInput().slice(0,7)+'-01');
  const [to,setTo]=useState(todayInput());
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setData(null); setError('');
    api(`/finance/financial-statements?${new URLSearchParams({companyId,from,to})}`)
      .then(value => { if (active) setData(value); })
      .catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [companyId, from, to]);
  const position = statement === 'financial-position';
  const rows = data ? (position ? data.financialPosition : data.incomeStatement) : [];
  const title = position ? 'Statement of Financial Position' : 'Income Statement';
  const download = () => {
    const lines = [[data.company.name], [title], [position ? `As at ${data.asAt}` : `For ${from} to ${to}`], ['Currency: LKR'], [data.basis], [], ['Account','Amount'], ...rows.map(row => [row.label,row.style === 'heading' ? '' : amount(row.amount)]), [], ...data.notes.map(note => [note])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.map(row => row.map(cell => `"${String(cell).replaceAll('"','""')}"`).join(',')).join('\r\n')], {type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = `${statement}-${companyId}-${from}-${to}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  return <section className="statement-view">
    <div className="statement-controls"><label>From<input aria-label="Statement from" type="date" value={from} onChange={event=>setFrom(event.target.value)} /></label><label>To<input aria-label="Statement to" type="date" value={to} onChange={event=>setTo(event.target.value)} /></label>{data && <><button type="button" className="secondary" onClick={download}>Export CSV</button><button type="button" className="secondary" onClick={async()=>{try{const url=await fetchDownload(`/finance/financial-statements/document?${new URLSearchParams({companyId,from,to,statement,download:'pdf'})}`,{expectedType:'application/pdf'});const link=document.createElement('a');link.href=url;link.download=`${statement}-${from}-${to}.pdf`;link.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(failure){setError(failure.message);}}}>Export PDF</button></>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading statement…</p>}
    {data && <><article className={`financial-statement ${position ? 'position' : 'income'}`}>
      <header><strong>{data.company.name}</strong><h2>{title}</h2><p>{position ? `As at ${data.asAt}` : `For ${data.from} to ${data.to}`}</p><small>LKR · {data.basis}</small></header>
      <table aria-label={title}><tbody>{rows.map((row,index) => <tr key={index} className={`statement-${row.style}`}>
        {row.style === 'heading' ? <th colSpan="2" scope="colgroup">{row.label}</th> : <><th scope="row">{row.label}</th><td className={row.amount === null ? 'statement-unknown' : ''}>{amount(row.amount)}</td></>}
      </tr>)}</tbody></table>
      <footer>Developed by Infinity AI (Pvt) Ltd, Sri Lanka</footer>
    </article><section className="statement-notes"><h3>Basis and available records</h3><ul>{data.notes.map(note => <li key={note}>{note}</li>)}</ul><a href="/finance/management-accounts">Review source schedules and saved management adjustments</a></section></>}
  </section>;
}
