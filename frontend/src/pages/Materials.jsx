import React, { useEffect, useState } from 'react';
import { Check, FileText, PackageCheck } from 'lucide-react';
import { api, openDocument, openRecord, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Modal, Page, Row, SelectField, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';
import { RecordScopeProvider } from '../record-scope.jsx';
import WorkflowChecklist from '../WorkflowChecklist.jsx';
import { requestSteps, orderSteps } from '../purchasing-workflow.js';

const TABS = ['Stock', 'Movements', 'Purchase requests', 'Orders', 'Suppliers'];

/** PID 2.6 and 2.7 — stock the stores actually hold, and the purchasing trail behind it. */
export default function Materials({ data, reload, can, companyId, company }) {
  const [tab, setTab] = useState(() => TABS.find(section => slug(section) === window.location.pathname.split('/')[2]) || TABS[0]);
  const [open, setOpen] = useState('');

  const actions = {
    Stock: can.stock && 'Add material',
    Movements: can.stock && 'Record movement',
    'Purchase requests': can.stock && 'Raise request',
    Orders: can.purchasing && 'Create order',
    Suppliers: can.purchasing && 'Add supplier'
  };

  return <RecordScopeProvider scope={['Purchase requests', 'Orders'].includes(tab) ? { kind: 'company', name: company?.name || 'the selected company', id: companyId } : { kind: 'shared' }}><Page title="Materials & purchasing" subtitle="Track receipts, issues, returns, stock levels and the purchase trail behind them."
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={TABS} active={tab} onChange={setTab} />

    {tab === 'Stock' && <Stock data={data} reload={reload} can={can} />}
    {tab === 'Movements' && <Movements data={data} reload={reload} can={can} />}
    {tab === 'Purchase requests' && <Requests reload={reload} can={can} companyId={companyId} />}
    {tab === 'Orders' && <Orders reload={reload} can={can} companyId={companyId} />}
    {tab === 'Suppliers' && <Suppliers can={can} />}

    {open === 'Stock' && <MaterialForm close={() => setOpen('')} reload={reload} />}
    {open === 'Movements' && <MovementForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Purchase requests' && <RequestForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Orders' && <OrderForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Suppliers' && <SupplierForm close={() => setOpen('')} reload={reload} />}
  </Page></RecordScopeProvider>;
}

const STOCK_COLUMNS = ['Material', 'Category / route', 'Kind', 'Store', 'In stock', 'Minimum', 'Stock value', 'Status', ''];
const STOCK_TEMPLATE = 'minmax(190px,1.4fr) minmax(150px,1fr) 115px minmax(140px,1fr) 110px 110px 130px 100px 90px';

function Stock({ data, reload, can }) {
  const [editing,setEditing]=useState(null);
  const low = data.materials.filter(material => material.state !== 'Available').length;
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get('record')); if (id) document.getElementById(`material-${id}`)?.scrollIntoView({ block: 'center' }); }, [data.materials]);

  return <>
    <div className="inventory-top">
      <div><span>Tracked material items</span><strong>{data.materials.length}</strong><small>Across active stores</small></div>
      <div><span>Low stock items</span><strong>{low}</strong><small>Require purchasing</small></div>
      <div><span>Healthy stock items</span><strong>{data.materials.length - low}</strong><small>At or above minimum</small></div>
    </div>
    <p className="invoice-note">Also visible in <a href="/stock-locations">Stock locations</a>: site locations, tool custodians and BOQ quantity exceptions. This stock register is shared by both companies. Record receipts and issues once through Movements or handovers; do not create a second item.</p>
    <Table columns={STOCK_COLUMNS} template={STOCK_TEMPLATE} title="Stock overview">
      {data.materials.map(material => <Row template={STOCK_TEMPLATE} key={material.id} id={`material-${material.id}`} className={Number(new URLSearchParams(window.location.search).get('record')) === Number(material.id) ? 'linked-record' : ''}>
        <div><strong>{material.name}</strong><small>MAT-{String(material.id).padStart(4, '0')}</small></div>
        <div><strong>{material.category||'General'}</strong><small>{material.procurementRoute||material.procurement_route||'Purchase order'}</small></div>
        <Badge tone={slug(material.stock_kind||'Consumable')}>{material.stock_kind||'Consumable'}</Badge>
        <span>{material.site}</span>
        <strong>{material.stock} <small>{material.unit}</small></strong>
        <span>{material.minimum} {material.unit}</span>
        <span>{rupees(Number(material.stock) * Number(material.unit_cost || 0))}</span>
        <Badge tone={slug(material.state)}>{material.state}</Badge>
        {can.stock ? <button className="status-button" onClick={()=>setEditing(material)}>Edit material</button> : <span>—</span>}
      </Row>)}
    </Table>
    {editing && <MaterialForm material={editing} close={()=>setEditing(null)} reload={reload} />}
  </>;
}

