import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, CalendarDays, CircleDollarSign, Plus, TrendingDown, TrendingUp, WalletCards } from 'lucide-react';
import { api, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, SelectField, Summary, TextArea } from '../ui.jsx';

const SOURCES = ['Material', 'Labour', 'Fuel', 'Equipment', 'Subcontractor', 'Overhead', 'Other'];
const number = value => Number(value || 0);
const percent = (value, total) => total ? Math.round(value / total * 100) : 0;

function Money({ value, signed = false }) {
  const amount = number(value); return <span className={amount > 0 && signed ? 'cost-negative' : amount < 0 ? 'cost-positive' : ''}>
    {signed && amount > 0 ? '+' : ''}{rupees(amount)}
  </span>;
}

export default function CostControl({ projects, can }) {
  const [projectId, setProjectId] = useState(projects[0]?.id || '');
  const [data, setData] = useState(null);
  const [open, setOpen] = useState('');
  const [forecastItem, setForecastItem] = useState(null);
  const [error, setError] = useState('');
  const load = () => projectId && api(`/boq/cost-control?projectId=${projectId}`).then(setData).catch(failure => setError(failure.message));
  useEffect(() => { setData(null); setError(''); load(); }, [projectId]);
  const summary = data?.summary || {};
  const overrunItems = useMemo(() => (data?.items || []).filter(item => item.variance > 0).sort((a, b) => b.variance - a.variance), [data]);

  if (!projects.length) return <p className="empty-state">Create a project before opening site cost control.</p>;
  return <div className="qs-cost-control">
    <section className="cost-control-hero">
      <div><span>Live commercial control</span><h2>Site cost command centre</h2><p>Baseline BOQ, approved changes, daily actuals and the latest final-cost forecast in one view.</p></div>
      <label>Project site<select value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option value={project.id} key={project.id}>{project.name} · {project.site}</option>)}</select></label>
      {(can.boq || can.finance) && <button className="primary" onClick={() => setOpen('expense')}><Plus size={16} />Record daily cost</button>}
    </section>
    {error && <p className="form-error">{error}</p>}
    {!data ? <div className="project-workspace-state compact"><span className="workspace-loader" /><h2>Calculating project costs</h2></div> : <>
      <div className="cost-control-summary">
        <article><CircleDollarSign /><span>Original estimate</span><strong>{rupees(summary.baseline)}</strong><small>Approved BOQ baseline</small></article>
        <article><WalletCards /><span>Real budget</span><strong>{rupees(summary.currentBudget)}</strong><small>{rupees(summary.approvedChanges)} approved changes</small></article>
        <article className={summary.actualVariance > 0 ? 'danger' : ''}><BarChart3 /><span>Actual spent</span><strong>{rupees(summary.actual)}</strong><small>{percent(summary.actual, summary.currentBudget)}% of real budget</small></article>
        <article className={summary.forecastVariance > 0 ? 'danger' : 'good'}>{summary.forecastVariance > 0 ? <TrendingDown /> : <TrendingUp />}<span>Forecast final cost</span><strong>{rupees(summary.forecast)}</strong><small><Money value={summary.forecastVariance} signed /> forecast variance</small></article>
      </div>

      <section className="cost-health-panel">
        <div className="cost-health-copy"><span>Cost outlook</span><h2>{summary.forecastVariance > 0 ? `Forecast overrun of ${rupees(summary.forecastVariance)}` : `${rupees(Math.abs(summary.forecastVariance))} forecast headroom`}</h2><p>{summary.unexpected ? `${rupees(summary.unexpected)} is explicitly marked as unexpected. ` : 'No cost is currently marked as unexpected. '}{summary.unallocated ? `${rupees(summary.unallocated)} of older actual costs still needs BOQ item allocation. ` : ''}{overrunItems.length} BOQ item(s) have exceeded their original allowance.</p></div>
        <div className="cost-comparison-visual">{[['Original estimate', summary.baseline], ['Real budget', summary.currentBudget], ['Actual to date', summary.actual], ['Forecast at completion', summary.forecast]].map(([label, value]) => <div key={label}><span>{label}</span><i><b className={label.includes('Forecast') && summary.forecastVariance > 0 ? 'over' : ''} style={{ width: `${Math.min(100, percent(value, Math.max(summary.currentBudget, summary.forecast, 1)))}%` }} /></i><strong>{rupees(value)}</strong></div>)}</div>
      </section>

      <div className="cost-intelligence-grid">
        <section className="cost-category-panel"><div><span>Estimate vs actual vs forecast</span><h2>Cost category exposure</h2></div>{data.categories.map(category => <article key={category.category}><strong>{category.category}</strong><div><i style={{ width: `${percent(category.expected, Math.max(category.expected, category.actual, category.forecast, 1))}%` }} /><i className="actual" style={{ width: `${percent(category.actual, Math.max(category.expected, category.actual, category.forecast, 1))}%` }} /><i className="forecast" style={{ width: `${percent(category.forecast, Math.max(category.expected, category.actual, category.forecast, 1))}%` }} /></div><span>{rupees(category.expected)} → {rupees(category.actual)} → {rupees(category.forecast)}</span></article>)}{!data.categories.length && <p>No approved BOQ cost categories yet.</p>}<footer><span><i />Estimate</span><span><i />Actual</span><span><i />Forecast</span></footer></section>
        <section className="daily-cost-panel"><div><span>Daily expenditure</span><h2>Recent site spend</h2></div><div className="daily-cost-bars">{data.daily.slice(0, 14).reverse().map(day => <article title={`${shortDate(day.expenseDate)} · ${rupees(day.total)}`} key={day.expenseDate}><i style={{ height: `${Math.max(5, percent(day.total, Math.max(...data.daily.map(row => number(row.total)), 1)))}%` }} /><span>{new Date(day.expenseDate).getDate()}</span></article>)}{!data.daily.length && <p>No daily costs recorded.</p>}</div><div className="daily-cost-total"><span>Unexpected costs</span><strong>{rupees(summary.unexpected)}</strong><span>Unallocated actuals</span><strong>{rupees(summary.unallocated)}</strong><span>Committed orders</span><strong>{rupees(summary.committed)}</strong></div></section>
      </div>

      <section className="cost-ledger-panel">
        <div className="cost-section-heading"><div><span>BOQ line control</span><h2>Expected cost against actual work</h2></div><Badge tone={overrunItems.length ? 'at-risk' : 'on-track'}>{overrunItems.length} over allowance</Badge></div>
        <div className="cost-table-scroll"><table><thead><tr><th>BOQ item</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Forecast</th><th>Position</th><th /></tr></thead><tbody>{data.items.map(item => <tr key={item.id}><td><strong>{item.description}</strong><small>{item.boqReference} · {item.category}<br />{number(item.quantity).toLocaleString()} {item.unit} × {rupees(item.rate)}</small></td><td>{rupees(item.expectedAmount)}</td><td>{rupees(item.actualAmount)}<small>{item.expenseCount} entries</small></td><td><Money value={item.variance} signed /><small>{item.variancePercent}%</small></td><td>{rupees(item.finalForecast)}{item.forecastReason && <small>{item.forecastReason}</small>}</td><td><Badge tone={item.variance > 0 ? 'at-risk' : item.forecastVariance > 0 ? 'watch' : 'on-track'}>{item.variance > 0 ? 'Exceeded' : item.forecastVariance > 0 ? 'Forecast risk' : 'Within budget'}</Badge></td><td>{can.boq && <button className="status-button" onClick={() => setForecastItem(item)}>Forecast</button>}</td></tr>)}{!data.items.length && <tr><td colSpan="7">Approve a BOQ to create the item-level cost baseline.</td></tr>}</tbody></table></div>
      </section>

      <section className="cost-ledger-panel"><div className="cost-section-heading"><div><span>Daily cost ledger</span><h2>Every project expense</h2></div><span>{data.expenses.length} entries</span></div><div className="cost-table-scroll"><table><thead><tr><th>Date</th><th>Description</th><th>BOQ item</th><th>Type</th><th>Quantity / rate</th><th>Amount</th><th>Reference</th></tr></thead><tbody>{data.expenses.map(row => <tr key={row.id}><td>{shortDate(row.expenseDate)}</td><td><strong>{row.description}</strong><small>{row.source} · {row.recordedBy}</small></td><td>{row.boqItem || 'Unallocated / other'}</td><td><Badge tone={row.costType === 'Unexpected' ? 'at-risk' : row.costType === 'Variation' ? 'watch' : 'on-track'}>{row.costType}</Badge></td><td>{row.quantity ? `${number(row.quantity).toLocaleString()} ${row.unit || ''} × ${rupees(row.unitRate)}` : 'Lump sum'}</td><td><strong>{rupees(row.amount)}</strong></td><td>{row.reference || '—'}</td></tr>)}{!data.expenses.length && <tr><td colSpan="7">No daily site costs have been recorded.</td></tr>}</tbody></table></div></section>

      <section className="cost-ledger-panel"><div className="cost-section-heading"><div><span>Budget movement</span><h2>Variations and unexpected additions</h2></div></div><div className="cost-table-scroll"><table><thead><tr><th>Reference</th><th>Description</th><th>Value</th><th>Status</th><th>Raised</th></tr></thead><tbody>{data.variations.map(row => <tr key={row.id}><td><strong>{row.reference}</strong></td><td>{row.description}</td><td><Money value={row.amount} signed /></td><td><Badge tone={slug(row.status)}>{row.status}</Badge></td><td>{shortDate(row.createdAt)}</td></tr>)}{!data.variations.length && <tr><td colSpan="5">No variation orders have been raised.</td></tr>}</tbody></table></div></section>
    </>}
    {open === 'expense' && data && <ExpenseForm projectId={Number(projectId)} items={data.items} close={() => setOpen('')} reload={load} />}
    {forecastItem && <ForecastForm projectId={Number(projectId)} item={forecastItem} close={() => setForecastItem(null)} reload={load} />}
  </div>;
}

