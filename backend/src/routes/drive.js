import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { pool, query, getOne, audit, transaction } from '../db.js';
import { auth, permit, validate, fail } from '../lib/http.js';
import { readUpload, store, checksumFile, remove, isLocalStore, localPathFor, signedDownloadUrl } from '../lib/storage.js';
import { checkDriveFile, guessType, fileFamily } from '../lib/drive-files.js';
import { accessFor, atLeast, ancestry, visibleChildren, publicLinkFor } from '../lib/drive-access.js';
import { publishTo, publishChange } from '../lib/realtime.js';
import { notify } from '../alerts.js';

const router = Router();

const mustAccess = async (itemId, user, needed) => {
  const { role } = await accessFor(itemId, user);
  if (!atLeast(role, needed)) {
    throw fail(role === 'None' ? 404 : 403,
      role === 'None' ? 'That item was not found' : 'You can see this but not change it');
  }
  return role;
};

/* ---- browsing ------------------------------------------------------------ */

router.get('/drive', auth, permit('drive.use'), async (req, res, next) => {
  try {
    const parentId = req.query.folder ? Number(req.query.folder) : null;
    if (parentId) await mustAccess(parentId, req.user, 'View');

    const [items, trail] = await Promise.all([
      visibleChildren(parentId, req.user),
      parentId ? ancestry(parentId) : []
    ]);
    res.json({
      folder: parentId ? trail[0] : null,
      /* Nearest-first from the walk; a person reads a path the other way round. */
      breadcrumb: trail.slice().reverse().map(one => ({ id: one.id, name: one.name })),
      items: items.map(one => ({ ...one, family: one.kind === 'Folder' ? 'folder' : fileFamily(one.name, one.mime) }))
    });
  } catch (error) { next(error); }
});

/** Everything shared with me that I do not own — the other way people look for a file. */
router.get('/drive/shared', auth, permit('drive.use'), async (req, res, next) => {
  try {
    const rows = await query(`
      SELECT DISTINCT d.id,d.kind,d.name,d.owner_id ownerId,u.name owner,d.mime,
             d.size_bytes sizeBytes,d.updated_at updatedAt,s.role myRole
        FROM drive_shares s JOIN drive_items d ON d.id=s.item_id
        JOIN users u ON u.id=d.owner_id
       WHERE s.user_id=? AND d.trashed_at IS NULL ORDER BY d.updated_at DESC LIMIT 200`,
    [req.user.id]);
    res.json(rows.map(one => ({ ...one, family: one.kind === 'Folder' ? 'folder' : fileFamily(one.name, one.mime) })));
  } catch (error) { next(error); }
});

/* ---- creating ------------------------------------------------------------ */

router.post('/drive/folders', auth, permit('drive.use'),
  validate(z.object({
    name: z.string().trim().min(1).max(255),
    parentId: z.coerce.number().int().positive().nullable().optional(),
    projectId: z.coerce.number().int().positive().nullable().optional()
  })),
  async (req, res, next) => {
    try {
      if (req.body.parentId) await mustAccess(req.body.parentId, req.user, 'Edit');
      const result = await query(
        'INSERT INTO drive_items (parent_id,kind,name,owner_id,project_id) VALUES (?,?,?,?,?)',
        [req.body.parentId || null, 'Folder', req.body.name, req.user.id, req.body.projectId || null]);
      await audit(pool, req.user.id, 'CREATE', 'drive_folder', result.insertId, null,
        { name: req.body.name, parentId: req.body.parentId || null }, req.ip);
      publishChange('drive', { parentId: req.body.parentId || null });
      res.status(201).json({ id: result.insertId });
    } catch (error) { next(error); }
  });