const MOVEMENT_COLUMNS = ['Date', 'Material', 'Type', 'Quantity', 'Project / destination', 'Recorded by', ''];
const MOVEMENT_TEMPLATE = '150px minmax(180px,1.3fr) 110px 110px minmax(140px,1fr) minmax(130px,1fr) 100px';

function Movements({data,reload,can}) {
  const [rows,setRows]=useState([]),[editing,setEditing]=useState(null),[error,setError]=useState('');
  const load=()=>api('/materials/movements').then(setRows).catch(failure=>setError(failure.message));
  useLiveList(load);
  return <>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <Table columns={MOVEMENT_COLUMNS} template={MOVEMENT_TEMPLATE} title="Stock movement history" empty="No movements recorded.">
      {rows.map(row=><Row template={MOVEMENT_TEMPLATE} key={row.id}>
        <span>{new Date(row.createdAt).toLocaleString('en-GB')}</span>
        <div><strong>{row.material}</strong><small>{row.reference||'—'}</small>{row.notes&&<small>{row.notes}</small>}</div>
        <div><Badge tone={slug(row.type)}>{row.type}</Badge><small>{row.originType||'Manual'}</small></div>
        <span>{row.quantity} {row.unit}</span><span>{row.destination||row.project||'—'}</span><span>{row.recordedBy}</span>
        {can.stock?<button className="status-button" onClick={()=>setEditing(row)}>{row.originType&&row.originType!=='Manual'?'Edit notes':'Edit movement'}</button>:<span>—</span>}
      </Row>)}
    </Table>
    {editing&&<MovementForm movement={editing} data={data} close={()=>setEditing(null)} reload={async()=>{await load();await reload();}}/>}
  </>;
}

const REQUEST_COLUMNS = ['Reference', 'Project', 'Needed by', 'Lines', 'Estimate', 'Status', ''];
const REQUEST_TEMPLATE = 'minmax(130px,.9fr) minmax(150px,1fr) 120px 70px 130px 110px 160px';

function Requests({ reload, can, companyId }) {
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const load = () => api(`/purchasing/requests?companyId=${companyId}`).then(setRows).catch(() => setRows([]));
  useLiveList(load);
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get('record')); if (id && rows.some(row => Number(row.id) === id)) openRecord(`/purchasing/requests/${id}`, setDetail); }, [rows]);
  const decide = async (id, status) => { await patch(`/purchasing/requests/${id}`, { status }); await load(); await reload(); };

  return <>
    <Table columns={REQUEST_COLUMNS} template={REQUEST_TEMPLATE} title="Purchase requests" empty="No purchase requests raised.">
    {rows.map(row => <Row template={REQUEST_TEMPLATE} key={row.id}>
      <div><strong>{row.reference}</strong><small>{row.requestedBy}</small></div>
      <span>{row.project}</span>
      <span>{shortDate(row.neededBy)}</span>
      <span>{row.lineCount}</span>
      <span>{rupees(row.estimate)}</span>
      <Badge tone={slug(row.status)}>{row.status}</Badge>
      <span className="row-actions">
        <button className="status-button" onClick={() => openRecord(`/purchasing/requests/${row.id}`, setDetail)}>Open</button>
        {can.projects && row.status === 'Pending' && <>
          <button className="status-button" onClick={() => decide(row.id, 'Approved')}>Approve</button>
          <button className="status-button" onClick={() => decide(row.id, 'Rejected')}>Reject</button>
        </>}
      </span>
    </Row>)}
    </Table>
    {detail && <RequestDetail request={detail} can={can} close={() => setDetail(null)}
      refresh={async () => setDetail(await api(`/purchasing/requests/${detail.id}`))} />}
  </>;
}

