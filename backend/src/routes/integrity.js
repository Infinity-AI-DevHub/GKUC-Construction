import { Router } from 'express';
import { z } from 'zod';
import { pool, query, getOne, audit } from '../db.js';
import { auth, permit, validate, fail, permissionsFor } from '../lib/http.js';
import { runIntegritySweep, loadSettings } from '../lib/integrity.js';
import { publishChange } from '../lib/realtime.js';
import { notify } from '../alerts.js';

const router = Router();

/** What the watch has found, worst first. */
router.get('/integrity/findings', auth, permit('admin.audit'), async (req, res, next) => {
  try {
    const status = ['Open', 'Confirmed', 'Dismissed', 'Resolved'].includes(req.query.status)
      ? req.query.status : 'Open';
    const rows = await query(`
      SELECT f.id,f.rule,f.category,f.severity,f.entity,f.entity_id entityId,f.title,f.detail,
             f.amount,f.score,f.status,f.created_at createdAt,f.evidence_json evidence,
             f.review_note reviewNote,f.reviewed_at reviewedAt,f.assigned_user_id assignedUserId,
             f.resolution_due_at resolutionDueAt,f.resolution_proof resolutionProof,
             p.name project, subject.name subject, reviewer.name reviewedBy, owner.name assignedTo
        FROM risk_findings f
        LEFT JOIN projects p ON p.id=f.project_id
        LEFT JOIN users subject ON subject.id=f.subject_user_id
        LEFT JOIN users reviewer ON reviewer.id=f.reviewed_by
        LEFT JOIN users owner ON owner.id=f.assigned_user_id
       WHERE f.status=?
       ORDER BY FIELD(f.severity,'Critical','High','Medium','Low'), f.score DESC, f.id DESC
       LIMIT 200`, [status]);
    for (const row of rows) {
      if (typeof row.evidence === 'string') {
        try { row.evidence = JSON.parse(row.evidence); } catch { row.evidence = null; }
      }
    }
    res.json(rows);
  } catch (error) { next(error); }
});

/** A count per severity, for the dashboard. */
router.get('/integrity/summary', auth, permit('admin.audit'), async (_req, res, next) => {
  try {
    const bySeverity = await query(`
      SELECT severity, COUNT(*) count FROM risk_findings WHERE status='Open' GROUP BY severity`);
    const byCategory = await query(`
      SELECT category, COUNT(*) count FROM risk_findings WHERE status='Open' GROUP BY category`);
    const [totals] = await query(`
      SELECT COUNT(*) total,
             SUM(status='Open') open,
             SUM(status='Confirmed') confirmed,
             SUM(status='Dismissed') dismissed,
             SUM(status='Open' AND severity IN ('Critical','High')) urgent,
             COALESCE(SUM(CASE WHEN status='Open' THEN amount ELSE 0 END),0) exposure
        FROM risk_findings`);
    res.json({ bySeverity, byCategory, totals });
  } catch (error) { next(error); }
});

/**
 * A reviewer's decision.
 *
 * Dismissing requires a reason. A finding waved away without one leaves nobody able to tell
 * later whether it was checked or simply cleared to tidy the list — which is precisely the
 * situation the watch exists to prevent.
 */