router.post('/drive/files', auth, permit('drive.use'), async (req, res, next) => {
  let discard = async () => {};
  try {
    const upload = await readUpload(req);
    discard = upload.discard;
    const { file, fields } = upload;

    const parentId = fields.parentId ? Number(fields.parentId) : null;
    if (parentId) await mustAccess(parentId, req.user, 'Edit');

    const verdict = checkDriveFile({ filename: file.filename, head: file.head, size: file.size });
    if (!verdict.ok) throw fail(415, verdict.reason);

    const mime = guessType(file.filename);
    const checksum = await checksumFile(file.path);
    const stored = await store({
      folder: 'drive', filename: file.filename, mime,
      path: file.path, head: file.head, size: file.size, skipTypeCheck: true
    });

    const result = await query(
      `INSERT INTO drive_items (parent_id,kind,name,owner_id,storage_key,size_bytes,mime,checksum)
       VALUES (?,?,?,?,?,?,?,?)`,
      [parentId, 'File', file.filename.slice(0, 255), req.user.id,
        stored.key, file.size, mime, checksum]);

    await audit(pool, req.user.id, 'UPLOAD', 'drive_file', result.insertId, null,
      { name: file.filename, size: file.size, checksum }, req.ip);
    publishChange('drive', { parentId });
    res.status(201).json({ id: result.insertId, name: file.filename, size: file.size, mime,
      family: fileFamily(file.filename, mime) });
  } catch (error) {
    next(error);
  } finally { await discard(); }
});

/* ---- downloading --------------------------------------------------------- */

router.get('/drive/items/:id/download', auth, permit('drive.use'), async (req, res, next) => {
  try {
    await mustAccess(req.params.id, req.user, 'View');
    const item = await getOne(
      'SELECT name,kind,storage_key storageKey,mime FROM drive_items WHERE id=?', [req.params.id]);
    if (!item || item.kind !== 'File') throw fail(404, 'That file was not found');

    await audit(pool, req.user.id, 'DOWNLOAD', 'drive_file', req.params.id, null,
      { name: item.name }, req.ip);
    res.setHeader('Content-Type', item.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `attachment; filename="${item.name.replace(/[^\w.\- ]+/g, '')}"`);
    if (isLocalStore()) return res.sendFile(localPathFor(item.storageKey));
    return res.redirect(await signedDownloadUrl(item.storageKey));
  } catch (error) { next(error); }
});

/* ---- sharing -------------------------------------------------------------- */

router.get('/drive/items/:id/sharing', auth, permit('drive.use'), async (req, res, next) => {
  try {
    await mustAccess(req.params.id, req.user, 'View');
    const item = await getOne(`
      SELECT d.id,d.name,d.kind,d.owner_id ownerId,u.name owner,d.visibility,d.org_role orgRole,
             d.public_token publicToken,d.public_expires_at publicExpiresAt,
             d.public_downloads publicDownloads
        FROM drive_items d JOIN users u ON u.id=d.owner_id WHERE d.id=?`, [req.params.id]);
    const people = await query(`
      SELECT s.user_id userId,u.name,u.role position,s.role FROM drive_shares s
        JOIN users u ON u.id=s.user_id WHERE s.item_id=? ORDER BY u.name`, [req.params.id]);
    const requests = await query(`
      SELECT r.id,r.user_id userId,u.name,r.requested_role requestedRole,r.message,r.created_at createdAt
        FROM drive_access_requests r JOIN users u ON u.id=r.user_id
       WHERE r.item_id=? AND r.status='Pending' ORDER BY r.id`, [req.params.id]);
    const { role } = await accessFor(req.params.id, req.user);
    res.json({ ...item, people, requests, myRole: role,
      publicLink: item.publicToken ? `/s/${item.publicToken}` : null });
  } catch (error) { next(error); }
});

const shareSchema = z.object({
  visibility: z.enum(['Private', 'People', 'Organisation']).optional(),
  orgRole: z.enum(['View', 'Edit']).optional(),
  add: z.array(z.object({
    userId: z.coerce.number().int().positive(),
    role: z.enum(['View', 'Edit']).default('View')
  })).optional(),
  remove: z.array(z.coerce.number().int().positive()).optional()
});

