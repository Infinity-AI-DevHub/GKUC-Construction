import React, { useEffect, useState } from 'react';
import { AlertTriangle, QrCode, Truck, Wrench } from 'lucide-react';
import { api, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Modal, Page, Row, SelectField, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';
import { toSvg } from '../qr.js';

const TABS = ['Vehicles', 'Compliance', 'Fuel & service', 'Equipment'];

/** Renders a QR label as inline SVG — no image request, so it prints cleanly. */
function QrCodeImage({ value }) {
  const { path, total } = toSvg(value, { scale: 4, quiet: 3 });
  return <svg className="qr-code" viewBox={`0 0 ${total} ${total}`} width="132" height="132" role="img" aria-label="Asset QR code">
    <rect width={total} height={total} fill="white" />
    <path d={path} fill="#111815" />
  </svg>;
}
const DOC_TYPES = ['Insurance', 'Revenue licence', 'Emission test', 'Service', 'Fitness certificate'];

/** PID 2.8 and 2.9 — vehicles with their compliance dates, and equipment with its whereabouts. */
export default function Fleet({ data, reload, can }) {
  const [tab, setTab] = useState(TABS[0]);
  const [open, setOpen] = useState('');

  const actions = {
    Vehicles: can.transport && 'Add asset',
    Compliance: can.transport && 'Record renewal',
    'Fuel & service': can.transport && 'Record fuel',
    Equipment: can.projects && 'Add equipment'
  };

  return <Page title="Fleet & equipment" subtitle="Keep vehicles available, assigned, maintained, and compliant."
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={TABS} active={tab} onChange={setTab} />

    {tab === 'Vehicles' && <Vehicles data={data} can={can} />}
    {tab === 'Compliance' && <Compliance />}
    {tab === 'Fuel & service' && <FuelAndService data={data} />}
    {tab === 'Equipment' && <Equipment data={data} reload={reload} can={can} />}

    {open === 'Vehicles' && <VehicleForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Compliance' && <DocumentForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Fuel & service' && <FuelForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Equipment' && <EquipmentForm close={() => setOpen('')} reload={reload} />}
  </Page>;
}

function Vehicles({ data, can }) {
  const [detail, setDetail] = useState(null);
  return <>
    <div className="fleet-grid">
      {data.fleet.map(vehicle => <article className="fleet-card" key={vehicle.id} onClick={async () => setDetail(await api(`/fleet/${vehicle.id}`))}>
        <div className="fleet-visual"><Truck size={34} /><Badge tone={slug(vehicle.status)}>{vehicle.status}</Badge></div>
        <h3>{vehicle.vehicle}</h3>
        <p>{vehicle.reg}</p>
        <dl>
          <div><dt>Assigned driver</dt><dd>{vehicle.driver || 'Unassigned'}</dd></div>
          <div><dt>Assigned site</dt><dd>{vehicle.project || 'Yard'}</dd></div>
          <div><dt>{vehicle.renewal}</dt><dd className={vehicle.due.includes('Overdue') ? 'overdue' : ''}>{vehicle.due}</dd></div>
          {vehicle.service && <div><dt>Next service</dt><dd className={vehicle.service.overdue ? 'overdue' : ''}>
            {vehicle.service.kmRemaining !== null
              ? `${Math.abs(vehicle.service.kmRemaining)} km ${vehicle.service.kmRemaining <= 0 ? 'overdue' : 'left'}`
              : shortDate(vehicle.service.dueDate)}
          </dd></div>}
        </dl>
      </article>)}
    </div>
    {detail && <VehicleDetail vehicle={detail} close={() => setDetail(null)} can={can}
      refresh={async () => setDetail(await api(`/fleet/${detail.id}`))} />}
  </>;
}

function VehicleDetail({ vehicle, close, can, refresh }) {
  const [logging, setLogging] = useState(false);
  return <Modal title={`${vehicle.vehicle} — ${vehicle.reg}`} close={close}>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Fuel cost to date</span><strong>{rupees(vehicle.running.fuelCost)}</strong></div>
        <div><span>Maintenance cost</span><strong>{rupees(vehicle.running.maintenanceCost)}</strong></div>
      </div>
      <div className="project-stats wide">
        <div><span>Driver</span><strong>{vehicle.driverName || vehicle.driver || 'Unassigned'}</strong></div>
        <div><span>Odometer</span><strong>{Number(vehicle.odometer).toLocaleString('en-LK')} km</strong></div>
      </div>
      {vehicle.service && <div className="project-stats wide">
        <div><span>Next service</span><strong className={vehicle.service.overdue ? 'overdue' : ''}>
          {vehicle.service.kmRemaining !== null
            ? `${Math.abs(vehicle.service.kmRemaining)} km ${vehicle.service.kmRemaining <= 0 ? 'overdue' : 'remaining'}`
            : shortDate(vehicle.service.dueDate)}
        </strong></div>
        <div><span>Last serviced</span><strong>{shortDate(vehicle.lastServiceDate)}</strong></div>
      </div>}
      <div className="wide">
        <Table columns={['Document', 'Reference', 'Expiry', 'Status']} template="150px minmax(140px,1fr) 130px 140px"
          title="Compliance" empty="No documents tracked.">
          {vehicle.documents.map(document => <Row template="150px minmax(140px,1fr) 130px 140px" key={document.id}>
            <strong>{document.docType}</strong>
            <span>{document.reference || '—'}</span>
            <span>{shortDate(document.expiryDate)}</span>
            <span className={document.due.includes('Overdue') ? 'overdue' : ''}>{document.due}</span>
          </Row>)}
        </Table>
      </div>
      <div className="wide">
        <Table columns={['Date', 'Litres', 'Cost', 'Odometer', 'Project']} template="130px 90px 120px 110px minmax(140px,1fr)"
          title="Fuel records" empty="No fuel recorded.">
          {vehicle.fuel.map(row => <Row template="130px 90px 120px 110px minmax(140px,1fr)" key={row.id}>
            <span>{shortDate(row.fuelDate)}</span><span>{row.litres}</span><span>{rupees(row.cost)}</span>
            <span>{row.odometer}</span><span>{row.project || '—'}</span>
          </Row>)}
        </Table>
      </div>
      <div className="wide">
        <Table columns={['Date', 'Work done', 'Garage', 'Cost']} template="130px minmax(200px,2fr) minmax(140px,1fr) 120px"
          title="Maintenance history"
          tools={can?.transport ? <button className="secondary" onClick={() => setLogging(true)}><Wrench size={14} /> Log service</button> : null}
          empty="No maintenance recorded.">
          {vehicle.maintenance.map(row => <Row template="130px minmax(200px,2fr) minmax(140px,1fr) 120px" key={row.id}>
            <span>{shortDate(row.serviceDate)}</span><span>{row.description}</span>
            <span>{row.garage || '—'}</span><span>{rupees(row.cost)}</span>
          </Row>)}
        </Table>
      </div>
      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>
    {logging && <MaintenanceForm vehicle={vehicle} close={() => setLogging(false)} reload={refresh} />}
  </Modal>;
}

/** Logging a service also resets the vehicle's service schedule from that date and odometer. */
function MaintenanceForm({ vehicle, close, reload }) {
  return <FormModal title={`Log service — ${vehicle.reg}`} close={close} label="Save service" onSubmit={async values => {
    await post(`/fleet/${vehicle.id}/maintenance`, {
      serviceDate: values.serviceDate,
      description: values.description,
      cost: Number(values.cost || 0),
      garage: values.garage || undefined,
      odometer: Number(values.odometer || 0)
    });
    await reload();
  }}>
    <Field name="serviceDate" label="Service date" type="date" defaultValue={todayInput()} />
    <Field name="odometer" label="Odometer reading" type="number" min="0" defaultValue={vehicle.odometer} />
    <Field name="cost" label="Cost (LKR)" type="number" step="any" min="0" defaultValue="0" required={false} />
    <Field name="garage" label="Garage" required={false} />
    <TextArea name="description" label="Work carried out" />
  </FormModal>;
}

const COMPLIANCE_COLUMNS = ['Vehicle', 'Document', 'Reference', 'Expiry date', 'Status'];
const COMPLIANCE_TEMPLATE = 'minmax(180px,1.3fr) 160px minmax(140px,1fr) 130px 150px';

/** The renewals that most commonly get missed, listed soonest-first. */
function Compliance() {
  const [rows, setRows] = useState([]);
  useLiveList(() => api('/fleet/documents/expiring?days=120').then(setRows).catch(() => setRows([])));
  return <Table columns={COMPLIANCE_COLUMNS} template={COMPLIANCE_TEMPLATE} title="Renewals due"
    empty="Nothing expiring in the next 120 days.">
    {rows.map(row => <Row template={COMPLIANCE_TEMPLATE} key={row.id}>
      <div><strong>{row.vehicle}</strong><small>{row.registration}</small></div>
      <span>{row.docType}</span>
      <span>{row.reference || '—'}</span>
      <span>{shortDate(row.expiryDate)}</span>
      <span className={row.due.includes('Overdue') ? 'overdue' : ''}>
        {row.due.includes('Overdue') && <AlertTriangle size={13} />} {row.due}
      </span>
    </Row>)}
  </Table>;
}

function FuelAndService({ data }) {
  const [rows, setRows] = useState([]);
  const template = 'minmax(180px,1.3fr) 120px 110px 130px 110px minmax(140px,1fr)';
  useEffect(() => {
    Promise.all(data.fleet.map(vehicle => api(`/fleet/${vehicle.id}`)))
      .then(vehicles => setRows(vehicles.flatMap(vehicle => vehicle.fuel.map(record => ({ ...record, vehicle: vehicle.vehicle, reg: vehicle.reg })))))
      .catch(() => setRows([]));
  }, [data.fleet]);

  return <Table columns={['Vehicle', 'Date', 'Litres', 'Cost', 'Odometer', 'Project']} template={template}
    title="Fuel records" empty="No fuel recorded yet.">
    {rows.map(row => <Row template={template} key={row.id}>
      <div><strong>{row.vehicle}</strong><small>{row.reg}</small></div>
      <span>{shortDate(row.fuelDate)}</span>
      <span>{row.litres}</span>
      <span>{rupees(row.cost)}</span>
      <span>{row.odometer}</span>
      <span>{row.project || '—'}</span>
    </Row>)}
  </Table>;
}

const EQUIPMENT_COLUMNS = ['Code', 'Equipment', 'Category', 'Assigned to', 'Status', ''];
const EQUIPMENT_TEMPLATE = '110px minmax(180px,1.3fr) minmax(140px,1fr) minmax(160px,1.1fr) 120px 210px';

function Equipment({ data, reload, can }) {
  const [acting, setActing] = useState(null);
  const [detail, setDetail] = useState(null);
  return <>
    <Table columns={EQUIPMENT_COLUMNS} template={EQUIPMENT_TEMPLATE} title="Equipment register" empty="No equipment recorded.">
      {data.equipment.map(item => <Row template={EQUIPMENT_TEMPLATE} key={item.id}>
        <strong>{item.code}</strong>
        <span>{item.name}</span>
        <span>{item.category}</span>
        <span>{item.project ? `${item.project}` : '—'}</span>
        <Badge tone={slug(item.status)}>{item.status}</Badge>
        <span className="row-actions">
          <button className="status-button" onClick={async () => setDetail(await api(`/equipment/${item.id}`))}>Open</button>
          {can.site && <button className="status-button" onClick={() => setActing(item)}>
            {item.status === 'Assigned' ? 'Return' : 'Assign'}
          </button>}
        </span>
      </Row>)}
    </Table>
    {acting && (acting.status === 'Assigned'
      ? <ReturnForm item={acting} close={() => setActing(null)} reload={reload} />
      : <AssignForm item={acting} data={data} close={() => setActing(null)} reload={reload} />)}
    {detail && <EquipmentDetail item={detail} can={can} close={() => setDetail(null)}
      refresh={async () => { setDetail(await api(`/equipment/${detail.id}`)); await reload(); }} />}
  </>;
}

/** Assignment history, maintenance record, and the printable QR label (PID 2.9). */
function EquipmentDetail({ item, close, refresh, can }) {
  const [servicing, setServicing] = useState(false);
  const assignTemplate = 'minmax(150px,1.2fr) minmax(140px,1fr) 120px 120px';
  const maintTemplate = '130px 120px minmax(180px,1.6fr) 120px';

  const issueQr = async () => { await post(`/equipment/${item.id}/qr`); await refresh(); };

  return <Modal title={`${item.code} — ${item.name}`} close={close}>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Category</span><strong>{item.category}</strong></div>
        <div><span>Status</span><strong>{item.status}</strong></div>
      </div>
      <div className="project-stats wide">
        <div><span>Currently with</span><strong>{item.holder || 'In store'}</strong></div>
        <div><span>Purchase cost</span><strong>{rupees(item.purchaseCost)}</strong></div>
      </div>

      <div className="wide qr-panel">
        <div>
          <strong>QR label</strong>
          <small>{item.qrToken ? 'Print this label and fix it to the asset. Scanning it opens this record.' : 'No label issued yet.'}</small>
          {item.qrToken && <code>{`${window.location.origin}/scan/${item.qrToken}`}</code>}
        </div>
        {item.qrToken && <QrCodeImage value={`${window.location.origin}/scan/${item.qrToken}`} />}
        {can.projects && <button type="button" className="secondary" onClick={issueQr}>
          <QrCode size={15} />{item.qrToken ? 'Reissue label' : 'Issue label'}
        </button>}
      </div>

      <div className="wide">
        <Table columns={['Project', 'Held by', 'From', 'Returned']} template={assignTemplate}
          title="Assignment history" empty="Never assigned.">
          {item.assignments.map(row => <Row template={assignTemplate} key={row.id}>
            <strong>{row.project}</strong>
            <span>{row.assignedTo}</span>
            <span>{shortDate(row.assignedAt)}</span>
            <span>{row.returnedAt ? shortDate(row.returnedAt) : 'Still out'}</span>
          </Row>)}
        </Table>
      </div>

      <div className="wide">
        <Table columns={['Date', 'Type', 'Notes', 'Cost']} template={maintTemplate} title="Maintenance and repairs"
          tools={can.projects ? <button className="secondary" onClick={() => setServicing(true)}><Wrench size={14} /> Log work</button> : null}
          empty="No maintenance recorded.">
          {item.maintenance.map(row => <Row template={maintTemplate} key={row.id}>
            <span>{shortDate(row.performedAt)}</span>
            <Badge tone={slug(row.maintenanceType)}>{row.maintenanceType}</Badge>
            <span>{row.notes || '—'}</span>
            <span>{rupees(row.cost)}</span>
          </Row>)}
        </Table>
      </div>

      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>
    {servicing && <EquipmentServiceForm item={item} close={() => setServicing(false)} reload={refresh} />}
  </Modal>;
}

function EquipmentServiceForm({ item, close, reload }) {
  return <FormModal title={`Log work — ${item.name}`} close={close} label="Save record" onSubmit={async values => {
    await post(`/equipment/${item.id}/maintenance`, {
      maintenanceType: values.maintenanceType,
      performedAt: values.performedAt,
      cost: Number(values.cost || 0),
      notes: values.notes || undefined,
      setStatus: values.setStatus || undefined
    });
    await reload();
  }}>
    <SelectField name="maintenanceType" label="Type" options={['Service', 'Repair', 'Inspection']} />
    <Field name="performedAt" label="Date" type="date" defaultValue={todayInput()} />
    <Field name="cost" label="Cost (LKR)" type="number" step="any" min="0" defaultValue="0" required={false} />
    <SelectField name="setStatus" label="Set status to" options={[['', 'Leave unchanged'], 'Available', 'Maintenance']} />
    <TextArea name="notes" label="What was done" required={false} placeholder="Optional" />
  </FormModal>;
}

function VehicleForm({ data, close, reload }) {
  return <FormModal title="Add fleet asset" close={close} label="Add asset" onSubmit={async values => {
    await post('/fleet', {
      vehicle: values.vehicle,
      registration: values.registration,
      driverEmployeeId: values.driverEmployeeId ? Number(values.driverEmployeeId) : undefined,
      driver: values.driverEmployeeId
        ? data.employees.find(employee => String(employee.id) === values.driverEmployeeId)?.name
        : undefined,
      status: values.status,
      renewal: values.renewal,
      dueDate: values.dueDate,
      projectId: values.projectId ? Number(values.projectId) : undefined,
      odometer: Number(values.odometer || 0),
      serviceIntervalKm: Number(values.serviceIntervalKm || 0),
      serviceIntervalMonths: Number(values.serviceIntervalMonths || 0)
    });
    await reload();
  }}>
    <Field name="vehicle" label="Vehicle / equipment" />
    <Field name="registration" label="Registration / asset ID" />
    <SelectField name="driverEmployeeId" label="Assigned driver"
      options={[['', 'Unassigned'], ...data.employees.map(employee => [employee.id, employee.name])]} />
    <SelectField name="status" label="Status" options={['Available', 'Assigned', 'Repair', 'Inactive']} />
    <SelectField name="renewal" label="Next renewal type" options={DOC_TYPES} />
    <Field name="dueDate" label="Renewal due date" type="date" defaultValue={todayInput()} />
    <SelectField name="projectId" label="Assigned site" options={[['', 'Yard'], ...data.projects.map(project => [project.id, project.name])]} />
    <Field name="odometer" label="Odometer" type="number" min="0" defaultValue="0" required={false} />
  </FormModal>;
}

function DocumentForm({ data, close, reload }) {
  return <FormModal title="Record renewal" close={close} label="Save renewal" onSubmit={async values => {
    await post(`/fleet/${values.vehicleId}/documents`, {
      docType: values.docType,
      reference: values.reference || undefined,
      expiryDate: values.expiryDate,
      cost: Number(values.cost || 0)
    });
    await reload();
  }}>
    <SelectField name="vehicleId" label="Vehicle" options={data.fleet.map(vehicle => [vehicle.id, `${vehicle.vehicle} — ${vehicle.reg}`])} />
    <SelectField name="docType" label="Document" options={DOC_TYPES} />
    <Field name="reference" label="Reference / policy number" required={false} />
    <Field name="expiryDate" label="Expires on" type="date" defaultValue={todayInput()} />
    <Field name="cost" label="Cost (LKR)" type="number" step="any" min="0" defaultValue="0" required={false} />
  </FormModal>;
}

function FuelForm({ data, close, reload }) {
  return <FormModal title="Record fuel" close={close} label="Save fuel record" onSubmit={async values => {
    await post(`/fleet/${values.vehicleId}/fuel`, {
      projectId: values.projectId ? Number(values.projectId) : undefined,
      fuelDate: values.fuelDate,
      litres: Number(values.litres),
      cost: Number(values.cost),
      odometer: Number(values.odometer || 0)
    });
    await reload();
  }}>
    <SelectField name="vehicleId" label="Vehicle" options={data.fleet.map(vehicle => [vehicle.id, `${vehicle.vehicle} — ${vehicle.reg}`])} />
    <SelectField name="projectId" label="Charge to project" options={[['', 'Not project-specific'], ...data.projects.map(project => [project.id, project.name])]} />
    <Field name="fuelDate" label="Date" type="date" defaultValue={todayInput()} />
    <Field name="litres" label="Litres" type="number" step="any" min="0" />
    <Field name="cost" label="Cost (LKR)" type="number" step="any" min="0" />
    <Field name="odometer" label="Odometer" type="number" min="0" defaultValue="0" required={false} />
  </FormModal>;
}

function EquipmentForm({ close, reload }) {
  return <FormModal title="Add equipment" close={close} label="Add equipment" onSubmit={async values => {
    await post('/equipment', {
      code: values.code,
      name: values.name,
      category: values.category,
      purchaseDate: values.purchaseDate || undefined,
      purchaseCost: Number(values.purchaseCost || 0),
      notes: values.notes || undefined
    });
    await reload();
  }}>
    <Field name="code" label="Asset code" placeholder="EQP-0006" />
    <Field name="name" label="Equipment name" />
    <Field name="category" label="Category" placeholder="Concreting, Survey, Power" />
    <Field name="purchaseDate" label="Purchase date" type="date" defaultValue={todayInput()} required={false} />
    <Field name="purchaseCost" label="Purchase cost (LKR)" type="number" step="any" min="0" defaultValue="0" required={false} />
    <TextArea name="notes" label="Notes" required={false} placeholder="Optional" />
  </FormModal>;
}

function AssignForm({ item, data, close, reload }) {
  return <FormModal title={`Assign ${item.name}`} close={close} label="Assign equipment" onSubmit={async values => {
    await post(`/equipment/${item.id}/assign`, {
      projectId: Number(values.projectId),
      assignedTo: values.assignedTo,
      assignedAt: values.assignedAt,
      conditionNote: values.conditionNote || undefined
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <SelectField name="assignedTo" label="Responsible person" options={data.employees.map(employee => [employee.name, employee.name])} />
    <Field name="assignedAt" label="Assigned from" type="date" defaultValue={todayInput()} />
    <TextArea name="conditionNote" label="Condition on issue" required={false} placeholder="Optional" />
  </FormModal>;
}

function ReturnForm({ item, close, reload }) {
  return <FormModal title={`Return ${item.name}`} close={close} label="Record return" onSubmit={async values => {
    await post(`/equipment/${item.id}/return`, {
      returnedAt: values.returnedAt,
      status: values.status,
      conditionNote: values.conditionNote || undefined
    });
    await reload();
  }}>
    <Field name="returnedAt" label="Returned on" type="date" defaultValue={todayInput()} />
    <SelectField name="status" label="Condition" options={['Available', 'Maintenance', 'Retired']} />
    <TextArea name="conditionNote" label="Condition on return" required={false} placeholder="Optional" />
  </FormModal>;
}
