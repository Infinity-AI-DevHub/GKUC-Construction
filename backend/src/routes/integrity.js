import { Router } from 'express';
import { z } from 'zod';
import { pool, query, getOne, audit } from '../db.js';
import { auth, permit, validate, fail } from '../lib/http.js';
import { runIntegritySweep, loadSettings } from '../lib/integrity.js';
import { publishChange } from '../lib/realtime.js';

const router = Router();

/** What the watch has found, worst first. */
router.get('/integrity/findings', auth, permit('admin.audit'), async (req, res, next) => {
  try {
    const status = ['Open', 'Confirmed', 'Dismissed', 'Resolved'].includes(req.query.status)
      ? req.query.status : 'Open';
    const rows = await query(`
      SELECT f.id,f.rule,f.category,f.severity,f.entity,f.entity_id entityId,f.title,f.detail,
             f.amount,f.score,f.status,f.created_at createdAt,f.evidence_json evidence,
             f.review_note reviewNote,f.reviewed_at reviewedAt,
             p.name project, subject.name subject, reviewer.name reviewedBy
        FROM risk_findings f
        LEFT JOIN projects p ON p.id=f.project_id
        LEFT JOIN users subject ON subject.id=f.subject_user_id
        LEFT JOIN users reviewer ON reviewer.id=f.reviewed_by
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
    note: z.string().trim().max(1000).optional()
  })),
  async (req, res, next) => {
    try {
      const finding = await getOne('SELECT * FROM risk_findings WHERE id=?', [req.params.id]);
      if (!finding) throw fail(404, 'That finding was not found');
      if (req.body.status === 'Dismissed' && !req.body.note?.trim()) {
        throw fail(400, 'Say why this is not a problem, so the decision can be understood later');
      }
      await query('UPDATE risk_findings SET status=?, reviewed_by=?, reviewed_at=NOW(), review_note=? WHERE id=?',
        [req.body.status, req.user.id, req.body.note || null, req.params.id]);
      await audit(pool, req.user.id, 'REVIEW', 'risk_finding', req.params.id,
        { status: finding.status }, { status: req.body.status, note: req.body.note }, req.ip);
      publishChange('integrity', { id: Number(req.params.id) });
      res.status(204).end();
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
