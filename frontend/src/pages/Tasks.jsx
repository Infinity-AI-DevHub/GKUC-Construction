import React, { useEffect, useState } from 'react';
import { Check, FolderKanban } from 'lucide-react';
import { api, openRecord, patch, post, slug, todayInput } from '../api.js';
import { Avatar, Badge, Field, FormModal, WorkflowForm, Modal, Page, Row, SelectField, Table, Tabs, TextArea } from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import EmployeeMultiSelect from '../EmployeeMultiSelect.jsx';

const FILTERS = ['All', 'Not started', 'In progress', 'Blocked', 'Completed', 'Approved', 'Rejected'];
const COLUMNS = ['Task', 'Assignee', 'Due', 'Status', 'Next action'];
const TEMPLATE = 'minmax(220px,2fr) minmax(140px,1fr) 110px 125px minmax(150px,1fr)';
const nextAction = (status, can) => ({ 'Not started': 'Start work', 'In progress': 'Submit for approval',
  Blocked: 'Resolve blocker', Completed: can?.projects ? 'Approve or return with reason' : 'Await manager approval',
  Approved: 'Approved · no action', Rejected: 'Review feedback and resubmit' })[status] || 'Open task';
const day = value => String(value || '').slice(0, 10);

/** PID 2.3 — assigned work with deadlines, so no instruction depends on being remembered. */
export default function Tasks({ data, reload, can, user }) {
  const [filter, setFilter] = useState('All');
  const [mine, setMine] = useState(false);
  const [projectFilter, setProjectFilter] = useState('all');
  const [dueFilter, setDueFilter] = useState('all');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const id = Number(new URLSearchParams(window.location.search).get('record'));
    if (!id || !data.tasks.some(task => Number(task.id) === id)) return;
    api(`/tasks/${id}`).then(setDetail).catch(failure => setError(failure.message));
  }, []);

  const myEmployee = data.employees.find(employee => Number(employee.userId) === Number(user?.id));
  const filterProjects = [...new Map(data.tasks.map(task => [String(task.projectId), {
    id: task.projectId, name: task.project
  }])).values()].filter(project => project.id != null);
  const shown = data.tasks.filter(task => {
    const dueDate = day(task.dueDate);
    const overdue = dueDate && dueDate < todayInput() && !['Completed', 'Approved'].includes(task.status);
    const mineMatch = (myEmployee && task.assigneeEmployeeIds?.some(id => Number(id) === Number(myEmployee.id)))
      || task.assignees?.some(employee => employee.name?.toLowerCase() === user?.name?.toLowerCase())
      || task.assignee?.split(',').some(name => name.trim().toLowerCase() === user?.name?.toLowerCase());
    return (filter === 'All' || task.status === filter) && (!mine || mineMatch)
      && (projectFilter === 'all' || String(task.projectId) === projectFilter)
      && (dueFilter === 'all' || dueDate === dueFilter) && (!overdueOnly || overdue);
  });

  const groups = [...new Map(shown.map(task => [task.projectId ?? task.project, {id:task.projectId ?? task.project,name:task.project}])).values()];
  return <Page title="Tasks" subtitle="Assign, follow up, and approve work across every site."
    action={can.site ? 'Create task' : null} onAction={() => setCreating(true)}>
    <Tabs tabs={FILTERS} active={filter} onChange={setFilter} />
    <div className="task-practical-filters">
      <label><input type="checkbox" checked={mine} onChange={event => setMine(event.target.checked)} /> Assigned to me</label>
      <label>Project <select value={projectFilter} onChange={event => setProjectFilter(event.target.value)}><option value="all">All projects</option>{filterProjects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label>
      <label>Due date <input type="date" value={dueFilter === 'all' ? '' : dueFilter} onChange={event => setDueFilter(event.target.value || 'all')} /></label>
      <label><input type="checkbox" checked={overdueOnly} onChange={event => setOverdueOnly(event.target.checked)} /> Overdue only</label>
    </div>
    {error && <p className="form-error" role="alert">{error}</p>}
    {!shown.length && <p className="empty-state">No tasks match these filters. Change a filter to see more work{can.site ? ', or create a task for a project.' : '.'}</p>}
    <div className="task-project-groups">{groups.map(group => <section className="task-project-group" key={group.id}>
      <header className="task-project-heading"><span className="task-project-icon"><FolderKanban size={21}/></span><div><small>Project tasks</small><h2>{group.name}</h2></div><span className="task-project-count">{shown.filter(task => (task.projectId ?? task.project) === group.id).length} {shown.filter(task => (task.projectId ?? task.project) === group.id).length === 1 ? 'task' : 'tasks'}</span></header>
      <Table columns={COLUMNS} template={TEMPLATE} empty="No tasks in this view.">
      {shown.filter(task => (task.projectId ?? task.project) === group.id).map(task => <Row template={TEMPLATE} key={task.id}>
        <div><button type="button" className="task-record-link" onClick={() => openRecord(`/tasks/${task.id}`, setDetail)}>{task.title}</button><small>{task.priority} priority</small></div>
        <div className="person"><Avatar name={task.assignee} /><span>{task.assignee}</span></div>
        <span className={task.due === 'Yesterday' ? 'overdue' : ''}>{task.due}</span>
        <Badge tone={slug(task.status)}>{task.status}</Badge>
        <span className="task-next-action">{nextAction(task.status, can)}</span>
      </Row>)}
    </Table></section>)}</div>

    {creating && <TaskForm data={data} close={() => setCreating(false)} reload={reload} />}
    {detail && <TaskDetail task={detail} close={() => setDetail(null)} reload={reload} can={can}
      refresh={async () => setDetail(await api(`/tasks/${detail.id}`))} />}
  </Page>;
}