/** Only the owner decides who else gets in — an editor may change the file, not the guest list. */
router.patch('/drive/items/:id/sharing', auth, permit('drive.use'), validate(shareSchema),
  async (req, res, next) => {
    try {
      const role = await mustAccess(req.params.id, req.user, 'View');
      const item = await getOne('SELECT * FROM drive_items WHERE id=?', [req.params.id]);
      if (role !== 'Owner' && !req.user.permissions.includes('admin.users')) {
        throw fail(403, 'Only the owner can change who this is shared with');
      }

      if (req.body.visibility || req.body.orgRole) {
        await query('UPDATE drive_items SET visibility=?, org_role=? WHERE id=?',
          [req.body.visibility || item.visibility, req.body.orgRole || item.org_role, req.params.id]);
      }
      for (const grant of req.body.add || []) {
        await query(
          `INSERT INTO drive_shares (item_id,user_id,role,granted_by) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE role=VALUES(role)`,
          [req.params.id, grant.userId, grant.role, req.user.id]);
        await notify({
          userId: grant.userId, severity: 'Info',
          title: `${req.user.name} shared "${item.name}" with you`,
          message: `You can now ${grant.role === 'Edit' ? 'edit' : 'view'} it in the drive.`,
          referenceType: 'drive_item', referenceId: req.params.id
        }).catch(() => {});
      }
      for (const userId of req.body.remove || []) {
        await query('DELETE FROM drive_shares WHERE item_id=? AND user_id=?', [req.params.id, userId]);
      }

      await audit(pool, req.user.id, 'SHARE', 'drive_item', req.params.id,
        { visibility: item.visibility, orgRole: item.org_role },
        { visibility: req.body.visibility, orgRole: req.body.orgRole,
          added: req.body.add?.length || 0, removed: req.body.remove?.length || 0 }, req.ip);
      publishChange('drive', { id: Number(req.params.id) });
      res.status(204).end();
    } catch (error) { next(error); }
  });

/* ---- the public link ------------------------------------------------------ */

/**
 * Makes something reachable by anybody holding the link.
 *
 * The most consequential thing anybody does in the drive, so it is the owner's decision
 * alone, it is written into the audit trail with their name against it, and it applies to
 * this one item — a folder made public does not carry its contents out with it.
 */
router.post('/drive/items/:id/public', auth, permit('drive.use'),
  validate(z.object({ expiresInDays: z.coerce.number().int().min(1).max(365).optional() })),
  async (req, res, next) => {
    try {
      const role = await mustAccess(req.params.id, req.user, 'View');
      if (role !== 'Owner') throw fail(403, 'Only the owner can create a public link');
      const item = await getOne('SELECT id,name,kind FROM drive_items WHERE id=?', [req.params.id]);
      if (item.kind !== 'File') throw fail(400, 'Only a file can have a public link, not a folder');

      const token = crypto.randomBytes(32).toString('base64url');
      const expires = req.body.expiresInDays
        ? new Date(Date.now() + req.body.expiresInDays * 86400000) : null;
      await query(
        'UPDATE drive_items SET public_token=?, public_expires_at=?, public_created_by=? WHERE id=?',
        [token, expires, req.user.id, req.params.id]);

      await audit(pool, req.user.id, 'PUBLISH', 'drive_item', req.params.id, null,
        { name: item.name, expiresAt: expires }, req.ip);
      res.status(201).json({ link: `/s/${token}`, expiresAt: expires });
    } catch (error) { next(error); }
  });

router.delete('/drive/items/:id/public', auth, permit('drive.use'), async (req, res, next) => {
  try {
    const role = await mustAccess(req.params.id, req.user, 'View');
    if (role !== 'Owner') throw fail(403, 'Only the owner can withdraw a public link');
    await query('UPDATE drive_items SET public_token=NULL, public_expires_at=NULL WHERE id=?',
      [req.params.id]);
    await audit(pool, req.user.id, 'UNPUBLISH', 'drive_item', req.params.id, null, null, req.ip);
    res.status(204).end();
  } catch (error) { next(error); }
});

/* ---- asking to be let in --------------------------------------------------- */

router.post('/drive/items/:id/request', auth, permit('drive.use'),
  validate(z.object({
    role: z.enum(['View', 'Edit']).default('View'),
    message: z.string().trim().max(500).optional()
  })),
  async (req, res, next) => {
    try {
      const item = await getOne('SELECT id,name,owner_id ownerId FROM drive_items WHERE id=? AND trashed_at IS NULL',
        [req.params.id]);
      if (!item) throw fail(404, 'That item was not found');
      const { role } = await accessFor(req.params.id, req.user);
      if (role !== 'None') throw fail(400, 'You already have access to this');

      await query(
        `INSERT INTO drive_access_requests (item_id,user_id,requested_role,message) VALUES (?,?,?,?)
         ON DUPLICATE KEY UPDATE requested_role=VALUES(requested_role), message=VALUES(message)`,
        [req.params.id, req.user.id, req.body.role, req.body.message || null]);

      await notify({
        userId: item.ownerId, severity: 'Info',
        title: `${req.user.name} is asking for access to "${item.name}"`,
        message: req.body.message
          ? `They said: "${req.body.message}"`
          : `They have asked to ${req.body.role === 'Edit' ? 'edit' : 'view'} it.`,
        referenceType: 'drive_item', referenceId: req.params.id
      }).catch(() => {});
      publishTo([item.ownerId], 'drive:request', { itemId: Number(req.params.id), from: req.user.name });
      res.status(201).json({ asked: true });
    } catch (error) { next(error); }
  });

