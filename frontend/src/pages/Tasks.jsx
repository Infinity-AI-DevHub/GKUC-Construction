import React, { useEffect, useState } from 'react';
import { Check, FolderKanban } from 'lucide-react';
import { api, openRecord, patch, post, slug, todayInput } from '../api.js';
import { Avatar, Badge, Field, FormModal, Modal, Page, Row, SelectField, Table, Tabs, TextArea } from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import EmployeeMultiSelect from '../EmployeeMultiSelect.jsx';

const FILTERS = ['All', 'Not started', 'In progress', 'Blocked', 'Completed', 'Approved', 'Rejected'];
const COLUMNS = ['Task', 'Assignee', 'Due', 'Priority', 'Status'];
const TEMPLATE = 'minmax(270px,2fr) minmax(140px,1fr) 110px 90px 140px';

/** PID 2.3 — assigned work with deadlines, so no instruction depends on being remembered. */
export default function Tasks({ data, reload, can }) {
  const [filter, setFilter] = useState('All');
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState('');

  const shown = data.tasks.filter(task => filter === 'All' || task.status === filter);

  const groups = [...new Map(shown.map(task => [task.projectId ?? task.project, {id:task.projectId ?? task.project,name:task.project}])).values()];
  const changeStatus = async (task, status) => {
    setSaving(task.id); setError('');
    try { await patch(`/tasks/${task.id}`, { status }); await reload(); }
    catch (failure) { setError(failure.message); }
    finally { setSaving(null); }
  };

  return <Page title="Tasks" subtitle="Assign, follow up, and approve work across every site."
    action={can.site ? 'Create task' : null} onAction={() => setCreating(true)}>
    <Tabs tabs={FILTERS} active={filter} onChange={setFilter} />
    {error && <p className="form-error" role="alert">{error}</p>}
    {!shown.length && <p className="empty-state">No tasks in this view.</p>}
    <div className="task-project-groups">{groups.map(group => <section className="task-project-group" key={group.id}>
      <header className="task-project-heading"><span className="task-project-icon"><FolderKanban size={21}/></span><div><small>Project tasks</small><h2>{group.name}</h2></div><span className="task-project-count">{shown.filter(task => (task.projectId ?? task.project) === group.id).length} task(s)</span></header>
      <Table columns={COLUMNS} template={TEMPLATE} empty="No tasks in this view.">
      {shown.filter(task => (task.projectId ?? task.project) === group.id).map(task => <Row template={TEMPLATE} key={task.id} onClick={() => openRecord(`/tasks/${task.id}`, setDetail)}>
        <div><strong>{task.title}</strong><small>{task.project}</small></div>
        <div className="person"><Avatar name={task.assignee} /><span>{task.assignee}</span></div>
        <span className={task.due === 'Yesterday' ? 'overdue' : ''}>{task.due}</span>
        <Badge tone={slug(task.priority)}>{task.priority}</Badge>
        <select className={`task-status-select ${slug(task.status)}`} aria-label={`Status for ${task.title}`} value={task.status}
          disabled={!can.site || saving === task.id} onClick={event => event.stopPropagation()}
          onChange={event => changeStatus(task,event.target.value)}>
          {FILTERS.slice(1).map(status => <option key={status} value={status} disabled={status === 'Approved' && !can.projects}>{status}</option>)}
        </select>
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
  return <FormModal title="Create task" close={close} label="Create task" onSubmit={async values => {
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
    <Field name="title" label="Task title" wide />
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <EmployeeMultiSelect employees={data.employees} selected={selected} onChange={setSelected} />
    <Field name="dueDate" label="Deadline date" type="date" defaultValue={todayInput()} />
    <Field name="dueTime" label="Deadline time (Sri Lanka)" type="time" defaultValue="16:00" />
    <SelectField name="priority" label="Priority" options={['Low', 'Medium', 'High']} defaultValue="Medium" />
    <TextArea name="notes" label="Notes" required={false} placeholder="Optional" />
    <label className="wide"><input type="checkbox" checked={reminders} onChange={event=>setReminders(event.target.checked)}/> Send task reminders</label>
    {reminders && <>
      <Field name="reminderAt" label="First reminder date & time (Sri Lanka)" type="datetime-local" />
      <SelectField name="reminderFrequency" label="Reminder frequency" options={['Once','Daily','Weekly','Monthly']} defaultValue="Daily" />
      {userError && <p className="form-error wide">{userError}</p>}
      <fieldset className="project-reminder-users wide"><legend>Reminder recipients</legend><p>Select one or more system users. Reminders stop when the task is completed or approved.</p><div>{users.map(user=><button type="button" key={user.id} className={recipients.includes(user.id)?'selected':''} aria-pressed={recipients.includes(user.id)} onClick={()=>setRecipients(old=>old.includes(user.id)?old.filter(id=>id!==user.id):[...old,user.id])}><span>{recipients.includes(user.id)?'✓':''}</span><strong>{user.name}</strong><small>{user.role}</small></button>)}</div></fieldset>
    </>}
  </FormModal>;
}

/** Task history: the comments and site photos that turn a task into an auditable record. */
function TaskDetail({ task, close, reload, refresh, can }) {
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

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

  const approve = async () => { await patch(`/tasks/${task.id}`, { status: 'Approved' }); await reload(); close(); };

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
      {task.notes && <p className="wide" style={{ fontSize: '11px', color: 'var(--muted)', margin: 0 }}>{task.notes}</p>}

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
      <div className="form-actions">
        <button type="button" className="secondary" onClick={close}>Close</button>
        {can.projects && task.status === 'Completed' && (
          <button type="button" className="primary" onClick={approve}><Check size={17} />Approve completion</button>
        )}
        <button type="button" className="primary" onClick={addComment} disabled={busy}><Check size={17} />{busy ? 'Saving…' : 'Post comment'}</button>
      </div>
    </div>
  </Modal>;
}
