import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, query, today, transaction } from '../db.js';
import { auth, permit, roles, validate, wrap } from '../lib/http.js';
import { notify } from '../alerts.js';
import { listAttachments } from './uploads.js';

const router = Router();

const select = `SELECT r.id,r.project_id projectId,p.name site,r.supervisor,DATE_FORMAT(r.report_date,'%d %b %Y') date,
  r.report_date reportDate,r.workforce,r.work_completed work,r.issue,r.weather,r.delay_hours delayHours
  FROM daily_reports r JOIN projects p ON p.id=r.project_id`;

router.get('/', auth, wrap(async (req, res) => {
  const where = req.query.projectId ? 'WHERE r.project_id=?' : '';
  const params = req.query.projectId ? [req.query.projectId] : [];
  res.json(await query(`${select} ${where} ORDER BY r.report_date DESC,r.id DESC LIMIT 120`, params));
}));

router.get('/:id', auth, wrap(async (req, res) => {
  const report = await getOne(`${select} WHERE r.id=?`, [req.params.id]);
  if (!report) return res.status(404).json({ error: 'Report not found' });
  const [materials, equipment, photos, attendance] = await Promise.all([
    query(`SELECT rm.id,rm.quantity,m.name material,m.unit FROM report_materials rm JOIN materials m ON m.id=rm.material_id WHERE rm.report_id=?`, [report.id]),
    query(`SELECT re.id,re.hours,e.name equipment,e.code FROM report_equipment re JOIN equipment e ON e.id=re.equipment_id WHERE re.report_id=?`, [report.id]),
    listAttachments('report', report.id),
    query(`SELECT employee_name name,role,check_in \`in\`,check_out \`out\`,state FROM attendance
      WHERE project_id=? AND work_date=? ORDER BY employee_name`, [report.projectId, report.reportDate])
  ]);
  res.json({ ...report, materials, equipment, photos, attendance });
}));

/**
 * A daily report is the site's record for the day: workforce, work done, materials and
 * equipment used, delays and photos — captured once, visible to management immediately.
 */
router.post('/', auth, permit(roles.site), validate(z.object({
  projectId: z.number().int().positive(),
  reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  workforce: z.number().int().min(0).max(10000),
  work: z.string().min(3).max(5000),
  issue: z.string().max(3000).optional(),
  weather: z.string().max(100).optional(),
  delayHours: z.number().min(0).max(24).default(0),
  materials: z.array(z.object({ materialId: z.number().int().positive(), quantity: z.number().positive() })).default([]),
  equipment: z.array(z.object({ equipmentId: z.number().int().positive(), hours: z.number().min(0).max(24) })).default([]),
  photos: z.array(z.object({ caption: z.string().max(200).optional(), fileRef: z.string().min(2).max(400) })).default([])
})), wrap(async (req, res) => {
  const body = req.body;
  const date = body.reportDate || today();
  try {
    const id = await transaction(async connection => {
      const [result] = await connection.execute(`INSERT INTO daily_reports
        (project_id,supervisor,report_date,workforce,work_completed,issue,weather,delay_hours,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [body.projectId, req.user.name, date, body.workforce, body.work, body.issue || '', body.weather || '', body.delayHours, req.user.id]);
      for (const item of body.materials) {
        await connection.execute('INSERT INTO report_materials (report_id,material_id,quantity) VALUES (?,?,?)', [result.insertId, item.materialId, item.quantity]);
      }
      for (const item of body.equipment) {
        await connection.execute('INSERT INTO report_equipment (report_id,equipment_id,hours) VALUES (?,?,?)', [result.insertId, item.equipmentId, item.hours]);
      }
      for (const photo of body.photos) {
        await connection.execute('INSERT INTO report_photos (report_id,caption,file_ref) VALUES (?,?,?)', [result.insertId, photo.caption || null, photo.fileRef]);
      }
      await audit(connection, req.user.id, 'CREATE', 'daily_report', result.insertId, null, { date, ...body }, req.ip);
      return result.insertId;
    });
    /* A reported issue or delay is escalated the same day rather than surfacing in a weekly review. */
    if (body.issue || body.delayHours > 0) {
      await notify({
        audience: 'Project Manager',
        severity: body.delayHours >= 2 ? 'Warning' : 'Info',
        title: `Site issue reported — ${date}`,
        message: `${req.user.name}: ${body.issue || 'Delay recorded'}${body.delayHours ? ` (${body.delayHours}h delay)` : ''}.`,
        referenceType: 'daily_report',
        referenceId: id
      });
    }
    res.status(201).json(await getOne(`${select} WHERE r.id=?`, [id]));
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'A report for this project already exists on that date' });
    throw error;
  }
}));

export default router;
