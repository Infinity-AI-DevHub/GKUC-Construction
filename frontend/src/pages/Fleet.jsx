import React, { useEffect, useState } from 'react';
import { AlertTriangle, CalendarDays, Fuel, Gauge, QrCode, Truck, Users, Wrench } from 'lucide-react';
import { api, openRecord, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { allowedTabs, Badge, Field, FormModal, Modal, Page, Row, SelectField, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';
import { toSvg } from '../qr.js';
import { useOptions } from '../options.js';

/* Fleet is two registers under one roof: the transport office's vehicles, and the store's
   tools. Each tab names what the server will accept for it — see allowedTabs. */
const TABS = [
  ['Vehicles', ['transport.view', 'transport.manage']],
  ['Compliance', ['transport.view', 'transport.manage']],
  ['Fuel & service', ['transport.view', 'transport.manage']],
  ['Equipment', ['store.view', 'store.manage', 'store.lending']]
];

/** Renders a QR label as inline SVG — no image request, so it prints cleanly. */
function QrCodeImage({ value }) {
  const { path, total } = toSvg(value, { scale: 4, quiet: 3 });
  return <svg className="qr-code" viewBox={`0 0 ${total} ${total}`} width="132" height="132" role="img" aria-label="Asset QR code">
    <rect width={total} height={total} fill="white" />
    <path d={path} fill="#111815" />
  </svg>;
}

/** PID 2.8 and 2.9 — vehicles with their compliance dates, and equipment with its whereabouts. */
export default function Fleet({ data, reload, can }) {
  const tabs = allowedTabs(TABS, can);
  const [tab, setTab] = useState(tabs[0]);
  const [open, setOpen] = useState('');
  const [vehicles,setVehicles]=useState(data.fleet);
  useLiveList(()=>api('/fleet').then(setVehicles).catch(()=>{}));
  const fleetData={...data,fleet:vehicles};

  const actions = {
    Vehicles: can.transport && 'Add asset',
    Compliance: can.transport && 'Record renewal',
    'Fuel & service': can.transport && 'Record fuel',
    Equipment: can.lending && 'Add equipment'
  };

  return <Page title="Fleet & equipment" subtitle="Keep vehicles available, assigned, maintained, and compliant."
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <FleetPulse vehicles={vehicles} />
    <Tabs tabs={tabs} active={tab} onChange={setTab} />

    {tab === 'Vehicles' && <Vehicles data={fleetData} can={can} reload={reload} />}
    {tab === 'Compliance' && <Compliance />}
    {tab === 'Fuel & service' && <FuelAndService data={fleetData} />}
    {tab === 'Equipment' && <Equipment data={data} reload={reload} can={can} />}

    {open === 'Vehicles' && <VehicleForm data={fleetData} close={() => setOpen('')} reload={reload} />}
    {open === 'Compliance' && <DocumentForm data={fleetData} close={() => setOpen('')} reload={reload} />}
    {open === 'Fuel & service' && <FuelForm data={fleetData} close={() => setOpen('')} reload={reload} />}
    {open === 'Equipment' && <EquipmentForm close={() => setOpen('')} reload={reload} />}
  </Page>;
}

function FleetPulse({vehicles}){
  const active=vehicles.filter(vehicle=>vehicle.status!=='Inactive');
  const needsService=active.filter(vehicle=>vehicle.service?.overdue).length;
  const renewal=active.filter(vehicle=>vehicle.due?.includes('Overdue')||vehicle.due?.includes('days')).length;
  const assigned=active.filter(vehicle=>vehicle.driverEmployeeId||vehicle.driver).length;
  const stats=[[Truck,'Active vehicles',active.length],[Users,'Drivers assigned',assigned],[Wrench,'Services overdue',needsService],[CalendarDays,'Renewals to review',renewal]];
  return <div className="inventory-top">{stats.map(([Icon,label,value])=><div key={label}><span><Icon size={16}/> {label}</span><strong>{value}</strong><small>{label==='Drivers assigned'?'Current assignments; history in each vehicle':'Open the vehicle record for details'}</small></div>)}</div>;
}

function Vehicles({ data, can, reload }) {
  const [detail, setDetail] = useState(null);
  return <>
    <div className="fleet-grid">
      {data.fleet.map(vehicle => <article className="fleet-card" key={vehicle.id} onClick={() => openRecord(`/fleet/${vehicle.id}`, setDetail)}>
        <div className="fleet-visual"><Truck size={34} /><Badge tone={slug(vehicle.status)}>{vehicle.status}</Badge></div>
        <h3>{vehicle.vehicle}</h3>
        <p>{vehicle.reg}</p>
        <dl>
          <div><dt>Assigned driver</dt><dd>{vehicle.driverName || vehicle.driver || 'Unassigned'}</dd></div>
          <div><dt>Assigned site</dt><dd>{vehicle.project || (vehicle.status==='Assigned'?'Site not linked':'Yard')}</dd></div>
          <div><dt>Odometer</dt><dd>{Number(vehicle.odometer||0).toLocaleString('en-LK')} km</dd></div>
          <div><dt>{vehicle.renewal}</dt><dd className={vehicle.due.includes('Overdue') ? 'overdue' : ''}>{vehicle.due}</dd></div>
          {vehicle.service && <div><dt>Next service</dt><dd className={vehicle.service.overdue ? 'overdue' : ''}>
            {vehicle.service.kmRemaining !== null
              ? `${Math.abs(vehicle.service.kmRemaining)} km ${vehicle.service.kmRemaining <= 0 ? 'overdue' : 'left'}`
              : shortDate(vehicle.service.dueDate)}
          </dd></div>}
        </dl>
      </article>)}
    </div>
    {detail && <VehicleDetail vehicle={detail} data={data} close={() => setDetail(null)} can={can}
      refresh={async () => {setDetail(await api(`/fleet/${detail.id}`));await reload();}} />}
  </>;
}

function VehicleDetail({ vehicle, data, close, can, refresh }) {
  const [action,setAction]=useState('');
  const fuelMax=Math.max(1,...vehicle.fuel.slice(0,8).map(row=>Number(row.cost)));
  return <Modal title={`${vehicle.vehicle} — ${vehicle.reg}`} close={close} wide>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Fuel cost to date</span><strong>{rupees(vehicle.running.fuelCost)}</strong></div>
        <div><span>Maintenance cost</span><strong>{rupees(vehicle.running.maintenanceCost)}</strong></div>
        <div><span>Fuel use</span><strong>{vehicle.running.litresPer100Km===null?'Not enough readings':`${vehicle.running.litresPer100Km} L / 100 km`}</strong></div>
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
      {can?.transport&&<div className="wide row-actions"><button className="secondary" onClick={()=>setAction('driver')}><Users size={15}/> Change driver</button><button className="secondary" onClick={()=>setAction('odometer')}><Gauge size={15}/> Odometer</button><button className="secondary" onClick={()=>setAction('fuel')}><Fuel size={15}/> Fuel</button><button className="secondary" onClick={()=>setAction('work')}><Wrench size={15}/> Service or repair</button><button className="secondary" onClick={()=>setAction('schedule')}><CalendarDays size={15}/> Service schedule</button><button className="secondary" onClick={()=>setAction('document')}><CalendarDays size={15}/> Renewal</button></div>}
      {vehicle.fuel.length>1&&<section className="workspace-surface wide"><div className="workspace-section-heading"><div><span className="section-kicker">Operating trend</span><h2>Recent fuel spend</h2></div></div><div className="cost-bars">{vehicle.fuel.slice(0,8).reverse().map(row=><div key={row.id}><span>{shortDate(row.fuelDate)}</span><i><b style={{width:`${Number(row.cost)/fuelMax*100}%`}}/></i><strong>{rupees(row.cost)}</strong></div>)}</div></section>}
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
      <div className="wide"><Table columns={['Driver','Site','From','Until','Notes']} template="minmax(160px,1.3fr) minmax(140px,1fr) 110px 110px minmax(180px,1.3fr)" title="Driver assignment history" empty="No driver assignments recorded.">{vehicle.drivers.map(row=><Row template="minmax(160px,1.3fr) minmax(140px,1fr) 110px 110px minmax(180px,1.3fr)" key={row.id}><strong>{row.driverName}</strong><span>{row.project||'Yard / office'}</span><span>{shortDate(row.assignedOn)}</span><span>{row.endedOn?shortDate(row.endedOn):'Current'}</span><span>{row.notes||'—'}</span></Row>)}</Table></div>
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
        <Table columns={['Date', 'Type','Work done', 'Garage', 'Project','Odometer','Cost']} template="110px 100px minmax(200px,2fr) minmax(140px,1fr) 140px 100px 120px"
          title="Services and repairs"
          tools={can?.transport ? <button className="secondary" onClick={() => setAction('work')}><Wrench size={14} /> Log work</button> : null}
          empty="No maintenance recorded.">
          {vehicle.maintenance.map(row => <Row template="110px 100px minmax(200px,2fr) minmax(140px,1fr) 140px 100px 120px" key={row.id}>
            <span>{shortDate(row.serviceDate)}</span><Badge tone={slug(row.kind)}>{row.kind}</Badge><span>{row.description}</span>
            <span>{row.garage || '—'}</span><span>{row.project||'Company fleet'}</span><span>{row.odometer} km</span><span>{rupees(row.cost)}</span>
          </Row>)}
        </Table>
      </div>
      <div className="wide"><Table columns={['Reading date','Odometer','Source','Notes']} template="130px 130px 120px minmax(200px,1fr)" title="Odometer history" empty="No dated odometer readings.">{vehicle.readings.map(row=><Row template="130px 130px 120px minmax(200px,1fr)" key={row.id}><span>{shortDate(row.readingDate)}</span><strong>{Number(row.odometer).toLocaleString('en-LK')} km</strong><span>{row.source}</span><span>{row.notes||'—'}</span></Row>)}</Table></div>
      <div className="wide"><Table columns={['Document','Renewed','Expiry','Reference','Cost']} template="150px 120px 120px minmax(160px,1fr) 120px" title="Renewal history" empty="No dated renewals yet; current dates appear above.">{vehicle.renewals.map(row=><Row template="150px 120px 120px minmax(160px,1fr) 120px" key={row.id}><strong>{row.docType}</strong><span>{shortDate(row.renewedOn)}</span><span>{shortDate(row.expiryDate)}</span><span>{row.reference||'—'}</span><span>{rupees(row.cost)}</span></Row>)}</Table></div>
      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>
    {action==='work'&&<MaintenanceForm vehicle={vehicle} data={data} close={()=>setAction('')} reload={refresh}/>}
    {action==='driver'&&<DriverForm vehicle={vehicle} data={data} close={()=>setAction('')} reload={refresh}/>}
    {action==='odometer'&&<OdometerForm vehicle={vehicle} close={()=>setAction('')} reload={refresh}/>}
    {action==='fuel'&&<FuelForm data={data} vehicle={vehicle} close={()=>setAction('')} reload={refresh}/>}
    {action==='document'&&<DocumentForm data={data} vehicle={vehicle} close={()=>setAction('')} reload={refresh}/>}
    {action==='schedule'&&<ScheduleForm vehicle={vehicle} close={()=>setAction('')} reload={refresh}/>}
  </Modal>;
}

/** Only scheduled service resets the service interval; repairs remain a distinct record. */
function MaintenanceForm({ vehicle, data, close, reload }) {
  return <FormModal title={`Log service or repair — ${vehicle.reg}`} close={close} label="Save work" onSubmit={async values => {
    await post(`/fleet/${vehicle.id}/maintenance`, {
      kind:values.kind,
      serviceDate: values.serviceDate,
      description: values.description,
      cost: Number(values.cost || 0),
      garage: values.garage || undefined,
      odometer: Number(values.odometer),
      projectId:values.projectId?Number(values.projectId):null,
      setStatus:values.setStatus||undefined
    });
    await reload();
  }}>
    <SelectField name="kind" label="Work type" options={['Service','Repair','Inspection']}/>
    <Field name="serviceDate" label="Work date" type="date" defaultValue={todayInput()} />
    <Field name="odometer" label="Odometer reading" type="number" min="0" defaultValue={vehicle.odometer} />
    <Field name="cost" label="Cost (LKR)" type="number" step="any" min="0" defaultValue="0" required={false} />
    <Field name="garage" label="Garage" required={false} />
    <SelectField name="projectId" label="Charge to project" options={[["",'Company fleet / not project-specific'],...data.projects.map(project=>[project.id,project.name])]} defaultValue={vehicle.projectId||''}/>
    <SelectField name="setStatus" label="Vehicle status" options={[["",'Leave unchanged'],'Repair','Available']}/>
    <TextArea name="description" label="Work carried out" />
  </FormModal>;
}

function DriverForm({vehicle,data,close,reload}){
  return <FormModal title={`Assign driver — ${vehicle.reg}`} close={close} label="Save assignment" onSubmit={async values=>{
    if(values.driverChoice==='__manual'&&!values.driverName?.trim())throw new Error('Enter the driver name or choose Unassign.');
    await post(`/fleet/${vehicle.id}/drivers`,{employeeId:/^\d+$/.test(values.driverChoice)?Number(values.driverChoice):null,
      driverName:values.driverChoice==='__manual'?values.driverName||undefined:undefined,
      projectId:values.projectId?Number(values.projectId):null,assignedOn:values.assignedOn,notes:values.notes||undefined});
    await reload();
  }}><SelectField name="driverChoice" label="Driver" options={[["__manual",'Named driver (not in employee list)'],["__none",'Unassign current driver'],...data.employees.map(employee=>[employee.id,employee.name])]} defaultValue={vehicle.driverEmployeeId||'__manual'}/><Field name="driverName" label="Name, if not registered" defaultValue={vehicle.driverName||vehicle.driver||''} required={false}/><SelectField name="projectId" label="Assigned site" options={[["",'Yard / office'],...data.projects.map(project=>[project.id,project.name])]} defaultValue={vehicle.projectId||''}/><Field name="assignedOn" label="Effective date" type="date" defaultValue={todayInput()}/><TextArea name="notes" label="Assignment note" required={false}/></FormModal>;
}

function OdometerForm({vehicle,close,reload}){
  return <FormModal title={`Record odometer — ${vehicle.reg}`} close={close} label="Save reading" onSubmit={async values=>{
    await post(`/fleet/${vehicle.id}/odometer`,{readingDate:values.readingDate,odometer:Number(values.odometer),notes:values.notes||undefined});
    await reload();
  }}><Field name="readingDate" label="Reading date" type="date" defaultValue={todayInput()}/><Field name="odometer" label="Odometer (km)" type="number" min={vehicle.odometer} defaultValue={vehicle.odometer}/><TextArea name="notes" label="Source / note" required={false}/></FormModal>;
}

function ScheduleForm({vehicle,close,reload}){
  return <FormModal title={`Service schedule — ${vehicle.reg}`} close={close} label="Save schedule" onSubmit={async values=>{
    await patch(`/fleet/${vehicle.id}`,{serviceIntervalKm:Number(values.serviceIntervalKm),serviceIntervalMonths:Number(values.serviceIntervalMonths)});
    await reload();
  }}><Field name="serviceIntervalKm" label="Every (km)" type="number" min="0" defaultValue={vehicle.serviceIntervalKm||0}/><Field name="serviceIntervalMonths" label="Every (months)" type="number" min="0" max="60" defaultValue={vehicle.serviceIntervalMonths||0}/><p className="invoice-note">The next service is due on whichever configured limit is reached first.</p></FormModal>;
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

const EQUIPMENT_COLUMNS = ['Code', 'Equipment', 'Category', 'Assigned to', 'Due back', 'Status', ''];
const EQUIPMENT_TEMPLATE = '110px minmax(180px,1.2fr) minmax(130px,1fr) minmax(150px,1.1fr) 130px 120px 210px';

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
        <div>
          <span className={Number(item.daysOverdue) > 0 ? 'overdue' : ''}>
            {item.dueBack ? shortDate(item.dueBack) : '—'}
          </span>
          {Number(item.daysOverdue) > 0
            ? <small className="overdue">{item.daysOverdue} days late</small> : null}
        </div>
        <Badge tone={slug(item.status)}>{item.status}</Badge>
        <span className="row-actions">
          <button className="status-button" onClick={() => openRecord(`/equipment/${item.id}`, setDetail)}>Open</button>
          {can.lending && <button className="status-button" onClick={() => setActing(item)}>
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
  const assignTemplate = 'minmax(150px,1.2fr) minmax(140px,1fr) 110px 110px 110px';
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
        {can.lending && <button type="button" className="secondary" onClick={issueQr}>
          <QrCode size={15} />{item.qrToken ? 'Reissue label' : 'Issue label'}
        </button>}
      </div>

      <div className="wide">
        <Table columns={['Project', 'Held by', 'From', 'Due back', 'Returned']} template={assignTemplate}
          title="Assignment history" empty="Never assigned.">
          {item.assignments.map(row => <Row template={assignTemplate} key={row.id}>
            <strong>{row.project}</strong>
            <span>{row.assignedTo}</span>
            <span>{shortDate(row.assignedAt)}</span>
            <span>{row.dueBack ? shortDate(row.dueBack) : '—'}</span>
            <span className={!row.returnedAt && row.dueBack && row.dueBack < todayInput() ? 'overdue' : ''}>
              {row.returnedAt ? shortDate(row.returnedAt) : 'Still out'}
            </span>
          </Row>)}
        </Table>
      </div>

      <div className="wide">
        <Table columns={['Date', 'Type', 'Notes', 'Cost']} template={maintTemplate} title="Maintenance and repairs"
          tools={can.lending ? <button className="secondary" onClick={() => setServicing(true)}><Wrench size={14} /> Log work</button> : null}
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
  const maintenanceTypes=useOptions('vehicle.maintenance');
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
    <SelectField name="maintenanceType" label="Type" options={maintenanceTypes} />
    <Field name="performedAt" label="Date" type="date" defaultValue={todayInput()} />
    <Field name="cost" label="Cost (LKR)" type="number" step="any" min="0" defaultValue="0" required={false} />
    <SelectField name="setStatus" label="Set status to" options={[['', 'Leave unchanged'], 'Available', 'Maintenance']} />
    <TextArea name="notes" label="What was done" required={false} placeholder="Optional" />
  </FormModal>;
}

function VehicleForm({ data, close, reload }) {
  const docTypes = useOptions('vehicle.document');
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
      projectId: values.projectId ? Number(values.projectId) : null,
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
    <SelectField name="renewal" label="Next renewal type" options={docTypes} />
    <Field name="dueDate" label="Renewal due date" type="date" defaultValue={todayInput()} />
    <SelectField name="projectId" label="Assigned site" options={[['', 'Yard'], ...data.projects.map(project => [project.id, project.name])]} />
    <Field name="odometer" label="Odometer" type="number" min="0" defaultValue="0" required={false} />
    <Field name="serviceIntervalKm" label="Service every (km)" type="number" min="0" defaultValue="0" required={false}/>
    <Field name="serviceIntervalMonths" label="Service every (months)" type="number" min="0" max="60" defaultValue="0" required={false}/>
  </FormModal>;
}

function DocumentForm({ data, vehicle, close, reload }) {
  const docTypes = useOptions('vehicle.document');
  return <FormModal title="Record renewal" close={close} label="Save renewal" onSubmit={async values => {
    await post(`/fleet/${vehicle?.id||values.vehicleId}/documents`, {
      docType: values.docType,
      reference: values.reference || undefined,
      renewedOn: values.renewedOn,
      expiryDate: values.expiryDate,
      cost: Number(values.cost || 0)
    });
    await reload();
  }}>
    <SelectField name="vehicleId" label="Vehicle" options={(vehicle?[vehicle]:data.fleet).map(item => [item.id, `${item.vehicle} — ${item.reg}`])} />
    <SelectField name="docType" label="Document" options={docTypes} />
    <Field name="reference" label="Reference / policy number" required={false} />
    <Field name="renewedOn" label="Renewed on" type="date" defaultValue={todayInput()} />
    <Field name="expiryDate" label="Expires on" type="date" defaultValue={todayInput()} />
    <Field name="cost" label="Cost (LKR)" type="number" step="any" min="0" defaultValue="0" required={false} />
  </FormModal>;
}

function FuelForm({ data, vehicle, close, reload }) {
  return <FormModal title="Record fuel" close={close} label="Save fuel record" onSubmit={async values => {
    await post(`/fleet/${vehicle?.id||values.vehicleId}/fuel`, {
      projectId: values.projectId ? Number(values.projectId) : null,
      fuelDate: values.fuelDate,
      litres: Number(values.litres),
      cost: Number(values.cost),
      odometer: Number(values.odometer)
    });
    await reload();
  }}>
    <SelectField name="vehicleId" label="Vehicle" options={(vehicle?[vehicle]:data.fleet).map(item => [item.id, `${item.vehicle} — ${item.reg}`])} />
    <SelectField name="projectId" label="Charge to project" options={[["",'Not project-specific'], ...data.projects.map(project => [project.id, project.name])]} defaultValue={vehicle?.projectId||''}/>
    <Field name="fuelDate" label="Date" type="date" defaultValue={todayInput()} />
    <Field name="litres" label="Litres" type="number" step="any" min="0" />
    <Field name="cost" label="Cost (LKR)" type="number" step="any" min="0" />
    <Field name="odometer" label="Odometer" type="number" min={vehicle?.odometer||1} defaultValue={vehicle?.odometer||''} />
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
      dueBack: values.dueBack || undefined,
      issuedCondition: values.issuedCondition,
      conditionNote: values.conditionNote || undefined
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <SelectField name="assignedTo" label="Responsible person" options={data.employees.map(employee => [employee.name, employee.name])} />
    <Field name="assignedAt" label="Assigned from" type="date" defaultValue={todayInput()} />
    {/* Everything lent out is chased once it is late, so the date is the whole point of the record. */}
    <Field name="dueBack" label="Due back on" type="date" required={false} />
    <SelectField name="issuedCondition" label="Condition on issue"
      options={['Good', 'Fair', 'Worn', 'Damaged']} />
    <TextArea name="conditionNote" label="Notes on issue" required={false} placeholder="Optional" />
  </FormModal>;
}

function ReturnForm({ item, close, reload }) {
  return <FormModal title={`Return ${item.name}`} close={close} label="Record return" onSubmit={async values => {
    await post(`/equipment/${item.id}/return`, {
      returnedAt: values.returnedAt,
      status: values.status,
      returnedCondition: values.returnedCondition,
      conditionNote: values.conditionNote || undefined
    });
    await reload();
  }}>
    <Field name="returnedAt" label="Returned on" type="date" defaultValue={todayInput()} />
    <SelectField name="returnedCondition" label="Condition it came back in"
      options={['Good', 'Fair', 'Worn', 'Damaged']} />
    <SelectField name="status" label="Where it goes now" options={['Available', 'Maintenance', 'Retired']} />
    <TextArea name="conditionNote" label="Notes on return" required={false} placeholder="Optional" />
  </FormModal>;
}