router.post('/drive/requests/:id/decide', auth, permit('drive.use'),
  validate(z.object({ grant: z.boolean(), role: z.enum(['View', 'Edit']).optional() })),
  async (req, res, next) => {
    try {
      const request = await getOne('SELECT * FROM drive_access_requests WHERE id=?', [req.params.id]);
      if (!request) throw fail(404, 'That request was not found');
      const role = await mustAccess(request.item_id, req.user, 'View');
      if (role !== 'Owner') throw fail(403, 'Only the owner can answer this');

      if (req.body.grant) {
        await query(
          `INSERT INTO drive_shares (item_id,user_id,role,granted_by) VALUES (?,?,?,?)
           ON DUPLICATE KEY UPDATE role=VALUES(role)`,
          [request.item_id, request.user_id, req.body.role || request.requested_role, req.user.id]);
      }
      await query("UPDATE drive_access_requests SET status=?, decided_by=?, decided_at=NOW() WHERE id=?",
        [req.body.grant ? 'Granted' : 'Refused', req.user.id, req.params.id]);

      const item = await getOne('SELECT name FROM drive_items WHERE id=?', [request.item_id]);
      await notify({
        userId: request.user_id, severity: 'Info',
        title: req.body.grant
          ? `You now have access to "${item.name}"`
          : `Your request for "${item.name}" was not granted`,
        message: req.body.grant ? 'It is in your drive under "Shared with me".' : '',
        referenceType: 'drive_item', referenceId: request.item_id
      }).catch(() => {});
      res.status(204).end();
    } catch (error) { next(error); }
  });

/* ---- moving, renaming, removing -------------------------------------------- */

router.patch('/drive/items/:id', auth, permit('drive.use'),
  validate(z.object({
    name: z.string().trim().min(1).max(255).optional(),
    parentId: z.coerce.number().int().positive().nullable().optional()
  })),
  async (req, res, next) => {
    try {
      await mustAccess(req.params.id, req.user, 'Edit');
      if (req.body.parentId !== undefined && req.body.parentId !== null) {
        await mustAccess(req.body.parentId, req.user, 'Edit');
        /* A folder cannot be moved inside itself: the tree would become a ring and every
           walk up it would never end. */
        const below = await ancestry(req.body.parentId);
        if (below.some(one => String(one.id) === String(req.params.id))) {
          throw fail(400, 'A folder cannot be moved inside itself');
        }
      }
      const item = await getOne('SELECT name,parent_id parentId FROM drive_items WHERE id=?', [req.params.id]);
      await query('UPDATE drive_items SET name=?, parent_id=? WHERE id=?',
        [req.body.name ?? item.name,
          req.body.parentId === undefined ? item.parentId : req.body.parentId, req.params.id]);
      await audit(pool, req.user.id, 'UPDATE', 'drive_item', req.params.id,
        { name: item.name, parentId: item.parentId },
        { name: req.body.name, parentId: req.body.parentId }, req.ip);
      publishChange('drive', {});
      res.status(204).end();
    } catch (error) { next(error); }
  });

router.delete('/drive/items/:id', auth, permit('drive.use'), async (req, res, next) => {
  try {
    const role = await mustAccess(req.params.id, req.user, 'Edit');
    if (role !== 'Owner' && !req.user.permissions.includes('admin.users')) {
      throw fail(403, 'Only the owner can remove this');
    }
    await query('UPDATE drive_items SET trashed_at=NOW(), trashed_by=?, public_token=NULL WHERE id=?',
      [req.user.id, req.params.id]);
    await audit(pool, req.user.id, 'DELETE', 'drive_item', req.params.id, null, null, req.ip);
    publishChange('drive', {});
    res.status(204).end();
  } catch (error) { next(error); }
});

export default router;
