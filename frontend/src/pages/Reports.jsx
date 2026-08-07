import React, { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { api, localDate, todayInput } from '../api.js';
import { Field, Page, Row, Table, Tabs } from '../ui.jsx';

const REPORTS = [
  ['projects', 'Projects'],
  ['budget', 'Budget'],
  ['profit', 'Profit'],
  ['progress', 'Daily progress'],
  ['attendance', 'Attendance'],
  ['employees', 'Employees'],
  ['tasks', 'Tasks'],
  ['materials', 'Materials'],
  ['purchases', 'Purchases'],
  ['vehicles', 'Vehicles'],
  ['equipment', 'Equipment']
];

const NUMERIC = /^-?\d+(\.\d+)?$/;
const cell = value => (NUMERIC.test(String(value)) && String(value).length > 4
  ? Number(value).toLocaleString('en-LK', { maximumFractionDigits: 2 })
  : String(value ?? '—'));

/** PID 2.12 — on-demand reports generated from live data instead of compiled by hand. */
export default function Reports() {
  const [type, setType] = useState('projects');
  const [range, setRange] = useState(() => {
    const to = todayInput();
    const from = new Date();
    from.setDate(from.getDate() - 30);
    return { from: localDate(from), to };
  });
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setReport(null);
    api(`/analytics/${type}?from=${range.from}&to=${range.to}`)
      .then(setReport)
      .catch(failure => setError(failure.message));
  }, [type, range.from, range.to]);

  /** Exports what is on screen, so the figures in the file always match the system. */
  const download = () => {
    if (!report) return;
    const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const csv = [report.columns, ...report.rows].map(row => row.map(escape).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `gkuc-${type}-${range.to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const label = REPORTS.find(([key]) => key === type)?.[1];
  const template = report ? `repeat(${report.columns.length}, minmax(120px, 1fr))` : '1fr';

  return <Page title="Reports" subtitle="System-generated reports across every operational area.">
    <Tabs tabs={REPORTS.map(([, name]) => name)} active={label}
      onChange={name => setType(REPORTS.find(([, item]) => item === name)[0])} />

    <div className="toolbar" style={{ width: '100%', justifyContent: 'space-between', marginBottom: '14px' }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
        <Field name="from" label="From" type="date" defaultValue={range.from} />
        <Field name="to" label="To" type="date" defaultValue={range.to} />
        <button className="secondary" onClick={() => setRange({
          from: document.querySelector('input[name="from"]').value,
          to: document.querySelector('input[name="to"]').value
        })}>Apply range</button>
      </div>
      <button className="primary" onClick={download} disabled={!report}><Download size={16} />Export CSV</button>
    </div>

    {error && <p className="empty-state">{error}</p>}
    {!report && !error && <p className="empty-state">Generating {label?.toLowerCase()} report…</p>}
    {report && <Table columns={report.columns} template={template} title={`${label} report`}
      empty="No data in this period.">
      {report.rows.map((row, index) => <Row template={template} key={index}>
        {row.map((value, position) => (position === 0
          ? <strong key={position}>{cell(value)}</strong>
          : <span key={position}>{cell(value)}</span>))}
      </Row>)}
    </Table>}
  </Page>;
}
