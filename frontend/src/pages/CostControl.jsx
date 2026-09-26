import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, CircleDollarSign, Plus, Trash2, TrendingDown, TrendingUp, WalletCards } from 'lucide-react';
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
  const [rework, setRework] = useState(null);
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
      {can.boq && <button className="primary" onClick={() => {setRework(null);setOpen('expense');}}><Plus size={16} />Submit daily costs</button>}
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

      <section className="cost-ledger-panel"><div className="cost-section-heading"><div><span>Daily commercial position</span><h2>Quoted recovery against actual cost</h2></div><span>Quoted recovery is not a payment or booked revenue</span></div><div className="cost-table-scroll"><table><thead><tr><th>Date</th><th>Quoted recovery allocated</th><th>All project actual cost</th><th>Unexpected cost</th><th>Net against quoted work</th></tr></thead><tbody>{data.daily.map(day=><tr key={day.expenseDate}><td>{shortDate(day.expenseDate)}</td><td>{rupees(day.quotedRecovery)}</td><td>{rupees(day.total)}</td><td>{rupees(day.unexpected)}</td><td><strong className={day.netAgainstQuote<0?'cost-negative':'cost-positive'}>{rupees(day.netAgainstQuote)}</strong></td></tr>)}{!data.daily.length&&<tr><td colSpan="5">No project costs have been recorded yet.</td></tr>}</tbody></table></div></section>

      <section className="cost-ledger-panel">
        <div className="cost-section-heading"><div><span>BOQ line control</span><h2>Expected cost against actual work</h2></div><Badge tone={overrunItems.length ? 'at-risk' : 'on-track'}>{overrunItems.length} over allowance</Badge></div>
        <div className="cost-table-scroll"><table><thead><tr><th>BOQ item</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Forecast</th><th>Position</th><th /></tr></thead><tbody>{data.items.map(item => <tr key={item.id}><td><strong>{item.description}</strong><small>{item.boqReference} · {item.category}<br />{number(item.quantity).toLocaleString()} {item.unit} × {rupees(item.rate)}</small></td><td>{rupees(item.expectedAmount)}</td><td>{rupees(item.actualAmount)}<small>{item.expenseCount} entries</small></td><td><Money value={item.variance} signed /><small>{item.variancePercent}%</small></td><td>{rupees(item.finalForecast)}{item.forecastReason && <small>{item.forecastReason}</small>}</td><td><Badge tone={item.variance > 0 ? 'at-risk' : item.forecastVariance > 0 ? 'watch' : 'on-track'}>{item.variance > 0 ? 'Exceeded' : item.forecastVariance > 0 ? 'Forecast risk' : 'Within budget'}</Badge></td><td>{can.boq && <button className="status-button" onClick={() => setForecastItem(item)}>Forecast</button>}</td></tr>)}{!data.items.length && <tr><td colSpan="7">Approve a BOQ to create the item-level cost baseline.</td></tr>}</tbody></table></div>
      </section>

      <section className="cost-ledger-panel"><div className="cost-section-heading"><div><span>Daily cost ledger</span><h2>Every project expense</h2></div><span>{data.expenses.length} entries</span></div><div className="cost-table-scroll"><table><thead><tr><th>Date</th><th>Description</th><th>BOQ item</th><th>Type</th><th>Quantity / rate</th><th>Amount</th><th>Reference</th></tr></thead><tbody>{data.expenses.map(row => <tr key={row.id}><td>{shortDate(row.expenseDate)}</td><td><strong>{row.description}</strong><small>{row.source} · {row.recordedBy}</small></td><td>{row.boqItem || 'Unallocated / other'}</td><td><Badge tone={row.costType === 'Unexpected' ? 'at-risk' : row.costType === 'Variation' ? 'watch' : 'on-track'}>{row.costType}</Badge></td><td>{row.quantity ? `${number(row.quantity).toLocaleString()} ${row.unit || ''} × ${rupees(row.unitRate)}` : 'Lump sum'}</td><td><strong>{rupees(row.amount)}</strong></td><td>{row.reference || '—'}</td></tr>)}{!data.expenses.length && <tr><td colSpan="7">No daily site costs have been recorded.</td></tr>}</tbody></table></div></section>

      <section className="cost-ledger-panel"><div className="cost-section-heading"><div><span>QS to Finance</span><h2>Daily cost sheets</h2></div><span>{data.sheets?.length || 0} submissions</span></div><div className="cost-table-scroll"><table><thead><tr><th>Date</th><th>Submitted by</th><th>Lines</th><th>Cost</th><th>Quoted recovery</th><th>Net against quoted work</th><th>Status</th><th /></tr></thead><tbody>{(data.sheets || []).map(sheet => <tr key={sheet.id}><td>{shortDate(sheet.workDate)}</td><td>{sheet.submittedBy}</td><td>{sheet.lineCount}</td><td>{rupees(sheet.totalCost)}</td><td>{rupees(sheet.quotedRecovery)}</td><td>{rupees(number(sheet.quotedRecovery) - number(sheet.totalCost))}</td><td><Badge tone={sheet.status === 'Approved' ? 'on-track' : sheet.status === 'Returned' ? 'at-risk' : 'watch'}>{sheet.status}</Badge>{sheet.reviewNote && <small>{sheet.reviewNote}</small>}</td><td><button className="status-button" onClick={() => setOpen(sheet.id)}>View</button></td></tr>)}{!data.sheets?.length && <tr><td colSpan="8">QS has not submitted a daily cost sheet for this project.</td></tr>}</tbody></table></div></section>

      <section className="cost-ledger-panel"><div className="cost-section-heading"><div><span>Budget movement</span><h2>Variations and unexpected additions</h2></div></div><div className="cost-table-scroll"><table><thead><tr><th>Reference</th><th>Description</th><th>Value</th><th>Status</th><th>Raised</th></tr></thead><tbody>{data.variations.map(row => <tr key={row.id}><td><strong>{row.reference}</strong></td><td>{row.description}</td><td><Money value={row.amount} signed /></td><td><Badge tone={slug(row.status)}>{row.status}</Badge></td><td>{shortDate(row.createdAt)}</td></tr>)}{!data.variations.length && <tr><td colSpan="5">No variation orders have been raised.</td></tr>}</tbody></table></div></section>
    </>}
    {open === 'expense' && data && <ExpenseForm projectId={Number(projectId)} items={data.items} initial={rework} close={() => {setOpen('');setRework(null);}} reload={load} />}
    {typeof open === 'number' && <DailySheetDetail id={open} close={() => setOpen('')} onCorrect={can.boq ? sheet => {setRework(sheet);setOpen('expense');} : null} />}
    {forecastItem && <ForecastForm projectId={Number(projectId)} item={forecastItem} close={() => setForecastItem(null)} reload={load} />}
  </div>;
}

