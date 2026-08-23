import React, { useEffect, useMemo, useState } from 'react';
import { Send, Search, Users, Phone, Check, AlertTriangle, MinusCircle } from 'lucide-react';
import { api, post, shortDate } from './api.js';

/*
 * Composing a WhatsApp message to chosen people.
 *
 * The picking is the hard part, not the sending: whoever is writing needs to find the right
 * people quickly among everyone in the company, and needs to see before pressing send who
 * among them actually has a number on file. Somebody selected but unreachable is shown as
 * such here rather than reported afterwards as a silent skip.
 */

const STATUS_ICON = { Sent: Check, Failed: AlertTriangle, Skipped: MinusCircle };

export default function Messaging() {
  const [directory, setDirectory] = useState(null);
  const [chosen, setChosen] = useState([]);          /* [{kind,id,name,address,reachable}] */
  const [search, setSearch] = useState('');
  const [manual, setManual] = useState('');
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState([]);

  const loadAll = () => Promise.all([
    api('/messaging/recipients').then(setDirectory),
    api('/messaging/history').then(setHistory)
  ]).catch(failure => setError(failure.message));

  useEffect(() => { loadAll(); }, []);

  const people = useMemo(() => {
    if (!directory) return [];
    const term = search.trim().toLowerCase();
    const rows = [
      ...directory.employees.map(row => ({
        kind: 'Employee', id: row.id, name: row.name, address: row.phone,
        detail: [row.designation, row.project].filter(Boolean).join(' · '), reachable: row.reachable
      })),
      ...directory.users.map(row => ({
        kind: 'User', id: row.id, name: row.name, address: row.phone,
        detail: row.role, reachable: row.reachable
      }))
    ];
    if (!term) return rows;
    return rows.filter(row => `${row.name} ${row.detail}`.toLowerCase().includes(term));
  }, [directory, search]);

  const key = row => `${row.kind}:${row.id}`;
  const picked = new Set(chosen.map(key));

  const toggle = row => setChosen(current => (
    picked.has(key(row)) ? current.filter(item => key(item) !== key(row)) : [...current, row]
  ));

  /* Everyone on a site at once — the case this is most often opened for. */
  const addProjectTeam = projectId => {
    const team = directory.employees.filter(row => row.projectId === Number(projectId));
    setChosen(current => {
      const have = new Set(current.map(key));
      const additions = team
        .map(row => ({ kind: 'Employee', id: row.id, name: row.name, address: row.phone, reachable: row.reachable }))
        .filter(row => !have.has(key(row)));
      return [...current, ...additions];
    });
  };

  const addNumber = () => {
    const value = manual.trim();
    if (value.length < 5) return;
    setChosen(current => [...current, { kind: 'Number', id: null, name: value, address: value, reachable: true }]);
    setManual('');
  };

  const unreachable = chosen.filter(row => !row.reachable).length;

  const send = async event => {
    event.preventDefault();
    setError('');
    setOutcome(null);
    setSending(true);
    try {
      const result = await post('/messaging/send', {
        channel: 'WhatsApp',
        subject: subject.trim() || undefined,
        body,
        recipients: chosen.map(row => (row.kind === 'Number'
          ? { kind: 'Number', address: row.address, name: row.name }
          : { kind: row.kind, id: row.id }))
      });
      setOutcome(result);
      setBody('');
      setSubject('');
      setChosen([]);
      api('/messaging/history').then(setHistory).catch(() => {});
    } catch (failure) {
      setError(failure.message);
    } finally {
      setSending(false);
    }
  };

  if (!directory) return <div className="empty-state">Loading the directory…</div>;

  const whatsapp = directory.channels.find(row => row.channel === 'WhatsApp');

  return <div className="messaging">
    {!whatsapp?.configured && (
      <div className="messaging-warning">
        <AlertTriangle size={17} />
        <div>
          <strong>WhatsApp credentials are not set on this server</strong>
          <p>Messages can be composed and are recorded, but nothing leaves the building until
            <code> WHATSAPP_TOKEN</code> and <code>WHATSAPP_PHONE_ID</code> are configured. Each
            recipient will be logged as “Skipped”, not “Sent”.</p>
        </div>
      </div>
    )}

    <div className="messaging-grid">
      <section className="panel">
        <div className="panel-title"><h2>Who to send to</h2><span className="badge">{chosen.length} chosen</span></div>

        <div className="messaging-tools">
          <label className="search-field">
            <Search size={15} />
            <input value={search} onChange={event => setSearch(event.target.value)}
              placeholder="Search people by name, role or site" aria-label="Search recipients" />
          </label>
          <select defaultValue="" onChange={event => { if (event.target.value) addProjectTeam(event.target.value); event.target.value = ''; }}
            aria-label="Add everyone on a site">
            <option value="">Add a whole site team…</option>
            {directory.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>

        <div className="recipient-list">
          {people.map(row => (
            <button type="button" key={key(row)} onClick={() => toggle(row)}
              className={`recipient${picked.has(key(row)) ? ' is-picked' : ''}`} aria-pressed={picked.has(key(row))}>
              <span className="recipient-check">{picked.has(key(row)) ? <Check size={14} /> : null}</span>
              <span className="recipient-main">
                <strong>{row.name}</strong>
                <small>{row.detail || (row.kind === 'User' ? 'Account' : '')}</small>
              </span>
              <span className={`recipient-address${row.reachable ? '' : ' is-missing'}`}>
                {row.reachable ? row.address : 'No number'}
              </span>
            </button>
          ))}
          {!people.length && <p className="empty-state">Nobody matches that search.</p>}
        </div>

        <div className="messaging-manual">
          <Phone size={15} />
          <input value={manual} onChange={event => setManual(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addNumber(); } }}
            placeholder="Or type a number, e.g. +94 77 123 4567" aria-label="Add a number directly" />
          <button type="button" className="secondary" onClick={addNumber}>Add</button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-title"><h2>Message</h2></div>
        <form className="messaging-form" onSubmit={send}>
          <label>
            Heading <small>optional — shown in bold at the top of the message</small>
            <input value={subject} onChange={event => setSubject(event.target.value)} maxLength={180}
              placeholder="Concrete pour moved to Thursday" />
          </label>
          <label>
            Message
            <textarea value={body} onChange={event => setBody(event.target.value)} rows={7} maxLength={2000}
              placeholder="Write what you need them to know." required />
            <small className="counter">{body.length} / 2000</small>
          </label>

          {chosen.length > 0 && (
            <div className="chosen-summary">
              <Users size={15} />
              <span>
                Sending to <strong>{chosen.length}</strong> {chosen.length === 1 ? 'person' : 'people'}
                {unreachable > 0 && <em> — {unreachable} with no number on file will be skipped</em>}
              </span>
              <button type="button" className="banner-link" onClick={() => setChosen([])}>Clear</button>
            </div>
          )}

          {error && <p className="form-error">{error}</p>}

          <button type="submit" className="primary" disabled={sending || !chosen.length || !body.trim()}>
            <Send size={16} />
            {sending ? 'Sending…' : `Send to ${chosen.length || 'nobody'}`}
          </button>
        </form>

        {outcome && (
          <div className="send-outcome">
            <strong>{outcome.sent} sent{outcome.failed ? `, ${outcome.failed} failed` : ''}
              {outcome.total - outcome.sent - outcome.failed > 0
                ? `, ${outcome.total - outcome.sent - outcome.failed} skipped` : ''}</strong>
            <ul>
              {outcome.results.map((row, index) => {
                const Icon = STATUS_ICON[row.status] || MinusCircle;
                return <li key={index} className={`outcome-${row.status.toLowerCase()}`}>
                  <Icon size={14} /> <span>{row.name}</span>
                  {row.detail ? <em>{row.detail}</em> : null}
                </li>;
              })}
            </ul>
          </div>
        )}
      </section>
    </div>

    <section className="panel">
      <div className="panel-title"><h2>Sent messages</h2></div>
      {history.length ? <div className="message-history">
        {history.map(row => (
          <div className="message-row" key={row.id}>
            <div>
              <strong>{row.subject || row.body.slice(0, 60)}</strong>
              <small>{row.sentBy} · {shortDate(row.createdAt)}</small>
            </div>
            <p>{row.body}</p>
            <span className="badge">{row.sentCount}/{row.recipientCount} delivered</span>
          </div>
        ))}
      </div> : <p className="empty-state">Nothing has been sent yet.</p>}
    </section>
  </div>;
}
