import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query } from '../db.js';
import { auth, permit, roles, wrap } from '../lib/http.js';
import { FOLDERS, allowedExtensions, MAX_UPLOAD_BYTES, readUpload, remove, storageDriver, store } from '../lib/storage.js';

const router = Router();

/** Uploading against a record needs the same permission as editing that record. */
const WRITERS = {
  task: roles.site,
  project: roles.projects,
  employee: roles.hr,
  report: roles.site,
  vehicle: roles.transport,
  equipment: roles.projects
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

router.get('/:ownerType/:ownerId', auth, wrap(async (req, res) => {
  if (!FOLDERS.includes(req.params.ownerType)) return res.status(404).json({ error: 'Unknown record type' });
  res.json(await listAttachments(req.params.ownerType, req.params.ownerId));
}));

/**
 * Stores the file first, then records it. A failed database write removes the object
 * again, so storage never accumulates files that nothing points at.
 */
router.post('/:ownerType/:ownerId', auth, wrap(async (req, res, next) => {
  const { ownerType, ownerId } = req.params;
  if (!FOLDERS.includes(ownerType)) return res.status(404).json({ error: 'Unknown record type' });
  if (!WRITERS[ownerType].includes(req.user.role)) {
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

router.delete('/:id', auth, permit(roles.projects), wrap(async (req, res) => {
  const attachment = await getOne('SELECT * FROM attachments WHERE id=?', [req.params.id]);
  if (!attachment) return res.status(404).json({ error: 'Attachment not found' });
  await query('DELETE FROM attachments WHERE id=?', [attachment.id]);
  await remove(attachment.storage_key).catch(() => {});
  await audit(pool, req.user.id, 'DELETE', `${attachment.owner_type}_attachment`, attachment.id, attachment, null, req.ip);
  res.status(204).end();
}));

export default router;
