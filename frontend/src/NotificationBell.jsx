import React, { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import { post } from './api.js';
import { Badge } from './ui.jsx';

const PREVIEW_COUNT = 6;
const severityTone = severity => (severity === 'Critical' ? 'at-risk' : severity === 'Warning' ? 'watch' : 'low');

const when = value => {
  const minutes = Math.round((Date.now() - new Date(value)) / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  return new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};

/**
 * The alert bell and its dropdown. Shown in the top bar on small screens and in the
 * navigation bar on desktop, so the count is always visible without opening a page.
 */
export default function NotificationBell({ notifications, reminders = [], reload, onViewAll, onViewReminders, onOpenCase, canOpenCase, placement = 'bar' }) {
  const [open, setOpen] = useState(false);
  const [busy,setBusy] = useState(null);
  const [error,setError] = useState('');
  const wrap = useRef(null);

  const openCases = notifications.filter(item => item.status !== 'Resolved' && (!item.snoozedUntil || new Date(item.snoozedUntil) <= new Date()));
  const preview = openCases.slice(0, PREVIEW_COUNT);

  /* Clicking anywhere else, or pressing Escape, closes the dropdown. */
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = event => { if (!wrap.current?.contains(event.target)) setOpen(false); };
    const onKey = event => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const viewAll = () => {
    setOpen(false);
    onViewAll?.();
  };

  const viewReminder = async id => {
    setOpen(false);
    onViewReminders();
    try {
      await post(`/notifications/${id}/read`);
      await reload();
    } catch {
      // Keep the notification unread if acknowledgement fails.
    }
  };

  const caseAction = async (alert,action) => {
    setBusy(alert.id);setError('');
    try {
      if (action==='open') await onOpenCase(alert);
      else {
        await post('/notification-cases/'+alert.id+'/actions',action==='snooze'
          ? {action,until:new Date(Date.now()+86400000).toISOString()} : {action});
        await reload();
      }
    } catch (failure) { setError(failure.message); }
    finally { setBusy(null); }
  };

  const attentionLabel = `${openCases.length} open cases, ${reminders.length} unread reminders`;
  return <div className={`bell-wrap ${placement}`} ref={wrap}>
    <button className="alert-button" aria-label={attentionLabel} aria-expanded={open}
      title={attentionLabel} onClick={() => setOpen(current => !current)}>
      <Bell size={18} /><span>Notifications</span>{(openCases.length > 0 || reminders.length > 0) && <i />}
    </button>

    {open && <div className="bell-menu">
      <div className="bell-menu-head">
        <h2>Notifications</h2>
      </div>

      <div className="bell-menu-list">
        {reminders.slice(0, PREVIEW_COUNT).map(reminder => <button className="bell-item"
          key={`reminder-${reminder.id}`} onClick={() => viewReminder(reminder.id)}>
          <Badge tone="low">Reminder</Badge>
          <strong>{reminder.title}</strong>
          <small>{when(reminder.createdAt)}</small>
          <p>{reminder.message}</p>
        </button>)}
        {error && <p className="form-error" role="alert">{error}</p>}
        {preview.map(alert => <article className="bell-item bell-case" key={alert.id}>
          <Badge tone={severityTone(alert.severity)}>{alert.severity}</Badge>
          <strong>{alert.title}</strong>
          <small>{alert.status}{alert.dueAt?' · Due '+new Date(alert.dueAt).toLocaleDateString('en-GB'):''} · {when(alert.createdAt)}</small>
          <p>{alert.message}</p>
          <div className="bell-case-actions">
            {canOpenCase?.(alert) && <button type="button" className="secondary" disabled={busy===alert.id}
              onClick={()=>caseAction(alert,'open')}>Open record</button>}
            {!alert.assignedUserId && <button type="button" className="secondary" disabled={busy===alert.id}
              onClick={()=>caseAction(alert,'claim')}>Take ownership</button>}
            <button type="button" className="secondary" disabled={busy===alert.id}
              onClick={()=>caseAction(alert,'snooze')}>Snooze 24 hours</button>
          </div>
        </article>)}
        {!preview.length && !reminders.length && <p className="bell-empty">Nothing needs attention.</p>}
      </div>

      {onViewAll && <button className="bell-menu-foot" onClick={viewAll}>
        Manage cases{notifications.length > PREVIEW_COUNT ? ` (${notifications.length})` : ''}
      </button>}
    </div>}
  </div>;
}
