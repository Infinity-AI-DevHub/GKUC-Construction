import crypto from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query } from '../db.js';
import { auth, can, permit, validate, wrap } from '../lib/http.js';
import { isAllowedType, isLocalStore, localPathFor, readUpload, remove, signedDownloadUrl, store } from '../lib/storage.js';

const router = Router();

/*
 * The project gallery: the site's photographic record, from the bare plot to handover.
 *
 * Seeing it follows seeing the project. Adding to it, or withdrawing from it, needs
 * gallery.manage — a permission of its own so the MD decides who keeps the record, rather
 * than it falling to whoever happens to be able to edit a project.
 *
 * Nothing here accepts a timestamp. The moment a photo arrives is the server's to record,
 * and a trigger on the table refuses to let it move afterwards.
 */

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

const folderSelect = `SELECT f.id,f.name,f.description,f.created_at createdAt,u.name createdBy,
  (SELECT COUNT(*) FROM gallery_photos p WHERE p.folder_id=f.id AND p.removed_at IS NULL) photos,
  (SELECT MIN(p.captured_at) FROM gallery_photos p WHERE p.folder_id=f.id AND p.removed_at IS NULL) firstPhoto,
  (SELECT MAX(p.captured_at) FROM gallery_photos p WHERE p.folder_id=f.id AND p.removed_at IS NULL) lastPhoto,
  (SELECT p.id FROM gallery_photos p WHERE p.folder_id=f.id AND p.removed_at IS NULL
    ORDER BY p.captured_at DESC LIMIT 1) coverId
  FROM gallery_folders f JOIN users u ON u.id=f.created_by`;

const photoSelect = `SELECT p.id,p.folder_id folderId,p.filename,p.mime,p.size_bytes size,p.caption,
  p.checksum,p.captured_at capturedAt,p.removed_at removedAt,p.removed_reason removedReason,
  u.name uploadedBy,r.name removedBy,f.name folder
  FROM gallery_photos p JOIN users u ON u.id=p.uploaded_by
  LEFT JOIN users r ON r.id=p.removed_by
  LEFT JOIN gallery_folders f ON f.id=p.folder_id`;

const projectExists = async id => getOne('SELECT id,name FROM projects WHERE id=?', [id]);

/* ------------------------------------------------------------------------- Folders */

