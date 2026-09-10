import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Folder, FolderPlus, Upload, File, FileText, FileSpreadsheet, Image, Video, Archive, PenTool, ChevronRight, Users, Globe, Lock, Share2, Download, Trash2, X, Check, Link2, Search, UserPlus } from 'lucide-react';
import { api, post, del, fileSize, shortDate } from './api.js';
import { Avatar, useLiveList } from './ui.jsx';

/*
 * The company's document store.
 *
 * Folders on the left of the trail, contents below, and the sharing state visible on every
 * row — because the question people actually have about a file in a shared drive is not
 * "where is it" but "who else can see this". Leaving that a click away is how documents end
 * up somewhere their owner did not intend.
 */

const ICONS = {
  folder: Folder, drawing: PenTool, image: Image, video: Video, archive: Archive,
  pdf: FileText, document: FileText, sheet: FileSpreadsheet, slides: FileText, file: File
};

export default function Drive({ user }) {
  const [folder, setFolder] = useState(null);
  const [data, setData] = useState({ items: [], breadcrumb: [] });
  const [tab, setTab] = useState('Mine');
  const [shared, setShared] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [sharing, setSharing] = useState(null);
  const [search, setSearch] = useState('');
  const fileInput = useRef(null);

  const load = async () => {
    try {
      setError('');
      if (tab === 'Shared') setShared(await api('/drive/shared'));
      else setData(await api(`/drive${folder ? `?folder=${folder}` : ''}`));
    } catch (failure) { setError(failure.message); }
  };

  useLiveList(load);
  useEffect(() => { load(); }, [folder, tab]);

  const newFolder = async () => {
    const name = window.prompt('Name the folder');
    if (!name?.trim()) return;
    try { await post('/drive/folders', { name: name.trim(), parentId: folder }); await load(); }
    catch (failure) { setError(failure.message); }
  };

  const upload = async files => {
    setError('');
    for (const file of files) {
      setBusy(file.name);
      const form = new FormData();
      form.append('file', file);
      if (folder) form.append('parentId', String(folder));
      try {
        const response = await fetch('/api/drive/files', {
          method: 'POST',
          headers: { Authorization: `Bearer ${sessionStorage.getItem('gkuc-token')}` },
          body: form
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || `${file.name} could not be uploaded`);
        }
      } catch (failure) { setError(failure.message); }
    }
    setBusy('');
    await load();
  };

  /* Dropping files onto the window is how people expect a drive to work. */
  const [dragging, setDragging] = useState(false);
  const onDrop = event => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer?.files?.length) upload([...event.dataTransfer.files]);
  };

  const rows = tab === 'Shared' ? shared : data.items;
  const shown = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? rows.filter(one => one.name.toLowerCase().includes(term)) : rows;
  }, [rows, search]);

  const download = item => {
    const url = `/api/drive/items/${item.id}/download`;
    fetch(url, { headers: { Authorization: `Bearer ${sessionStorage.getItem('gkuc-token')}` } })
      .then(response => (response.ok ? response.blob() : Promise.reject(new Error('Could not download that'))))
      .then(blob => {
        const href = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = href;
        link.download = item.name;
        link.click();
        setTimeout(() => URL.revokeObjectURL(href), 30000);
      })
      .catch(failure => setError(failure.message));
  };

  return <div className={`drive${dragging ? ' is-dragging' : ''}`}
    onDragOver={event => { event.preventDefault(); setDragging(true); }}
    onDragLeave={() => setDragging(false)}
    onDrop={onDrop}>

    <div className="drive-bar">
      <div className="segments">
        {['Mine', 'Shared'].map(one => (
          <button type="button" key={one} className={tab === one ? 'active' : ''}
            onClick={() => { setTab(one); setFolder(null); }}>
            {one === 'Mine' ? 'My drive' : 'Shared with me'}
          </button>
        ))}
      </div>
      <label className="drive-search">
        <Search size={15} />
        <input value={search} onChange={event => setSearch(event.target.value)}
          placeholder="Search this folder" aria-label="Search" />
      </label>
      {tab === 'Mine' && <>
        <button type="button" className="secondary" onClick={newFolder}>
          <FolderPlus size={16} /> New folder
        </button>
        <button type="button" className="primary" onClick={() => fileInput.current?.click()}>
          <Upload size={16} /> Upload
        </button>
        <input ref={fileInput} type="file" multiple hidden
          onChange={event => { upload([...event.target.files]); event.target.value = ''; }} />
      </>}
    </div>

    {tab === 'Mine' && (
      <nav className="drive-trail" aria-label="Where you are">
        <button type="button" onClick={() => setFolder(null)}>My drive</button>
        {data.breadcrumb.map(step => (
          <React.Fragment key={step.id}>
            <ChevronRight size={14} />
            <button type="button" onClick={() => setFolder(step.id)}>{step.name}</button>
          </React.Fragment>
        ))}
      </nav>
    )}

    {error && <p className="form-error">{error}</p>}
    {busy && <p className="drive-busy">Uploading {busy}…</p>}

    {!shown.length && !busy && (
      <div className="drive-empty">
        <Folder size={28} />
        <strong>{search ? 'Nothing matches that' : tab === 'Shared' ? 'Nothing has been shared with you yet' : 'This folder is empty'}</strong>
        {tab === 'Mine' && !search && <p>Drop files here, or press Upload. Anything you put in is private
          to you until you share it.</p>}
      </div>
    )}

    <div className="drive-grid">
      {shown.map(item => {
        const Icon = ICONS[item.family] || File;
        return <div className={`drive-item is-${item.family}`} key={item.id}>
          <button type="button" className="drive-open"
            onClick={() => (item.kind === 'Folder' ? (setTab('Mine'), setFolder(item.id)) : download(item))}>
            <span className="drive-icon"><Icon size={20} /></span>
            <span className="drive-name">
              <strong>{item.name}</strong>
              <small>
                {item.kind === 'Folder'
                  ? `${item.children || 0} item${item.children === 1 ? '' : 's'}`
                  : fileSize(Number(item.sizeBytes) || 0)}
                {item.owner && item.ownerId !== user.id ? ` · ${item.owner}` : ''}
                {item.updatedAt ? ` · ${shortDate(item.updatedAt)}` : ''}
              </small>
            </span>
          </button>

          <span className="drive-state">
            {item.public
              ? <span className="drive-tag is-public" title="Anyone with the link can download this"><Globe size={12} /> Public</span>
              : item.visibility === 'Organisation'
                ? <span className="drive-tag is-org" title="Everybody in the company"><Users size={12} /> Company</span>
                : Number(item.sharedWith) > 0
                  ? <span className="drive-tag is-people" title={`${item.sharedWith} people`}><Users size={12} /> {item.sharedWith}</span>
                  : <span className="drive-tag is-private" title="Only you"><Lock size={12} /> Private</span>}
          </span>

          <span className="drive-tools">
            {item.kind === 'File' && (
              <button type="button" title="Download" aria-label={`Download ${item.name}`}
                onClick={() => download(item)}><Download size={15} /></button>
            )}
            <button type="button" title="Sharing" aria-label={`Sharing for ${item.name}`}
              onClick={() => setSharing(item)}><Share2 size={15} /></button>
            {item.ownerId === user.id && (
              <button type="button" title="Remove" aria-label={`Remove ${item.name}`}
                onClick={async () => {
                  if (!window.confirm(`Remove "${item.name}"? It goes to the bin, not away for good.`)) return;
                  try { await del(`/drive/items/${item.id}`); await load(); }
                  catch (failure) { setError(failure.message); }
                }}><Trash2 size={15} /></button>
            )}
          </span>
        </div>;
      })}
    </div>

    {dragging && <div className="drive-drop"><Upload size={26} /><strong>Drop to upload here</strong></div>}
    {sharing && <SharingPanel item={sharing} user={user}
      onClose={() => { setSharing(null); load(); }} />}
  </div>;
}

