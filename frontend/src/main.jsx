import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AlertTriangle, ArrowDownToLine, Bell, Boxes, BriefcaseBusiness, Building2,
  CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDollarSign,
  ClipboardCheck, ClipboardList, Clock3, FileText, HardHat, LayoutDashboard,
  LogIn, LogOut, Menu, PackageCheck, Plus, Search, ShieldCheck, Truck, UserRoundCheck, Users,
  Warehouse, X, XCircle
} from 'lucide-react';
import './styles.css';
import './theme.css';
import './reference.css';
import './responsive.css';

const seed = {
  projects: [
    { id: 1, name: 'Riverside Residences', client: 'Harbour Holdings', manager: 'Kasun Perera', progress: 68, budget: 48500000, actual: 34700000, health: 'At risk', stage: 'Structural works', site: 'Colombo 05' },
    { id: 2, name: 'Kaduwela Warehouse', client: 'Lanka Distribution', manager: 'Nadeesha Silva', progress: 42, budget: 27600000, actual: 10400000, health: 'On track', stage: 'Steel erection', site: 'Kaduwela' },
    { id: 3, name: 'Lakeview Villa', client: 'Private Client', manager: 'Imran Zain', progress: 86, budget: 14800000, actual: 12900000, health: 'Watch', stage: 'Finishing', site: 'Battaramulla' }
  ],
  tasks: [
    { id: 1, title: 'Complete Level 4 column shuttering', project: 'Riverside Residences', assignee: 'Dilan Fernando', due: 'Today, 4:00 PM', priority: 'High', status: 'In progress' },
    { id: 2, title: 'Inspect steel frame alignment', project: 'Kaduwela Warehouse', assignee: 'Nadeesha Silva', due: 'Today, 2:30 PM', priority: 'High', status: 'Blocked' },
    { id: 3, title: 'Approve bathroom tile sample', project: 'Lakeview Villa', assignee: 'Imran Zain', due: 'Today, 11:00 AM', priority: 'Medium', status: 'Completed' },
    { id: 4, title: 'Submit concrete pour checklist', project: 'Riverside Residences', assignee: 'Sahan Jayasuriya', due: 'Yesterday', priority: 'High', status: 'Not started' },
    { id: 5, title: 'Update weekly progress photos', project: 'Kaduwela Warehouse', assignee: 'Tharushi Wickrama', due: 'Tomorrow', priority: 'Low', status: 'In progress' }
  ],
  attendance: [
    { id: 1, name: 'Dilan Fernando', role: 'Site Supervisor', site: 'Riverside Residences', in: '07:18', out: '', state: 'On site' },
    { id: 2, name: 'Sahan Jayasuriya', role: 'Foreman', site: 'Riverside Residences', in: '07:26', out: '', state: 'On site' },
    { id: 3, name: 'M. Rizwan', role: 'Steel Fixer', site: 'Kaduwela Warehouse', in: '08:12', out: '', state: 'Late' },
    { id: 4, name: 'Chamod Senanayake', role: 'Mason', site: 'Lakeview Villa', in: '07:05', out: '16:42', state: 'Checked out' },
    { id: 5, name: 'P. Kumara', role: 'Electrician', site: 'Lakeview Villa', in: '', out: '', state: 'Absent' }
  ],
  materials: [
    { id: 1, name: 'Portland cement 50kg', unit: 'bags', stock: 84, minimum: 100, site: 'Riverside Store', state: 'Low stock' },
    { id: 2, name: 'TMT steel 12mm', unit: 'lengths', stock: 342, minimum: 180, site: 'Central Yard', state: 'Available' },
    { id: 3, name: 'River sand', unit: 'm³', stock: 18, minimum: 12, site: 'Kaduwela Store', state: 'Available' },
    { id: 4, name: 'Concrete blocks 6in', unit: 'blocks', stock: 56, minimum: 250, site: 'Lakeview Store', state: 'Critical' },
    { id: 5, name: 'Marine plywood 18mm', unit: 'sheets', stock: 46, minimum: 30, site: 'Riverside Store', state: 'Available' }
  ],
  fleet: [
    { id: 1, vehicle: 'Toyota Dyna Tipper', reg: 'WP LD-4821', driver: 'Ruwan', status: 'Assigned', renewal: 'Insurance', due: '12 days' },
    { id: 2, vehicle: 'Mitsubishi Canter', reg: 'WP LL-9034', driver: 'Sampath', status: 'Available', renewal: 'Revenue licence', due: '28 days' },
    { id: 3, vehicle: 'JCB 3CX Backhoe', reg: 'EQ-017', driver: 'Nimal', status: 'Repair', renewal: 'Service', due: 'Overdue 3 days' },
    { id: 4, vehicle: 'Toyota Hilux', reg: 'CAA-6827', driver: 'Kasun', status: 'Assigned', renewal: 'Emission test', due: '46 days' }
  ],
  reports: [
    { id: 1, site: 'Riverside Residences', supervisor: 'Dilan Fernando', date: '03 Aug 2026', workforce: 34, work: 'Level 4 columns and stair core', issue: 'Concrete pump delayed by 55 minutes' },
    { id: 2, site: 'Kaduwela Warehouse', supervisor: 'Nadeesha Silva', date: '03 Aug 2026', workforce: 21, work: 'Portal frame assembly', issue: 'Awaiting crane inspection certificate' }
  ]
};