router.get('/projects/:projectId/gallery/folders', auth, permit('projects.view'), wrap(async (req, res) => {
  if (!await projectExists(req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const folders = await query(`${folderSelect} WHERE f.project_id=? ORDER BY f.name`, [req.params.projectId]);
  /* Photos taken before anyone made a folder still belong to the project, so they are
     offered as a folder of their own rather than being invisible. */
  const loose = await getOne(
    `SELECT COUNT(*) photos, MIN(captured_at) firstPhoto, MAX(captured_at) lastPhoto,
       (SELECT id FROM gallery_photos WHERE project_id=? AND folder_id IS NULL AND removed_at IS NULL
         ORDER BY captured_at DESC LIMIT 1) coverId
     FROM gallery_photos WHERE project_id=? AND folder_id IS NULL AND removed_at IS NULL`,
    [req.params.projectId, req.params.projectId]);
  res.json({ folders, unfiled: Number(loose.photos) ? { ...loose, id: null, name: 'Unfiled' } : null });
}));

router.post('/projects/:projectId/gallery/folders', auth, permit('gallery.manage'), validate(z.object({
  name: z.string().min(1).max(140),
  description: z.string().max(400).optional()
})), wrap(async (req, res) => {
  if (!await projectExists(req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  try {
    const result = await query(
      'INSERT INTO gallery_folders (project_id,name,description,created_by) VALUES (?,?,?,?)',
      [req.params.projectId, req.body.name.trim(), req.body.description || null, req.user.id]);
    await audit(pool, req.user.id, 'CREATE', 'gallery_folder', result.insertId, null, req.body, req.ip);
    res.status(201).json(await getOne(`${folderSelect} WHERE f.id=?`, [result.insertId]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This project already has a folder with that name' });
    throw error;
  }
}));

router.patch('/gallery/folders/:id', auth, permit('gallery.manage'), validate(z.object({
  name: z.string().min(1).max(140).optional(),
  description: z.string().max(400).optional()
}).refine(value => Object.keys(value).length > 0, { message: 'Nothing to change' })), wrap(async (req, res) => {
  const folder = await getOne('SELECT * FROM gallery_folders WHERE id=?', [req.params.id]);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  try {
    await query('UPDATE gallery_folders SET name=COALESCE(?,name), description=COALESCE(?,description) WHERE id=?',
      [req.body.name?.trim() ?? null, req.body.description ?? null, folder.id]);
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This project already has a folder with that name' });
    throw error;
  }
  await audit(pool, req.user.id, 'UPDATE', 'gallery_folder', folder.id, folder, req.body, req.ip);
  res.json(await getOne(`${folderSelect} WHERE f.id=?`, [folder.id]));
}));

/**
 * A folder is only removed when nothing is filed in it. Emptying it first would mean
 * deleting the photographs, which is the one thing this feature exists to prevent.
 */
router.delete('/gallery/folders/:id', auth, permit('gallery.manage'), wrap(async (req, res) => {
  const folder = await getOne('SELECT * FROM gallery_folders WHERE id=?', [req.params.id]);
  if (!folder) return res.status(404).json({ error: 'Folder not found' });
  const held = await getOne(
    'SELECT COUNT(*) count FROM gallery_photos WHERE folder_id=? AND removed_at IS NULL', [folder.id]);
  if (Number(held.count)) {
    return res.status(409).json({
      error: `This folder still holds ${held.count} photo(s). Move them to another folder first.`
    });
  }
  await query('DELETE FROM gallery_folders WHERE id=?', [folder.id]);
  await audit(pool, req.user.id, 'DELETE', 'gallery_folder', folder.id, folder, null, req.ip);
  res.status(204).end();
}));

/* -------------------------------------------------------------------------- Photos */

router.get('/projects/:projectId/gallery/photos', auth, permit('projects.view'), wrap(async (req, res) => {
  if (!await projectExists(req.params.projectId)) return res.status(404).json({ error: 'Project not found' });
  const filters = ['p.project_id=?'];
  const params = [req.params.projectId];
  if (req.query.folderId === 'none') filters.push('p.folder_id IS NULL');
  else if (req.query.folderId) { filters.push('p.folder_id=?'); params.push(req.query.folderId); }
  /* Withdrawn photos stay out of the gallery but remain visible to whoever keeps it, so a
     removal is something you can see rather than something you have to notice. */
  if (req.query.includeRemoved !== 'true' || !can(req, 'gallery.manage')) filters.push('p.removed_at IS NULL');

  res.json(await query(
    `${photoSelect} WHERE ${filters.join(' AND ')} ORDER BY p.captured_at DESC, p.id DESC LIMIT 400`, params));
}));

/**
 * Receiving a photo.
 *
 * The clock is read here and nowhere else. The browser sends the picture, optionally a
 * small preview it drew itself, a folder and a caption — it does not send a time, and there
 * is no field for one.
 */
router.post('/projects/:projectId/gallery/photos', auth, permit('gallery.manage'), wrap(async (req, res, next) => {
  const project = await projectExists(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { file, thumbnail, fields } = await readUpload(req);
  if (!PHOTO_TYPES.has(file.mime)) {
    return res.status(415).json({ error: 'The gallery takes photographs only: JPEG, PNG, WebP or HEIC' });
  }

  let folderId = null;
  if (fields.folderId && fields.folderId !== 'none') {
    const folder = await getOne('SELECT id FROM gallery_folders WHERE id=? AND project_id=?',
      [fields.folderId, project.id]);
    if (!folder) return res.status(404).json({ error: 'That folder is not on this project' });
    folderId = folder.id;
  }

  /* Fingerprinted on arrival: the checksum is what lets anyone later show the file behind
     this record is the file that was received, and the trigger keeps it from being reset. */
  const checksum = crypto.createHash('sha256').update(file.buffer).digest('hex');

  const stored = await store({ folder: 'gallery', filename: file.filename, mime: file.mime, buffer: file.buffer });
  let thumb = null;
  if (thumbnail && isAllowedType(thumbnail.mime)) {
    thumb = await store({ folder: 'gallery', filename: `thumb-${file.filename}`, mime: thumbnail.mime, buffer: thumbnail.buffer })
      .catch(() => null);
  }

  try {
    const result = await query(
      `INSERT INTO gallery_photos
        (project_id,folder_id,storage_key,thumb_key,filename,mime,size_bytes,checksum,caption,captured_at,uploaded_by)
       VALUES (?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(),?)`,
      [project.id, folderId, stored.key, thumb?.key || null, stored.filename, stored.mime, stored.size,
        checksum, fields.caption?.slice(0, 400) || null, req.user.id]);
    await audit(pool, req.user.id, 'UPLOAD', 'gallery_photo', result.insertId, null,
      { project: project.name, filename: stored.filename, checksum }, req.ip);
    res.status(201).json(await getOne(`${photoSelect} WHERE p.id=?`, [result.insertId]));
  } catch (error) {
    await remove(stored.key).catch(() => {});
    if (thumb) await remove(thumb.key).catch(() => {});
    next(error);
  }
}));

/** The caption can be corrected and the photo refiled. The time and the file cannot. */
router.patch('/gallery/photos/:id', auth, permit('gallery.manage'), validate(z.object({
  caption: z.string().max(400).nullable().optional(),
  folderId: z.union([z.number().int().positive(), z.null()]).optional()
}).refine(value => Object.keys(value).length > 0, { message: 'Nothing to change' })), wrap(async (req, res) => {
  const photo = await getOne('SELECT * FROM gallery_photos WHERE id=?', [req.params.id]);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  if (photo.removed_at) return res.status(409).json({ error: 'This photo has been withdrawn and cannot be edited' });

  if (req.body.folderId) {
    const folder = await getOne('SELECT id FROM gallery_folders WHERE id=? AND project_id=?',
      [req.body.folderId, photo.project_id]);
    if (!folder) return res.status(404).json({ error: 'That folder is not on this project' });
  }
  if (req.body.caption !== undefined) {
    await query('UPDATE gallery_photos SET caption=? WHERE id=?', [req.body.caption, photo.id]);
  }
  if (req.body.folderId !== undefined) {
    await query('UPDATE gallery_photos SET folder_id=? WHERE id=?', [req.body.folderId, photo.id]);
  }
  await audit(pool, req.user.id, 'UPDATE', 'gallery_photo', photo.id, photo, req.body, req.ip);
  res.json(await getOne(`${photoSelect} WHERE p.id=?`, [photo.id]));
}));

/**
 * Withdrawing a photo, which is as far as removal goes.
 *
 * The picture leaves the gallery and the reason is recorded, but the row and the file stay.
 * A record kept to settle arguments is worth nothing if the inconvenient frames can be
 * made to disappear, so this is a marking, not a deletion.
 */
router.delete('/gallery/photos/:id', auth, permit('gallery.manage'), wrap(async (req, res) => {
  const photo = await getOne('SELECT * FROM gallery_photos WHERE id=?', [req.params.id]);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  if (photo.removed_at) return res.status(409).json({ error: 'This photo has already been withdrawn' });

  const reason = typeof req.query.reason === 'string' ? req.query.reason.slice(0, 300) : null;
  await query('UPDATE gallery_photos SET removed_at=UTC_TIMESTAMP(), removed_by=?, removed_reason=? WHERE id=?',
    [req.user.id, reason, photo.id]);
  await audit(pool, req.user.id, 'WITHDRAW', 'gallery_photo', photo.id, photo, { reason }, req.ip);
  res.json(await getOne(`${photoSelect} WHERE p.id=?`, [photo.id]));
}));

router.post('/gallery/photos/:id/restore', auth, permit('gallery.manage'), wrap(async (req, res) => {
  const photo = await getOne('SELECT * FROM gallery_photos WHERE id=?', [req.params.id]);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });
  await query('UPDATE gallery_photos SET removed_at=NULL, removed_by=NULL, removed_reason=NULL WHERE id=?', [photo.id]);
  await audit(pool, req.user.id, 'RESTORE', 'gallery_photo', photo.id, photo, null, req.ip);
  res.json(await getOne(`${photoSelect} WHERE p.id=?`, [photo.id]));
}));

/** The image itself, behind the same permission as seeing the project it belongs to. */
router.get('/gallery/photos/:id/file', auth, permit('projects.view'), wrap(async (req, res) => {
  const photo = await getOne(
    'SELECT storage_key, thumb_key, mime, filename, removed_at FROM gallery_photos WHERE id=?', [req.params.id]);
  if (!photo) return res.status(404).json({ error: 'Photo not found' });

  /*
   * A withdrawn photograph leaves the gallery here too.
   *
   * The listing hides it, but this route served the bytes to anyone who could see the
   * project and knew the id — so withdrawing a photo removed it from view without removing
   * it from reach. Whoever keeps the record still gets it, because they are the ones who
   * need to see what was taken out and why.
   */
  if (photo.removed_at && !can(req, 'gallery.manage')) {
    return res.status(404).json({ error: 'Photo not found' });
  }

  const key = req.query.size === 'thumb' && photo.thumb_key ? photo.thumb_key : photo.storage_key;
  if (!isLocalStore()) return res.redirect(302, signedDownloadUrl(key));
  res.type(photo.mime);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(photo.filename)}"`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(localPathFor(key), error => {
    if (error && !res.headersSent) res.status(404).json({ error: 'Photo file not found' });
  });
}));

export default router;