function ExpenseForm({ projectId, items, initial, close, reload }) {
  const [options, setOptions] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [lines, setLines] = useState(initial?.lines?.map(line => ({source:line.source,costType:line.cost_type,
    taskId:line.task_id,boqItemId:line.boq_item_id || '',description:line.description,quantity:line.quantity || '',
    unit:line.unit || '',unitRate:line.unit_rate ?? '',amount:line.amount,employeeId:line.employee_id || '',
    vehicleId:line.vehicle_id || '',fuelOrigin:line.fuel_origin || '',fuelRecordId:line.fuel_record_id || '',
    fuelFloatId:line.fuel_float_id || '',odometer:line.odometer || '',stationMode:line.fuel_record_id?'Existing':'New',
    reserveMaterialId:line.reserve_material_id || '',quotationItemId:line.quotation_item_id || '',
    quotedRecovery:line.quoted_recovery || '',reference:line.reference || '' })) ||
    [{ source:'Material', costType:'Expected', taskId:'', description:'', amount:'' }]);
  useEffect(() => { api(`/boq/cost-control/options?projectId=${projectId}`).then(setOptions).catch(error => setLoadError(error.message)); }, [projectId]);
  const update = (index, changes) => setLines(previous => previous.map((line, at) => at === index ? { ...line, ...changes } : line));
  const id = value => value ? Number(value) : null;
  return <FormModal title="Submit daily project costs" close={close} label="Send to Finance for review" wide onSubmit={async values => {
    if (!options) throw new Error(loadError || 'Wait for the project work and cost options to load.');
    if (!options.tasks.length) throw new Error('Add the work tasks on the Tasks page before submitting project costs.');
    await post('/boq/cost-control/daily-sheets', { projectId, workDate:values.workDate, notes:values.notes || null,
      lines: lines.map(line => ({ taskId:Number(line.taskId), boqItemId:id(line.boqItemId), source:line.source,
        costType:line.costType, description:line.description.trim(), quantity:line.quantity ? Number(line.quantity) : null,
        unit:line.unit || null, unitRate:line.unitRate === '' || line.unitRate == null ? null : Number(line.unitRate),
        amount:Number(line.amount), employeeId:id(line.employeeId), vehicleId:id(line.vehicleId),
        fuelOrigin:line.source === 'Fuel' ? line.fuelOrigin || null : null,
        fuelRecordId:id(line.fuelRecordId), fuelFloatId:id(line.fuelFloatId),odometer:id(line.odometer),
        reserveMaterialId:id(line.reserveMaterialId),
        quotationItemId:id(line.quotationItemId), quotedRecovery:Number(line.quotedRecovery || 0),
        reference:line.reference || null })) }); await reload();
  }}>
    <p className="form-note wide">Use one line per cost and select the work task it belongs to. Finance will verify the sheet before new costs are posted. Fleet-recorded station fuel is linked, not charged again. For a new station purchase, Finance will deduct the approved amount from the selected fuel float.</p>
    {loadError && <p className="form-error wide">{loadError}</p>}
    <Field name="workDate" label="Work date" type="date" defaultValue={initial?.work_date || todayInput()} />
    <Field name="notes" label="Daily notes" required={false} defaultValue={initial?.notes || ''} />
    <div className="daily-cost-editor wide">{lines.map((line, index) => <div className="daily-cost-line" key={index}>
      <div className="daily-cost-line-title"><strong>Cost line {index + 1}</strong>{lines.length > 1 && <button type="button" className="status-button" onClick={() => setLines(old => old.filter((_, at) => at !== index))}><Trash2 size={14} /> Remove</button>}</div>
      <label>Work task *<select value={line.taskId} required onChange={event => update(index,{taskId:event.target.value})}><option value="">Choose a completed task…</option>{options?.tasks.filter(task => task.status === 'Completed').map(task => <option key={task.id} value={task.id}>{task.title} · {task.status}</option>)}</select></label>
      {options && !options.tasks.some(task => task.status === 'Completed') && <p className="form-note">No completed tasks are available for this project. Mark the finished work as Completed in Tasks before recording its daily cost.</p>}
      <label>Category *<select value={line.source} onChange={event => update(index,{source:event.target.value,employeeId:'',vehicleId:'',fuelOrigin:'',fuelRecordId:'',fuelFloatId:'',odometer:'',reserveMaterialId:'',amount:''})}>{SOURCES.map(source => <option key={source}>{source}</option>)}</select></label>
      <label>Cost classification<select value={line.costType} onChange={event => update(index,{costType:event.target.value,boqItemId:'',quotationItemId:'',quotedRecovery:''})}>{['Expected','Variation','Unexpected'].map(type => <option key={type}>{type}</option>)}</select></label>
      <label>What was used or paid for *<input value={line.description} required minLength={2} onChange={event => update(index,{description:event.target.value})} /></label>
      {line.source === 'Labour' && <label>Labourer and day salary *<select value={line.employeeId || ''} required onChange={event => { const employee=options.employees.find(person => String(person.id) === event.target.value); update(index,{employeeId:event.target.value,amount:employee?.dailyRate || ''}); }}><option value="">Choose employee…</option>{options?.employees.filter(person => number(person.dailyRate)>0).map(person => <option key={person.id} value={person.id}>{person.name} · {rupees(person.dailyRate)} per day</option>)}</select></label>}
      {line.source === 'Fuel' && <><label>Fuel source *<select required value={line.fuelOrigin || ''} onChange={event => update(index,{fuelOrigin:event.target.value,fuelRecordId:'',fuelFloatId:'',reserveMaterialId:'',amount:'',quantity:'',vehicleId:''})}><option value="">Choose source…</option><option>Station</option><option>Reserve</option></select></label>
        {line.fuelOrigin === 'Station' && <><label>Station record<select value={line.stationMode || 'New'} onChange={event => update(index,{stationMode:event.target.value,fuelRecordId:'',fuelFloatId:'',vehicleId:'',amount:'',quantity:'',odometer:''})}><option value="New">New purchase — Finance will post it</option><option value="Existing">Already recorded in Fleet</option></select></label>
          {line.stationMode === 'Existing' ? <label>Fleet fuel record *<select required value={line.fuelRecordId || ''} onChange={event => { const fuel=options.fuel.find(item => String(item.id) === event.target.value); update(index,{fuelRecordId:event.target.value,vehicleId:fuel?.vehicleId || '',quantity:fuel?.litres || '',unit:'litres',amount:fuel?.cost || ''}); }}><option value="">Choose recorded fuel…</option>{options?.fuel.map(fuel => <option key={fuel.id} value={fuel.id}>{shortDate(fuel.fuelDate)} · {fuel.registration} · {fuel.litres} L · {rupees(fuel.cost)}</option>)}</select></label> : <><label>Vehicle *<select required value={line.vehicleId || ''} onChange={event => update(index,{vehicleId:event.target.value})}><option value="">Choose vehicle…</option>{options?.vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicle} · {vehicle.registration}</option>)}</select></label><label>Fuel float *<select required value={line.fuelFloatId || ''} onChange={event => update(index,{fuelFloatId:event.target.value})}><option value="">Choose funded fuel float…</option>{options?.fuelFloats.map(floating => <option key={floating.id} value={floating.id}>{floating.name} · {rupees(floating.balance)} available</option>)}</select></label>{options && !options.fuelFloats.length && <p className="form-note">Finance must create and top up a Fuel petty-cash float before QS can submit a new station purchase.</p>}<label>Vehicle odometer (km) *<input required type="number" min="1" step="1" value={line.odometer || ''} onChange={event => update(index,{odometer:event.target.value})} /></label></>}
        </>}
        {line.fuelOrigin === 'Reserve' && <><label>Vehicle *<select required value={line.vehicleId || ''} onChange={event => update(index,{vehicleId:event.target.value})}><option value="">Choose vehicle…</option>{options?.vehicles.map(vehicle => <option key={vehicle.id} value={vehicle.id}>{vehicle.vehicle} · {vehicle.registration}</option>)}</select></label><label>Fuel reserve item *<select required value={line.reserveMaterialId || ''} onChange={event => { const material=options.reserves.find(item => String(item.id) === event.target.value); update(index,{reserveMaterialId:event.target.value,unit:'litres',unitRate:material?.unitCost || 0,amount:line.quantity ? Number((number(line.quantity)*number(material?.unitCost)).toFixed(2)) : ''}); }}><option value="">Choose stocked fuel…</option>{options?.reserves.map(material => <option key={material.id} value={material.id}>{material.name} · {material.stock} {material.unit} available · {rupees(material.unitCost)}/L</option>)}</select></label></>}
      </>}
      {line.costType !== 'Unexpected' && <label>BOQ item (optional)<select value={line.boqItemId || ''} onChange={event => update(index,{boqItemId:event.target.value})}><option value="">No BOQ item</option>{items.map(item => <option value={item.id} key={item.id}>{item.boqReference} · {item.description}</option>)}</select></label>}
      {line.source !== 'Labour' && !(line.fuelOrigin === 'Station' && line.stationMode === 'Existing') && <><label>{line.source==='Fuel'?'Litres *':'Quantity'}<input type="number" required={line.source==='Fuel'} min="0.001" step="0.001" value={line.quantity || ''} onChange={event => { const quantity=event.target.value; update(index,{quantity,amount:line.source === 'Fuel' && line.fuelOrigin === 'Reserve' ? Number((number(quantity)*number(line.unitRate)).toFixed(2)) : line.amount}); }} /></label><label>Unit<input value={line.unit || ''} onChange={event => update(index,{unit:event.target.value})} placeholder="m³, kg, day" /></label><label>Unit rate (LKR)<input type="number" min="0" step="0.01" value={line.unitRate ?? ''} readOnly={line.source==='Fuel'&&line.fuelOrigin==='Reserve'} onChange={event => { const unitRate=event.target.value; update(index,{unitRate,amount:line.source === 'Fuel' && line.fuelOrigin === 'Reserve' ? Number((number(line.quantity)*number(unitRate)).toFixed(2)) : line.amount}); }} /></label></>}
      <label>Cost (LKR) *<input type="number" required min="0.01" step="0.01" value={line.amount} readOnly={line.source === 'Labour' || (line.source === 'Fuel' && (line.fuelOrigin === 'Reserve' || line.stationMode === 'Existing'))} onChange={event => update(index,{amount:event.target.value})} /></label>
      <label>Receipt / reference<input value={line.reference || ''} onChange={event => update(index,{reference:event.target.value})} /></label>
      {line.costType !== 'Unexpected' && <><label>Accepted quotation item<select value={line.quotationItemId || ''} onChange={event => update(index,{quotationItemId:event.target.value,quotedRecovery:''})}><option value="">No quoted recovery assigned</option>{options?.quotationItems.map(item => <option key={item.id} value={item.id}>{item.reference} · {item.description} · {rupees(item.amount)}</option>)}</select></label>{line.quotationItemId && <label>Quoted recovery allocated to this day (LKR)<input type="number" min="0" step="0.01" value={line.quotedRecovery || ''} onChange={event => update(index,{quotedRecovery:event.target.value})} /></label>}</>}
    </div>)}<button className="secondary" type="button" onClick={() => setLines(old => [...old,{source:'Material',costType:'Expected',taskId:'',description:'',amount:''}])}><Plus size={14} /> Add cost line</button></div>
  </FormModal>;
}

