import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Search, Send, Users, Plus, ArrowLeft, Check, CheckCheck, Clock, Trash2, X
} from 'lucide-react';
import { api, post, del, initials } from './api.js';
import { onRealtime } from './realtime.js';
import { Avatar } from './ui.jsx';

/*
 * Messaging between the people who use the system.
 *
 * Laid out as two panes on a computer and one at a time on a phone: on a narrow screen a
 * list and a conversation side by side leaves too little of either to use, so the list
 * steps aside once a conversation is open.
 */

/** "last seen 10 minutes ago", in the words somebody would actually use. */
function lastSeen(value) {
  if (!value) return 'not seen yet';
  const then = new Date(value);
  const minutes = Math.round((Date.now() - then.getTime()) / 60000);
  if (minutes < 1) return 'last seen just now';
  if (minutes < 60) return `last seen ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `last seen ${hours} hour${hours === 1 ? '' : 's'} ago`;
  const sameYear = then.getFullYear() === new Date().getFullYear();
  return `last seen ${then.toLocaleDateString('en-GB',
    { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })}`;
}

const clockTime = value => new Date(value).toLocaleTimeString('en-GB',
  { hour: '2-digit', minute: '2-digit', hour12: false });

const dayLabel = value => {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(date, today)) return 'Today';
  if (same(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
};

/**
 * The delivery marks.
 *
 * One tick: the system has it. Two: it reached everybody it was for. Two filled: they
 * opened it. Deliberately the marks people already know from WhatsApp — a mark nobody has
 * to be taught is worth more than one that is technically clearer.
 */
function Ticks({ status, readBy, recipients }) {
  const label = status === 'Read'
    ? (recipients > 1 ? `Read by all ${recipients}` : 'Read')
    : status === 'Delivered'
      ? (recipients > 1 ? `Delivered to all ${recipients}${readBy ? `, read by ${readBy}` : ''}` : 'Delivered')
      : 'Sent';
  return (
    <span className={`ticks ticks-${(status || 'Sent').toLowerCase()}`} title={label} aria-label={label}>
      {status === 'Sent' ? <Check size={14} /> : <CheckCheck size={14} />}
    </span>
  );
}

export default function Chat({ user }) {
  const [conversations, setConversations] = useState([]);
  const [people, setPeople] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [starting, setStarting] = useState(false);
  const [makingGroup, setMakingGroup] = useState(false);
  const [typing, setTyping] = useState({});
  /*
   * One timer per conversation, restarted each time they type.
   *
   * Scheduling a fresh clear on every event and letting them all run meant the first
   * event's timer wiped the state a later event had just set — so somebody typing steadily
   * had the indicator blink out every few seconds. The timer is replaced, not added to.
   */
  const typingTimers = useRef({});
  const showTyping = (conversationId, name) => {
    setTyping(current => ({ ...current, [conversationId]: name }));
    clearTimeout(typingTimers.current[conversationId]);
    typingTimers.current[conversationId] = setTimeout(() => {
      delete typingTimers.current[conversationId];
      setTyping(current => {
        const next = { ...current };
        delete next[conversationId];
        return next;
      });
    }, 4000);
  };
  /* Nothing left running when the screen goes away. */
  useEffect(() => () => {
    for (const timer of Object.values(typingTimers.current)) clearTimeout(timer);
  }, []);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef(null);
  const activeRef = useRef(null);
  activeRef.current = activeId;

  const active = conversations.find(c => c.id === activeId) || null;

  const loadConversations = () => api('/chat/conversations').then(setConversations).catch(() => {});
  const loadPeople = () => api('/chat/people').then(setPeople).catch(() => {});

  useEffect(() => {
    loadConversations();
    loadPeople();
    /* Anything that arrived while they were away picks up its second tick now. */
    post('/chat/delivered').catch(() => {});
  }, []);

  /* Opening a conversation marks what is in it as read. */
  const openConversation = async id => {
    setActiveId(id);
    setMessages([]);
    const rows = await api(`/chat/conversations/${id}/messages`).catch(() => []);
    setMessages(rows);
    const lastFromOthers = [...rows].reverse().find(row => row.senderId !== user.id);
    if (lastFromOthers) {
      await post(`/chat/conversations/${id}/read`, { upToId: lastFromOthers.id }).catch(() => {});
      loadConversations();
    }
  };

  useEffect(() => {
    const off = onRealtime((type, payload) => {
      if (type === 'chat:message') {
        if (payload.conversationId === activeRef.current) {
          setMessages(current => (current.some(m => m.id === payload.message.id)
            ? current : [...current, payload.message]));
          /* Read straight away if they are looking at it. */
          if (payload.message.senderId !== user.id) {
            post(`/chat/conversations/${payload.conversationId}/read`, { upToId: payload.message.id })
              .catch(() => {});
          }
        }
        loadConversations();
      } else if (type === 'chat:read' || type === 'chat:delivered') {
        if (payload.conversationId === activeRef.current) {
          api(`/chat/conversations/${payload.conversationId}/messages`).then(setMessages).catch(() => {});
        }
        loadConversations();
      } else if (type === 'chat:withdrawn') {
        setMessages(current => current.map(m => (m.id === payload.messageId
          ? { ...m, deletedAt: new Date().toISOString() } : m)));
      } else if (type === 'chat:conversation') {
        loadConversations();
      } else if (type === 'presence') {
        setPeople(current => current.map(person => (person.id === payload.userId
          ? { ...person, online: payload.online, lastActiveAt: payload.lastActiveAt } : person)));
        loadConversations();
      } else if (type === 'chat:typing') {
        showTyping(payload.conversationId, payload.name);
      }
    });
    return off;
  }, [user.id]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [messages.length, activeId]);

  const send = async event => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !activeId) return;
    setSending(true);
    setError('');
    try {
      const message = await post(`/chat/conversations/${activeId}/messages`, { body });
      /*
       * The sender is a member too, so the live event carries their own message back to
       * them. Appending it here as well put the same message on screen twice — and gave
       * React two children with one key, which it resolves by dropping things unpredictably.
       */
      setMessages(current => (current.some(one => one.id === message.id)
        ? current : [...current, message]));
      setDraft('');
      loadConversations();
    } catch (failure) { setError(failure.message); } finally { setSending(false); }
  };

  /* Sent at most once every couple of seconds — it only has to say "still typing". */
  const lastTyped = useRef(0);
  const onType = value => {
    setDraft(value);
    const now = Date.now();
    if (activeId && now - lastTyped.current > 2000) {
      lastTyped.current = now;
      post(`/chat/conversations/${activeId}/typing`).catch(() => {});
    }
  };

  const startDirect = async personId => {
    const result = await post('/chat/direct', { userId: personId }).catch(() => null);
    if (!result) return;
    setStarting(false);
    await loadConversations();
    openConversation(result.id);
  };

  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter(c => (c.name || '').toLowerCase().includes(term));
  }, [conversations, search]);

  const totalUnread = conversations.reduce((sum, c) => sum + Number(c.unread || 0), 0);

  return <div className={`chat${activeId ? ' has-open' : ''}`}>
    <aside className="chat-list">
      <div className="chat-list-head">
        <div className="chat-search">
          <Search size={15} />
          <input value={search} onChange={event => setSearch(event.target.value)}
            placeholder="Search conversations" aria-label="Search conversations" />
        </div>
        <button type="button" className="icon-btn" title="Start a conversation"
          aria-label="Start a conversation" onClick={() => setStarting(true)}>
          <Plus size={17} />
        </button>
      </div>

      {totalUnread > 0 && (
        <p className="chat-unread-total">{totalUnread} unread message{totalUnread === 1 ? '' : 's'}</p>
      )}

      <div className="chat-threads">
        {shown.map(conversation => (
          <button type="button" key={conversation.id}
            className={`chat-thread${conversation.id === activeId ? ' is-open' : ''}`}
            onClick={() => openConversation(conversation.id)}>
            <span className="chat-avatar">
              {conversation.kind === 'Group'
                ? <span className="chat-group-mark"><Users size={16} /></span>
                : <Avatar name={conversation.name} />}
              {conversation.kind === 'Direct' && conversation.online && <i className="chat-dot" title="Online" />}
            </span>
            <span className="chat-thread-body">
              <strong>{conversation.name}</strong>
              <small>
                {typing[conversation.id]
                  ? <em className="chat-typing">{typing[conversation.id]} is typing…</em>
                  : conversation.lastBody
                    ? `${conversation.lastSenderId === user.id ? 'You: ' : ''}${conversation.lastDeletedAt ? 'Message withdrawn' : conversation.lastBody}`
                    : 'No messages yet'}
              </small>
            </span>
            <span className="chat-thread-meta">
              {conversation.lastMessageAt && <time>{clockTime(conversation.lastMessageAt)}</time>}
              {Number(conversation.unread) > 0 && <b className="chat-count">{conversation.unread}</b>}
            </span>
          </button>
        ))}
        {!shown.length && <p className="empty-state">
          No conversations yet. Press <b>+</b> to start one.
        </p>}
      </div>
    </aside>

    <section className="chat-thread-view">
      {!active ? (
        <div className="chat-empty">
          <Users size={30} />
          <strong>Choose a conversation</strong>
          <p>Or start a new one. Messages stay in the system, so what was agreed is on the record.</p>
        </div>
      ) : <>
        <header className="chat-head">
          <button type="button" className="chat-back icon-btn" onClick={() => setActiveId(null)}
            aria-label="Back to conversations"><ArrowLeft size={17} /></button>
          <div className="chat-head-who">
            <strong>{active.name}</strong>
            <small>
              {active.kind === 'Group'
                ? `${active.members?.length || 0} people${active.topic ? ` · ${active.topic}` : ''}`
                : active.online ? <span className="chat-online">Online</span> : lastSeen(active.lastActiveAt)}
            </small>
          </div>
          {active.kind === 'Group' && (
            <div className="chat-head-members">
              {active.members?.slice(0, 5).map(member => (
                <span key={member.id} title={`${member.name}${member.online ? ' · online' : ''}`}
                  className={member.online ? 'is-online' : ''}>
                  <Avatar name={member.name} />
                </span>
              ))}
            </div>
          )}
        </header>

        <div className="chat-messages">
          {messages.map((message, index) => {
            const mine = message.senderId === user.id;
            const previous = messages[index - 1];
            const newDay = !previous || dayLabel(previous.createdAt) !== dayLabel(message.createdAt);
            const runOn = previous && previous.senderId === message.senderId && !newDay;
            return <React.Fragment key={message.id}>
              {newDay && <div className="chat-day"><span>{dayLabel(message.createdAt)}</span></div>}
              <div className={`chat-bubble${mine ? ' is-mine' : ''}${runOn ? ' is-runon' : ''}`}>
                {!mine && !runOn && active.kind === 'Group' && (
                  <span className="chat-from">{message.senderName}</span>
                )}
                {message.deletedAt
                  ? <p className="chat-withdrawn">This message was withdrawn</p>
                  : <p>{message.body}</p>}
                <span className="chat-meta">
                  <time>{clockTime(message.createdAt)}</time>
                  {mine && !message.deletedAt && (
                    <Ticks status={message.status} readBy={message.readBy} recipients={message.recipients} />
                  )}
                  {mine && !message.deletedAt && (
                    <button type="button" className="chat-withdraw" title="Withdraw this message"
                      aria-label="Withdraw this message"
                      onClick={() => del(`/chat/messages/${message.id}`).catch(() => {})}>
                      <Trash2 size={12} />
                    </button>
                  )}
                </span>
              </div>
            </React.Fragment>;
          })}
          {typing[activeId] && <div className="chat-bubble chat-typing-bubble"><p>{typing[activeId]} is typing…</p></div>}
          <div ref={bottom} />
        </div>

        {error && <p className="form-error chat-error">{error}</p>}

        <form className="chat-compose" onSubmit={send}>
          <textarea value={draft} rows={1} placeholder="Write a message"
            onChange={event => onType(event.target.value)}
            onKeyDown={event => {
              /* Enter sends, shift+Enter starts a line — what everybody expects. */
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(event); }
            }} />
          <button type="submit" className="primary" disabled={sending || !draft.trim()}
            aria-label="Send"><Send size={17} /></button>
        </form>
      </>}
    </section>

    {starting && <StartConversation people={people} onPick={startDirect}
      onGroup={() => { setStarting(false); setMakingGroup(true); }}
      onClose={() => setStarting(false)} />}
    {makingGroup && <NewGroup people={people}
      onDone={async id => { setMakingGroup(false); await loadConversations(); openConversation(id); }}
      onClose={() => setMakingGroup(false)} />}
  </div>;
}

function StartConversation({ people, onPick, onGroup, onClose }) {
  const [term, setTerm] = useState('');
  const shown = people.filter(person =>
    `${person.name} ${person.role}`.toLowerCase().includes(term.trim().toLowerCase()));

  return <div className="chat-picker-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="chat-picker" role="dialog" aria-label="Start a conversation">
      <div className="chat-picker-head">
        <strong>Start a conversation</strong>
        <button type="button" onClick={onClose} aria-label="Close"><X size={17} /></button>
      </div>
      <button type="button" className="chat-new-group" onClick={onGroup}>
        <span className="chat-group-mark"><Users size={17} /></span>
        <span><strong>New group</strong><small>For a site team, or anybody who needs the same message</small></span>
      </button>
      <div className="chat-search chat-picker-search">
        <Search size={15} />
        <input autoFocus value={term} onChange={e => setTerm(e.target.value)}
          placeholder="Search people" aria-label="Search people" />
      </div>
      <div className="chat-people">
        {shown.map(person => (
          <button type="button" key={person.id} onClick={() => onPick(person.id)}>
            <span className="chat-avatar"><Avatar name={person.name} />
              {person.online && <i className="chat-dot" />}</span>
            <span><strong>{person.name}</strong><small>{person.role}</small></span>
            <em>{person.online ? 'Online' : lastSeen(person.lastActiveAt)}</em>
          </button>
        ))}
        {!shown.length && <p className="empty-state">Nobody matches that.</p>}
      </div>
    </div>
  </div>;
}

function NewGroup({ people, onDone, onClose }) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [picked, setPicked] = useState([]);
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const shown = people.filter(person =>
    `${person.name} ${person.role}`.toLowerCase().includes(term.trim().toLowerCase()));
  const toggle = id => setPicked(current =>
    (current.includes(id) ? current.filter(one => one !== id) : [...current, id]));

  const create = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const result = await post('/chat/groups',
        { name: name.trim(), topic: topic.trim() || undefined, memberIds: picked });
      onDone(result.id);
    } catch (failure) { setError(failure.message); setBusy(false); }
  };

  return <div className="chat-picker-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <form className="chat-picker" onSubmit={create} aria-label="New group">
      <div className="chat-picker-head">
        <strong>New group</strong>
        <button type="button" onClick={onClose} aria-label="Close"><X size={17} /></button>
      </div>
      <label className="chat-field">Group name<abbr className="req" title="This field is required">*</abbr>
        <input value={name} onChange={e => setName(e.target.value)} required maxLength={120}
          placeholder="Kaduwela site team" />
      </label>
      <label className="chat-field">What it is for
        <input value={topic} onChange={e => setTopic(e.target.value)} maxLength={300}
          placeholder="Day to day coordination" />
      </label>
      <div className="chat-search chat-picker-search">
        <Search size={15} />
        <input value={term} onChange={e => setTerm(e.target.value)}
          placeholder="Search people" aria-label="Search people" />
      </div>
      <div className="chat-people">
        {shown.map(person => (
          <button type="button" key={person.id} onClick={() => toggle(person.id)}
            className={picked.includes(person.id) ? 'is-picked' : ''}
            aria-pressed={picked.includes(person.id)}>
            <span className="chat-pick">{picked.includes(person.id) ? <Check size={13} /> : null}</span>
            <span><strong>{person.name}</strong><small>{person.role}</small></span>
          </button>
        ))}
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="chat-picker-foot">
        <span>{picked.length} chosen</span>
        <button type="submit" className="primary" disabled={busy || !name.trim() || !picked.length}>
          {busy ? 'Creating…' : 'Create group'}
        </button>
      </div>
    </form>
  </div>;
}
