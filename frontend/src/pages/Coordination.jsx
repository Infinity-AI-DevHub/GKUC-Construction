import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, CloudRain, HardHat, MessageSquare, Truck, Wrench } from 'lucide-react';
import { api, daysUntil, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Avatar, Badge, Field, FormModal, Modal, Page, Row, SelectField, Summary, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';

const TABS = ['Live sites', 'Resource availability', 'Enquiries', 'Movement history'];

/**
 * PID v3 §3.5 and §4.3 — the Project Coordinator's screen. GKUC runs two sites at a time,
 * and when one is rained off the decision is "who and what moves where". This puts the
 * whole picture on one screen so that decision takes minutes rather than a round of calls.
 */
export default function Coordination({ data, reload, can }) {
  const [tab, setTab] = useState(TABS[0]);
  const [board, setBoard] = useState(null);
  const [resources, setResources] = useState(null);
  const [rescheduling, setRescheduling] = useState(null);
  const [moving, setMoving] = useState(null);

  const load = async () => {
    const [sites, availability] = await Promise.all([
      api('/coordination').catch(() => null),
      can.resources ? api('/resources/availability').catch(() => null) : Promise.resolve(null)
    ]);
    setBoard(sites);
    setResources(availability);
  };
  useLiveList(load);
  const refresh = async () => { await load(); await reload(); };

  return <Page title="Coordination" subtitle="Both active sites, who is on them, and what moves when plans change.">
    <Tabs tabs={TABS} active={tab} onChange={setTab} />

    {tab === 'Live sites' && <LiveSites board={board} can={can} onReschedule={setRescheduling} />}
    {tab === 'Resource availability' && <Availability resources={resources} can={can} onMove={setMoving} />}
    {tab === 'Enquiries' && <Enquiries can={can} reload={reload} />}
    {tab === 'Movement history' && <MovementHistory />}

    {rescheduling && <RescheduleForm site={rescheduling} sites={board?.sites || []}
      close={() => setRescheduling(null)} reload={refresh} />}
    {moving && <ReassignForm resource={moving} sites={board?.sites || []}
      close={() => setMoving(null)} reload={refresh} />}
  </Page>;
}

function LiveSites({ board, can, onReschedule }) {
  if (!board) return <p className="empty-state">Loading the site picture…</p>;
  if (!board.sites.length) return <p className="empty-state">No active sites.</p>;

  return <>
    <div className="attendance-summary">
      <Summary label="Sites running" value={board.activeCount} icon={HardHat} />
      <Summary label="People on site" value={board.sites.reduce((sum, site) => sum + site.headcount, 0)} icon={HardHat} />
      <Summary label="Vehicles out" value={board.sites.reduce((sum, site) => sum + site.vehicles.length, 0)} icon={Truck} />
      <Summary label="Tools out" value={board.sites.reduce((sum, site) => sum + site.equipment.length, 0)} icon={Wrench} />
    </div>

    <div className="site-board">
      {board.sites.map(site => (
        <section className={`site-card ${slug(site.siteStatus)}`} key={site.id}>
          <header>
            <div>
              <Badge tone={site.siteStatus === 'Active' ? 'on-track' : site.siteStatus === 'Rescheduled' ? 'at-risk' : 'watch'}>
                {site.siteStatus}
              </Badge>
              <h3>{site.name}</h3>
              <p>{site.site} · {site.stage}</p>
            </div>
            {can.schedule && (
              <button className="secondary" onClick={() => onReschedule(site)}>
                <CloudRain size={15} />Reschedule
              </button>
            )}
          </header>

          {site.statusReason && site.siteStatus !== 'Active' && (
            <p className="site-reason"><AlertTriangle size={14} />{site.statusReason}</p>
          )}

          <dl>
            <div><dt>On site today</dt><dd>{site.headcount} people</dd></div>
            <div><dt>Open tasks</dt><dd>{site.openTasks}</dd></div>
            <div><dt>Next milestone</dt>
              <dd>{site.nextMilestone ? `${site.nextMilestone.title} · ${shortDate(site.nextMilestone.dueDate)}` : '—'}</dd></div>
            <div><dt>Daily report</dt>
              <dd className={site.reportedToday ? '' : 'overdue'}>{site.reportedToday ? 'Filed today' : 'Not filed yet'}</dd></div>
          </dl>

          {site.latestReport && (
            <p className="site-latest"><strong>Last report:</strong> {site.latestReport.work}
              {site.latestReport.issue ? ` — ${site.latestReport.issue}` : ''}</p>
          )}

          <div className="site-people">
            {site.team.slice(0, 8).map(person => (
              <span key={person.id} title={`${person.name} — ${person.designation}`}><Avatar name={person.name} /></span>
            ))}
            {site.team.length > 8 && <span className="site-more">+{site.team.length - 8}</span>}
            {!site.team.length && <small>Nobody assigned</small>}
          </div>
        </section>
      ))}
    </div>
  </>;
}

const RESOURCE_TABLES = [
  { key: 'labour', title: 'Labour', type: 'Labour', columns: ['Name', 'Trade', 'Site', 'Availability', ''] },
  { key: 'vehicles', title: 'Vehicles', type: 'Vehicle', columns: ['Vehicle', 'Driver', 'Site', 'Availability', ''] },
  { key: 'equipment', title: 'Tools & equipment', type: 'Equipment', columns: ['Asset', 'Category', 'Site', 'Availability', ''] }
];
const RESOURCE_TEMPLATE = 'minmax(170px,1.3fr) minmax(130px,1fr) minmax(140px,1fr) 150px 110px';

function Availability({ resources, can, onMove }) {
  if (!resources) return <p className="empty-state">You do not have access to the resource view.</p>;

  const tone = value => (value === 'Free' ? 'on-track'
    : value === 'Available to move' ? 'watch'
      : value === 'Committed' ? 'low' : 'at-risk');

  return <>
    <div className="attendance-summary">
      <Summary label="Labour free" value={resources.summary.labourFree} icon={HardHat} />
      <Summary label="Vehicles free" value={resources.summary.vehiclesFree} icon={Truck} />
      <Summary label="Tools free" value={resources.summary.equipmentFree} icon={Wrench} />
      <Summary label="Sites" value={resources.sites.length} icon={HardHat} />
    </div>

    {RESOURCE_TABLES.map(group => (
      <div key={group.key} style={{ marginBottom: '14px' }}>
        <Table columns={group.columns} template={RESOURCE_TEMPLATE} title={group.title}
          empty={`No ${group.title.toLowerCase()} on record.`}>
          {(resources[group.key] || []).map(row => (
            <Row template={RESOURCE_TEMPLATE} key={`${group.key}-${row.id}`}>
              <div className="person">
                {group.key === 'labour' ? <Avatar name={row.name} /> : null}
                <div><strong>{row.name || row.vehicle}</strong><small>{row.code || row.registration || ''}</small></div>
              </div>
              <span>{row.designation || row.driverName || row.driver || row.category || '—'}</span>
              <span>{row.project || 'Yard'}</span>
              <Badge tone={tone(row.availability)}>{row.availability}</Badge>
              {can.reassign
                ? <button className="status-button" onClick={() => onMove({ ...row, type: group.type })}>
                  <ArrowRightLeft size={13} />Move
                </button>
                : <span>—</span>}
            </Row>
          ))}
        </Table>
      </div>
    ))}
  </>;
}

function MovementHistory() {
  const [rows, setRows] = useState([]);
  useLiveList(() => api('/resources/reassignments').then(setRows).catch(() => setRows([])));
  const template = '150px minmax(170px,1.3fr) minmax(140px,1fr) minmax(140px,1fr) minmax(160px,1.2fr)';
  return <Table columns={['When', 'Resource', 'From', 'To', 'Reason']} template={template}
    title="Everything that has moved" empty="Nothing has been reassigned yet.">
    {rows.map(row => <Row template={template} key={row.id}>
      <span>{new Date(row.createdAt).toLocaleString('en-GB')}</span>
      <div><strong>{row.resourceName}</strong><small>{row.resourceType} · {row.movedBy}</small></div>
      <span>{row.fromProject || 'Yard'}</span>
      <span>{row.toProject || 'Yard'}</span>
      <span>{row.reason || '—'}</span>
    </Row>)}
  </Table>;
}

/**
 * The two-tap change from PID §4.3. Choosing where the work moves to is what triggers the
 * notifications and flags the deliveries, so it sits on this one form.
 */
function RescheduleForm({ site, sites, close, reload }) {
  const others = sites.filter(row => row.id !== site.id);
  return <FormModal title={`Reschedule ${site.name}`} close={close} label="Apply and notify" onSubmit={async values => {
    await post(`/projects/${site.id}/reschedule`, {
      status: values.status,
      reason: values.reason,
      effectiveDate: values.effectiveDate,
      moveToProjectId: values.moveToProjectId ? Number(values.moveToProjectId) : undefined
    });
    await reload();
  }}>
    <SelectField name="status" label="New status" options={['Rescheduled', 'On hold', 'Active', 'Completed']} />
    <Field name="effectiveDate" label="Effective from" type="date" defaultValue={todayInput()} />
    <SelectField name="moveToProjectId" label="Move the work to" wide
      options={[['', 'Nowhere — just pause this site'], ...others.map(row => [row.id, row.name])]} />
    <TextArea name="reason" label="Reason" placeholder="Weather, supervisor unavailable, or another reason" />
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      Everyone assigned to this site is notified automatically, and any delivery already booked
      here is flagged so it can be redirected. The reason is recorded so patterns become visible.
    </p>
  </FormModal>;
}

function ReassignForm({ resource, sites, close, reload }) {
  return <FormModal title={`Move ${resource.name || resource.vehicle}`} close={close} label="Move and notify"
    onSubmit={async values => {
      await post('/resources/reassign', {
        resourceType: resource.type,
        resourceId: resource.id,
        toProjectId: values.toProjectId ? Number(values.toProjectId) : null,
        reason: values.reason || undefined
      });
      await reload();
    }}>
    <SelectField name="toProjectId" label="Move to" wide
      options={[['', 'Back to the yard'], ...sites.map(row => [row.id, row.name])]} />
    <TextArea name="reason" label="Reason" required={false} placeholder="Optional" />
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      Both sites update together, so nobody is left double-booked or forgotten.
    </p>
  </FormModal>;
}

const ENQUIRY_TEMPLATE = 'minmax(120px,.8fr) minmax(150px,1.2fr) minmax(140px,1fr) 130px 110px 130px';

/**
 * PID v3 §3.5 — every enquiry, and the history of dealings with the client it came from.
 *
 * The list and the history sit together because that is how the Coordinator works: the
 * question is rarely "what enquiries are open" on its own, but "where did we get to with
 * this one, and who said what".
 */
function Enquiries({ can, reload }) {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(null);
  const load = () => api('/inquiries').then(setRows).catch(() => setRows([]));
  useLiveList(load);

  const setStatus = async (id, status) => { await patch(`/inquiries/${id}`, { status }); await load(); await reload(); };

  return <>
    <Table columns={['Reference', 'Client', 'Location', 'Expected', 'Status', '']} template={ENQUIRY_TEMPLATE}
      title="Enquiries" empty="No enquiries logged yet.">
      {rows.map(row => <Row template={ENQUIRY_TEMPLATE} key={row.id}>
        <div><strong>{row.reference}</strong><small>{shortDate(row.createdAt)}</small></div>
        <div><strong>{row.customer}</strong><small>{row.contact || row.phone || '—'}</small></div>
        <span>{row.location}</span>
        <strong>{rupees(row.expectedValue)}</strong>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        <span className="row-actions">
          <button className="status-button" onClick={() => setOpen(row)}>
            <MessageSquare size={13} />History
          </button>
          {can.enquiries && row.status === 'New' && (
            <button className="status-button" onClick={() => setStatus(row.id, 'Quoted')}>Quoted</button>
          )}
        </span>
      </Row>)}
    </Table>

    {open && <ClientHistory enquiry={open} can={can} close={() => setOpen(null)} />}
  </>;
}

const CHANNELS = ['Call', 'WhatsApp', 'Email', 'Meeting', 'Site visit', 'Letter'];

/** The record of contact with one client, and the means to add to it. */
function ClientHistory({ enquiry, can, close }) {
  const [entries, setEntries] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api(`/inquiries/${enquiry.id}/communications`).then(setEntries).catch(() => setEntries([]));
  useEffect(() => { load(); }, [enquiry.id]);

  const add = async event => {
    event.preventDefault();
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    try {
      await post(`/inquiries/${enquiry.id}/communications`, {
        direction: form.get('direction'),
        channel: form.get('channel'),
        contactPerson: form.get('contactPerson') || undefined,
        summary: form.get('summary'),
        followUpDate: form.get('followUpDate') || undefined
      });
      event.target.reset();
      await load();
    } catch (failure) { setError(failure.message); } finally { setBusy(false); }
  };

  const template = '150px 110px minmax(220px,2fr) 130px';

  return <Modal title={`${enquiry.customer} — ${enquiry.reference}`} close={close}>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Location</span><strong>{enquiry.location || '—'}</strong></div>
        <div><span>Contact</span><strong>{enquiry.contact || enquiry.phone || '—'}</strong></div>
      </div>

      <div className="wide">
        <Table columns={['When', 'How', 'What was said', 'Follow up']} template={template}
          title="History with this client"
          empty="Nothing logged yet. Every call, message and visit belongs here.">
          {(entries || []).map(entry => <Row template={template} key={entry.id}>
            <div>
              <strong>{shortDate(entry.happenedAt)}</strong>
              <small>{entry.loggedBy}</small>
            </div>
            <div>
              <Badge tone={entry.direction === 'Incoming' ? 'watch' : 'low'}>{entry.channel}</Badge>
              <small>{entry.direction}</small>
            </div>
            <div>
              <span>{entry.summary}</span>
              {entry.contactPerson && <small>with {entry.contactPerson}</small>}
            </div>
            <span className={entry.followUpDate && daysUntil(entry.followUpDate) < 0 ? 'overdue' : ''}>
              {entry.followUpDate ? shortDate(entry.followUpDate) : '—'}
            </span>
          </Row>)}
        </Table>
      </div>

      {can.enquiries && <form onSubmit={add} className="wide delegate-form">
        <label>Direction<select name="direction"><option>Incoming</option><option>Outgoing</option></select></label>
        <label>How<select name="channel">{CHANNELS.map(one => <option key={one}>{one}</option>)}</select></label>
        <label>Who<input name="contactPerson" placeholder="Person spoken to" /></label>
        <label>Follow up<input type="date" name="followUpDate" /></label>
        <label className="wide">What was said
          <input name="summary" required placeholder="Asked for a price to surface the yard, about 1,987 m2" />
        </label>
        <button className="secondary" disabled={busy}>{busy ? 'Saving…' : 'Log this contact'}</button>
      </form>}

      {error && <p className="form-error">{error}</p>}
      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>
  </Modal>;
}
