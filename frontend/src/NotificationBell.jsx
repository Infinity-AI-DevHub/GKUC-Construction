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
export default function NotificationBell({ notifications, reload, onViewAll, placement = 'bar' }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef(null);

  const unread = notifications.filter(item => item.status !== 'Read');
  const preview = [...unread, ...notifications.filter(item => item.status === 'Read')].slice(0, PREVIEW_COUNT);

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

  const markRead = async alert => {
    if (alert.status !== 'Read') {
      await post(`/notifications/${alert.id}/read`);
      await reload();
    }
  };

  const markAll = async () => {
    await post('/notifications/read-all');
    await reload();
  };

  const viewAll = () => {
    setOpen(false);
    onViewAll();
  };

  return <div className={`bell-wrap ${placement}`} ref={wrap}>
    <button className="alert-button" aria-label={`${unread.length} open alerts`} aria-expanded={open}
      title={`${unread.length} open alerts`} onClick={() => setOpen(current => !current)}>
      <Bell size={18} /><span>Alerts</span>{unread.length > 0 && <i />}
    </button>

    {open && <div className="bell-menu">
      <div className="bell-menu-head">
        <h2>Notifications</h2>
        {unread.length > 0 && <button onClick={markAll}>Mark all read</button>}
      </div>

      <div className="bell-menu-list">
        {preview.map(alert => (
          <button className={`bell-item ${alert.status === 'Read' ? 'read' : ''}`} key={alert.id} onClick={() => markRead(alert)}>
            <Badge tone={severityTone(alert.severity)}>{alert.severity}</Badge>
            <strong>{alert.title}</strong>
            <small>{when(alert.createdAt)}</small>
            <p>{alert.message}</p>
          </button>
        ))}
        {!preview.length && <p className="bell-empty">Nothing needs attention.</p>}
      </div>

      <button className="bell-menu-foot" onClick={viewAll}>
        View all notifications{notifications.length > PREVIEW_COUNT ? ` (${notifications.length})` : ''}
      </button>
    </div>}
  </div>;
}