router.post('/integrity/findings/:id/review', auth, permit('admin.audit'),
  validate(z.object({
    status: z.enum(['Confirmed', 'Dismissed', 'Resolved']),
    note: z.string().trim().max(1000).optional(),
    assignedUserId: z.coerce.number().int().positive().optional(),
    resolutionDueAt: z.string().datetime({ offset: true }).optional(),
    resolutionProof: z.string().trim().max(1000).optional()
  })),
  async (req, res, next) => {
    try {
      const finding = await getOne('SELECT * FROM risk_findings WHERE id=?', [req.params.id]);
      if (!finding) throw fail(404, 'That finding was not found');
      if (req.body.status === 'Dismissed') {
        let creatorId = Number(finding.subject_user_id);
        if (finding.entity === 'supplier_invoice') {
          const record = await getOne('SELECT recorded_by FROM supplier_invoices WHERE id=?', [finding.entity_id]);
          creatorId = Number(record?.recorded_by || creatorId);
        } else if (finding.entity === 'purchase_order') {
          const record = await getOne('SELECT issued_by FROM purchase_orders WHERE id=?', [finding.entity_id]);
          creatorId = Number(record?.issued_by || creatorId);
        }
        if (creatorId === Number(req.user.id)) throw fail(403, 'An independent reviewer must decide findings on your own transaction');
      }
      if (req.body.status === 'Dismissed' && !req.body.note?.trim()) {
        throw fail(400, 'Say why this is not a problem, so the decision can be understood later');
      }
      if (req.body.status === 'Confirmed' && (!req.body.assignedUserId || !req.body.resolutionDueAt)) {
        throw fail(400, 'Choose an investigator and resolution deadline before confirming');
      }
      if (req.body.status === 'Resolved' && (!finding.assigned_user_id || !req.body.resolutionProof?.trim())) {
        throw fail(400, 'Assign an investigator and record resolution proof before resolving');
      }
      if (req.body.status === 'Resolved' && finding.status !== 'Confirmed')
        throw fail(409, 'Confirm the finding before marking its investigation resolved');
      if (req.body.assignedUserId) {
        const owner = await getOne('SELECT id,role_id roleId FROM users WHERE id=? AND active=1', [req.body.assignedUserId]);
        if (!owner || !(await permissionsFor(owner.id, owner.roleId)).includes('admin.audit'))
          throw fail(400, 'Choose an active investigator with access to the integrity workspace');
      }
      await query(`UPDATE risk_findings SET status=?, reviewed_by=?, reviewed_at=NOW(), review_note=?,
        assigned_user_id=COALESCE(?,assigned_user_id),resolution_due_at=COALESCE(?,resolution_due_at),
        resolution_proof=COALESCE(?,resolution_proof) WHERE id=?`,
        [req.body.status, req.user.id, req.body.note || null, req.body.assignedUserId || null,
          req.body.resolutionDueAt ? new Date(req.body.resolutionDueAt) : null,
          req.body.resolutionProof || null, req.params.id]);
      await audit(pool, req.user.id, 'REVIEW', 'risk_finding', req.params.id,
        { status: finding.status }, { ...req.body }, req.ip);
      if (req.body.status === 'Confirmed') await notify({
        key: `risk-assigned:${finding.id}:${req.body.assignedUserId}`,
        caseKey: `risk-investigation:${finding.id}`, userId: req.body.assignedUserId,
        severity: finding.severity === 'Critical' ? 'Critical' : 'Warning',
        title: `Investigate: ${finding.title}`,
        message: `${req.body.note || finding.detail} Resolution due ${req.body.resolutionDueAt}.`,
        referenceType: 'risk_finding', referenceId: finding.id
      });
      publishChange('integrity', { id: Number(req.params.id) });
      res.status(204).end();
    } catch (error) { next(error); }
  });

router.get('/integrity/investigators', auth, permit('admin.audit'), async (_req, res, next) => {
  try {
    const users = await query('SELECT id,name,role_id roleId FROM users WHERE active=1 ORDER BY name');
    const eligible = [];
    for (const user of users) if ((await permissionsFor(user.id, user.roleId)).includes('admin.audit'))
      eligible.push({ id: user.id, name: user.name });
    res.json(eligible);
  }
  catch (error) { next(error); }
});

router.get('/integrity/findings/:id/comments', auth, permit('admin.audit'), async (req, res, next) => {
  try {
    res.json(await query(`SELECT c.id,c.body,c.created_at createdAt,u.name author FROM risk_finding_comments c
      JOIN users u ON u.id=c.user_id WHERE c.finding_id=? ORDER BY c.id`, [req.params.id]));
  } catch (error) { next(error); }
});

router.post('/integrity/findings/:id/comments', auth, permit('admin.audit'),
  validate(z.object({ body: z.string().trim().min(1).max(2000) })), async (req, res, next) => {
    try {
      if (!await getOne('SELECT id FROM risk_findings WHERE id=?', [req.params.id])) throw fail(404, 'Finding not found');
      const result = await query('INSERT INTO risk_finding_comments(finding_id,user_id,body) VALUES(?,?,?)',
        [req.params.id, req.user.id, req.body.body]);
      await audit(pool, req.user.id, 'COMMENT', 'risk_finding', req.params.id, null, { body: req.body.body }, req.ip);
      publishChange('integrity', { id: Number(req.params.id) });
      res.status(201).json({ id: result.insertId });
    } catch (error) { next(error); }
  });

/** Runs the whole sweep now rather than waiting for the timer. */
router.post('/integrity/scan', auth, permit('admin.audit'), async (_req, res, next) => {
  try {
    res.json(await runIntegritySweep());
  } catch (error) { next(error); }
});

/* ---- what the company considers normal ---------------------------------- */

router.get('/integrity/settings', auth, permit('admin.audit'), async (_req, res, next) => {
  try {
    res.json(await query(
      'SELECT setting_key settingKey,value,label,help,updated_at updatedAt FROM risk_settings ORDER BY setting_key'));
  } catch (error) { next(error); }
});

router.patch('/integrity/settings/:key', auth, permit('admin.users'),
  validate(z.object({ value: z.string().trim().min(1).max(200) })),
  async (req, res, next) => {
    try {
      const existing = await getOne('SELECT * FROM risk_settings WHERE setting_key=?', [req.params.key]);
      if (!existing) throw fail(404, 'That setting does not exist');
      await query('UPDATE risk_settings SET value=?, updated_by=? WHERE setting_key=?',
        [req.body.value, req.user.id, req.params.key]);
      await loadSettings(true);
      await audit(pool, req.user.id, 'UPDATE', 'risk_setting', req.params.key,
        { value: existing.value }, { value: req.body.value }, req.ip);
      res.status(204).end();
    } catch (error) { next(error); }
  });

export default router;
