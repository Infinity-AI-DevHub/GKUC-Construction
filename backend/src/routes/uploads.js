import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query } from '../db.js';
import { auth, can, permit, wrap } from '../lib/http.js';
import { enqueue as enqueueOcr } from '../lib/ocr-queue.js';
import { allowedExtensions, isLocalStore, localPathFor, MAX_UPLOAD_BYTES, readUpload, remove, signedDownloadUrl, storageDriver, store } from '../lib/storage.js';

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

/*
 * The record types a file can be attached to. Deliberately its own list rather than the
 * storage folders: those include places the store writes to that are not attachment owners.
 */
const OWNER_TYPES = Object.keys(WRITERS);

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
/*
 * Declared above the /:ownerType/:ownerId routes on purpose. Express takes the first
 * match, and a two-segment path like /search/documents is otherwise read as an owner
 * type called "search" with a record id of "documents".
 */
/*
 * Searching inside documents.
 *
 * FULLTEXT in boolean mode, so a person can type what they remember of a document rather
 * than an exact phrase. Results are filtered to the record types the viewer may see: a
 * search must never become a way to learn the contents of a payslip or a contract that the
 * ordinary listing would refuse.
 */
/*
 * What a person typed, turned into something the full-text parser will accept.
 *
 * The search term used to be handed to MATCH ... IN BOOLEAN MODE exactly as typed, which
 * gets two things wrong. The punctuation in it is not punctuation to that parser, it is
 * operators: the hyphen means NOT, so searching for a reference like QUO-2026-0042 asked
 * for documents containing QUO but *not* 2026 and *not* 0042 — reliably excluding the one
 * document being looked for. Every reference this company issues is hyphenated. And an
 * expression the parser cannot read at all, which an email address or a stray +++ produces,
 * raised a syntax error that reached the person as "Unexpected server error".
 *
 * So the term is reduced to the words inside it and rebuilt: every word required, each
 * allowed to match on its prefix, which is how somebody half-remembering a file name
 * expects search to behave. Words shorter than the index's minimum are dropped because the
 * index does not hold them; requiring one would match nothing at all.
 */
const MIN_INDEXED_WORD = Number(process.env.FT_MIN_WORD_LEN || 3);

export function searchExpression(term) {
  const words = String(term).match(/[\p{L}\p{N}]+/gu) || [];
  const usable = words.filter(word => word.length >= MIN_INDEXED_WORD);
  return {
    words,
    usable,
    /* e.g. QUO-2026-0042 -> +QUO* +2026* +0042* */
    expression: usable.map(word => `+${word}*`).join(' ')
  };
}

router.get('/search/documents', auth, wrap(async (req, res) => {
  const term = String(req.query.q || '').trim();
  if (term.length < 3) return res.json({ term, results: [], note: 'Type at least three characters' });

  /* Permission per owner type, mirroring what the attachment listing itself allows. */
  const readable = Object.entries(READERS)
    .filter(([, keys]) => keys.some(key => req.user.permissions.includes(key)))
    .map(([type]) => type);
  if (!readable.length) return res.json({ term, results: [] });

  const { usable, expression } = searchExpression(term);
  if (!expression) {
    return res.json({
      term, results: [],
      note: `Use a word of at least ${MIN_INDEXED_WORD} letters or numbers`
    });
  }

  /* The excerpt is centred on the first real word, since the whole term as typed —
     punctuation and all — may not appear in the text verbatim. */
  const anchor = usable[0];

  const rows = await query(
    `SELECT a.id,a.owner_type ownerType,a.owner_id ownerId,a.filename,a.title,a.mime,
       t.source,t.pages,t.characters,
       MATCH(t.content) AGAINST (? IN BOOLEAN MODE) score,
       SUBSTRING(t.content, GREATEST(1, LOCATE(?, t.content) - 90), 260) excerpt
     FROM attachment_text t JOIN attachments a ON a.id=t.attachment_id
     WHERE a.owner_type IN (${readable.map(() => '?').join(',')})
       AND MATCH(t.content) AGAINST (? IN BOOLEAN MODE)
     ORDER BY score DESC LIMIT 50`,
    [expression, anchor, ...readable, expression]);

  res.json({ term, results: rows });
}));

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
   * Object storage answers with a link of its own rather than streaming through here. The
   * bucket stays private: the URL is signed for a few minutes, and the permission check
   * above is what decides whether one is issued at all.
   */
  if (!isLocalStore()) return res.redirect(302, signedDownloadUrl(file.storageKey));

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
  if (!OWNER_TYPES.includes(req.params.ownerType)) return res.status(404).json({ error: 'Unknown record type' });
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
  if (!OWNER_TYPES.includes(ownerType)) return res.status(404).json({ error: 'Unknown record type' });
  if (!can(req, WRITERS[ownerType])) {
    return res.status(403).json({ error: 'You do not have permission to attach files to this record' });
  }
  const owner = await getOne(`SELECT id FROM ${OWNER_TABLES[ownerType]} WHERE id=?`, [ownerId]);
  if (!owner) return res.status(404).json({ error: 'Record not found' });

  const { file, fields, discard } = await readUpload(req);
  const meta = metaSchema.safeParse(fields);
  if (!meta.success) {
    /* The bytes are already on disk; a rejected form must not leave them there. */
    await discard();
    return res.status(400).json({ error: 'Invalid data', issues: meta.error.flatten() });
  }

  let stored;
  try {
    stored = await store({
      folder: ownerType, filename: file.filename, mime: file.mime,
      path: file.path, head: file.head, size: file.size
    });
  } catch (error) {
    await discard();
    throw error;
  }
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
    /* Queued, not awaited: a scan takes minutes to read and the file is usable now. */
    await enqueueOcr(result.insertId, stored.mime).catch(() => {});
    res.status(201).json(await getOne(`SELECT a.id,a.url,a.filename,a.mime,a.size_bytes size,a.title,a.category,a.kind,
      a.expiry_date expiryDate,a.created_at createdAt,? uploadedBy FROM attachments a WHERE a.id=?`, [req.user.name, result.insertId]));
  } catch (error) {
    await remove(stored.key).catch(() => {});
    next(error);
  } finally {
    await discard();
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

/** Whether a document has been read yet, and what came of it. */
router.get('/:ownerType/:ownerId/text/:id', auth, wrap(async (req, res) => {
  const readers = READERS[req.params.ownerType];
  if (!readers || !readers.some(key => can(req, key))) {
    return res.status(403).json({ error: 'You do not have permission to see these files' });
  }
  const row = await getOne(
    `SELECT t.content,t.source,t.pages,t.characters,t.extracted_at extractedAt,
       j.status,j.detail
     FROM attachments a
     LEFT JOIN attachment_text t ON t.attachment_id=a.id
     LEFT JOIN ocr_jobs j ON j.attachment_id=a.id
     WHERE a.id=? AND a.owner_type=? AND a.owner_id=?`,
    [req.params.id, req.params.ownerType, req.params.ownerId]);
  if (!row) return res.status(404).json({ error: 'File not found' });
  res.json(row);
}));

export default router;