/** PID 2.7 "Supplier Quotations" — priced offers compared side by side before ordering. */
function RequestDetail({ request, close, refresh, can }) {
  const [quoting, setQuoting] = useState(false);
  const cheapest = request.quotes.length ? Math.min(...request.quotes.map(quote => Number(quote.amount))) : null;
  const itemTemplate = 'minmax(180px,1.6fr) 110px 110px 130px';
  const quoteTemplate = 'minmax(170px,1.4fr) 130px 110px minmax(140px,1fr)';

  return <Modal title={`${request.reference} — ${request.project}`} close={close}>
    <div className="report-form">
      <WorkflowChecklist title="Purchase to payment" steps={requestSteps(request)} />
      <div className="project-stats wide">
        <div><span>Requested by</span><strong>{request.requestedBy}</strong></div>
        <div><span>Needed by</span><strong>{shortDate(request.neededBy)}</strong></div>
      </div>
      <div className="project-stats wide">
        <div><span>Status</span><strong>{request.status}</strong></div>
        <div><span>Estimated value</span><strong>{rupees(request.estimate)}</strong></div>
      </div>
      {request.notes && <p className="wide" style={{ margin: 0, fontSize: '11px', color: 'var(--muted)' }}>{request.notes}</p>}

      <div className="wide">
        <Table columns={['Item', 'Quantity', 'Est. rate', 'Est. value']} template={itemTemplate} title="Requested items">
          {request.items.map(item => <Row template={itemTemplate} key={item.id}>
            <strong>{item.material || item.description}</strong>
            <span>{item.quantity} {item.unit}</span>
            <span>{rupees(item.estimatedRate)}</span>
            <strong>{rupees(Number(item.quantity) * Number(item.estimatedRate))}</strong>
          </Row>)}
        </Table>
      </div>

      <div className="wide">
        <Table columns={['Supplier', 'Quoted', 'Lead time', 'Notes']} template={quoteTemplate} title="Supplier quotations"
          tools={can.purchasing ? <button className="secondary" onClick={() => setQuoting(true)}>Add quotation</button> : null}
          empty="No quotations recorded yet.">
          {request.quotes.map(quote => <Row template={quoteTemplate} key={quote.id}>
            <div><strong>{quote.supplier}</strong>{Number(quote.amount) === cheapest && <small>Lowest quote</small>}</div>
            <strong className={Number(quote.amount) === cheapest ? '' : undefined}>{rupees(quote.amount)}</strong>
            <span>{quote.leadTimeDays} days</span>
            <span>{quote.notes || '—'}</span>
          </Row>)}
        </Table>
      </div>

      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>
    {quoting && <QuotationForm requestId={request.id} close={() => setQuoting(false)} reload={refresh} />}
  </Modal>;
}

function QuotationForm({ requestId, close, reload }) {
  const [suppliers, setSuppliers] = useState([]);
  useEffect(() => { api('/purchasing/suppliers').then(setSuppliers).catch(() => setSuppliers([])); }, []);
  return <FormModal title="Add supplier quotation" close={close} label="Save quotation" onSubmit={async values => {
    await post(`/purchasing/requests/${requestId}/quotations`, {
      supplierId: Number(values.supplierId),
      amount: Number(values.amount),
      leadTimeDays: Number(values.leadTimeDays || 0),
      notes: values.notes || undefined
    });
    await reload();
  }}>
    <SelectField name="supplierId" label="Supplier" options={suppliers.map(supplier => [supplier.id, supplier.name])} />
    <Field name="amount" label="Quoted amount (LKR)" type="number" step="any" min="0" />
    <Field name="leadTimeDays" label="Lead time (days)" type="number" min="0" defaultValue="0" required={false} />
    <TextArea name="notes" label="Notes" required={false} placeholder="Delivery terms, validity" />
  </FormModal>;
}