/*
 * Who can see this, in one place.
 *
 * Ordered from the least exposure to the most, so making something public is the last thing
 * on the panel rather than a switch beside the others — it deserves the pause.
 */
function SharingPanel({ item, user, onClose }) {
  const [detail, setDetail] = useState(null);
  const [people, setPeople] = useState([]);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState('View');
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = () => api(`/drive/items/${item.id}/sharing`).then(setDetail).catch(f => setError(f.message));
  useEffect(() => { load(); api('/chat/people').then(setPeople).catch(() => {}); }, [item.id]);

  const isOwner = detail && detail.ownerId === user.id;

  const change = async body => {
    try { await api(`/drive/items/${item.id}/sharing`, { method: 'PATCH', body: JSON.stringify(body) }); await load(); }
    catch (failure) { setError(failure.message); }
  };

  const publish = async () => {
    try { await post(`/drive/items/${item.id}/public`, {}); await load(); }
    catch (failure) { setError(failure.message); }
  };
  const unpublish = async () => {
    try { await del(`/drive/items/${item.id}/public`); await load(); }
    catch (failure) { setError(failure.message); }
  };

  const fullLink = detail?.publicLink ? `${window.location.origin}${detail.publicLink}` : null;

  return <div className="chat-picker-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="chat-picker drive-sharing" role="dialog" aria-label={`Sharing for ${item.name}`}>
      <div className="chat-picker-head">
        <strong>Who can see “{item.name}”</strong>
        <button type="button" onClick={onClose} aria-label="Close"><X size={17} /></button>
      </div>

      {error && <p className="form-error">{error}</p>}
      {!detail ? <p className="empty-state">Loading…</p> : <>
        <p className="drive-owner">Owned by {detail.owner}{isOwner ? ' — you' : ''}</p>

        {!isOwner && (
          <p className="drive-readonly">
            You can see this because it was shared with you. Only {detail.owner} can change
            who else gets in.
          </p>
        )}

        {detail.requests?.length > 0 && isOwner && (
          <div className="drive-requests">
            <strong>Waiting to be let in</strong>
            {detail.requests.map(request => (
              <div key={request.id}>
                <span><b>{request.name}</b> asked to {request.requestedRole.toLowerCase()}
                  {request.message ? ` — “${request.message}”` : ''}</span>
                <span className="drive-request-buttons">
                  <button type="button" className="secondary"
                    onClick={() => post(`/drive/requests/${request.id}/decide`, { grant: false }).then(load)}>
                    Refuse
                  </button>
                  <button type="button" className="primary"
                    onClick={() => post(`/drive/requests/${request.id}/decide`, { grant: true }).then(load)}>
                    <Check size={14} /> Let them in
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <fieldset className="drive-levels" disabled={!isOwner}>
          <legend>Who this is for</legend>
          {[
            ['Private', Lock, 'Only me', 'Nobody else can open it, whatever folder it sits in.'],
            ['People', Users, 'People I choose', 'Only the people named below.'],
            ['Organisation', Users, 'Everybody in the company', 'Anybody who can sign in to SiteOps.']
          ].map(([value, Icon, label, help]) => (
            <label key={value} className={detail.visibility === value ? 'is-on' : ''}>
              <input type="radio" name="visibility" checked={detail.visibility === value}
                onChange={() => change({ visibility: value })} />
              <Icon size={16} />
              <span><strong>{label}</strong><small>{help}</small></span>
            </label>
          ))}
          {detail.visibility === 'Organisation' && (
            <label className="drive-orgrole">
              Everybody can
              <select value={detail.orgRole} onChange={event => change({ orgRole: event.target.value })}>
                <option value="View">view it</option>
                <option value="Edit">view and change it</option>
              </select>
            </label>
          )}
        </fieldset>

        <div className="drive-people">
          <strong>People with access</strong>
          {detail.people.length ? detail.people.map(person => (
            <div key={person.userId}>
              <Avatar name={person.name} />
              <span><b>{person.name}</b><small>{person.position}</small></span>
              {isOwner ? <>
                <select value={person.role}
                  onChange={event => change({ add: [{ userId: person.userId, role: event.target.value }] })}>
                  <option value="View">Can view</option>
                  <option value="Edit">Can edit</option>
                </select>
                <button type="button" title="Remove" aria-label={`Remove ${person.name}`}
                  onClick={() => change({ remove: [person.userId] })}><X size={15} /></button>
              </> : <em>{person.role === 'Edit' ? 'Can edit' : 'Can view'}</em>}
            </div>
          )) : <p className="empty-state">Nobody yet.</p>}

          {isOwner && (
            <div className="drive-add">
              <UserPlus size={15} />
              <select value={pick} onChange={event => setPick(event.target.value)}>
                <option value="">Add somebody…</option>
                {people.filter(one => !detail.people.some(p => p.userId === one.id))
                  .map(one => <option key={one.id} value={one.id}>{one.name} — {one.role}</option>)}
              </select>
              <select value={role} onChange={event => setRole(event.target.value)}>
                <option value="View">Can view</option>
                <option value="Edit">Can edit</option>
              </select>
              <button type="button" className="secondary" disabled={!pick}
                onClick={() => { change({ add: [{ userId: Number(pick), role }] }); setPick(''); }}>Add</button>
            </div>
          )}
        </div>

        {item.kind === 'File' && (
          <div className={`drive-public${detail.publicLink ? ' is-on' : ''}`}>
            <div className="drive-public-head">
              <Globe size={17} />
              <div>
                <strong>Anyone with the link</strong>
                <small>{detail.publicLink
                  ? `Live. Downloaded ${detail.publicDownloads || 0} time${Number(detail.publicDownloads) === 1 ? '' : 's'}.`
                  : 'Off. Nobody outside the company can reach this.'}</small>
              </div>
              {isOwner && (detail.publicLink
                ? <button type="button" className="secondary" onClick={unpublish}>Turn off</button>
                : <button type="button" className="secondary" onClick={publish}>Create a link</button>)}
            </div>
            {detail.publicLink && <>
              <div className="drive-link">
                <Link2 size={14} />
                <input readOnly value={fullLink} onFocus={event => event.target.select()} />
                <button type="button" className="secondary" onClick={() => {
                  navigator.clipboard?.writeText(fullLink);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}>{copied ? 'Copied' : 'Copy'}</button>
              </div>
              <p className="drive-warning">
                Anybody holding this link can download the file without signing in, and can pass
                it on. It covers this file only — nothing else in the folder. Turn it off when it
                has served its purpose.
              </p>
            </>}
          </div>
        )}
      </>}
    </div>
  </div>;
}