export function DailySheetDetail({ id, close, review = false, reload, onCorrect }) {
  const [sheet,setSheet]=useState(null),[error,setError]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false);
  useEffect(() => { api(`/boq/cost-control/daily-sheets/${id}`).then(setSheet).catch(e => setError(e.message)); }, [id]);
  const decide = async decision => { setBusy(true);setError('');try { await post(`/boq/cost-control/daily-sheets/${id}/review`,{decision,note}); await reload?.(); close(); } catch(e) {setError(e.message);} finally {setBusy(false);} };
  return <div className="modal-backdrop" role="presentation" onMouseDown={event => { if(event.target===event.currentTarget) close(); }}><div className="modal wide" role="dialog" aria-modal="true" aria-label="Daily cost sheet"><div className="modal-header"><h2>Daily costs · {sheet ? shortDate(sheet.work_date) : 'Loading'}</h2><button type="button" className="modal-close" onClick={close}>×</button></div><div className="modal-body">
    {error && <p className="form-error">{error}</p>}{sheet && <><p className="form-note">{sheet.project} · submitted by {sheet.submittedBy} · {sheet.status}{sheet.notes ? ` · ${sheet.notes}` : ''}</p>
      <div className="cost-table-scroll"><table><thead><tr><th>Work task</th><th>Category</th><th>Item</th><th>Source / person</th><th>Quantity</th><th>Cost</th><th>Quoted recovery</th></tr></thead><tbody>{sheet.lines.map(line => <tr key={line.id}><td>{line.work}</td><td>{line.source}<small>{line.cost_type}</small></td><td>{line.description}<small>{line.quotationItem || line.reference || ''}</small></td><td>{line.employee || line.registration || line.reserveMaterial || '—'}<small>{line.fuel_origin || ''}{line.fuelFloat ? ` · ${line.fuelFloat}` : ''}{line.odometer ? ` · ${line.odometer} km` : ''}</small></td><td>{line.quantity ? `${line.quantity} ${line.unit || ''}` : '—'}</td><td>{rupees(line.amount)}</td><td>{rupees(line.quoted_recovery)}</td></tr>)}</tbody></table></div>
      {sheet.review_note && <p className="form-note">Finance note: {sheet.review_note}</p>}
      {onCorrect && sheet.status === 'Returned' && <div className="modal-actions"><button type="button" className="primary" onClick={()=>onCorrect(sheet)}>Correct and resubmit</button></div>}
      {review && sheet.status === 'Submitted' && <><label className="wide">Review note (required when returning)<textarea value={note} onChange={event => setNote(event.target.value)} /></label><div className="modal-actions"><button className="secondary" type="button" disabled={busy || !note.trim()} onClick={() => decide('Returned')}>Return to QS</button><button className="primary" type="button" disabled={busy} onClick={() => decide('Approved')}>Approve and post costs</button></div></>}
    </>}
  </div></div></div>;
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
