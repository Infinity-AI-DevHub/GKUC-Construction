import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, CloudRain, HardHat, Truck, Wrench } from 'lucide-react';
import { api, post, shortDate, slug, todayInput } from '../api.js';
import { Avatar, Badge, Field, FormModal, Page, Row, SelectField, Summary, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';

const TABS = ['Live sites', 'Resource availability', 'Movement history'];

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
  useEffect(() => { api('/resources/reassignments').then(setRows).catch(() => setRows([])); }, []);
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