const ORDER_COLUMNS = ['Reference', 'Supplier', 'Project', 'Order date', 'Total', 'Status', ''];
const ORDER_TEMPLATE = 'minmax(130px,.9fr) minmax(160px,1.1fr) minmax(140px,1fr) 120px 130px 130px 110px';

function Orders({ reload, can, companyId }) {
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const load = () => api(`/purchasing/orders?companyId=${companyId}`).then(setRows).catch(() => setRows([]));
  useLiveList(load);
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get('record')); if (id && rows.some(row => Number(row.id) === id)) openRecord(`/purchasing/orders/${id}`, setDetail); }, [rows]);

  return <>
    <Table columns={ORDER_COLUMNS} template={ORDER_TEMPLATE} title="Purchase orders" empty="No purchase orders issued.">
      {rows.map(row => <Row template={ORDER_TEMPLATE} key={row.id}>
        <div><strong>{row.reference}</strong><small>{row.issuedBy}</small></div>
        <span>{row.supplier}</span>
        <span>{row.project}</span>
        <span>{shortDate(row.orderDate)}</span>
        <strong>{rupees(row.total)}</strong>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        <button className="status-button" onClick={() => openRecord(`/purchasing/orders/${row.id}`, setDetail)}>Open</button>
      </Row>)}
    </Table>
    {detail && <OrderDetail order={detail} can={can} close={() => setDetail(null)}
      done={async () => { setDetail(null); await load(); await reload(); }} />}
  </>;
}

/** Receiving goods is where stock, the order and the project cost all move together. */
function OrderDetail({ order, close, done, can }) {
  const [quantities, setQuantities] = useState(() =>
    Object.fromEntries(order.items.map(item => [item.id, Number(item.quantity) - Number(item.receivedQuantity)])));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const template = 'minmax(180px,1.6fr) 110px 110px 110px 120px';

  const receive = async () => {
    setBusy(true);
    setError('');
    try {
      const lines = Object.entries(quantities)
        .filter(([, quantity]) => Number(quantity) > 0)
        .map(([itemId, quantity]) => ({ itemId: Number(itemId), quantity: Number(quantity) }));
      if (!lines.length) throw new Error('Enter at least one quantity to receive');
      await post(`/purchasing/orders/${order.id}/receive`, { lines });
      await done();
    } catch (failure) {
      setError(failure.message);
    } finally { setBusy(false); }
  };
  const approve = async () => {
    setBusy(true); setError('');
    try { await post(`/purchasing/orders/${order.id}/approve`, {}); await done(); }
    catch (failure) { setError(failure.message); }
    finally { setBusy(false); }
  };

  return <Modal title={`${order.reference} — ${order.supplier}`} close={close}>
    <div className="report-form">
      <WorkflowChecklist title="Purchase to payment" steps={orderSteps(order)} />
      <div className="project-stats wide">
        <div><span>Project</span><strong>{order.project}</strong></div>
        <div><span>Order total</span><strong>{rupees(order.total)}</strong></div>
      </div>
      <div className="wide">
        <Table columns={['Item', 'Ordered', 'Received', 'Rate', 'Receive now']} template={template}>
          {order.items.map(item => <Row template={template} key={item.id}>
            <strong>{item.description}</strong>
            <span>{item.quantity} {item.unit}</span>
            <span>{item.receivedQuantity} {item.unit}</span>
            <span>{rupees(item.rate)}</span>
            <input type="number" step="any" min="0" value={quantities[item.id]}
              onChange={event => setQuantities(current => ({ ...current, [item.id]: event.target.value }))}
              disabled={!can.stock || order.status === 'Received'} />
          </Row>)}
        </Table>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={close}>Close</button>
        <button type="button" className="secondary" onClick={()=>openDocument(`/purchasing/orders/${order.id}/document`)}><FileText size={16}/>Print / PDF</button>
        {can.projects && order.status === 'Pending approval' && (
          <button type="button" className="primary" onClick={approve} disabled={busy}>Approve order</button>
        )}
        {can.stock && order.status !== 'Received' && order.status !== 'Pending approval' && (
          <button type="button" className="primary" onClick={receive} disabled={busy}>
            <Check size={17} />{busy ? 'Saving…' : 'Record goods received'}
          </button>
        )}
      </div>
    </div>
  </Modal>;
}

