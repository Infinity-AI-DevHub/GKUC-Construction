import React, { useEffect, useRef, useState } from 'react';
import { FileText, Paperclip, Trash2, Upload } from 'lucide-react';
import { api, del, fileSize, shortDate, upload } from './api.js';
import { Badge } from './ui.jsx';

/**
 * Files attached to a record. Used for task photos, project and employee documents, and
 * daily-report site evidence — one component so every module handles files identically.
 */
export default function Attachments({
  ownerType,
  ownerId,
  title = 'Attachments',
  canUpload = true,
  canDelete = false,
  withCategory = false,
  withExpiry = false,
  onChange
}) {
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [meta, setMeta] = useState({ title: '', category: '', expiryDate: '' });
  const input = useRef(null);

  const load = () => api(`/uploads/${ownerType}/${ownerId}`).then(setItems).catch(() => setItems([]));
  useEffect(() => { load(); }, [ownerType, ownerId]);

  const send = async event => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      await upload(ownerType, ownerId, file, meta);
      setMeta({ title: '', category: '', expiryDate: '' });
      await load();
      onChange?.();
    } catch (failure) {
      setError(failure.message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const removeItem = async id => {
    if (!window.confirm('Remove this file? It is deleted from storage as well.')) return;
    try {
      await del(`/uploads/${id}`);
      await load();
      onChange?.();
    } catch (failure) { setError(failure.message); }
  };

  return <section className="attachments">
    <div className="attachments-head">
      <h2>{title}</h2>
      {canUpload && <label className="secondary attachment-add">
        <Upload size={15} />{busy ? 'Uploading…' : 'Add file'}
        <input ref={input} type="file" onChange={send} disabled={busy} hidden />
      </label>}
    </div>

    {canUpload && (withCategory || withExpiry) && <div className="attachment-meta">
      <label>Title
        <input value={meta.title} onChange={event => setMeta({ ...meta, title: event.target.value })} placeholder="Optional" />
      </label>
      {withCategory && <label>Category
        <input value={meta.category} onChange={event => setMeta({ ...meta, category: event.target.value })} placeholder="Drawing, contract, permit" />
      </label>}
      {withExpiry && <label>Expires on
        <input type="date" value={meta.expiryDate} onChange={event => setMeta({ ...meta, expiryDate: event.target.value })} />
      </label>}
    </div>}

    {error && <p className="form-error">{error}</p>}

    <div className="attachment-list">
      {items.map(item => <div className="attachment-item" key={item.id}>
        {item.mime.startsWith('image/')
          ? <a href={item.url} target="_blank" rel="noreferrer"><img src={item.url} alt={item.title} /></a>
          : <a className="attachment-icon" href={item.url} target="_blank" rel="noreferrer"><FileText size={20} /></a>}
        <div>
          <strong>{item.title || item.filename}</strong>
          <small>{fileSize(item.size)} · {item.uploadedBy} · {shortDate(item.createdAt)}</small>
          {item.category && <Badge tone="low">{item.category}</Badge>}
          {item.expiryDate && <Badge tone={new Date(item.expiryDate) < new Date() ? 'at-risk' : 'watch'}>
            Expires {shortDate(item.expiryDate)}
          </Badge>}
        </div>
        {canDelete && <button className="icon-btn" onClick={() => removeItem(item.id)} title="Remove file"><Trash2 size={15} /></button>}
      </div>)}
      {!items.length && <p className="attachment-empty"><Paperclip size={14} /> No files attached yet.</p>}
    </div>
  </section>;
}