function TaskForm({ data, close, reload }) {
  const [selected, setSelected] = useState([]);
  const [reminders,setReminders]=useState(false),[users,setUsers]=useState([]),[recipients,setRecipients]=useState([]),[userError,setUserError]=useState('');
  useEffect(()=>{api('/tasks/reminder-users').then(setUsers).catch(e=>setUserError(e.message));},[]);
  return <WorkflowForm title="Create task" close={close} label="Create task" summary={[["Assignees", `${selected.length} employee${selected.length === 1 ? '' : 's'}`], ["Reminders", reminders ? `${recipients.length} recipient${recipients.length === 1 ? '' : 's'}` : 'Off']]} reviewContent={<><h3>Assigned team</h3>{selected.map(id=><div key={id}><span>{data.employees.find(employee => Number(employee.id) === Number(id))?.name || `Employee ${id}`}</span></div>)}{reminders&&<><h3>Reminder recipients</h3>{recipients.map(id=><div key={id}><span>{users.find(user => Number(user.id) === Number(id))?.name || `User ${id}`}</span></div>)}</>}</>} onSubmit={async values => {
    if (!selected.length) throw new Error('Select at least one employee for this task.');
    if (reminders && !recipients.length) throw new Error('Choose at least one user to receive reminders.');
    await post('/tasks', {
      title: values.title,
      projectId: Number(values.projectId),
      assigneeEmployeeIds: selected,
      due: `${values.dueDate} at ${values.dueTime}`,
      dueDate: values.dueDate,
      dueTime: values.dueTime,
      ...(reminders ? {reminderAt:values.reminderAt,reminderFrequency:values.reminderFrequency,reminderUserIds:recipients}:{}),
      priority: values.priority,
      notes: values.notes || ''
    });
    await reload();
  }}>
    <div className="qs-form-section wide"><span>01</span><div><h3>Task and team</h3><p>Choose the project and people responsible.</p></div></div>
    <Field name="title" label="Task title" wide />
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <EmployeeMultiSelect employees={data.employees} selected={selected} onChange={setSelected} />
    <div className="qs-form-section wide"><span>02</span><div><h3>Deadline and priority</h3><p>Set the date and time the team should see.</p></div></div>
    <Field name="dueDate" label="Deadline date" type="date" defaultValue={todayInput()} />
    <Field name="dueTime" label="Deadline time (Sri Lanka)" type="time" defaultValue="16:00" />
    <SelectField name="priority" label="Priority" options={['Low', 'Medium', 'High']} defaultValue="Medium" />
    <TextArea name="notes" label="Notes" required={false} placeholder="Optional" />
    <div className="qs-form-section wide"><span>03</span><div><h3>Reminders</h3><p>Notify selected system users on the chosen schedule.</p></div></div>
    <label className="wide"><input type="checkbox" checked={reminders} onChange={event=>setReminders(event.target.checked)}/> Send task reminders</label>
    {reminders && <>
      <Field name="reminderAt" label="First reminder date & time (Sri Lanka)" type="datetime-local" />
      <SelectField name="reminderFrequency" label="Reminder frequency" options={['Once','Daily','Weekly','Monthly']} defaultValue="Daily" />
      {userError && <p className="form-error wide">{userError}</p>}
      <fieldset className="project-reminder-users wide"><legend>Reminder recipients</legend><p>Select one or more system users. Reminders stop when the task is completed or approved.</p><div>{users.map(user=><button type="button" key={user.id} className={recipients.includes(user.id)?'selected':''} aria-pressed={recipients.includes(user.id)} onClick={()=>setRecipients(old=>old.includes(user.id)?old.filter(id=>id!==user.id):[...old,user.id])}><span>{recipients.includes(user.id)?'✓':''}</span><strong>{user.name}</strong><small>{user.role}</small></button>)}</div></fieldset>
    </>}
  </WorkflowForm>;
}