function Suppliers({ can }) {
  const [rows, setRows] = useState([]);
  const [bankSupplier, setBankSupplier] = useState(null);
  const template = 'minmax(190px,1.4fr) minmax(150px,1fr) 140px minmax(170px,1.1fr) 90px 140px 130px';
  const load = () => api('/purchasing/suppliers').then(setRows).catch(() => setRows([]));
  useLiveList(load);
  return <><Table columns={['Supplier', 'Contact', 'Phone', 'Email', 'Orders', 'Outstanding', 'Bank']} template={template}
    title="Suppliers" empty="No suppliers recorded.">
    {rows.map(row => <Row template={template} key={row.id}>
      <strong>{row.name}</strong>
      <span>{row.contact || '—'}</span>
      <span>{row.phone || '—'}</span>
      <span>{row.email || '—'}</span>
      <span>{row.orders}</span>
      <span className={Number(row.outstanding) > 0 ? 'overdue' : ''}>{rupees(row.outstanding)}</span>
      <span>{can.supplierPay ? <button className="status-button" onClick={() => setBankSupplier(row)}>Bank details</button> : '—'}</span>
    </Row>)}
  </Table>
  {bankSupplier && <FormModal title={`${bankSupplier.name} — bank details`} close={() => setBankSupplier(null)} label="Save bank details" onSubmit={async values => {
    await patch(`/purchasing/suppliers/${bankSupplier.id}/bank`, {
      bankName: values.bankName, bankBranch: values.bankBranch || undefined,
      bankAccountName: values.bankAccountName, bankAccountNumber: values.bankAccountNumber,
      reason: values.reason
    });
    await load();
  }}>
    <Field name="bankName" label="Bank name" defaultValue={bankSupplier.bankName || ''} />
    <Field name="bankBranch" label="Branch" required={false} defaultValue={bankSupplier.bankBranch || ''} />
    <Field name="bankAccountName" label="Account holder" defaultValue={bankSupplier.bankAccountName || ''} />
    <Field name="bankAccountNumber" label="Account number" defaultValue={bankSupplier.bankAccountNumber || ''} />
    <TextArea name="reason" label="Reason for change (audited)" />
  </FormModal>}
  </>;
}

function MaterialForm({ material=null, close, reload }) {
  return <FormModal title={material?'Edit material':'Add material'} close={close} label={material?'Save material':'Add material'} repeat={!material} onSubmit={async values=>{
    const payload={name:values.name,unit:values.unit,stock:Number(values.stock||0),minimum:Number(values.minimum),site:values.site,
      unitCost:Number(values.unitCost||0),stockKind:values.stockKind,category:values.category,procurementRoute:values.procurementRoute,
      ...(material?{reason:values.reason,expectedStock:Number(material.stock)}:{})};
    if(material)await patch(`/materials/${material.id}`,payload);else await post('/materials',payload);
    await reload();
  }}>
    <Field name="name" label="Material name" wide defaultValue={material?.name}/>
    <Field name="unit" label="Unit label" placeholder="bags, m³, sheets" defaultValue={material?.unit}/>
    <SelectField name="stockKind" label="Stock type" options={['Consumable','Returnable']} defaultValue={material?.stock_kind||'Consumable'}/>
    <SelectField name="category" label="Material category" options={['General','Concrete','Aggregate','Cement','Steel','Timber','Fuel','Other',...(material?.category?[material.category]:[])].filter((value,index,all)=>all.indexOf(value)===index)} defaultValue={material?.category||'General'}/>
    <SelectField name="procurementRoute" label="Purchasing route" options={['Purchase order','Direct delivery']} defaultValue={material?.procurement_route||'Purchase order'}/>
    <Field name="site" label="Store" defaultValue={material?.site}/>
    <Field name="stock" label={material?'Current store stock':'Opening stock'} type="number" step="0.001" min="0" defaultValue={material?.stock??0}/>
    <Field name="minimum" label="Minimum level" type="number" step="any" min="0" defaultValue={material?.minimum}/>
    <Field name="unitCost" label="Unit cost (LKR)" type="number" step="0.01" min="0" defaultValue={material?.unit_cost??0}/>
    {material&&<><TextArea name="reason" label="Reason for correction" rows={2}/>
      <p className="form-note wide">Changing stock creates a separate receipt or downward adjustment in the history. Unit edits change the label, not the quantities. Consumable/Returnable type stays fixed after stock activity.</p></>}
    <p className="form-note wide">Direct delivery is for supplies sent straight to a project. Unit-cost changes apply to future issues; existing issue costs keep their recorded rate.</p>
  </FormModal>;
}

