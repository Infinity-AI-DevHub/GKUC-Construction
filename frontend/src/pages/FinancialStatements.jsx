import React, { useEffect, useState } from 'react';
import { api, todayInput } from '../api.js';
import './FinancialStatements.css';

const amount = value => value === null ? 'Not recorded' : `${value < 0 ? '(' : ''}${Math.abs(value).toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${value < 0 ? ')' : ''}`;

export default function FinancialStatements({ companyId, statement }) {
  const [period, setPeriod] = useState(todayInput().slice(0,7));
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setData(null); setError('');
    api(`/finance/financial-statements?${new URLSearchParams({companyId,period})}`)
      .then(value => { if (active) setData(value); })
      .catch(failure => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [companyId, period]);
  const position = statement === 'financial-position';
  const rows = data ? (position ? data.financialPosition : data.incomeStatement) : [];
  const title = position ? 'Statement of Financial Position' : 'Income Statement';
  const download = () => {
    const lines = [[data.company.name], [title], [position ? `As at ${data.asAt}` : `For the month ${period}`], ['Currency: LKR'], [data.basis], [], ['Account','Amount'], ...rows.map(row => [row.label,row.style === 'heading' ? '' : amount(row.amount)]), [], ...data.notes.map(note => [note])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + lines.map(row => row.map(cell => `"${String(cell).replaceAll('"','""')}"`).join(',')).join('\r\n')], {type:'text/csv;charset=utf-8'}));
    const link = document.createElement('a'); link.href = url; link.download = `${statement}-${companyId}-${period}.csv`; link.click(); URL.revokeObjectURL(url);
  };
  return <section className="statement-view">
    <div className="statement-controls"><label>Reporting month<input aria-label="Statement reporting month" type="month" min="1900-01" max="9999-12" value={period} onChange={event => { if (event.target.value) setPeriod(event.target.value); }} /></label>{data && <button type="button" className="secondary" onClick={download}>Export statement</button>}</div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!data && !error && <p role="status">Loading statement…</p>}
    {data && <><article className={`financial-statement ${position ? 'position' : 'income'}`}>
      <header><strong>{data.company.name}</strong><h2>{title}</h2><p>{position ? `As at ${data.asAt}` : `For the month ended ${data.asAt}`}</p><small>LKR · {data.basis}</small></header>
      <table aria-label={title}><tbody>{rows.map((row,index) => <tr key={index} className={`statement-${row.style}`}>
        {row.style === 'heading' ? <th colSpan="2" scope="colgroup">{row.label}</th> : <><th scope="row">{row.label}</th><td className={row.amount === null ? 'statement-unknown' : ''}>{amount(row.amount)}</td></>}
      </tr>)}</tbody></table>
      <footer>Developed by Infinity AI (Pvt) Ltd, Sri Lanka</footer>
    </article><section className="statement-notes"><h3>Basis and available records</h3><ul>{data.notes.map(note => <li key={note}>{note}</li>)}</ul><a href="/finance/management-accounts">Review source schedules and saved management adjustments</a></section></>}
  </section>;
}
