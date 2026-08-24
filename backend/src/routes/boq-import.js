import { Router } from 'express';
import { z } from 'zod';
import { pool, query, getOne, transaction, audit, nextReference } from '../db.js';
import { auth, permit, validate, fail, fromOptions } from '../lib/http.js';
import { readUpload, readUploadedFile } from '../lib/storage.js';
import { buildTemplate, parseBoqWorkbook, CATEGORIES } from '../lib/boq-template.js';
import { notify } from '../alerts.js';

const router = Router();

/** The blank template, ready to be filled in and sent back. */
router.get('/boq/template', auth, permit('qs.boq'), async (req, res, next) => {
  try {
    const project = req.query.projectId
      ? await getOne('SELECT name,client FROM projects WHERE id=?', [req.query.projectId])
      : null;
    const company = await getOne('SELECT name FROM company_profile LIMIT 1').catch(() => null);
    const file = buildTemplate({
      company: company?.name || 'GKUC Construction',
      title: project ? `${project.name} — Bill of Quantities` : '',
      client: project?.client || ''
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="GKUC-BOQ-template.xlsx"');
    res.send(file);
  } catch (error) { next(error); }
});

/**
 * Takes a filled-in template and stages it for review.
 *
 * Nothing reaches a bill of quantities here. The rows are recorded as they were read,
 * with whatever could not be understood noted against the row it came from, and the person
 * who uploaded it decides what to do about each one.
 */
router.post('/boq/import', auth, permit('qs.boq'), async (req, res, next) => {
  let discard = async () => {};
  try {
    const upload = await readUpload(req);
    discard = upload.discard;
    const { file, fields } = upload;

    const buffer = await readUploadedFile(file.path);
    const parsed = parseBoqWorkbook(buffer);
    if (!parsed.ok) throw fail(422, parsed.error);

    const projectId = fields.projectId ? Number(fields.projectId) : null;
    if (projectId) {
      const project = await getOne('SELECT id FROM projects WHERE id=? AND active=1', [projectId]);
      if (!project) throw fail(404, 'That project does not exist');
    }

    const problemCount = parsed.items.filter(item => item.problems.length).length;
    const total = parsed.items.reduce((sum, item) => sum + (item.amount || 0), 0);

    const importId = await transaction(async connection => {
      const [created] = await connection.execute(
        `INSERT INTO boq_imports (project_id,filename,title,client,status,row_count,problem_count,total,uploaded_by)
         VALUES (?,?,?,?,'Review',?,?,?,?)`,
        [projectId, file.filename.slice(0, 190), parsed.title, parsed.client,
          parsed.items.length, problemCount, total, req.user.id]);

      for (const item of parsed.items) {
        await connection.execute(
          `INSERT INTO boq_import_items
             (import_id,source_row,category,description,unit,quantity,rate,amount,method,notes,raw_json,problems,notice,include)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [created.insertId, item.sourceRow, item.category, item.description, item.unit,
            item.quantity, item.rate, item.amount, item.method, item.notes,
            JSON.stringify(item.raw), item.problems.join(' · ').slice(0, 600) || null,
            item.notices.join(' · ').slice(0, 600) || null, 1]);
      }
      return created.insertId;
    });

    await audit(pool, req.user.id, 'IMPORT', 'boq_import', importId, null,
      { filename: file.filename, rows: parsed.items.length, problems: problemCount }, req.ip);

    res.status(201).json(await detail(importId));
  } catch (error) {
    next(error);
  } finally {
    await discard();
  }
});

const detail = async importId => {
  const record = await getOne(`SELECT i.id,i.project_id projectId,i.boq_id boqId,i.filename,i.title,i.client,
    i.status,i.row_count rowCount,i.problem_count problemCount,i.total,i.created_at createdAt,
    u.name uploadedBy,p.name project
    FROM boq_imports i JOIN users u ON u.id=i.uploaded_by
    LEFT JOIN projects p ON p.id=i.project_id WHERE i.id=?`, [importId]);
  if (!record) return null;
  record.items = await query(`SELECT id,source_row sourceRow,category,description,unit,quantity,rate,amount,
    method,notes,problems,notice,include FROM boq_import_items WHERE import_id=? ORDER BY source_row`, [importId]);
  record.categories = CATEGORIES;
  return record;
};

router.get('/boq/imports', auth, permit('qs.boq', 'qs.view'), async (_req, res, next) => {
  try {
    res.json(await query(`SELECT i.id,i.filename,i.title,i.client,i.status,i.row_count rowCount,
      i.problem_count problemCount,i.total,i.created_at createdAt,u.name uploadedBy,p.name project,i.boq_id boqId
      FROM boq_imports i JOIN users u ON u.id=i.uploaded_by
      LEFT JOIN projects p ON p.id=i.project_id ORDER BY i.id DESC LIMIT 50`));
  } catch (error) { next(error); }
});

router.get('/boq/imports/:id', auth, permit('qs.boq', 'qs.view'), async (req, res, next) => {
  try {
    const record = await detail(req.params.id);
    if (!record) return res.status(404).json({ error: 'That import was not found' });
    res.json(record);
  } catch (error) { next(error); }
});

/* Correcting a staged row. The original is kept in raw_json, so this is never destructive. */
const rowSchema = z.object({
  category: z.string().trim().min(1).max(60).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
  unit: z.string().trim().max(30).nullable().optional(),
  quantity: z.coerce.number().nonnegative().nullable().optional(),
  rate: z.coerce.number().nonnegative().nullable().optional(),
  method: z.string().trim().max(4000).nullable().optional(),
  notes: z.string().trim().max(600).nullable().optional(),
  include: z.boolean().optional()
});

router.patch('/boq/imports/:id/items/:itemId', auth, permit('qs.boq'), validate(rowSchema),
  async (req, res, next) => {
    try {
      const staged = await getOne(
        `SELECT t.*, i.status FROM boq_import_items t JOIN boq_imports i ON i.id=t.import_id
         WHERE t.id=? AND t.import_id=?`, [req.params.itemId, req.params.id]);
      if (!staged) return res.status(404).json({ error: 'That row was not found' });
      if (staged.status !== 'Review') return res.status(409).json({ error: 'This import has already been dealt with' });

      const merged = {
        category: req.body.category ?? staged.category,
        description: req.body.description ?? staged.description,
        unit: req.body.unit ?? staged.unit,
        quantity: req.body.quantity ?? staged.quantity,
        rate: req.body.rate ?? staged.rate,
        method: req.body.method ?? staged.method,
        notes: req.body.notes ?? staged.notes,
        include: req.body.include === undefined ? staged.include : (req.body.include ? 1 : 0)
      };
      const amount = merged.quantity !== null && merged.rate !== null
        ? Number((Number(merged.quantity) * Number(merged.rate)).toFixed(2)) : null;

      /* Re-checked after the correction, so a fixed row stops being flagged. */
      const problems = [];
      if (!merged.description) problems.push('No description');
      if (!merged.category) problems.push('No category');
      if (!merged.unit) problems.push('No unit');
      if (merged.quantity === null || Number(merged.quantity) <= 0) problems.push('Quantity must be more than zero');
      if (merged.rate === null) problems.push('No rate');

      await query(`UPDATE boq_import_items SET category=?,description=?,unit=?,quantity=?,rate=?,amount=?,
        method=?,notes=?,include=?,problems=? WHERE id=?`,
      [merged.category, merged.description, merged.unit, merged.quantity, merged.rate, amount,
        merged.method, merged.notes, merged.include, problems.join(' · ') || null, req.params.itemId]);

      await refreshTotals(req.params.id);
      res.json(await detail(req.params.id));
    } catch (error) { next(error); }
  });

async function refreshTotals(importId) {
  /* "rows" is reserved in MySQL 8 and cannot be used as a bare alias. */
  const [sums] = await query(
    `SELECT COUNT(*) staged, SUM(problems IS NOT NULL AND include=1) problems,
            COALESCE(SUM(CASE WHEN include=1 THEN amount ELSE 0 END),0) total
     FROM boq_import_items WHERE import_id=?`, [importId]);
  await query('UPDATE boq_imports SET row_count=?, problem_count=?, total=? WHERE id=?',
    [sums.staged, Number(sums.problems || 0), sums.total, importId]);
}

/**
 * Turns a reviewed import into a real bill of quantities.
 *
 * Refuses while any included row still has a problem: the point of the review step is that
 * what gets committed is what a person confirmed, and a bill built on a row nobody could
 * read is exactly what this is meant to prevent.
 */
router.post('/boq/imports/:id/commit', auth, permit('qs.boq'),
  validate(z.object({ projectId: z.coerce.number().int().positive(), notes: z.string().trim().max(1000).optional() })),
  async (req, res, next) => {
    try {
      const record = await getOne('SELECT * FROM boq_imports WHERE id=?', [req.params.id]);
      if (!record) return res.status(404).json({ error: 'That import was not found' });
      if (record.status !== 'Review') return res.status(409).json({ error: 'This import has already been dealt with' });

      const project = await getOne('SELECT id,name FROM projects WHERE id=? AND active=1', [req.body.projectId]);
      if (!project) return res.status(404).json({ error: 'That project does not exist' });

      const items = await query(
        'SELECT * FROM boq_import_items WHERE import_id=? AND include=1 ORDER BY source_row', [record.id]);
      if (!items.length) return res.status(400).json({ error: 'No rows are marked to be included' });

      const unresolved = items.filter(item => item.problems);
      if (unresolved.length) {
        return res.status(400).json({
          error: `${unresolved.length} row${unresolved.length === 1 ? '' : 's'} still need attention. `
            + 'Correct them, or untick them, before approving.',
          rows: unresolved.map(item => item.source_row)
        });
      }

      const reference = await nextReference('BOQ', 'boqs');
      const total = items.reduce((sum, item) => sum + Number(item.amount || 0), 0);

      const boqId = await transaction(async connection => {
        const [created] = await connection.execute(
          `INSERT INTO boqs (project_id,reference,title,status,total,prepared_by,notes)
           VALUES (?,?,?,'Draft',?,?,?)`,
          [project.id, reference, record.title || `${project.name} — Bill of Quantities`,
            total, req.user.id, req.body.notes || record.notes || null]);

        for (const item of items) {
          await connection.execute(
            `INSERT INTO boq_items (boq_id,category,description,unit,quantity,rate,amount,method,notes)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [created.insertId, item.category, item.description, item.unit,
              item.quantity, item.rate, item.amount, item.method, item.notes]);
        }
        await connection.execute(
          "UPDATE boq_imports SET status='Committed', boq_id=?, committed_by=?, committed_at=NOW() WHERE id=?",
          [created.insertId, req.user.id, record.id]);
        return created.insertId;
      });

      await audit(pool, req.user.id, 'COMMIT', 'boq_import', record.id, null,
        { boqId, reference, rows: items.length, total }, req.ip);

      await notify({
        audience: 'qs.approve', severity: 'Info',
        title: `BOQ ready for approval — ${reference}`,
        message: `${req.user.name} imported ${items.length} item(s) for ${project.name}, totalling `
          + `LKR ${total.toLocaleString('en-LK')}. It is a draft until approved.`,
        referenceType: 'boq', referenceId: boqId
      });

      res.status(201).json({ boqId, reference, items: items.length, total });
    } catch (error) { next(error); }
  });

router.delete('/boq/imports/:id', auth, permit('qs.boq'), async (req, res, next) => {
  try {
    const record = await getOne('SELECT status FROM boq_imports WHERE id=?', [req.params.id]);
    if (!record) return res.status(404).json({ error: 'That import was not found' });
    if (record.status === 'Committed') return res.status(409).json({ error: 'A committed import cannot be discarded' });
    await query("UPDATE boq_imports SET status='Discarded' WHERE id=?", [req.params.id]);
    res.status(204).end();
  } catch (error) { next(error); }
});

/* ---- changing a bill that has already been approved --------------------- */

/*
 * An approved BOQ is what quotations, invoices and the project budget are built on. Once
 * it is approved it stops being editable directly: a change is proposed, with a reason,
 * and applies only when somebody holding qs.boqAmend agrees. The MD holds that permission
 * and can grant it to anyone else from Access control.
 */

/*
 * A JSON column comes back already parsed from mysql2, but not from every path that
 * reaches this code. Parsing an object throws, so the shape is checked rather than assumed.
 */
const asObject = value => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

const changeSchema = z.object({
  action: z.enum(['Edit', 'Add', 'Remove']),
  itemId: z.coerce.number().int().positive().optional(),
  reason: z.string().trim().min(5, 'Say why the change is needed').max(600),
  item: z.object({
    category: z.string().trim().min(1).max(60).optional(),
    description: z.string().trim().min(2).max(300).optional(),
    unit: z.string().trim().min(1).max(30).optional(),
    quantity: z.coerce.number().positive().optional(),
    rate: z.coerce.number().nonnegative().optional(),
    method: z.string().trim().max(4000).nullable().optional(),
    notes: z.string().trim().max(600).nullable().optional()
  }).optional()
});

router.post('/boq/:id/changes', auth, permit('qs.boq'), validate(changeSchema), async (req, res, next) => {
  try {
    const boq = await getOne('SELECT id,reference,status FROM boqs WHERE id=?', [req.params.id]);
    if (!boq) return res.status(404).json({ error: 'That BOQ was not found' });
    if (boq.status !== 'Approved') {
      return res.status(409).json({
        error: 'This BOQ is not approved yet, so it can still be edited directly. '
          + 'Change requests are only for bills that have been signed off.'
      });
    }

    let before = null;
    if (req.body.action !== 'Add') {
      if (!req.body.itemId) return res.status(400).json({ error: 'Which line is being changed?' });
      before = await getOne('SELECT * FROM boq_items WHERE id=? AND boq_id=?', [req.body.itemId, boq.id]);
      if (!before) return res.status(404).json({ error: 'That line is not on this BOQ' });
    }

    const created = await query(
      `INSERT INTO boq_change_requests (boq_id,item_id,action,reason,before_json,after_json,requested_by)
       VALUES (?,?,?,?,?,?,?)`,
      [boq.id, req.body.itemId || null, req.body.action, req.body.reason,
        before ? JSON.stringify(before) : null,
        req.body.item ? JSON.stringify(req.body.item) : null, req.user.id]);

    await notify({
      audience: 'qs.boqAmend', severity: 'Warning',
      title: `BOQ change needs approval — ${boq.reference}`,
      message: `${req.user.name} asked to ${req.body.action.toLowerCase()} a line on ${boq.reference}. `
        + `Reason: ${req.body.reason}`,
      referenceType: 'boq_change', referenceId: created.insertId
    });

    res.status(201).json({ id: created.insertId, status: 'Pending' });
  } catch (error) { next(error); }
});

router.get('/boq/changes/pending', auth, permit('qs.view', 'qs.boq', 'qs.boqAmend'), async (_req, res, next) => {
  try {
    res.json(await query(`SELECT c.id,c.boq_id boqId,c.item_id itemId,c.action,c.reason,c.status,
      c.before_json beforeJson,c.after_json afterJson,c.created_at createdAt,
      u.name requestedBy,b.reference,b.title
      FROM boq_change_requests c JOIN users u ON u.id=c.requested_by JOIN boqs b ON b.id=c.boq_id
      WHERE c.status='Pending' ORDER BY c.id DESC`));
  } catch (error) { next(error); }
});

/** Approving applies the change; rejecting records the decision and changes nothing. */
router.patch('/boq/changes/:id', auth, permit('qs.boqAmend'),
  validate(z.object({ status: z.enum(['Approved', 'Rejected']), note: z.string().trim().max(600).optional() })),
  async (req, res, next) => {
    try {
      const request = await getOne('SELECT * FROM boq_change_requests WHERE id=?', [req.params.id]);
      if (!request) return res.status(404).json({ error: 'That request was not found' });
      if (request.status !== 'Pending') return res.status(409).json({ error: 'That request has already been decided' });

      if (req.body.status === 'Approved') {
        const after = asObject(request.after_json);
        await transaction(async connection => {
          if (request.action === 'Remove') {
            await connection.execute('DELETE FROM boq_items WHERE id=?', [request.item_id]);
          } else if (request.action === 'Add') {
            const amount = Number((after.quantity * after.rate).toFixed(2));
            await connection.execute(
              `INSERT INTO boq_items (boq_id,category,description,unit,quantity,rate,amount,method,notes)
               VALUES (?,?,?,?,?,?,?,?,?)`,
              [request.boq_id, after.category, after.description, after.unit,
                after.quantity, after.rate, amount, after.method || null, after.notes || null]);
          } else {
            const before = asObject(request.before_json);
            const merged = { ...before, ...after };
            const amount = Number((merged.quantity * merged.rate).toFixed(2));
            await connection.execute(
              `UPDATE boq_items SET category=?,description=?,unit=?,quantity=?,rate=?,amount=?,method=?,notes=?
               WHERE id=?`,
              [merged.category, merged.description, merged.unit, merged.quantity, merged.rate,
                amount, merged.method || null, merged.notes || null, request.item_id]);
          }
          /* The bill's own total has to follow its lines, or every figure built on it drifts. */
          await connection.execute(
            'UPDATE boqs SET total=(SELECT COALESCE(SUM(amount),0) FROM boq_items WHERE boq_id=?) WHERE id=?',
            [request.boq_id, request.boq_id]);
        });
      }

      await query('UPDATE boq_change_requests SET status=?, decided_by=?, decided_at=NOW(), decision_note=? WHERE id=?',
        [req.body.status, req.user.id, req.body.note || null, request.id]);

      await audit(pool, req.user.id, req.body.status === 'Approved' ? 'APPROVE' : 'REJECT',
        'boq_change', request.id, asObject(request.before_json), asObject(request.after_json), req.ip);

      await notify({
        userId: request.requested_by, severity: 'Info',
        title: `BOQ change ${req.body.status.toLowerCase()}`,
        message: `${req.user.name} ${req.body.status.toLowerCase()} your change to the bill of quantities.`
          + (req.body.note ? ` Note: ${req.body.note}` : ''),
        referenceType: 'boq', referenceId: request.boq_id
      });

      res.json({ id: request.id, status: req.body.status });
    } catch (error) { next(error); }
  });

export default router;