function MovementForm({data,close,reload,movement=null}) {
  const linked=Boolean(movement?.originType&&movement.originType!=='Manual');
  return <FormModal title={movement?(linked?'Edit movement notes':'Correct stock movement'):'Record stock movement'} close={close} label={movement?'Save correction':'Save movement'} onSubmit={async values=>{
    const payload=linked?{type:movement.type,quantity:Number(movement.quantity),projectId:movement.projectId||null,destination:movement.destination||null,reference:movement.reference||'',notes:values.notes||'',reason:values.reason,expectedQuantity:Number(movement.quantity)}:
      {type:values.type,quantity:Number(values.quantity),reference:values.reference||'',projectId:values.projectId?Number(values.projectId):null,destination:values.destination||null,notes:values.notes||'',...(movement?{reason:values.reason,expectedQuantity:Number(movement.quantity)}:{})};
    if(movement)await patch(`/materials/movements/${movement.id}`,payload);
    else { const {projectId,destination,...rest}=payload;await post(`/materials/${values.materialId}/movements`,{...rest,projectId:projectId||undefined,destination:destination||undefined}); }
    await reload();
  }}>
    {movement?<p className="form-note wide"><strong>{movement.material}</strong> · {movement.type} · {movement.quantity} {movement.unit}</p>:
      <SelectField name="materialId" label="Material" options={data.materials.map(material=>[material.id,`${material.name} (${material.stock} ${material.unit})`])}/>}
    {!linked&&<>
      <SelectField name="type" label="Movement type" options={['Receipt','Issue','Return','Adjustment']} defaultValue={movement?.type}/>
      <Field name="quantity" label="Quantity" type="number" step="0.001" min="0.001" defaultValue={movement?.quantity}/>
      <SelectField name="projectId" label="Project / site" required={false} defaultValue={movement?.projectId||''} options={[["",'Not project-specific'],...data.projects.map(project=>[project.id,project.name]),...(movement?.projectId&&!data.projects.some(row=>Number(row.id)===Number(movement.projectId))?[[movement.projectId,movement.project||'Original project']]:[])]}/>
      <Field name="destination" label="Destination / store (optional)" required={false} defaultValue={movement?.destination||''}/>
      <Field name="reference" label="Reference" required={false} defaultValue={movement?.reference||''}/>
    </>}
    {linked&&<p className="form-note wide">This entry is linked to {movement.originType}. Its quantities and project cannot be changed independently from that record. You can correct the notes here.</p>}
    <TextArea name="notes" label="Notes" required={false} defaultValue={movement?.notes||''}/>
    {movement&&<TextArea name="reason" label="Reason for correction" rows={2}/>}
    {!linked&&<p className="form-note wide">Receipts and returns increase store stock. Issues and adjustments decrease it. Movement corrections also update the linked site issue cost.</p>}
  </FormModal>;
}

