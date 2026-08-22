import React, { useEffect, useState } from 'react';
import { Check, PackageCheck } from 'lucide-react';
import { api, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Badge, Field, FormModal, Modal, Page, Row, SelectField, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';

const TABS = ['Stock', 'Movements', 'Purchase requests', 'Orders', 'Suppliers'];

/** PID 2.6 and 2.7 — stock the stores actually hold, and the purchasing trail behind it. */
export default function Materials({ data, reload, can }) {
  const [tab, setTab] = useState(TABS[0]);
  const [open, setOpen] = useState('');

  const actions = {
    Stock: can.stock && 'Add material',
    Movements: can.stock && 'Record movement',
    'Purchase requests': can.stock && 'Raise request',
    Orders: can.purchasing && 'Create order',
    Suppliers: can.purchasing && 'Add supplier'
  };

  return <Page title="Materials & purchasing" subtitle="Track receipts, issues, returns, stock levels and the purchase trail behind them."
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={TABS} active={tab} onChange={setTab} />

    {tab === 'Stock' && <Stock data={data} reload={reload} can={can} />}
    {tab === 'Movements' && <Movements />}
    {tab === 'Purchase requests' && <Requests reload={reload} can={can} />}
    {tab === 'Orders' && <Orders reload={reload} can={can} />}
    {tab === 'Suppliers' && <Suppliers />}

    {open === 'Stock' && <MaterialForm close={() => setOpen('')} reload={reload} />}
    {open === 'Movements' && <MovementForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Purchase requests' && <RequestForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Orders' && <OrderForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Suppliers' && <SupplierForm close={() => setOpen('')} reload={reload} />}
  </Page>;
}

const STOCK_COLUMNS = ['Material', 'Store', 'In stock', 'Minimum', 'Stock value', 'Status', ''];
const STOCK_TEMPLATE = 'minmax(190px,1.4fr) minmax(140px,1fr) 110px 110px 130px 100px 45px';

function Stock({ data, reload, can }) {
  const receive = async id => { await post(`/materials/${id}/movements`, { type: 'Receipt', quantity: 10, reference: 'Quick receipt' }); await reload(); };
  const low = data.materials.filter(material => material.state !== 'Available').length;

  return <>
    <div className="inventory-top">
      <div><span>Tracked material items</span><strong>{data.materials.length}</strong><small>Across active stores</small></div>
      <div><span>Low stock items</span><strong>{low}</strong><small>Require purchasing</small></div>
      <div><span>Healthy stock items</span><strong>{data.materials.length - low}</strong><small>At or above minimum</small></div>
    </div>
    <Table columns={STOCK_COLUMNS} template={STOCK_TEMPLATE} title="Stock overview">
      {data.materials.map(material => <Row template={STOCK_TEMPLATE} key={material.id}>
        <div><strong>{material.name}</strong><small>MAT-{String(material.id).padStart(4, '0')}</small></div>
        <span>{material.site}</span>
        <strong>{material.stock} <small>{material.unit}</small></strong>
        <span>{material.minimum} {material.unit}</span>
        <span>{rupees(Number(material.stock) * Number(material.unit_cost || 0))}</span>
        <Badge tone={slug(material.state)}>{material.state}</Badge>
        {can.stock
          ? <button className="icon-btn" onClick={() => receive(material.id)} title="Receive 10 units"><PackageCheck size={17} /></button>
          : <span />}
      </Row>)}
    </Table>
  </>;
}

const MOVEMENT_COLUMNS = ['Date', 'Material', 'Type', 'Quantity', 'Project / destination', 'Recorded by'];
const MOVEMENT_TEMPLATE = '150px minmax(180px,1.3fr) 110px 110px minmax(140px,1fr) minmax(130px,1fr)';

function Movements() {
  const [rows, setRows] = useState([]);
  useLiveList(() => api('/materials/movements').then(setRows).catch(() => setRows([])));
  return <Table columns={MOVEMENT_COLUMNS} template={MOVEMENT_TEMPLATE} title="Stock movement history" empty="No movements recorded.">
    {rows.map(row => <Row template={MOVEMENT_TEMPLATE} key={row.id}>
      <span>{new Date(row.createdAt).toLocaleString('en-GB')}</span>
      <div><strong>{row.material}</strong><small>{row.reference || '—'}</small></div>
      <Badge tone={slug(row.type)}>{row.type}</Badge>
      <span>{row.quantity} {row.unit}</span>
      <span>{row.destination || row.project || '—'}</span>
      <span>{row.recordedBy}</span>
    </Row>)}
  </Table>;
}

const REQUEST_COLUMNS = ['Reference', 'Project', 'Needed by', 'Lines', 'Estimate', 'Status', ''];
const REQUEST_TEMPLATE = 'minmax(130px,.9fr) minmax(150px,1fr) 120px 70px 130px 110px 160px';

function Requests({ reload, can }) {
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const load = () => api('/purchasing/requests').then(setRows).catch(() => setRows([]));
  useLiveList(load);
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
        <button className="status-button" onClick={async () => setDetail(await api(`/purchasing/requests/${row.id}`))}>Open</button>
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

function Orders({ reload, can }) {
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const load = () => api('/purchasing/orders').then(setRows).catch(() => setRows([]));
  useLiveList(load);

  return <>
    <Table columns={ORDER_COLUMNS} template={ORDER_TEMPLATE} title="Purchase orders" empty="No purchase orders issued.">
      {rows.map(row => <Row template={ORDER_TEMPLATE} key={row.id}>
        <div><strong>{row.reference}</strong><small>{row.issuedBy}</small></div>
        <span>{row.supplier}</span>
        <span>{row.project}</span>
        <span>{shortDate(row.orderDate)}</span>
        <strong>{rupees(row.total)}</strong>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        <button className="status-button" onClick={async () => setDetail(await api(`/purchasing/orders/${row.id}`))}>Open</button>
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

  return <Modal title={`${order.reference} — ${order.supplier}`} close={close}>
    <div className="report-form">
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
        {can.stock && order.status !== 'Received' && (
          <button type="button" className="primary" onClick={receive} disabled={busy}>
            <Check size={17} />{busy ? 'Saving…' : 'Record goods received'}
          </button>
        )}
      </div>
    </div>
  </Modal>;
}

function Suppliers() {
  const [rows, setRows] = useState([]);
  const template = 'minmax(190px,1.4fr) minmax(150px,1fr) 140px minmax(170px,1.1fr) 90px 140px';
  useLiveList(() => api('/purchasing/suppliers').then(setRows).catch(() => setRows([])));
  return <Table columns={['Supplier', 'Contact', 'Phone', 'Email', 'Orders', 'Outstanding']} template={template}
    title="Suppliers" empty="No suppliers recorded.">
    {rows.map(row => <Row template={template} key={row.id}>
      <strong>{row.name}</strong>
      <span>{row.contact || '—'}</span>
      <span>{row.phone || '—'}</span>
      <span>{row.email || '—'}</span>
      <span>{row.orders}</span>
      <span className={Number(row.outstanding) > 0 ? 'overdue' : ''}>{rupees(row.outstanding)}</span>
    </Row>)}
  </Table>;
}

function MaterialForm({ close, reload }) {
  return <FormModal title="Add material" close={close} label="Add material" onSubmit={async values => {
    await post('/materials', {
      name: values.name,
      unit: values.unit,
      stock: Number(values.stock || 0),
      minimum: Number(values.minimum),
      site: values.site,
      unitCost: Number(values.unitCost || 0)
    });
    await reload();
  }}>
    <Field name="name" label="Material name" wide />
    <Field name="unit" label="Unit" placeholder="bags, m³, sheets" />
    <Field name="site" label="Store" />
    <Field name="stock" label="Opening stock" type="number" step="any" min="0" defaultValue="0" />
    <Field name="minimum" label="Minimum level" type="number" step="any" min="0" />
    <Field name="unitCost" label="Unit cost (LKR)" type="number" step="any" min="0" defaultValue="0" />
  </FormModal>;
}

function MovementForm({ data, close, reload }) {
  return <FormModal title="Record stock movement" close={close} label="Save movement" onSubmit={async values => {
    await post(`/materials/${values.materialId}/movements`, {
      type: values.type,
      quantity: Number(values.quantity),
      reference: values.reference || undefined,
      projectId: values.projectId ? Number(values.projectId) : undefined,
      destination: values.destination || undefined,
      notes: values.notes || undefined
    });
    await reload();
  }}>
    <SelectField name="materialId" label="Material" options={data.materials.map(material => [material.id, `${material.name} (${material.stock} ${material.unit})`])} />
    <SelectField name="type" label="Movement type" options={['Receipt', 'Issue', 'Return', 'Adjustment', 'Transfer']} />
    <Field name="quantity" label="Quantity" type="number" step="any" min="0" />
    <SelectField name="projectId" label="Project / site" options={[['', 'Not project-specific'], ...data.projects.map(project => [project.id, project.name])]} />
    <Field name="destination" label="Transfer to store" required={false} placeholder="Only for transfers" />
    <Field name="reference" label="Reference" required={false} />
    <TextArea name="notes" label="Notes" required={false} placeholder="Optional" />
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

  return <FormModal title="Create purchase order" close={close} label="Issue order" onSubmit={async values => {
    await post('/purchasing/orders', {
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
    });
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
    <Field name="quantity" label={`Quantity${selected ? ` (${selected.unit})` : ''}`} type="number" step="any" min="0" />
    <Field name="rate" label="Agreed rate (LKR)" type="number" step="any" min="0" defaultValue={selected?.unit_cost || 0} />
  </FormModal>;
}

function SupplierForm({ close, reload }) {
  return <FormModal title="Add supplier" close={close} label="Add supplier" onSubmit={async values => {
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
