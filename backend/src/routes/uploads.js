import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query } from '../db.js';
import { auth, can, permit, wrap } from '../lib/http.js';
import { FOLDERS, allowedExtensions, isLocalStore, localPathFor, MAX_UPLOAD_BYTES, readUpload, remove, storageDriver, store } from '../lib/storage.js';

const router = Router();

/** Uploading against a record needs the same permission as editing that record. */
const WRITERS = {
  task: 'site.tasks',
  project: 'projects.manage',
  employee: 'hr.manage',
  report: 'site.reports',
  vehicle: 'transport.manage',
  equipment: 'store.lending'
};

/**
 * Reading what is attached to a record needs the permission to see that record. An
 * employee's file is their contract and their identity documents; listing them is as
 * revealing as opening the employee page itself.
 */
const READERS = {
  task: ['site.tasks', 'projects.view'],
  project: ['projects.view'],
  employee: ['hr.view', 'hr.manage'],
  report: ['site.reports', 'projects.view'],
  vehicle: ['transport.view', 'transport.manage'],
  equipment: ['store.view', 'store.manage']
};

/** Each owner type points at the table its id must exist in. */
const OWNER_TABLES = {
  task: 'tasks', project: 'projects', employee: 'employees',
  report: 'daily_reports', vehicle: 'fleet', equipment: 'equipment'
};

const metaSchema = z.object({
  title: z.string().max(200).optional(),
  category: z.string().max(80).optional(),
  kind: z.enum(['File', 'Site photo']).optional(),
  expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
});

export const listAttachments = (ownerType, ownerId) => query(
  `SELECT a.id,a.url,a.filename,a.mime,a.size_bytes size,a.title,a.category,a.kind,a.expiry_date expiryDate,
     a.created_at createdAt,u.name uploadedBy
   FROM attachments a JOIN users u ON u.id=a.uploaded_by
   WHERE a.owner_type=? AND a.owner_id=? ORDER BY a.id DESC`, [ownerType, ownerId]
);

router.get('/limits', auth, (_req, res) => res.json({
  maxBytes: MAX_UPLOAD_BYTES,
  maxMb: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024),
  extensions: allowedExtensions(),
  driver: storageDriver
}));

/**
 * Serving the file itself, behind the same permission that governs seeing it listed.
 *
 * The store used to be mounted as plain static files, so an employee's contract or a
 * signed tender could be fetched by anyone holding the URL — no session, no permission,
 * and no way to withdraw access once someone had seen the link. The bytes now travel
 * through the same check as the listing, and the URL alone grants nothing.
 */
router.get('/file/:id', auth, wrap(async (req, res) => {
  const file = await getOne(
    'SELECT id,owner_type ownerType,owner_id ownerId,storage_key storageKey,filename,mime FROM attachments WHERE id=?',
    [req.params.id]);
  if (!file) return res.status(404).json({ error: 'File not found' });

  const readers = READERS[file.ownerType];
  if (!readers || !readers.some(key => can(req, key))) {
    return res.status(403).json({ error: 'You do not have permission to open this file' });
  }

  /*
   * Only the local store is served from here. When R2 is switched on, its bucket must stay
   * private and this branch must hand back a short-lived signed URL — a public bucket would
   * put the store back outside these checks, which is the hole this route exists to close.
   */
  if (!isLocalStore()) {
    return res.status(501).json({
      error: 'Object storage is enabled but signed downloads are not configured. '
        + 'Keep the bucket private and issue a signed URL here before using R2 in production.'
    });
  }

  res.type(file.mime);
  /* Attachment rather than inline: a stored HTML or SVG file rendered in place would run
     in this origin, which is the same as letting an uploader script the application. */
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.filename)}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(localPathFor(file.storageKey), error => {
    if (error && !res.headersSent) res.status(404).json({ error: 'File not found' });
  });
}));

router.get('/:ownerType/:ownerId', auth, wrap(async (req, res) => {
  if (!FOLDERS.includes(req.params.ownerType)) return res.status(404).json({ error: 'Unknown record type' });
  if (!READERS[req.params.ownerType].some(key => can(req, key))) {
    return res.status(403).json({ error: 'You do not have permission to see files on this record' });
  }
  res.json(await listAttachments(req.params.ownerType, req.params.ownerId));
}));

/**
 * Stores the file first, then records it. A failed database write removes the object
 * again, so storage never accumulates files that nothing points at.
 */
router.post('/:ownerType/:ownerId', auth, wrap(async (req, res, next) => {
  const { ownerType, ownerId } = req.params;
  if (!FOLDERS.includes(ownerType)) return res.status(404).json({ error: 'Unknown record type' });
  if (!can(req, WRITERS[ownerType])) {
    return res.status(403).json({ error: 'You do not have permission to attach files to this record' });
  }
  const owner = await getOne(`SELECT id FROM ${OWNER_TABLES[ownerType]} WHERE id=?`, [ownerId]);
  if (!owner) return res.status(404).json({ error: 'Record not found' });

  const { file, fields } = await readUpload(req);
  const meta = metaSchema.safeParse(fields);
  if (!meta.success) return res.status(400).json({ error: 'Invalid data', issues: meta.error.flatten() });

  const stored = await store({ folder: ownerType, filename: file.filename, mime: file.mime, buffer: file.buffer });
  try {
    const result = await query(`INSERT INTO attachments
      (owner_type,owner_id,storage_key,url,filename,mime,size_bytes,title,category,kind,expiry_date,uploaded_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [ownerType, ownerId, stored.key, stored.url, stored.filename, stored.mime, stored.size,
      meta.data.title || stored.filename, meta.data.category || null,
      meta.data.kind || (stored.mime.startsWith('image/') ? 'Site photo' : 'File'),
      meta.data.expiryDate || null, req.user.id]);
    await audit(pool, req.user.id, 'UPLOAD', `${ownerType}_attachment`, result.insertId, null,
      { filename: stored.filename, size: stored.size }, req.ip);
    res.status(201).json(await getOne(`SELECT a.id,a.url,a.filename,a.mime,a.size_bytes size,a.title,a.category,a.kind,
      a.expiry_date expiryDate,a.created_at createdAt,? uploadedBy FROM attachments a WHERE a.id=?`, [req.user.name, result.insertId]));
  } catch (error) {
    await remove(stored.key).catch(() => {});
    next(error);
  }
}));

/*
 * Removing a file needs the permission to edit the record it belongs to.
 *
 * This asked for projects.manage whatever the file was attached to, so a project
 * coordinator could permanently delete an employee's contract or a vehicle's insurance —
 * records in departments they have no authority over. The check now follows the owner
 * type, exactly as attaching one does.
 */
router.delete('/:id', auth, wrap(async (req, res) => {
  const attachment = await getOne('SELECT * FROM attachments WHERE id=?', [req.params.id]);
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
  const required = WRITERS[attachment.owner_type];
  if (!required || !can(req, required)) {
    return res.status(403).json({ error: 'You do not have permission to remove files from this record' });
  }
  await query('DELETE FROM attachments WHERE id=?', [attachment.id]);
  await remove(attachment.storage_key).catch(() => {});
  await audit(pool, req.user.id, 'DELETE', `${attachment.owner_type}_attachment`, attachment.id, attachment, null, req.ip);
  res.status(204).end();
}));

export default router;