const nav = [
  ['Dashboard', LayoutDashboard], ['Projects', Building2], ['Tasks', ClipboardCheck],
  ['Attendance', UserRoundCheck], ['Materials', Warehouse], ['Fleet', Truck],
  ['Daily reports', FileText], ['Users', Users], ['Audit log', ShieldCheck]
];

const money = value => `LKR ${(value / 1000000).toFixed(1)}M`;
const initials = name => name.split(' ').map(x => x[0]).slice(0, 2).join('');
const api = async (path, options = {}) => {
  const token = sessionStorage.getItem('gkuc-token');
  const response = await fetch(`/api${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers } });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
};

function Badge({ children, tone }) { return <span className={`badge ${tone || children.toString().toLowerCase().replaceAll(' ', '-')}`}>{children}</span>; }
function Avatar({ name }) { return <span className="avatar">{initials(name)}</span>; }
function Progress({ value }) { return <div className="progress"><span style={{ width: `${value}%` }} /></div>; }

function Dashboard({ data, go, user }) {
  const overdue = data.tasks.filter(t => t.due === 'Yesterday' && t.status !== 'Completed').length;
  const low = data.materials.filter(m => m.stock < m.minimum).length;
  const present = data.attendance.filter(a=>a.state==='On site'||a.state==='Late').length;
  return <div className="reference-dashboard">
    <div className="reference-welcome">
      <div><p>{new Date().toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long'})}</p><h1>Welcome in, {user.name.split(' ')[0]}</h1></div>
      <div className="welcome-counters"><span><b>{present}</b>On site</span><span><b>{data.tasks.filter(t=>t.status!=='Completed').length}</b>Open tasks</span><span><b>{data.projects.length}</b>Projects</span></div>
    </div>
    <div className="project-pulse">
      <span><small>Riverside</small><b>68%</b></span><span><small>Warehouse</small><b>42%</b></span><span><small>Lakeview</small><b>86%</b></span><span className="pulse-output"><small>Portfolio output</small><b>65%</b></span>
    </div>
    <div className="reference-grid">
      <section className="site-spotlight"><div><Badge tone="on-track">Live site</Badge><h2>Riverside<br/>Residences</h2><p>Structural works · Colombo 05</p></div><span><Avatar name="Dilan Fernando"/><b>Dilan Fernando</b><small>Site supervisor</small></span></section>
      <section className="reference-card progress-card"><PanelTitle title="Weekly progress" action="Projects" onClick={()=>go('Projects')}/><div className="progress-number"><strong>68%</strong><span>+6%<small>this week</small></span></div><div className="bar-chart">{[38,52,47,66,61,82,72].map((v,i)=><span key={i}><i style={{height:`${v}%`}}/><small>{['M','T','W','T','F','S','S'][i]}</small></span>)}</div></section>
      <section className="reference-card attendance-card"><PanelTitle title="Site attendance" action="People" onClick={()=>go('Attendance')}/><div className="attendance-ring" style={{'--ring':`${Math.min(100,present/Math.max(1,data.attendance.length)*100)}%`}}><div><strong>{present}</strong><span>on site</span></div></div><div className="attendance-legend"><span><i/>Present</span><span><i/>Late</span></div></section>
      <section className="priority-board"><div className="priority-title"><div><span>Priority work</span><strong>{data.tasks.filter(t=>t.status!=='Completed').length}/{data.tasks.length}</strong></div><button onClick={()=>go('Tasks')}><ChevronRight size={17}/></button></div>{data.tasks.slice(0,5).map((t,i)=><button className="priority-item" key={t.id} onClick={()=>go('Tasks')}><span>{i+1}</span><div><strong>{t.title}</strong><small>{t.assignee} · {t.due}</small></div><CheckCircle2 size={16}/></button>)}</section>
      <section className="reference-card quick-control"><h2>Operations</h2><button onClick={()=>go('Materials')}><Boxes size={17}/><span>Low-stock materials</span><b>{low}</b><ChevronRight size={15}/></button><button onClick={()=>go('Fleet')}><Truck size={17}/><span>Fleet renewals</span><b>2</b><ChevronRight size={15}/></button><button onClick={()=>go('Daily reports')}><FileText size={17}/><span>Daily reports</span><b>{data.reports.length}</b><ChevronRight size={15}/></button></section>
      <section className="reference-card activity-timeline"><div className="timeline-title"><span>Monday</span><h2>Site activity</h2><span>3 August</span></div><div className="timeline-grid"><div className="time-labels"><span>7:00</span><span>9:00</span><span>11:00</span><span>1:00</span><span>3:00</span></div><div className="timeline-events"><i className="event concrete"><b>Concrete pour</b><small>Riverside · Level 4</small></i><i className="event inspection"><b>Steel inspection</b><small>Kaduwela · Nadeesha</small></i><i className="event delivery"><b>Block delivery</b><small>Lakeview · 2:30 PM</small></i></div></div></section>
    </div>
  </div>;
}

function Metric({ icon: Icon, label, value, detail, tone }) { return <div className="metric"><span className={`metric-icon ${tone}`}><Icon size={20}/></span><div><p>{label}</p><strong>{value}</strong><span>{detail}</span></div></div>; }
function PanelTitle({ title, action, onClick }) { return <div className="panel-title"><h2>{title}</h2>{onClick&&<button onClick={onClick}>{action}<ChevronRight size={15}/></button>}</div>; }
function Attention({ icon: Icon, tone, title, text }) { return <div className="attention-row"><span className={`attention-icon ${tone}`}><Icon size={18}/></span><div><strong>{title}</strong><span>{text}</span></div><ChevronRight size={17}/></div>; }

function Projects({data,setData}){const[open,setOpen]=useState(false),[error,setError]=useState('');const add=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const row=await api('/projects',{method:'POST',body:JSON.stringify({name:f.get('name'),client:f.get('client'),manager:f.get('manager'),site:f.get('site'),stage:f.get('stage'),budget:Number(f.get('budget')),progress:0,health:'On track'})});setData(d=>({...d,projects:[...d.projects,row]}));setOpen(false)}catch(err){setError(err.message)}};return <Page title="Projects" subtitle="Monitor progress, cost, and site health across active work." action="New project" onAction={()=>setOpen(true)}><div className="project-cards">{data.projects.map(p=><article className="project-card" key={p.id}><div className="card-top"><span className="project-mark"><Building2 size={20}/></span><Badge tone={p.health==='On track'?'on-track':p.health==='At risk'?'at-risk':'watch'}>{p.health}</Badge></div><h3>{p.name}</h3><p>{p.client} · {p.site}</p><div className="card-progress"><span>Overall progress</span><b>{p.progress}%</b><Progress value={p.progress}/></div><div className="project-stats"><div><span>Budget</span><strong>{money(p.budget)}</strong></div><div><span>Actual cost</span><strong>{money(p.actual)}</strong></div></div><div className="card-footer"><span><BriefcaseBusiness size={15}/>{p.stage}</span><span><Avatar name={p.manager}/>{p.manager}</span></div></article>)}</div>{open&&<Modal title="Create project" close={()=>setOpen(false)}><EntityForm onSubmit={add} error={error}><Field name="name" label="Project name"/><Field name="client" label="Client"/><Field name="manager" label="Project manager"/><Field name="site" label="Site location"/><Field name="stage" label="Current stage"/><Field name="budget" label="Approved budget (LKR)" type="number"/><FormButtons close={()=>setOpen(false)} label="Create project"/></EntityForm></Modal>}</Page>}

function Tasks({ data, setData }) {
  const [filter,setFilter]=useState('All');const[open,setOpen]=useState(false),[error,setError]=useState('');
  const shown=data.tasks.filter(t=>filter==='All'||t.status===filter);
  const cycle=async id=>{const task=data.tasks.find(t=>t.id===id);const status=task.status==='Not started'?'In progress':task.status==='In progress'?'Completed':'Not started';await api(`/tasks/${id}`,{method:'PATCH',body:JSON.stringify({status})});setData(d=>({...d,tasks:d.tasks.map(t=>t.id===id?{...t,status}:t)}));};
  const add=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{const row=await api('/tasks',{method:'POST',body:JSON.stringify({title:f.get('title'),projectId:Number(f.get('projectId')),assignee:f.get('assignee'),due:f.get('due'),priority:f.get('priority'),status:'Not started',notes:f.get('notes')})});setData(d=>({...d,tasks:[...d.tasks,row]}));setOpen(false)}catch(err){setError(err.message)}};
  return <Page title="Tasks" subtitle="Assign, follow up, and approve work across every site." action="Create task" onAction={()=>setOpen(true)}><div className="toolbar"><div className="segments">{['All','Not started','In progress','Blocked','Completed'].map(x=><button className={filter===x?'active':''} onClick={()=>setFilter(x)} key={x}>{x}</button>)}</div></div><section className="table-panel"><div className="table-head task-table"><span>Task</span><span>Assignee</span><span>Due</span><span>Priority</span><span>Status</span></div>{shown.map(t=><div className="table-row task-table" key={t.id}><div><strong>{t.title}</strong><small>{t.project}</small></div><div className="person"><Avatar name={t.assignee}/><span>{t.assignee}</span></div><span className={t.due==='Yesterday'?'overdue':''}>{t.due}</span><Badge tone={t.priority.toLowerCase()}>{t.priority}</Badge><button className="status-button" onClick={()=>cycle(t.id)}><span className={`status-dot ${t.status.toLowerCase().replaceAll(' ','-')}`}/>{t.status}<ChevronDown size={13}/></button></div>)}</section>{open&&<Modal title="Create task" close={()=>setOpen(false)}><EntityForm onSubmit={add} error={error}><Field name="title" label="Task title" wide/><SelectField name="projectId" label="Project" options={data.projects.map(p=>[p.id,p.name])}/><Field name="assignee" label="Assignee"/><Field name="due" label="Due date / time"/><SelectField name="priority" label="Priority" options={['Low','Medium','High']}/><Field name="notes" label="Notes" wide required={false}/><FormButtons close={()=>setOpen(false)} label="Create task"/></EntityForm></Modal>}</Page>;
}

function Attendance({ data, setData }) {
  const[open,setOpen]=useState(false),[error,setError]=useState('');
  const toggle=async id=>{const row=await api(`/attendance/${id}/toggle`,{method:'POST'});setData(d=>({...d,attendance:d.attendance.map(a=>a.id===id?{...a,in:row.check_in,out:row.check_out,state:row.state}:a)}));};
  const add=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('/attendance',{method:'POST',body:JSON.stringify({name:f.get('name'),role:f.get('role'),projectId:Number(f.get('projectId')),date:f.get('date'),state:f.get('state')})});const fresh=await api('/bootstrap');setData(fresh.data);setOpen(false)}catch(err){setError(err.message)}};
  const present=data.attendance.filter(a=>a.state==='On site'||a.state==='Late').length,late=data.attendance.filter(a=>a.state==='Late').length,absent=data.attendance.filter(a=>a.state==='Absent').length;
  return <Page title="Attendance" subtitle="Live workforce presence and verified hours by site." action="Add attendance" onAction={()=>setOpen(true)}><div className="attendance-summary"><Summary label="Present" value={present} icon={UserRoundCheck}/><Summary label="Late" value={late} icon={Clock3}/><Summary label="Absent" value={absent} icon={XCircle}/><Summary label="Records today" value={data.attendance.length} icon={ShieldCheck}/></div><section className="table-panel"><div className="table-tools"><h2>Today’s attendance</h2></div><div className="table-head attendance-table"><span>Employee</span><span>Site</span><span>Check in</span><span>Check out</span><span>Status</span><span></span></div>{data.attendance.map(a=><div className="table-row attendance-table" key={a.id}><div className="person"><Avatar name={a.name}/><div><strong>{a.name}</strong><small>{a.role}</small></div></div><span>{a.site}</span><span>{a.in||'—'}</span><span>{a.out||'—'}</span><Badge tone={a.state.toLowerCase().replaceAll(' ','-')}>{a.state}</Badge><button className="icon-btn" onClick={()=>toggle(a.id)} title={a.in&&!a.out?'Check out':'Check in'}>{a.in&&!a.out?<ArrowDownToLine size={17}/>:<Check size={17}/>}</button></div>)}</section>{open&&<Modal title="Record attendance" close={()=>setOpen(false)}><EntityForm onSubmit={add} error={error}><Field name="name" label="Employee name"/><Field name="role" label="Role / trade"/><SelectField name="projectId" label="Project / site" options={data.projects.map(p=>[p.id,p.name])}/><Field name="date" label="Work date" type="date" defaultValue={new Date().toISOString().slice(0,10)}/><SelectField name="state" label="Status" options={['On site','Late','Absent']}/><FormButtons close={()=>setOpen(false)} label="Record attendance"/></EntityForm></Modal>}</Page>;
}
function Summary({label,value,icon:Icon}){return <div className="summary"><Icon size={19}/><div><strong>{value}</strong><span>{label}</span></div></div>}

function Materials({data,setData}){
  const[open,setOpen]=useState(false),[error,setError]=useState('');
  const receive=async id=>{const row=await api(`/materials/${id}/movements`,{method:'POST',body:JSON.stringify({type:'Receipt',quantity:10,reference:'Quick receipt'})});setData(d=>({...d,materials:d.materials.map(m=>m.id===id?{...m,stock:row.stock,state:row.stock>=m.minimum?'Available':m.state}:m)}));};
  const movement=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api(`/materials/${f.get('materialId')}/movements`,{method:'POST',body:JSON.stringify({type:f.get('type'),quantity:Number(f.get('quantity')),reference:f.get('reference'),notes:f.get('notes')})});const fresh=await api('/bootstrap');setData(fresh.data);setOpen(false)}catch(err){setError(err.message)}};
  return <Page title="Materials" subtitle="Track receipts, transfers, issues, returns, and stock levels." action="Record movement" onAction={()=>setOpen(true)}><div className="inventory-top"><div><span>Tracked material items</span><strong>{data.materials.length}</strong><small>Across active stores</small></div><div><span>Low stock items</span><strong>{data.materials.filter(m=>m.stock<m.minimum).length}</strong><small>Require purchasing</small></div><div><span>Healthy stock items</span><strong>{data.materials.filter(m=>m.stock>=m.minimum).length}</strong><small>At or above minimum</small></div></div><section className="table-panel"><div className="table-tools"><h2>Stock overview</h2></div><div className="table-head material-table"><span>Material</span><span>Store</span><span>In stock</span><span>Minimum</span><span>Status</span><span></span></div>{data.materials.map(m=><div className="table-row material-table" key={m.id}><div><strong>{m.name}</strong><small>MAT-{String(m.id).padStart(4,'0')}</small></div><span>{m.site}</span><strong>{m.stock} <small>{m.unit}</small></strong><span>{m.minimum} {m.unit}</span><Badge tone={m.state.toLowerCase().replaceAll(' ','-')}>{m.state}</Badge><button className="icon-btn" onClick={()=>receive(m.id)} title="Receive 10 units"><PackageCheck size={17}/></button></div>)}</section>{open&&<Modal title="Record stock movement" close={()=>setOpen(false)}><EntityForm onSubmit={movement} error={error}><SelectField name="materialId" label="Material" options={data.materials.map(m=>[m.id,m.name])}/><SelectField name="type" label="Movement type" options={['Receipt','Issue','Return','Adjustment']}/><Field name="quantity" label="Quantity" type="number"/><Field name="reference" label="Reference" required={false}/><Field name="notes" label="Notes" wide required={false}/><FormButtons close={()=>setOpen(false)} label="Save movement"/></EntityForm></Modal>}</Page>;
}

function Fleet({data,setData}){const[open,setOpen]=useState(false),[error,setError]=useState('');const add=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('/fleet',{method:'POST',body:JSON.stringify({vehicle:f.get('vehicle'),registration:f.get('registration'),driver:f.get('driver'),status:f.get('status'),renewal:f.get('renewal'),dueDate:f.get('dueDate')})});const fresh=await api('/bootstrap');setData(fresh.data);setOpen(false)}catch(err){setError(err.message)}};return <Page title="Fleet & equipment" subtitle="Keep vehicles available, assigned, maintained, and compliant." action="Add asset" onAction={()=>setOpen(true)}><div className="fleet-grid">{data.fleet.map(v=><article className="fleet-card" key={v.id}><div className="fleet-visual"><Truck size={34}/><Badge tone={v.status.toLowerCase()}>{v.status}</Badge></div><h3>{v.vehicle}</h3><p>{v.reg}</p><dl><div><dt>Assigned driver</dt><dd>{v.driver||'Unassigned'}</dd></div><div><dt>{v.renewal}</dt><dd className={v.due.includes('Overdue')?'overdue':''}>{v.due}</dd></div></dl></article>)}</div>{open&&<Modal title="Add fleet asset" close={()=>setOpen(false)}><EntityForm onSubmit={add} error={error}><Field name="vehicle" label="Vehicle / equipment"/><Field name="registration" label="Registration / asset ID"/><Field name="driver" label="Assigned driver" required={false}/><SelectField name="status" label="Status" options={['Available','Assigned','Repair','Inactive']}/><Field name="renewal" label="Renewal / service type"/><Field name="dueDate" label="Due date" type="date"/><FormButtons close={()=>setOpen(false)} label="Add asset"/></EntityForm></Modal>}</Page>}

function Reports({data,setData}){
 const [open,setOpen]=useState(false); const [error,setError]=useState(''); const add=async e=>{e.preventDefault();setError('');const f=new FormData(e.currentTarget);try{await api('/reports',{method:'POST',body:JSON.stringify({projectId:Number(f.get('projectId')),workforce:Number(f.get('workforce')),work:f.get('work'),issue:f.get('issue')})});const fresh=await api('/bootstrap');setData(fresh.data);setOpen(false)}catch(err){setError(err.message)}};
 return <Page title="Daily site reports" subtitle="Capture workforce, completed work, materials, delays, and site evidence." action="New report" onAction={()=>setOpen(true)}><div className="report-list">{data.reports.map(r=><article className="report-row" key={r.id}><div className="report-date"><b>{r.date.split(' ')[0]}</b><span>{r.date.split(' ')[1]}</span></div><div className="report-body"><div><h3>{r.site}</h3><p>{r.work}</p></div><div className="report-tags"><span><Users size={15}/>{r.workforce} workforce</span><span><HardHat size={15}/>{r.supervisor}</span></div><div className="issue"><AlertTriangle size={16}/><span>{r.issue||'No issues reported'}</span></div></div><ChevronRight size={19}/></article>)}</div>{open&&<Modal title="New daily site report" close={()=>setOpen(false)}><form onSubmit={add} className="report-form"><label>Project / site<select name="projectId">{data.projects.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label><label>Workforce on site<input name="workforce" type="number" min="0" required placeholder="e.g. 24"/></label><label className="wide">Work completed<textarea name="work" required placeholder="Summarise today's completed work"/></label><label className="wide">Delays or issues<textarea name="issue" placeholder="Optional"/></label>{error&&<p className="form-error">{error}</p>}<div className="form-actions"><button type="button" className="secondary" onClick={()=>setOpen(false)}>Cancel</button><button className="primary"><Check size={17}/> Submit report</button></div></form></Modal>}</Page>
}

function UsersPage(){const[users,setUsers]=useState([]),[open,setOpen]=useState(false),[error,setError]=useState('');const load=()=>api('/users').then(setUsers).catch(e=>setError(e.message));useEffect(load,[]);const add=async e=>{e.preventDefault();const f=new FormData(e.currentTarget);try{await api('/users',{method:'POST',body:JSON.stringify({name:f.get('name'),email:f.get('email'),password:f.get('password'),role:f.get('role')})});await load();setOpen(false)}catch(err){setError(err.message)}};return <Page title="Users & access" subtitle="Manage staff accounts and role-based permissions." action="Add user" onAction={()=>setOpen(true)}>{error&&!users.length?<p className="empty-state">{error}</p>:<section className="table-panel"><div className="table-head user-table"><span>User</span><span>Email</span><span>Role</span><span>Status</span></div>{users.map(u=><div className="table-row user-table" key={u.id}><div className="person"><Avatar name={u.name}/><strong>{u.name}</strong></div><span>{u.email}</span><span>{u.role}</span><Badge tone={u.active?'on-track':'inactive'}>{u.active?'Active':'Inactive'}</Badge></div>)}</section>}{open&&<Modal title="Add user" close={()=>setOpen(false)}><EntityForm onSubmit={add} error={error}><Field name="name" label="Full name"/><Field name="email" label="Email" type="email"/><Field name="password" label="Temporary password" type="password"/><SelectField name="role" label="Role" options={['Administrator','Project Manager','Site Supervisor','Storekeeper','Finance / Accounts','Employee','Read-Only Viewer']}/><FormButtons close={()=>setOpen(false)} label="Create user"/></EntityForm></Modal>}</Page>}
function AuditPage(){const[logs,setLogs]=useState([]),[error,setError]=useState('');useEffect(()=>{api('/audit').then(setLogs).catch(e=>setError(e.message))},[]);return <Page title="Audit log" subtitle="Immutable history of important operational and security changes.">{error?<p className="empty-state">{error}</p>:<section className="table-panel"><div className="table-head audit-table"><span>Date and time</span><span>User</span><span>Action</span><span>Record</span></div>{logs.map(l=><div className="table-row audit-table" key={l.id}><span>{new Date(l.createdAt).toLocaleString()}</span><strong>{l.user||'System'}</strong><Badge>{l.action}</Badge><span>{l.entity} #{l.entityId}</span></div>)}</section>}</Page>}
function EntityForm({onSubmit,error,children}){return <form onSubmit={onSubmit} className="report-form">{children}{error&&<p className="form-error">{error}</p>}</form>}
function Field({name,label,type='text',wide=false,required=true,defaultValue}){return <label className={wide?'wide':''}>{label}<input name={name} type={type} required={required} defaultValue={defaultValue}/></label>}
function SelectField({name,label,options}){return <label>{label}<select name={name}>{options.map(option=>{const[value,text]=Array.isArray(option)?option:[option,option];return <option value={value} key={value}>{text}</option>})}</select></label>}
function FormButtons({close,label}){return <div className="form-actions"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary"><Check size={17}/>{label}</button></div>}
function Page({title,subtitle,action,children,onAction}){return <><div className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>{action&&onAction&&<button className="primary" onClick={onAction}><Plus size={17}/>{action}</button>}</div>{children}</>}
function Modal({title,close,children}){return <div className="modal-backdrop"><div className="modal"><div className="modal-title"><h2>{title}</h2><button className="icon-btn" onClick={close}><X size={18}/></button></div>{children}</div></div>}

function Login({onLogin}){const [error,setError]=useState('');const [busy,setBusy]=useState(false);const submit=async e=>{e.preventDefault();setBusy(true);setError('');const f=new FormData(e.currentTarget);try{const result=await api('/auth/login',{method:'POST',body:JSON.stringify({email:f.get('email'),password:f.get('password')})});sessionStorage.setItem('gkuc-token',result.token);onLogin(result.user)}catch(err){setError(err.message)}finally{setBusy(false)}};return <div className="login-page"><div className="login-brand"><span><Building2 size={28}/></span><strong>GKUC</strong><small>CONSTRUCTION SITEOPS</small></div><form className="login-panel" onSubmit={submit}><div><p className="eyebrow">SECURE OPERATIONS PORTAL</p><h1>Sign in to SiteOps</h1><p>Use your company account to access assigned projects and workflows.</p></div><label>Email address<input type="email" name="email" defaultValue="owner@gkuc.lk" required/></label><label>Password<input type="password" name="password" defaultValue="GKUC@2026" required/></label>{error&&<p className="login-error">{error}</p>}<button className="primary" disabled={busy}><LogIn size={17}/>{busy?'Signing in...':'Sign in'}</button><small className="demo-note">Client review account: owner@gkuc.lk</small></form></div>}

function App(){
 const [page,setPage]=useState('Dashboard'); const [menu,setMenu]=useState(false); const [user,setUser]=useState(null); const [loading,setLoading]=useState(true);
 const [data,setData]=useState(null);
 const load=async currentUser=>{try{const result=await api('/bootstrap');setUser(currentUser||result.user);setData(result.data)}catch{sessionStorage.removeItem('gkuc-token');setUser(null)}finally{setLoading(false)}};
 useEffect(()=>{if(sessionStorage.getItem('gkuc-token'))load();else setLoading(false)},[]);
 const loggedIn=async u=>{setLoading(true);await load(u)}; const logout=async()=>{try{await api('/auth/logout',{method:'POST'})}finally{sessionStorage.removeItem('gkuc-token');setUser(null);setData(null)}};
 if(loading)return <div className="loading-screen"><Building2 size={30}/><strong>Loading SiteOps...</strong></div>;
 if(!user||!data)return <Login onLogin={loggedIn}/>;
 const content={Dashboard:<Dashboard data={data} go={setPage} user={user}/>,Projects:<Projects data={data} setData={setData}/>,Tasks:<Tasks data={data} setData={setData}/>,Attendance:<Attendance data={data} setData={setData}/>,Materials:<Materials data={data} setData={setData}/>,Fleet:<Fleet data={data} setData={setData}/>,['Daily reports']:<Reports data={data} setData={setData}/>,Users:<UsersPage/>,['Audit log']:<AuditPage/>}[page]||<Dashboard data={data} go={setPage} user={user}/>;
 const visibleNav=nav.filter(([name])=>!['Users','Audit log'].includes(name)||['Owner / Director','Administrator'].includes(user.role));
 return <div className="app"><aside className={menu?'open':''}><div className="brand"><span><Building2 size={22}/></span><div><strong>GKUC</strong><small>SITEOPS</small></div></div><nav>{visibleNav.map(([name,Icon])=><button className={page===name?'active':''} key={name} onClick={()=>{setPage(name);setMenu(false)}}><Icon size={18}/><span>{name}</span>{name==='Tasks'&&<b>{data.tasks.filter(t=>t.status!=='Completed').length}</b>}</button>)}</nav><div className="sidebar-bottom"><button onClick={logout}><LogOut size={18}/>Sign out</button><div className="profile"><Avatar name={user.name}/><div><strong>{user.name}</strong><span>{user.role}</span></div><ChevronDown size={15}/></div></div></aside><div className="workspace"><header><button className="menu-btn" aria-label="Menu" title="Menu" onClick={()=>setMenu(!menu)}><Menu size={20}/></button><div className="mobile-brand">GKUC SITEOPS</div><div className="header-actions"><div className="header-user"><Avatar name={user.name}/><div><strong>{user.name}</strong><span>{user.role}</span></div></div></div></header><main>{content}</main></div></div>
}

createRoot(document.getElementById('root')).render(<App/>);
