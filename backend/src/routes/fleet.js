import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query } from '../db.js';
import { auth, permit, roles, validate, wrap } from '../lib/http.js';
import { dueLabel } from './bootstrap.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DOC_TYPES = ['Insurance', 'Revenue licence', 'Emission test', 'Service', 'Fitness certificate'];

const select = `SELECT f.id,f.vehicle,f.registration reg,f.driver,f.status,f.renewal_type renewal,f.due_date,f.odometer,
  f.project_id projectId,p.name project,f.driver_employee_id driverEmployeeId,e.name driverName,e.phone driverPhone,
  f.service_interval_km serviceIntervalKm,f.service_interval_months serviceIntervalMonths,
  f.last_service_date lastServiceDate,f.last_service_odometer lastServiceOdometer
  FROM fleet f LEFT JOIN projects p ON p.id=f.project_id LEFT JOIN employees e ON e.id=f.driver_employee_id`;

const fleetSchema = z.object({
  vehicle: z.string().min(2).max(180),
  registration: z.string().min(2).max(60),
  driver: z.string().max(120).optional(),
  status: z.enum(['Available', 'Assigned', 'Repair', 'Inactive']),
  renewal: z.string().min(2).max(100),
  dueDate: isoDate,
  projectId: z.number().int().positive().nullable().optional(),
  odometer: z.number().int().nonnegative().optional(),
  driverEmployeeId: z.number().int().positive().nullable().optional(),
  serviceIntervalKm: z.number().int().nonnegative().optional(),
  serviceIntervalMonths: z.number().int().min(0).max(60).optional(),
  lastServiceDate: isoDate.optional(),
  lastServiceOdometer: z.number().int().nonnegative().optional()
});

/**
 * The next service falls due on whichever comes first: the distance interval or the
 * time interval. Returns null when neither has been configured for the vehicle.
 */
export function serviceDue(vehicle) {
  const byDistance = vehicle.serviceIntervalKm
    ? Number(vehicle.lastServiceOdometer || 0) + Number(vehicle.serviceIntervalKm) - Number(vehicle.odometer || 0)
    : null;
  let dueDate = null;
  if (vehicle.serviceIntervalMonths && vehicle.lastServiceDate) {
    const next = new Date(vehicle.lastServiceDate);
    next.setMonth(next.getMonth() + Number(vehicle.serviceIntervalMonths));
    dueDate = next.toISOString().slice(0, 10);
  }
  if (byDistance === null && !dueDate) return null;
  return { kmRemaining: byDistance, dueDate, overdue: (byDistance !== null && byDistance <= 0) || (dueDate && dueDate < new Date().toISOString().slice(0, 10)) };
}

router.get('/', auth, wrap(async (_req, res) => {
  const vehicles = await query(`${select} ORDER BY f.id`);
  res.json(vehicles.map(vehicle => ({ ...vehicle, due: dueLabel(vehicle.due_date), service: serviceDue(vehicle) })));
}));

router.get('/:id', auth, wrap(async (req, res) => {
  const vehicle = await getOne(`${select} WHERE f.id=?`, [req.params.id]);
  if (!vehicle) return res.status(404).json({ error: 'Asset not found' });
  const [documents, fuel, maintenance, running] = await Promise.all([
    query('SELECT id,doc_type docType,reference,expiry_date expiryDate,cost FROM vehicle_documents WHERE vehicle_id=? ORDER BY expiry_date', [vehicle.id]),
    query(`SELECT f.id,f.fuel_date fuelDate,f.litres,f.cost,f.odometer,f.driver,p.name project FROM fuel_records f
      LEFT JOIN projects p ON p.id=f.project_id WHERE f.vehicle_id=? ORDER BY f.fuel_date DESC LIMIT 50`, [vehicle.id]),
    query('SELECT id,service_date serviceDate,description,cost,garage,odometer FROM vehicle_maintenance WHERE vehicle_id=? ORDER BY service_date DESC', [vehicle.id]),
    query(`SELECT COALESCE((SELECT SUM(cost) FROM fuel_records WHERE vehicle_id=?),0) fuelCost,
      COALESCE((SELECT SUM(cost) FROM vehicle_maintenance WHERE vehicle_id=?),0) maintenanceCost,
      COALESCE((SELECT SUM(litres) FROM fuel_records WHERE vehicle_id=?),0) litres`, [vehicle.id, vehicle.id, vehicle.id])
  ]);
  res.json({
    ...vehicle,
    due: dueLabel(vehicle.due_date),
    service: serviceDue(vehicle),
    documents: documents.map(document => ({ ...document, due: dueLabel(document.expiryDate) })),
    fuel,
    maintenance,
    running: running[0]
  });
}));

