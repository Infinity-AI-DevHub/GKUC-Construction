import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, FolderPlus, Images, Trash2, Upload, X } from 'lucide-react';
import { api, del, fileSize, post } from './api.js';

/**
 * The site's photographic record.
 *
 * GKUC photograph a plot before anything is touched, then through every stage to handover,
 * so that what the ground looked like on any given day can be shown rather than argued
 * about. The gallery is built around that: photographs are filed in folders the site team
 * name themselves, and every one carries the moment it was received — set by the server,
 * shown here, and editable by nobody.
 */

const THUMB_EDGE = 480;
const THUMB_QUALITY = 0.72;

/**
 * A small preview drawn in the browser and sent alongside the original.
 *
 * Site photographs come off a phone at several megabytes each; a folder of eighty would be
 * hundreds of megabytes to draw a grid of thumbnails. The full-size image is still what is
 * stored as the record — this is only what the grid shows.
 */
async function makeThumbnail(file) {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMB_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', THUMB_QUALITY));
  } catch {
    /* A format the browser will not decode still uploads; it simply has no preview. */
    return null;
  }
}

/** Photographs are fetched with the session, so the browser cannot load them by URL alone. */
function usePhotoSource(id, size) {
  const [source, setSource] = useState(null);
  useEffect(() => {
    let live = true;
    let made = null;
    const token = sessionStorage.getItem('gkuc-token');
    fetch(`/api/gallery/photos/${id}/file${size ? `?size=${size}` : ''}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
      .then(response => (response.ok ? response.blob() : Promise.reject(new Error('unavailable'))))
      .then(blob => {
        if (!live) return;
        made = URL.createObjectURL(blob);
        setSource(made);
      })
      .catch(() => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [id, size]);
  return source;
}

const stamp = value => new Date(value).toLocaleString('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
});

export default function ProjectGallery({ projectId, canManage }) {
  const [folders, setFolders] = useState([]);
  const [unfiled, setUnfiled] = useState(null);
  const [open, setOpen] = useState(undefined);   /* undefined = folder list, otherwise id|null */
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState(null);
  const [camera, setCamera] = useState(false);
  const fileInput = useRef(null);

  const loadFolders = () => api(`/projects/${projectId}/gallery/folders`)
    .then(body => { setFolders(body.folders); setUnfiled(body.unfiled); })
    .catch(failure => setError(failure.message));

  const loadPhotos = folderId => api(
    `/projects/${projectId}/gallery/photos?folderId=${folderId === null ? 'none' : folderId}`)
    .then(setPhotos)
    .catch(failure => setError(failure.message));

  useEffect(() => { loadFolders(); }, [projectId]);
  useEffect(() => { if (open !== undefined) loadPhotos(open); }, [open, projectId]);

  const send = async files => {
    setError('');
    const list = [...files].filter(file => file.type.startsWith('image/'));
    if (!list.length) return;
    let done = 0;
    for (const file of list) {
      setBusy(`Uploading ${done + 1} of ${list.length}…`);
      const form = new FormData();
      form.append('file', file);
      const thumb = await makeThumbnail(file);
      if (thumb) form.append('thumbnail', new File([thumb], 'thumb.jpg', { type: 'image/jpeg' }));
      if (open !== undefined && open !== null) form.append('folderId', String(open));
      try {
        const token = sessionStorage.getItem('gkuc-token');
        const response = await fetch(`/api/projects/${projectId}/gallery/photos`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          body: form
        });
        if (!response.ok) {
          const body = await response.json().catch(() => ({}));
          throw new Error(body.error || 'That photo could not be saved');
        }
        done += 1;
      } catch (failure) {
        setError(`${file.name}: ${failure.message}`);
        break;
      }
    }
    setBusy('');
    await loadFolders();
    if (open !== undefined) await loadPhotos(open);
  };

  const withdraw = async photo => {
    const reason = window.prompt('Why is this photo being withdrawn? It stays on the record either way.');
    if (reason === null) return;
    try {
      await del(`/gallery/photos/${photo.id}?reason=${encodeURIComponent(reason)}`);
      setViewing(null);
      await loadFolders();
      await loadPhotos(open);
    } catch (failure) { setError(failure.message); }
  };

  /* ------------------------------------------------------------------ folder list */
  if (open === undefined) {
    return <div className="gallery">
      <div className="gallery-bar">
        <div>
          <h3>Site gallery</h3>
          <p>Every photograph keeps the date and time it was received. That stamp cannot be changed.</p>
        </div>
        {canManage && <NewFolder projectId={projectId} onDone={loadFolders} onError={setError} />}
      </div>
      {error && <p className="form-error">{error}</p>}

      <div className="folder-grid">
        {unfiled && <FolderCard folder={unfiled} onOpen={() => setOpen(null)} />}
        {folders.map(folder => <FolderCard key={folder.id} folder={folder} onOpen={() => setOpen(folder.id)} />)}
        {!folders.length && !unfiled && <p className="attachment-empty">
          <Images size={15} /> No photographs yet. Make a folder — “Before works”, “Foundations”, “Handover” —
          and start the record.
        </p>}
      </div>
    </div>;
  }

  /* ---------------------------------------------------------------- inside a folder */
  const folder = open === null ? { name: 'Unfiled' } : folders.find(row => row.id === open) || {};

  return <div className="gallery">
    <div className="gallery-bar">
      <div>
        <button type="button" className="link-button" onClick={() => setOpen(undefined)}>← All folders</button>
        <h3>{folder.name}</h3>
        <p>{photos.length} photograph{photos.length === 1 ? '' : 's'}</p>
      </div>
      {canManage && <div className="gallery-actions">
        <input ref={fileInput} type="file" accept="image/*" multiple hidden
          onChange={event => { send(event.target.files); event.target.value = ''; }} />
        <button type="button" className="secondary" onClick={() => fileInput.current?.click()}>
          <Upload size={15} />Add photos
        </button>
        <button type="button" className="secondary" onClick={() => setCamera(true)}>
          <Camera size={15} />Capture
        </button>
      </div>}
    </div>

    {busy && <p className="form-success">{busy}</p>}
    {error && <p className="form-error">{error}</p>}

    <div className="photo-grid">
      {photos.map(photo => <PhotoTile key={photo.id} photo={photo} onOpen={() => setViewing(photo)} />)}
      {!photos.length && !busy && <p className="attachment-empty"><Images size={15} /> Nothing filed here yet.</p>}
    </div>

    {viewing && <Lightbox photo={viewing} canManage={canManage}
      onClose={() => setViewing(null)} onWithdraw={() => withdraw(viewing)} />}
    {camera && <CameraCapture onClose={() => setCamera(false)}
      onCapture={async blob => { setCamera(false); await send([new File([blob], `capture-${Date.now()}.jpg`, { type: 'image/jpeg' })]); }} />}
  </div>;
}

function FolderCard({ folder, onOpen }) {
  const cover = folder.coverId ? <CoverImage id={folder.coverId} /> : <span className="folder-blank"><Images size={22} /></span>;
  return <button type="button" className="folder-card" onClick={onOpen}>
    {cover}
    <strong>{folder.name}</strong>
    <small>{folder.photos} photo{Number(folder.photos) === 1 ? '' : 's'}
      {folder.firstPhoto ? ` · from ${stamp(folder.firstPhoto).split(',')[0]}` : ''}</small>
  </button>;
}

function CoverImage({ id }) {
  const source = usePhotoSource(id, 'thumb');
  return source
    ? <img className="folder-cover" src={source} alt="" />
    : <span className="folder-blank" aria-busy="true" />;
}

function PhotoTile({ photo, onOpen }) {
  const source = usePhotoSource(photo.id, 'thumb');
  return <button type="button" className="photo-tile" onClick={onOpen}>
    {source ? <img src={source} alt={photo.caption || photo.filename} /> : <span className="photo-loading" />}
    <span className="photo-stamp">{stamp(photo.capturedAt)}</span>
  </button>;
}

function Lightbox({ photo, canManage, onClose, onWithdraw }) {
  const source = usePhotoSource(photo.id, null);
  useEffect(() => {
    const onKey = event => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /*
   * Rendered at the top of the document rather than inside the project dialog.
   *
   * That dialog carries a backdrop-filter, which makes it a containing block: a fixed
   * overlay nested inside it is fixed to the dialog, not the window, so the photograph and
   * its details ended up cropped to a panel a third of the screen wide.
   */
  return createPortal(<div className="lightbox" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="lightbox-inner">
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
      {source ? <img src={source} alt={photo.caption || photo.filename} /> : <p className="photo-loading-text">Loading…</p>}
      <div className="lightbox-meta">
        <strong>{photo.caption || photo.filename}</strong>
        {/* The point of the whole feature: when this was taken into the record, fixed. */}
        <span><b>Recorded {stamp(photo.capturedAt)}</b> · by {photo.uploadedBy} · {fileSize(photo.size)}</span>
        <small title="Fingerprint of the image as it was received">SHA-256 {photo.checksum?.slice(0, 24)}…</small>
        {photo.removedAt && <em>Withdrawn {stamp(photo.removedAt)} by {photo.removedBy}
          {photo.removedReason ? ` — ${photo.removedReason}` : ''}</em>}
        {canManage && !photo.removedAt && <button type="button" className="secondary" onClick={onWithdraw}>
          <Trash2 size={15} />Withdraw from gallery
        </button>}
      </div>
    </div>
  </div>, document.body);
}

/** Live capture, so a photograph can be taken without leaving the site record. */
function CameraCapture({ onCapture, onClose }) {
  const video = useRef(null);
  const [error, setError] = useState('');
  const streamRef = useRef(null);

  useEffect(() => {
    let live = true;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then(stream => {
        if (!live) { stream.getTracks().forEach(track => track.stop()); return; }
        streamRef.current = stream;
        if (video.current) video.current.srcObject = stream;
      })
      .catch(() => setError('No camera is available, or permission was refused. Use “Add photos” instead.'));
    return () => { live = false; streamRef.current?.getTracks().forEach(track => track.stop()); };
  }, []);

  const shoot = () => {
    const element = video.current;
    if (!element) return;
    const canvas = document.createElement('canvas');
    canvas.width = element.videoWidth;
    canvas.height = element.videoHeight;
    canvas.getContext('2d').drawImage(element, 0, 0);
    canvas.toBlob(blob => blob && onCapture(blob), 'image/jpeg', 0.92);
  };

  return createPortal(<div className="lightbox" onMouseDown={event => event.target === event.currentTarget && onClose()}>
    <div className="lightbox-inner camera">
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close"><X size={20} /></button>
      {error ? <p className="form-error">{error}</p> : <video ref={video} autoPlay playsInline muted />}
      {!error && <button type="button" className="primary shutter" onClick={shoot}><Camera size={17} />Take photo</button>}
    </div>
  </div>, document.body);
}

function NewFolder({ projectId, onDone, onError }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');

  const create = async event => {
    event.preventDefault();
    if (!name.trim()) return;
    try {
      await post(`/projects/${projectId}/gallery/folders`, { name: name.trim() });
      setName('');
      setNaming(false);
      await onDone();
    } catch (failure) { onError(failure.message); }
  };

  if (!naming) {
    return <button type="button" className="secondary" onClick={() => setNaming(true)}>
      <FolderPlus size={15} />New folder
    </button>;
  }
  return <form className="checklist-add" onSubmit={create}>
    <input autoFocus value={name} onChange={event => setName(event.target.value)}
      placeholder="Before works, Foundations, Handover…" />
    <button className="primary" type="submit">Create</button>
    <button className="secondary" type="button" onClick={() => setNaming(false)}>Cancel</button>
  </form>;
}