function RequestForm({ data, close, reload }) {
  const [material, setMaterial] = useState(data.materials[0]?.id || '');
  const selected = data.materials.find(row => String(row.id) === String(material));
  return <FormModal title="Raise purchase request" close={close} label="Raise request" onSubmit={async values => {
    await post('/purchasing/requests', {
      projectId: Number(values.projectId),
      neededBy: values.neededBy,
      notes: values.notes || undefined,
      items: [{
        materialId: Number(values.materialId),
        description: selected?.name || values.description,
        unit: selected?.unit || 'item',
        quantity: Number(values.quantity),
        estimatedRate: Number(values.estimatedRate || 0)
      }]
    });
    await reload();
  }}>
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <Field name="neededBy" label="Needed by" type="date" defaultValue={todayInput()} />
    <label>Material
      <select name="materialId" value={material} onChange={event => setMaterial(event.target.value)}>
        {data.materials.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
      </select>
    </label>
    <Field name="quantity" label={`Quantity${selected ? ` (${selected.unit})` : ''}`} type="number" step="any" min="0" />
    <Field name="estimatedRate" label="Estimated rate (LKR)" type="number" step="any" min="0"
      defaultValue={selected?.unit_cost || 0} required={false} />
    <TextArea name="notes" label="Justification" required={false} placeholder="Optional" />
  </FormModal>;
}

function OrderForm({ data, close, reload }) {
  const [suppliers, setSuppliers] = useState([]);
  const [material, setMaterial] = useState(data.materials[0]?.id || '');
  useEffect(() => { api('/purchasing/suppliers').then(setSuppliers).catch(() => setSuppliers([])); }, []);
  const selected = data.materials.find(row => String(row.id) === String(material));
  const direct=(selected?.procurementRoute||selected?.procurement_route)==='Direct delivery'||String(selected?.category||'').toLowerCase()==='concrete'||/concrete/i.test(selected?.name||'');

  return <FormModal title={direct?'Create direct delivery instruction':'Create purchase order'} close={close} label={direct?'Issue delivery instruction':'Issue order'} onSubmit={async values => {
    const payload = {
      supplierId: Number(values.supplierId),
      projectId: Number(values.projectId),
      orderDate: values.orderDate,
      items: [{
        materialId: Number(values.materialId),
        description: selected?.name || 'Ordered item',
        unit: selected?.unit || 'item',
        quantity: Number(values.quantity),
        rate: Number(values.rate)
      }]
    };
    const check = await post('/purchasing/orders/check', payload);
    if (check.warnings.length) {
      const reason = window.prompt(`Purchase risk review:\n${check.warnings.map(item => `• ${item.message}`).join('\n')}\n\nExplain why this order should proceed:`);
      if (!reason || reason.trim().length < 10) throw new Error('Enter at least 10 characters explaining the purchase risk before saving.');
      payload.riskAccepted = true;
      payload.riskReason = reason.trim();
    }
    await post('/purchasing/orders', payload);
    await reload();
  }}>
    <SelectField name="supplierId" label="Supplier" options={suppliers.map(supplier => [supplier.id, supplier.name])} />
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <Field name="orderDate" label="Order date" type="date" defaultValue={todayInput()} />
    <label>Material
      <select name="materialId" value={material} onChange={event => setMaterial(event.target.value)}>
        {data.materials.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}
      </select>
    </label>
    <p className="form-note wide"><strong>{direct?'Direct delivery route':'Purchase order route'}</strong><br/>{direct?'Concrete is delivered to the selected project site. The site must record the quantity received and Finance must link and verify the supplier invoice.':'This material follows the purchase-order approval workflow before it can be received.'}</p>
    <Field name="quantity" label={`Quantity${selected ? ` (${selected.unit})` : ''}`} type="number" step="any" min="0" />
    <Field name="rate" label="Agreed rate (LKR)" type="number" step="any" min="0" defaultValue={selected?.unit_cost || 0} />
  </FormModal>;
}

function SupplierForm({ close, reload }) {
  return <FormModal title="Add supplier" close={close} label="Add supplier" repeat onSubmit={async values => {
    await post('/purchasing/suppliers', {
      name: values.name,
      contact: values.contact || undefined,
      phone: values.phone || undefined,
      email: values.email || undefined,
      address: values.address || undefined
    });
    await reload();
  }}>
    <Field name="name" label="Supplier name" wide />
    <Field name="contact" label="Contact person" required={false} />
    <Field name="phone" label="Phone" required={false} />
    <Field name="email" label="Email" type="email" required={false} />
    <TextArea name="address" label="Address" required={false} placeholder="Optional" />
  </FormModal>;
}