router.post('/', auth, permit(roles.transport), validate(fleetSchema), wrap(async (req, res) => {
  const body = req.body;
  try {
    const result = await query('INSERT INTO fleet (vehicle,registration,driver,status,renewal_type,due_date,project_id,odometer) VALUES (?,?,?,?,?,?,?,?)',
      [body.vehicle, body.registration, body.driver || null, body.status, body.renewal, body.dueDate, body.projectId || null, body.odometer || 0]);
    /* The renewal captured on the asset is also its first tracked compliance document. */
    if (DOC_TYPES.includes(body.renewal)) {
      await query('INSERT INTO vehicle_documents (vehicle_id,doc_type,expiry_date) VALUES (?,?,?)', [result.insertId, body.renewal, body.dueDate]);
    }
    const row = await getOne(`${select} WHERE f.id=?`, [result.insertId]);
    await audit(pool, req.user.id, 'CREATE', 'fleet', row.id, null, row, req.ip);
    res.status(201).json({ ...row, due: dueLabel(row.due_date) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That registration is already recorded' });
    throw error;
  }
}));

router.patch('/:id', auth, permit(roles.transport), validate(fleetSchema.partial()), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM fleet WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Asset not found' });
  const columns = {
    renewal: 'renewal_type', dueDate: 'due_date', projectId: 'project_id', driverEmployeeId: 'driver_employee_id',
    serviceIntervalKm: 'service_interval_km', serviceIntervalMonths: 'service_interval_months',
    lastServiceDate: 'last_service_date', lastServiceOdometer: 'last_service_odometer'
  };
  const entries = Object.entries(req.body);
  if (entries.length) {
    await query(`UPDATE fleet SET ${entries.map(([key]) => `${columns[key] || key}=?`).join(',')} WHERE id=?`,
      [...entries.map(([, value]) => value), req.params.id]);
  }
  const after = await getOne(`${select} WHERE f.id=?`, [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'fleet', after.id, before, after, req.ip);
  res.json({ ...after, due: dueLabel(after.due_date) });
}));

/** Compliance documents — the expiry dates that the PID names as a recurring GKUC risk. */
router.get('/documents/expiring', auth, wrap(async (req, res) => {
  const window = Number(req.query.days || 60);
  const rows = await query(`SELECT d.id,d.doc_type docType,d.reference,d.expiry_date expiryDate,d.cost,f.vehicle,f.registration,f.id vehicleId
    FROM vehicle_documents d JOIN fleet f ON f.id=d.vehicle_id
    WHERE d.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY) ORDER BY d.expiry_date`, [window]);
  res.json(rows.map(row => ({ ...row, due: dueLabel(row.expiryDate) })));
}));

router.post('/:id/documents', auth, permit(roles.transport), validate(z.object({
  docType: z.enum(DOC_TYPES),
  reference: z.string().max(120).optional(),
  expiryDate: isoDate,
  cost: z.number().nonnegative().default(0)
})), wrap(async (req, res) => {
  const body = req.body;
  await query(`INSERT INTO vehicle_documents (vehicle_id,doc_type,reference,expiry_date,cost) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE reference=VALUES(reference),expiry_date=VALUES(expiry_date),cost=VALUES(cost)`,
  [req.params.id, body.docType, body.reference || null, body.expiryDate, body.cost]);
  const row = await getOne('SELECT * FROM vehicle_documents WHERE vehicle_id=? AND doc_type=?', [req.params.id, body.docType]);
  await audit(pool, req.user.id, 'RENEWAL', 'vehicle_document', row.id, null, row, req.ip);
  res.status(201).json({ ...row, due: dueLabel(row.expiry_date) });
}));

router.post('/:id/fuel', auth, permit(roles.transport), validate(z.object({
  projectId: z.number().int().positive().optional(),
  fuelDate: isoDate,
  litres: z.number().positive().max(2000),
  cost: z.number().positive(),
  odometer: z.number().int().nonnegative().default(0),
  driver: z.string().max(120).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const vehicle = await getOne('SELECT * FROM fleet WHERE id=?', [req.params.id]);
  if (!vehicle) return res.status(404).json({ error: 'Asset not found' });
  const result = await query('INSERT INTO fuel_records (vehicle_id,project_id,fuel_date,litres,cost,odometer,driver,created_by) VALUES (?,?,?,?,?,?,?,?)',
    [vehicle.id, body.projectId || null, body.fuelDate, body.litres, body.cost, body.odometer, body.driver || vehicle.driver, req.user.id]);
  if (body.odometer > vehicle.odometer) await query('UPDATE fleet SET odometer=? WHERE id=?', [body.odometer, vehicle.id]);
  if (body.projectId) {
    await query(`INSERT INTO expenses (project_id,source,description,amount,expense_date,origin_type,origin_id,created_by)
      VALUES (?,'Fuel',?,?,?, 'fuel_record', ?, ?)`,
    [body.projectId, `Fuel — ${vehicle.vehicle} (${vehicle.registration})`, body.cost, body.fuelDate, String(result.insertId), req.user.id]);
  }
  const row = await getOne('SELECT * FROM fuel_records WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'fuel_record', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.post('/:id/maintenance', auth, permit(roles.transport), validate(z.object({
  serviceDate: isoDate,
  description: z.string().min(3).max(400),
  cost: z.number().nonnegative().default(0),
  garage: z.string().max(180).optional(),
  odometer: z.number().int().nonnegative().default(0)
})), wrap(async (req, res) => {
  const body = req.body;
  const result = await query('INSERT INTO vehicle_maintenance (vehicle_id,service_date,description,cost,garage,odometer,created_by) VALUES (?,?,?,?,?,?,?)',
    [req.params.id, body.serviceDate, body.description, body.cost, body.garage || null, body.odometer, req.user.id]);
  await query(`UPDATE fleet SET last_service_date=?, last_service_odometer=?, odometer=GREATEST(odometer,?) WHERE id=?`,
    [body.serviceDate, body.odometer, body.odometer, req.params.id]);
  const row = await getOne('SELECT * FROM vehicle_maintenance WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'vehicle_maintenance', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

export default router;
