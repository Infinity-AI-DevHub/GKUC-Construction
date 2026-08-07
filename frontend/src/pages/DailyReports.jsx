import React, { useState } from 'react';
import { AlertTriangle, ChevronRight, HardHat, Users } from 'lucide-react';
import { api, post, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Modal, Page, Row, SelectField, Table, TextArea } from '../ui.jsx';
import Attachments from '../Attachments.jsx';

/** PID 2.11 — the structured daily site record that replaces paper logs and phone updates. */
export default function DailyReports({ data, reload, can }) {
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);

  return <Page title="Daily site reports" subtitle="Capture workforce, completed work, materials, delays, and site evidence."
    action={can.site ? 'New report' : null} onAction={() => setCreating(true)}>
    <div className="report-list">
      {data.reports.map(report => <article className="report-row" key={report.id} onClick={async () => setDetail(await api(`/reports/${report.id}`))}>
        <div className="report-date">
          <b>{report.date.split(' ')[0]}</b>
          <span>{report.date.split(' ')[1]}</span>
        </div>
        <div className="report-body">
          <div><h3>{report.site}</h3><p>{report.work}</p></div>
          <div className="report-tags">
            <span><Users size={15} />{report.workforce} workforce</span>
            <span><HardHat size={15} />{report.supervisor}</span>
          </div>
          <div className="issue">
            <AlertTriangle size={16} />
            <span>{report.issue || (report.delayHours > 0 ? `${report.delayHours}h delay recorded` : 'No issues reported')}</span>
          </div>
        </div>
        <ChevronRight size={19} />
      </article>)}
      {!data.reports.length && <p className="empty-state">No daily reports submitted yet.</p>}
    </div>

    {creating && <ReportForm data={data} close={() => setCreating(false)} reload={reload} />}
    {detail && <ReportDetail report={detail} close={() => setDetail(null)} can={can} />}
  </Page>;
}

function ReportDetail({ report, close, can }) {
  return <Modal title={`${report.site} — ${report.date}`} close={close}>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Supervisor</span><strong>{report.supervisor}</strong></div>
        <div><span>Workforce on site</span><strong>{report.workforce}</strong></div>
      </div>
      <div className="project-stats wide">
        <div><span>Weather</span><strong>{report.weather || '—'}</strong></div>
        <div><span>Delay recorded</span><strong>{report.delayHours || 0} h</strong></div>
      </div>
      <label className="wide">Work completed<textarea readOnly value={report.work} /></label>
      {report.issue && <label className="wide">Issues and delays<textarea readOnly value={report.issue} /></label>}

      <div className="wide">
        <Table columns={['Material used', 'Quantity']} template="minmax(200px,1fr) 160px" title="Material usage" empty="No material usage recorded.">
          {report.materials.map(row => <Row template="minmax(200px,1fr) 160px" key={row.id}>
            <strong>{row.material}</strong><span>{row.quantity} {row.unit}</span>
          </Row>)}
        </Table>
      </div>
      <div className="wide">
        <Table columns={['Employee', 'Role', 'In', 'Out', 'Status']} template="minmax(170px,1.2fr) minmax(140px,1fr) 80px 80px 110px"
          title="Labour attendance" empty="No attendance recorded for that day.">
          {report.attendance.map((row, index) => <Row template="minmax(170px,1.2fr) minmax(140px,1fr) 80px 80px 110px" key={index}>
            <strong>{row.name}</strong><span>{row.role}</span>
            <span>{row.in || '—'}</span><span>{row.out || '—'}</span>
            <Badge tone={slug(row.state)}>{row.state}</Badge>
          </Row>)}
        </Table>
      </div>
      <div className="wide">
        <Attachments ownerType="report" ownerId={report.id} title="Site photos" canUpload={can.site} canDelete={can.projects} />
      </div>
      {report.equipment.length > 0 && <div className="wide">
        <Table columns={['Equipment used', 'Hours']} template="minmax(200px,1fr) 160px" title="Equipment usage">
          {report.equipment.map(row => <Row template="minmax(200px,1fr) 160px" key={row.id}>
            <strong>{row.equipment}</strong><span>{row.hours} h</span>
          </Row>)}
        </Table>
      </div>}
      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>
  </Modal>;
}

function ReportForm({ data, close, reload }) {
  const [usage, setUsage] = useState([]);
  const [plant, setPlant] = useState([]);
  const addUsage = () => setUsage(current => [...current, { materialId: data.materials[0]?.id || '', quantity: '' }]);
  const update = (index, key, value) => setUsage(current => current.map((row, position) => (position === index ? { ...row, [key]: value } : row)));
  const addPlant = () => setPlant(current => [...current, { equipmentId: data.equipment[0]?.id || '', hours: '' }]);
  const updatePlant = (index, key, value) => setPlant(current => current.map((row, position) => (position === index ? { ...row, [key]: value } : row)));

  return <FormModal title="New daily site report" close={close} label="Submit report" onSubmit={async values => {
    await post('/reports', {
      projectId: Number(values.projectId),
      reportDate: values.reportDate,
      workforce: Number(values.workforce),
      work: values.work,
      issue: values.issue || undefined,
      weather: values.weather || undefined,
      delayHours: Number(values.delayHours || 0),
      materials: usage.filter(row => row.materialId && row.quantity)
        .map(row => ({ materialId: Number(row.materialId), quantity: Number(row.quantity) })),
      equipment: plant.filter(row => row.equipmentId && row.hours !== '')
        .map(row => ({ equipmentId: Number(row.equipmentId), hours: Number(row.hours) }))
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project / site" options={data.projects.map(project => [project.id, project.name])} />
    <Field name="reportDate" label="Report date" type="date" defaultValue={todayInput()} />
    <Field name="workforce" label="Workforce on site" type="number" min="0" placeholder="e.g. 24" />
    <SelectField name="weather" label="Weather" options={['Clear', 'Cloudy', 'Light rain', 'Heavy rain', 'Windy']} />
    <Field name="delayHours" label="Delay hours" type="number" step="0.5" min="0" defaultValue="0" required={false} />
    <TextArea name="work" label="Work completed" placeholder="Summarise today's completed work" />
    <TextArea name="issue" label="Delays or issues" required={false} placeholder="Optional — reported to management immediately" />

    {usage.map((row, index) => <div className="wide" key={index} style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: '8px' }}>
      <label>Material used
        <select value={row.materialId} onChange={event => update(index, 'materialId', event.target.value)}>
          {data.materials.map(material => <option value={material.id} key={material.id}>{material.name}</option>)}
        </select>
      </label>
      <label>Quantity<input type="number" step="any" min="0" value={row.quantity} onChange={event => update(index, 'quantity', event.target.value)} /></label>
    </div>)}
    {plant.map((row, index) => <div className="wide" key={`plant-${index}`} style={{ display: 'grid', gridTemplateColumns: '1fr 140px', gap: '8px' }}>
      <label>Equipment used
        <select value={row.equipmentId} onChange={event => updatePlant(index, 'equipmentId', event.target.value)}>
          {data.equipment.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>Hours<input type="number" step="0.5" min="0" value={row.hours} onChange={event => updatePlant(index, 'hours', event.target.value)} /></label>
    </div>)}
    <div className="wide" style={{ display: 'flex', gap: '8px' }}>
      <button type="button" className="secondary" onClick={addUsage}>Add material usage</button>
      <button type="button" className="secondary" onClick={addPlant}>Add equipment usage</button>
    </div>
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      Site photos can be attached from the report once it is submitted.
    </p>
  </FormModal>;
}
