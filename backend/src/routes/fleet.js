import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, today, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { dueLabel } from './bootstrap.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DOC_TYPES = ['Insurance', 'Revenue licence', 'Emission test', 'Service', 'Fitness certificate'];

const select = `SELECT f.id,f.vehicle,f.registration reg,f.driver,f.status,f.renewal_type renewal,
  COALESCE(primary_doc.expiry_date,f.due_date) due_date,f.odometer,
  f.project_id projectId,p.name project,f.driver_employee_id driverEmployeeId,e.name driverName,e.phone driverPhone,
  f.service_interval_km serviceIntervalKm,f.service_interval_months serviceIntervalMonths,
  f.last_service_date lastServiceDate,f.last_service_odometer lastServiceOdometer
  FROM fleet f LEFT JOIN projects p ON p.id=f.project_id LEFT JOIN employees e ON e.id=f.driver_employee_id
  LEFT JOIN vehicle_documents primary_doc ON primary_doc.vehicle_id=f.id AND primary_doc.doc_type=f.renewal_type`;

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
  return { kmRemaining: byDistance, dueDate, overdue: (byDistance !== null && byDistance <= 0) || (dueDate && dueDate < today()) };
}

router.get('/', auth, permit('transport.view','transport.manage'), wrap(async (_req, res) => {
  const vehicles = await query(`${select} ORDER BY f.id`);
  res.json(vehicles.map(vehicle => ({ ...vehicle, due: dueLabel(vehicle.due_date), service: serviceDue(vehicle) })));
}));

router.get('/:id', auth, permit('transport.view','transport.manage'), wrap(async (req, res) => {
  const vehicle = await getOne(`${select} WHERE f.id=?`, [req.params.id]);
  if (!vehicle) return res.status(404).json({ error: 'Asset not found' });
  const [documents, fuel, maintenance, running, drivers, readings, renewals] = await Promise.all([
    query('SELECT id,doc_type docType,reference,expiry_date expiryDate,cost FROM vehicle_documents WHERE vehicle_id=? ORDER BY expiry_date', [vehicle.id]),
    query(`SELECT f.id,f.fuel_date fuelDate,f.litres,f.cost,f.odometer,f.driver,p.name project FROM fuel_records f
      LEFT JOIN projects p ON p.id=f.project_id WHERE f.vehicle_id=? ORDER BY f.fuel_date DESC LIMIT 50`, [vehicle.id]),
    query(`SELECT m.id,m.service_date serviceDate,m.maintenance_kind kind,m.description,m.cost,m.garage,m.odometer,
      p.name project FROM vehicle_maintenance m LEFT JOIN projects p ON p.id=m.project_id
      WHERE m.vehicle_id=? ORDER BY m.service_date DESC,m.id DESC`, [vehicle.id]),
    query(`SELECT COALESCE((SELECT SUM(cost) FROM fuel_records WHERE vehicle_id=?),0) fuelCost,
      COALESCE((SELECT SUM(cost) FROM vehicle_maintenance WHERE vehicle_id=?),0) maintenanceCost,
      COALESCE((SELECT SUM(litres) FROM fuel_records WHERE vehicle_id=?),0) litres`, [vehicle.id, vehicle.id, vehicle.id]),
    query(`SELECT a.id,a.driver_name driverName,a.employee_id employeeId,a.assigned_on assignedOn,
      a.ended_on endedOn,a.notes,p.name project FROM vehicle_driver_assignments a
      LEFT JOIN projects p ON p.id=a.project_id WHERE a.vehicle_id=? ORDER BY a.id DESC`,[vehicle.id]),
    query(`SELECT id,reading_date readingDate,odometer,source,notes FROM vehicle_odometer_readings
      WHERE vehicle_id=? ORDER BY reading_date DESC,id DESC LIMIT 100`,[vehicle.id]),
    query(`SELECT id,doc_type docType,reference,renewed_on renewedOn,expiry_date expiryDate,cost
      FROM vehicle_document_renewals WHERE vehicle_id=? ORDER BY renewed_on DESC,id DESC`,[vehicle.id])
  ]);
  const measured=fuel.filter(row=>Number(row.odometer)>0).sort((a,b)=>Number(a.odometer)-Number(b.odometer));
  const distance=measured.length>1?Number(measured.at(-1).odometer)-Number(measured[0].odometer):0;
  const measuredLitres=measured.slice(1).reduce((sum,row)=>sum+Number(row.litres),0);
  res.json({
    ...vehicle,
    due: dueLabel(vehicle.due_date),
    service: serviceDue(vehicle),
    documents: documents.map(document => ({ ...document, due: dueLabel(document.expiryDate) })),
    fuel,
    maintenance,
    drivers,readings,renewals,
    running: {...running[0],distanceKm:distance,litresPer100Km:distance>0?Math.round(measuredLitres/distance*10000)/100:null}
  });
}));

