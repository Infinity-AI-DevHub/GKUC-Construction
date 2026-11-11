import React, {useEffect, useState} from 'react';
import {api, post} from '../api.js';
import {Field, FormModal, Page, TextArea, useLiveList} from '../ui.jsx';
import './Reminders.css';

const formatTime = value => new Intl.DateTimeFormat('en-LK', {
  timeZone:'Asia/Colombo',dateStyle:'medium',timeStyle:'short'
}).format(new Date(value));

function ReminderList({rows}) {
  return rows.length ? <ul className="reminder-list">{rows.map(row => <li key={row.id}>
    <strong>{row.title}</strong> · {formatTime(row.dueAt)}
    {row.message && <p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{row.message}</p>}
    <small>{row.addressedToMe ? (row.notified ? 'Notified' : 'Scheduled') : 'Created by you'} · From {row.creator}
      {!!row.recipients.length && ` · To ${row.recipients.map(r=>r.name).join(', ')}`}</small>
  </li>)}</ul> : <p>No reminders yet.</p>;
}

export function DashboardReminders({go}) {
  const [rows,setRows] = useState([]);
  useLiveList(() => api('/reminders?scope=mine').then(setRows).catch(() => {}));
  return <section className="panel" style={{padding:'1rem'}}>
    <div className="row-actions"><h2>My reminders</h2><button type="button" className="secondary" onClick={()=>go('Reminders')}>Open reminders</button></div>
    <ReminderList rows={rows}/>
  </section>;
}

export default function Reminders({user}) {
  const [rows,setRows] = useState([]);
  const [users,setUsers] = useState([]);
  const [open,setOpen] = useState(false);
  const [error,setError] = useState('');
  const load = () => api('/reminders').then(value=>{setRows(value);setError('');}).catch(e=>setError(e.message));
  useLiveList(load);
  useEffect(() => {
    if (open) api('/reminders/recipients').then(setUsers).catch(e=>setError(e.message));
  }, [open]);
  return <Page title="Reminders" action="Create reminder" onAction={()=>setOpen(true)}>
    {error && <p className="form-error" role="alert">{error}</p>}
    <section className="panel" style={{padding:'1rem'}}><ReminderList rows={rows}/></section>
    {open && <FormModal title="Create reminder" label="Schedule reminder" close={()=>setOpen(false)} onSubmit={async (values,form) => {
      const recipientIds = form.getAll('recipient').map(Number);
      if (!recipientIds.length) throw Error('Choose at least one recipient.');
      await post('/reminders',{title:values.title,message:values.message,
        dueAt:new Date(`${values.dueAt}+05:30`).toISOString(),recipientIds});
      await load();
    }}>
      <Field name="title" label="Reminder title" wide />
      <TextArea name="message" label="Details" required={false}/>
      <Field name="dueAt" label="Remind on (Sri Lanka time)" type="datetime-local" wide/>
      <fieldset className="wide reminder-recipients">
        <legend>Who should be reminded?</legend>
        <label><input name="recipient" type="checkbox" value={user.id} defaultChecked/> Me</label>
        {users.filter(person=>Number(person.id)!==Number(user.id)).map(person=><label key={person.id}>
          <input name="recipient" type="checkbox" value={person.id}/> {person.name}
        </label>)}
      </fieldset>
    </FormModal>}
  </Page>;
}