/** Task history: the comments and site photos that turn a task into an auditable record. */
function TaskDetail({ task, close, reload, refresh, can }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState('');

  const addComment = async event => {
    event.preventDefault();
    if (!comment.trim()) return;
    setBusy(true);
    try {
      await post(`/tasks/${task.id}/comments`, { comment });
      setComment('');
      await refresh();
    } finally { setBusy(false); }
  };

  const act = async status => {
    setActionError('');
    if (['Rejected', 'Blocked'].includes(status) && !reason.trim()) {
      setActionError('Explain what needs attention before changing this task.'); return;
    }
    setBusy(true);
    try { await patch(`/tasks/${task.id}`, { status, ...(['Rejected', 'Blocked'].includes(status) ? { statusReason: reason.trim() } : {}) });
      setReason(''); await reload(); await refresh(); }
    catch (failure) { setActionError(failure.message); }
    finally { setBusy(false); }
  };

  return <Modal title={task.title} close={close}>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Project</span><strong>{task.project}</strong></div>
        <div><span>Assignee</span><strong>{task.assignee}</strong></div>
      </div>
      <div className="project-stats wide">
        <div><span>Status</span><strong>{task.status}</strong></div>
        <div><span>Due</span><strong>{task.due}</strong></div>
      </div>
      <p className="form-note wide"><strong>Next step:</strong> {nextAction(task.status, can)}. {task.status === 'Completed' ? 'Project management must approve it or return it with a reason.' : ''}</p>
      <p className="form-note wide">Also visible in <a href={`/projects/${task.projectId}`}>{task.project} · project activity</a>. Update this task here or there; both open the same task record.</p>
      {task.notes && <p className="wide" style={{ fontSize: '11px', color: 'var(--muted)', margin: 0 }}>{task.notes}</p>}

      <div className="wide task-status-history"><h3>Status history</h3>{task.statusHistory?.length ? <ol>{task.statusHistory.map((change, index) => <li key={`${change.changedAt}-${index}`}><strong>{change.after}</strong><span>{change.changedBy} · {new Date(change.changedAt).toLocaleString('en-GB')}</span>{change.reason && <p>{change.reason}</p>}</li>)}</ol> : <p>No status changes recorded yet.</p>}</div>

      <div className="wide">
        <Table columns={['Comment', 'By', 'When']} template="minmax(200px,2fr) 140px 160px" title="Task history" empty="No comments yet.">
          {task.comments.map(entry => <Row template="minmax(200px,2fr) 140px 160px" key={entry.id}>
            <span>{entry.comment}</span>
            <span>{entry.author}</span>
            <span>{new Date(entry.createdAt).toLocaleString('en-GB')}</span>
          </Row>)}
        </Table>
      </div>

      <div className="wide">
        <Attachments ownerType="task" ownerId={task.id} title="Files and site photos"
          canUpload={can.site} canDelete={can.projects} onChange={refresh} />
      </div>

      <label className="wide">Add a comment
        <textarea value={comment} onChange={event => setComment(event.target.value)} placeholder="Progress update, blocker, or instruction" />
      </label>
      {can.site && ['In progress', 'Rejected', 'Not started'].includes(task.status) && <label className="wide">Reason when blocking or returning work<textarea value={reason} onChange={event => setReason(event.target.value)} placeholder="What needs attention?" /></label>}
      {can.projects && task.status === 'Completed' && <label className="wide">Reason if returning for correction<textarea value={reason} onChange={event => setReason(event.target.value)} placeholder="What should the team correct?" /></label>}
      {actionError && <p className="form-error wide" role="alert">{actionError}</p>}
      <div className="form-actions">
        <button type="button" className="secondary" onClick={close}>Close</button>
        {can.site && task.status === 'Not started' && <button type="button" className="secondary" disabled={busy} onClick={() => act('In progress')}>Start work</button>}
        {can.site && task.status === 'Blocked' && <button type="button" className="secondary" disabled={busy} onClick={() => act('In progress')}>Resume work</button>}
        {can.site && task.status === 'Rejected' && <button type="button" className="secondary" disabled={busy} onClick={() => act('In progress')}>Resume corrections</button>}
        {can.site && task.status === 'In progress' && <><button type="button" className="secondary" disabled={busy} onClick={() => act('Blocked')}>Mark blocked</button><button type="button" className="primary" disabled={busy} onClick={() => act('Completed')}>Submit for approval</button></>}
        {can.projects && task.status === 'Completed' && <><button type="button" className="secondary" disabled={busy} onClick={() => act('Rejected')}>Return with reason</button><button type="button" className="primary" disabled={busy} onClick={() => act('Approved')}><Check size={17} />Approve</button></>}
        <button type="button" className="primary" onClick={addComment} disabled={busy}><Check size={17} />{busy ? 'Saving…' : 'Post comment'}</button>
      </div>
    </div>
  </Modal>;
}