router.post('/', auth, permit('transport.manage'), validate(fleetSchema), wrap(async (req, res) => {
  const body = req.body;
  try {
    const id=await transaction(async connection=>{
      let driver=body.driver||null;
      if(body.driverEmployeeId){
        const [[employee]]=await connection.execute('SELECT name FROM employees WHERE id=? AND active=1',[body.driverEmployeeId]);
        if(!employee)throw Object.assign(new Error('Assigned driver is not an active employee'),{status:400});
        driver=employee.name;
      }
      const [result]=await connection.execute(`INSERT INTO fleet
        (vehicle,registration,driver,driver_employee_id,status,renewal_type,due_date,project_id,odometer,service_interval_km,service_interval_months)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`,[body.vehicle,body.registration,driver,body.driverEmployeeId||null,
        body.status,body.renewal,body.dueDate,body.projectId||null,body.odometer||0,
        body.serviceIntervalKm||0,body.serviceIntervalMonths||0]);
      if(driver)await connection.execute(`INSERT INTO vehicle_driver_assignments
        (vehicle_id,employee_id,driver_name,project_id,assigned_on,assigned_by) VALUES (?,?,?,?,CURDATE(),?)`,
        [result.insertId,body.driverEmployeeId||null,driver,body.projectId||null,req.user.id]);
      if(DOC_TYPES.includes(body.renewal)){
        await connection.execute('INSERT INTO vehicle_documents (vehicle_id,doc_type,expiry_date) VALUES (?,?,?)',
          [result.insertId,body.renewal,body.dueDate]);
        await connection.execute(`INSERT INTO vehicle_document_renewals
          (vehicle_id,doc_type,renewed_on,expiry_date,recorded_by) VALUES (?,?,CURDATE(),?,?)`,
          [result.insertId,body.renewal,body.dueDate,req.user.id]);
      }
      if(body.odometer)await connection.execute(`INSERT INTO vehicle_odometer_readings
        (vehicle_id,reading_date,odometer,source,notes,recorded_by) VALUES (?,CURDATE(),?,'Manual',?,?)`,
        [result.insertId,body.odometer,'Initial vehicle reading',req.user.id]);
      return result.insertId;
    });
    const row = await getOne(`${select} WHERE f.id=?`, [id]);
    await audit(pool, req.user.id, 'CREATE', 'fleet', row.id, null, row, req.ip);
    res.status(201).json({ ...row, due: dueLabel(row.due_date) });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'That registration is already recorded' });
    if(error.status)return res.status(error.status).json({error:error.message});
    throw error;
  }
}));