function ExpenseForm({ projectId, items, close, reload }) {
  const [itemId, setItemId] = useState(''); const [costType, setCostType] = useState('Expected');
  return <FormModal title="Record daily project cost" close={close} label="Add to cost ledger" wide onSubmit={async values => {
    await post('/boq/cost-control/expenses', { projectId, boqItemId: itemId ? Number(itemId) : null, expenseDate: values.expenseDate,
      source: values.source, costType, description: values.description, quantity: values.quantity ? Number(values.quantity) : null,
      unit: values.unit || null, unitRate: values.unitRate ? Number(values.unitRate) : null,
      amount: values.amount ? Number(values.amount) : undefined, reference: values.reference || null }); await reload();
  }}>
    <Field name="expenseDate" label="Expense date" type="date" defaultValue={todayInput()} />
    <label>Cost classification<select value={costType} onChange={event => { setCostType(event.target.value); if (event.target.value === 'Unexpected') setItemId(''); }}><option>Expected</option><option>Variation</option><option>Unexpected</option></select></label>
    <label className="wide">Related BOQ item<select value={itemId} onChange={event => setItemId(event.target.value)} disabled={costType === 'Unexpected'}><option value="">Unallocated / additional cost</option>{items.map(item => <option value={item.id} key={item.id}>{item.boqReference} · {item.description}</option>)}</select></label>
    <SelectField name="source" label="Cost category" options={SOURCES} />
    <Field name="description" label="What was paid for" wide />
    <Field name="quantity" label="Actual quantity (optional)" type="number" min="0.001" step="0.001" required={false} />
    <Field name="unit" label="Unit (optional)" required={false} placeholder="m3, kg, day" />
    <Field name="unitRate" label="Actual unit rate (optional)" type="number" min="0" step="0.01" required={false} />
    <Field name="amount" label="Total amount (or quantity × rate)" type="number" min="0.01" step="0.01" required={false} />
    <Field name="reference" label="Receipt / invoice reference" required={false} wide />
  </FormModal>;
}

