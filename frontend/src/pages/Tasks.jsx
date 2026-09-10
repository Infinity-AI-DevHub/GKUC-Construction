import React, { useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { api, openRecord, patch, post, slug, todayInput } from '../api.js';
import { Avatar, Badge, Field, FormModal, Modal, Page, Row, SelectField, Table, Tabs, TextArea } from '../ui.jsx';
import Attachments from '../Attachments.jsx';

const FILTERS = ['All', 'Not started', 'In progress', 'Blocked', 'Completed', 'Approved'];
const COLUMNS = ['Task', 'Assignee', 'Due', 'Priority', 'Status'];
const TEMPLATE = 'minmax(270px,2fr) minmax(140px,1fr) 110px 90px 140px';

/** PID 2.3 — assigned work with deadlines, so no instruction depends on being remembered. */
export default function Tasks({ data, reload, can }) {
  const [filter, setFilter] = useState('All');
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState(null);

  const shown = data.tasks.filter(task => filter === 'All' || task.status === filter);

  /** One click moves a task along its normal path; approval is a separate management step. */
  const cycle = async (event, task) => {
    event.stopPropagation();
    const next = { 'Not started': 'In progress', 'In progress': 'Completed', Blocked: 'In progress', Completed: 'Not started', Approved: 'Approved' }[task.status];
    await patch(`/tasks/${task.id}`, { status: next });
    await reload();
  };

  return <Page title="Tasks" subtitle="Assign, follow up, and approve work across every site."
    action={can.site ? 'Create task' : null} onAction={() => setCreating(true)}>
    <Tabs tabs={FILTERS} active={filter} onChange={setFilter} />
    <Table columns={COLUMNS} template={TEMPLATE} empty="No tasks in this view.">
      {shown.map(task => <Row template={TEMPLATE} key={task.id} onClick={() => openRecord(`/tasks/${task.id}`, setDetail)}>
        <div><strong>{task.title}</strong><small>{task.project}</small></div>
        <div className="person"><Avatar name={task.assignee} /><span>{task.assignee}</span></div>
        <span className={task.due === 'Yesterday' ? 'overdue' : ''}>{task.due}</span>
        <Badge tone={slug(task.priority)}>{task.priority}</Badge>
        <button className="status-button" onClick={event => can.site && cycle(event, task)}>
          <span className={`status-dot ${slug(task.status)}`} />{task.status}<ChevronDown size={13} />
        </button>
      </Row>)}
    </Table>

    {creating && <TaskForm data={data} close={() => setCreating(false)} reload={reload} />}
    {detail && <TaskDetail task={detail} close={() => setDetail(null)} reload={reload} can={can}
      refresh={async () => setDetail(await api(`/tasks/${detail.id}`))} />}
  </Page>;
}

function TaskForm({ data, close, reload }) {
  return <FormModal title="Create task" close={close} label="Create task" onSubmit={async values => {
    await post('/tasks', {
      title: values.title,
      projectId: Number(values.projectId),
      assignee: values.assignee,
      due: values.due,
      dueDate: values.dueDate,
      priority: values.priority,
      notes: values.notes || ''
    });
    await reload();
  }}>
    <Field name="title" label="Task title" wide />
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <SelectField name="assignee" label="Assignee" options={data.employees.map(employee => [employee.name, `${employee.name} — ${employee.designation}`])} />
    <Field name="due" label="Due (as shown to the team)" defaultValue="Today, 4:00 PM" />
    <Field name="dueDate" label="Deadline date" type="date" defaultValue={todayInput()} />
    <SelectField name="priority" label="Priority" options={['Low', 'Medium', 'High']} defaultValue="Medium" />
    <TextArea name="notes" label="Notes" required={false} placeholder="Optional" />
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
