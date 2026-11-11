import React,{useEffect,useState} from 'react';
import {Download} from 'lucide-react';
import {api,patch,post,rupees,shortDate,slug,todayInput} from '../api.js';
import {Summary,Table,Row,Badge,FormModal,Field,SelectField,TextArea,useLiveList} from '../ui.jsx';

const RETENTION_TEMPLATE = 'minmax(180px,1.4fr) minmax(140px,1fr) 130px 130px 130px 120px';

export default function Retention({ can, companyId, data }) {
  const [adding,setAdding]=useState(false);
  const [rows, setRows] = useState([]);
  const [editingRemark, setEditingRemark] = useState(null);
  const [releasing, setReleasing] = useState(null);
  const load = () => api(`/qs/retentions?companyId=${companyId}`).then(setRows).catch(() => setRows([]));
  useLiveList(load);
  useEffect(()=>{load();},[companyId]);
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get('record')); if (id && rows.some(row => Number(row.id) === id)) document.getElementById(`retention-${id}`)?.scrollIntoView({ block: 'center' }); }, [rows]);
  const held = rows.reduce((sum, row) => sum + (Number(row.amount) - Number(row.releasedAmount)), 0);

  return <>
    <div className="attendance-summary">
      <Summary label="Still held" value={rupees(held)} icon={Download} />
      <Summary label="Retentions" value={rows.length} icon={Download} />
      <Summary label="Due in 30 days" value={rows.filter(row =>
        row.status !== 'Released' && (new Date(row.releaseDate) - new Date()) / 86400000 <= 30).length} icon={Download} />
      <Summary label="Released" value={rows.filter(row => row.status === 'Released').length} icon={Download} />
    </div>
    <Table columns={['Retention', 'Project', 'Held', 'Release date', 'Status', '']} template={RETENTION_TEMPLATE}
      title="Retention held against projects" empty="No retention recorded."
      tools={can.retention ? <button type="button" className="secondary" onClick={()=>setAdding(true)}>Record retention</button> : null}>
      {rows.map(row => <Row template={RETENTION_TEMPLATE} key={row.id} id={`retention-${row.id}`} className={Number(new URLSearchParams(window.location.search).get('record')) === Number(row.id) ? 'linked-record' : ''}>
        <div><strong>{row.description}</strong><small>{row.percent}%</small>{row.notes && <small style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{row.notes}</small>}</div>
        <span>{row.project}</span>
        <strong>{rupees(Number(row.amount) - Number(row.releasedAmount))}</strong>
        <span className={row.status !== 'Released' && new Date(row.releaseDate) < new Date() ? 'overdue' : ''}>
          {shortDate(row.releaseDate)}
        </span>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        {can.retention ? <div className="row-actions">
          <button type="button" className="secondary" onClick={() => setEditingRemark(row)}>{row.notes ? 'Edit remark' : 'Add remark'}</button>
          {row.status !== 'Released' && <button type="button" className="status-button" onClick={() => setReleasing(row)}>Release</button>}
        </div> : <span>—</span>}
      </Row>)}
    </Table>
    {adding && <RetentionForm data={data} companyId={companyId} close={()=>setAdding(false)} reload={load} />}
    {editingRemark && <FormModal title="Retention remark" close={() => setEditingRemark(null)} label="Save remark"
      onSubmit={async values => {
        await patch(`/qs/retentions/${editingRemark.id}/remark`, { notes: values.notes });
        await load();
      }}>
      <p className="wide">{editingRemark.description} · {editingRemark.project}</p>
      <TextArea name="notes" label="Remark" required={false} defaultValue={editingRemark.notes || ''} />
    </FormModal>}
    {releasing && <ReleaseForm retention={releasing} close={() => setReleasing(null)} reload={load} />}
  </>;
}

function RetentionForm({ data, companyId, close, reload }) {
  return <FormModal title="Record retention" close={close} label="Record retention" onSubmit={async values => {
    await post('/qs/retentions', {
      projectId: Number(values.projectId),
      description: values.description,
      amount: Number(values.amount),
      percent: Number(values.percent || 0),
      heldFrom: values.heldFrom,
      releaseDate: values.releaseDate,
      defectLiabilityEnds: values.defectLiabilityEnds || undefined,
      notes: values.notes || undefined
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.filter(project=>Number(project.companyId??project.company_id)===Number(companyId)).map(project => [project.id, project.name])} />
    <Field name="description" label="Description" />
    <Field name="amount" label="Amount held (LKR)" type="number" step="any" min="0" />
    <Field name="percent" label="Percent" type="number" step="0.01" min="0" defaultValue="5" required={false} />
    <Field name="heldFrom" label="Held from" type="date" defaultValue={todayInput()} />
    <Field name="releaseDate" label="Release date" type="date" />
    <Field name="defectLiabilityEnds" label="Defect liability ends" type="date" required={false} />
    <TextArea name="notes" label="Remark" required={false} placeholder="Optional" />
  </FormModal>;
}

function ReleaseForm({ retention, close, reload }) {
  const outstanding = Number(retention.amount) - Number(retention.releasedAmount);
  return <FormModal title={`Release retention — ${retention.project}`} close={close} label="Record release"
    onSubmit={async values => {
      await post(`/qs/retentions/${retention.id}/release`, { amount: Number(values.amount), notes: values.notes || undefined });
      await reload();
    }}>
    <Field name="amount" label={`Amount (outstanding ${rupees(outstanding)})`} type="number" step="any" min="0"
      defaultValue={outstanding} />
    <TextArea name="notes" label="Update remark" required={false} placeholder="Leave blank to keep the current remark" />
  </FormModal>;
}