router.patch('/:id', auth, permit('transport.manage'), validate(fleetSchema.partial()), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM fleet WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Asset not found' });
  if(['driver','driverEmployeeId','odometer','renewal','dueDate'].some(key=>key in req.body))
    return res.status(400).json({error:'Use the dated driver, odometer or document record to change these fields'});
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

router.post('/:id/drivers',auth,permit('transport.manage'),validate(z.object({
  employeeId:z.number().int().positive().nullable().optional(),driverName:z.string().trim().min(2).max(120).optional(),
  projectId:z.number().int().positive().nullable().optional(),assignedOn:isoDate,notes:z.string().max(500).optional()
})),wrap(async(req,res)=>{
  const b=req.body,id=await transaction(async connection=>{
    const [[vehicle]]=await connection.execute('SELECT * FROM fleet WHERE id=? FOR UPDATE',[req.params.id]);
    if(!vehicle)throw Object.assign(new Error('Vehicle not found'),{status:404});
    let name=b.driverName||null;
    if(b.employeeId){
      const [[employee]]=await connection.execute('SELECT name FROM employees WHERE id=? AND active=1',[b.employeeId]);
      if(!employee)throw Object.assign(new Error('Driver is not an active employee'),{status:400});
      name=employee.name;
    }
    const projectId=b.projectId===undefined?vehicle.project_id:b.projectId;
    if(projectId){
      const [[project]]=await connection.execute('SELECT id FROM projects WHERE id=? AND active=1',[projectId]);
      if(!project)throw Object.assign(new Error('Project site not found'),{status:400});
    }
    const [[active]]=await connection.execute(`SELECT id,assigned_on assignedOn FROM vehicle_driver_assignments
      WHERE vehicle_id=? AND ended_on IS NULL ORDER BY id DESC LIMIT 1 FOR UPDATE`,[vehicle.id]);
    if(active&&new Date(b.assignedOn)<new Date(active.assignedOn))
      throw Object.assign(new Error('The new assignment cannot predate the current assignment'),{status:400});
    if(active)await connection.execute('UPDATE vehicle_driver_assignments SET ended_on=? WHERE id=?',[b.assignedOn,active.id]);
    let assignmentId=null;
    if(name){
      const [created]=await connection.execute(`INSERT INTO vehicle_driver_assignments
        (vehicle_id,employee_id,driver_name,project_id,assigned_on,notes,assigned_by) VALUES (?,?,?,?,?,?,?)`,
        [vehicle.id,b.employeeId||null,name,projectId||null,b.assignedOn,b.notes||null,req.user.id]);
      assignmentId=created.insertId;
    }
    await connection.execute('UPDATE fleet SET driver=?,driver_employee_id=?,project_id=? WHERE id=?',
      [name,b.employeeId||null,projectId||null,vehicle.id]);
    await audit(connection,req.user.id,'ASSIGN','vehicle_driver',assignmentId||vehicle.id,active,{name,projectId,...b},req.ip);
    return assignmentId;
  });res.status(201).json({id,assigned:Boolean(id)});
}));

router.post('/:id/odometer',auth,permit('transport.manage'),validate(z.object({
  readingDate:isoDate,odometer:z.number().int().nonnegative(),notes:z.string().max(300).optional()
})),wrap(async(req,res)=>{
  const b=req.body,id=await transaction(async connection=>{
    const [[vehicle]]=await connection.execute('SELECT id,odometer FROM fleet WHERE id=? FOR UPDATE',[req.params.id]);
    if(!vehicle)throw Object.assign(new Error('Vehicle not found'),{status:404});
    if(b.odometer<Number(vehicle.odometer))throw Object.assign(new Error('Odometer cannot go backwards'),{status:409});
    const [created]=await connection.execute(`INSERT INTO vehicle_odometer_readings
      (vehicle_id,reading_date,odometer,source,notes,recorded_by) VALUES (?,?,?,'Manual',?,?)`,
      [vehicle.id,b.readingDate,b.odometer,b.notes||null,req.user.id]);
    await connection.execute('UPDATE fleet SET odometer=? WHERE id=?',[b.odometer,vehicle.id]);
    await audit(connection,req.user.id,'READ','vehicle_odometer',created.insertId,vehicle,{...b},req.ip);
    return created.insertId;
  });res.status(201).json({id});
}));

/** Compliance documents — the expiry dates that the PID names as a recurring GKUC risk. */
router.get('/documents/expiring', auth, permit('transport.view','transport.manage'), wrap(async (req, res) => {
  const window = Number(req.query.days || 60);
  const rows = await query(`SELECT d.id,d.doc_type docType,d.reference,d.expiry_date expiryDate,d.cost,f.vehicle,f.registration,f.id vehicleId
    FROM vehicle_documents d JOIN fleet f ON f.id=d.vehicle_id
    WHERE d.expiry_date <= DATE_ADD(CURDATE(), INTERVAL ? DAY) ORDER BY d.expiry_date`, [window]);
  res.json(rows.map(row => ({ ...row, due: dueLabel(row.expiryDate) })));
}));

router.post('/:id/documents', auth, permit('transport.manage'), validate(z.object({
  docType: z.enum(DOC_TYPES),
  reference: z.string().max(120).optional(),
  renewedOn: isoDate.optional(),
  expiryDate: isoDate,
  cost: z.number().nonnegative().default(0)
})), wrap(async (req, res) => {
  const body = req.body;
  await transaction(async connection=>{
    const [[vehicle]]=await connection.execute('SELECT id FROM fleet WHERE id=? FOR UPDATE',[req.params.id]);
    if(!vehicle)throw Object.assign(new Error('Vehicle not found'),{status:404});
    await connection.execute(`INSERT INTO vehicle_documents (vehicle_id,doc_type,reference,expiry_date,cost) VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE reference=VALUES(reference),expiry_date=VALUES(expiry_date),cost=VALUES(cost)`,
      [vehicle.id,body.docType,body.reference||null,body.expiryDate,body.cost]);
    await connection.execute('UPDATE fleet SET due_date=? WHERE id=? AND renewal_type=?',
      [body.expiryDate,vehicle.id,body.docType]);
    const [history]=await connection.execute(`INSERT INTO vehicle_document_renewals
      (vehicle_id,doc_type,reference,renewed_on,expiry_date,cost,recorded_by) VALUES (?,?,?,?,?,?,?)`,
      [vehicle.id,body.docType,body.reference||null,body.renewedOn||today(),body.expiryDate,body.cost,req.user.id]);
    await audit(connection,req.user.id,'RENEWAL','vehicle_document',history.insertId,null,body,req.ip);
  });
  const row = await getOne('SELECT * FROM vehicle_documents WHERE vehicle_id=? AND doc_type=?', [req.params.id, body.docType]);
  res.status(201).json({ ...row, due: dueLabel(row.expiry_date) });
}));

router.post('/:id/fuel', auth, permit('transport.manage'), validate(z.object({
  projectId: z.number().int().positive().nullable().optional(),
  fuelDate: isoDate,
  litres: z.number().positive().max(2000),
  cost: z.number().positive(),
  odometer: z.number().int().positive(),
  driver: z.string().max(120).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const id=await transaction(async connection=>{
    const [[vehicle]]=await connection.execute('SELECT * FROM fleet WHERE id=? FOR UPDATE',[req.params.id]);
    if(!vehicle)throw Object.assign(new Error('Vehicle not found'),{status:404});
    if(body.odometer<Number(vehicle.odometer))throw Object.assign(new Error(
      `The odometer cannot go backwards — ${vehicle.registration} was last recorded at ${vehicle.odometer} km`),{status:409});
    const projectId=body.projectId===undefined?vehicle.project_id:body.projectId;
    if(projectId){const [[project]]=await connection.execute('SELECT id FROM projects WHERE id=? AND active=1',[projectId]);
      if(!project)throw Object.assign(new Error('Project site not found'),{status:400});}
    const [result]=await connection.execute(`INSERT INTO fuel_records
      (vehicle_id,project_id,fuel_date,litres,cost,odometer,driver,created_by) VALUES (?,?,?,?,?,?,?,?)`,
      [vehicle.id,projectId,body.fuelDate,body.litres,body.cost,body.odometer,body.driver||vehicle.driver,req.user.id]);
    await connection.execute('UPDATE fleet SET odometer=GREATEST(odometer,?) WHERE id=?',[body.odometer,vehicle.id]);
    await connection.execute(`INSERT INTO vehicle_odometer_readings
      (vehicle_id,reading_date,odometer,source,source_id,recorded_by) VALUES (?,?,?,'Fuel',?,?)`,
      [vehicle.id,body.fuelDate,body.odometer,result.insertId,req.user.id]);
    if(projectId)await connection.execute(`INSERT INTO expenses
      (project_id,source,description,amount,expense_date,origin_type,origin_id,created_by)
      VALUES (?,'Fuel',?,?,?,'fuel_record',?,?)`,
      [projectId,`Fuel — ${vehicle.vehicle} (${vehicle.registration})`,body.cost,body.fuelDate,String(result.insertId),req.user.id]);
    await audit(connection,req.user.id,'CREATE','fuel_record',result.insertId,null,{...body,projectId},req.ip);
    return result.insertId;
  });
  const row=await getOne('SELECT * FROM fuel_records WHERE id=?',[id]);
  res.status(201).json(row);
}));

router.post('/:id/maintenance', auth, permit('transport.manage'), validate(z.object({
  kind:z.enum(['Service','Repair','Inspection']).default('Service'),
  serviceDate: isoDate,
  description: z.string().min(3).max(400),
  cost: z.number().nonnegative().default(0),
  garage: z.string().max(180).optional(),
  odometer: z.number().int().nonnegative(),
  projectId:z.number().int().positive().nullable().optional(),
  setStatus:z.enum(['Available','Repair']).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const id=await transaction(async connection=>{
    const [[vehicle]]=await connection.execute('SELECT * FROM fleet WHERE id=? FOR UPDATE',[req.params.id]);
    if(!vehicle)throw Object.assign(new Error('Vehicle not found'),{status:404});
    if(body.odometer<Number(vehicle.odometer))throw Object.assign(new Error('Odometer cannot go backwards'),{status:409});
    if(body.projectId){const [[project]]=await connection.execute('SELECT id FROM projects WHERE id=? AND active=1',[body.projectId]);
      if(!project)throw Object.assign(new Error('Project site not found'),{status:400});}
    const [result]=await connection.execute(`INSERT INTO vehicle_maintenance
      (vehicle_id,project_id,service_date,maintenance_kind,description,cost,garage,odometer,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [vehicle.id,body.projectId||null,body.serviceDate,body.kind,body.description,body.cost,body.garage||null,body.odometer,req.user.id]);
    if(body.kind==='Service')await connection.execute(`UPDATE fleet SET last_service_date=?,last_service_odometer=?,
      odometer=GREATEST(odometer,?),status=COALESCE(?,status) WHERE id=?`,
      [body.serviceDate,body.odometer,body.odometer,body.setStatus||null,vehicle.id]);
    else await connection.execute('UPDATE fleet SET odometer=GREATEST(odometer,?),status=COALESCE(?,status) WHERE id=?',
      [body.odometer,body.setStatus||null,vehicle.id]);
    await connection.execute(`INSERT INTO vehicle_odometer_readings
      (vehicle_id,reading_date,odometer,source,source_id,recorded_by) VALUES (?,?,?,?,?,?)`,
      [vehicle.id,body.serviceDate,body.odometer,body.kind,result.insertId,req.user.id]);
    if(body.projectId&&body.cost>0)await connection.execute(`INSERT INTO expenses
      (project_id,source,description,amount,expense_date,origin_type,origin_id,created_by)
      VALUES (?,'Equipment',?,?,?,'vehicle_maintenance',?,?)`,
      [body.projectId,`${body.kind} — ${vehicle.vehicle} (${vehicle.registration}): ${body.description}`,
        body.cost,body.serviceDate,String(result.insertId),req.user.id]);
    await audit(connection,req.user.id,'CREATE','vehicle_maintenance',result.insertId,null,body,req.ip);
    return result.insertId;
  });
  const row=await getOne('SELECT * FROM vehicle_maintenance WHERE id=?',[id]);
  res.status(201).json(row);
}));

export default router;