function ForecastForm({ projectId, item, close, reload }) {
  return <FormModal title="Update final-cost forecast" close={close} label="Save forecast" onSubmit={async values => {
    await patch(`/boq/cost-control/items/${item.id}/forecast`, { projectId,
      forecastQuantity: values.forecastQuantity ? Number(values.forecastQuantity) : null,
      forecastRate: values.forecastRate ? Number(values.forecastRate) : null,
      forecastAmount: Number(values.forecastAmount), reason: values.reason }); await reload();
  }}>
    <div className="forecast-baseline wide"><AlertTriangle size={17} /><div><span>Original BOQ allowance</span><strong>{number(item.quantity).toLocaleString()} {item.unit} × {rupees(item.rate)} = {rupees(item.expectedAmount)}</strong></div></div>
    <Field name="forecastQuantity" label="Forecast final quantity" type="number" step="0.001" min="0.001" required={false} defaultValue={item.forecastQuantity || item.quantity} />
    <Field name="forecastRate" label="Forecast unit rate" type="number" step="0.01" min="0" required={false} defaultValue={item.forecastRate || item.rate} />
    <Field name="forecastAmount" label="Forecast final amount" type="number" step="0.01" min="0" defaultValue={item.forecastAmount || item.expectedAmount} />
    <TextArea name="reason" label="Reason for forecast change" wide defaultValue={item.forecastReason || ''} />
  </FormModal>;
}
