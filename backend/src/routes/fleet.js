import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, today, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { dueLabel } from './bootstrap.js';
import { publishChange } from '../lib/realtime.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const DOC_TYPES = ['Insurance', 'Revenue licence', 'Emission test', 'Service', 'Fitness certificate'];
const money = amount => `LKR ${Number(amount || 0).toLocaleString('en-LK', { maximumFractionDigits: 2 })}`;

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

/* Vehicles are shared; the selected company determines which funded fuel float can pay. */
router.get('/fuel-floats', auth, permit('transport.view','transport.manage'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error: 'Choose a company to see its fuel floats' });
  const floats = await query(`SELECT f.id,f.name,f.company_id companyId,f.project_id projectId,
    COALESCE(SUM(e.amount),0) balance FROM petty_cash_floats f
    LEFT JOIN petty_cash_entries e ON e.float_id=f.id
    WHERE f.account_type='Fuel' AND f.active=1 AND f.company_id=?
    GROUP BY f.id,f.name,f.company_id,f.project_id ORDER BY f.name`, [companyId]);
  res.json(floats);
}));

router.get('/monthly-report',auth,permit('finance.vehicleExpenses','transport.view','transport.manage'),wrap(async(req,res)=>{
  const companyId=Number(req.query.companyId),period=String(req.query.period||'');
  if(!Number.isInteger(companyId)||companyId<1||!/^\d{4}-(0[1-9]|1[0-2])$/.test(period))
    return res.status(400).json({error:'Choose a company and reporting month.'});
  const company=await getOne('SELECT id,name FROM companies WHERE id=? AND active=1',[companyId]);
  if(!company)return res.status(404).json({error:'Company not found.'});
  const from=`${period}-01`;
  const [fuel,maintenance,readings]=await Promise.all([
    query(`SELECT r.vehicle_id vehicleId,r.project_id projectId,v.vehicle,v.registration,p.name project,
      SUM(r.litres) fuelLitres,SUM(r.cost) fuelCost,COUNT(*) fuelEntries
      FROM fuel_records r JOIN fleet v ON v.id=r.vehicle_id LEFT JOIN projects p ON p.id=r.project_id
      WHERE r.company_id=? AND r.fuel_date>=? AND r.fuel_date<DATE_ADD(?,INTERVAL 1 MONTH)
      GROUP BY r.vehicle_id,r.project_id,v.vehicle,v.registration,p.name`,[companyId,from,from]),
    query(`SELECT m.vehicle_id vehicleId,m.project_id projectId,v.vehicle,v.registration,p.name project,
      SUM(CASE WHEN m.maintenance_kind='Repair' THEN m.cost ELSE 0 END) repairCost,
      SUM(CASE WHEN m.maintenance_kind='Service' THEN m.cost ELSE 0 END) serviceCost,
      SUM(CASE WHEN m.maintenance_kind='Inspection' THEN m.cost ELSE 0 END) inspectionCost,
      COUNT(*) maintenanceEntries FROM vehicle_maintenance m JOIN fleet v ON v.id=m.vehicle_id
      LEFT JOIN projects p ON p.id=m.project_id WHERE m.company_id=? AND m.service_date>=?
      AND m.service_date<DATE_ADD(?,INTERVAL 1 MONTH)
      GROUP BY m.vehicle_id,m.project_id,v.vehicle,v.registration,p.name`,[companyId,from,from]),
    query(`SELECT r.vehicle_id vehicleId,r.project_id projectId,MIN(r.odometer) firstOdometer,MAX(r.odometer) lastOdometer
      FROM vehicle_odometer_readings r WHERE r.company_id=? AND r.reading_date>=?
      AND r.reading_date<DATE_ADD(?,INTERVAL 1 MONTH) GROUP BY r.vehicle_id,r.project_id`,[companyId,from,from])
  ]);
  const rows=new Map(),key=row=>`${row.vehicleId}:${row.projectId||0}`;
  const ensure=row=>{const id=key(row);if(!rows.has(id))rows.set(id,{vehicleId:row.vehicleId,vehicle:row.vehicle,
    registration:row.registration,projectId:row.projectId||null,project:row.project||'Company fleet',fuelLitres:0,
    fuelCost:0,repairCost:0,serviceCost:0,inspectionCost:0,distanceKm:0,fuelEntries:0,maintenanceEntries:0});return rows.get(id);};
  for(const row of fuel)Object.assign(ensure(row),{fuelLitres:Number(row.fuelLitres),fuelCost:Number(row.fuelCost),fuelEntries:Number(row.fuelEntries)});
  for(const row of maintenance)Object.assign(ensure(row),{repairCost:Number(row.repairCost),serviceCost:Number(row.serviceCost),inspectionCost:Number(row.inspectionCost),maintenanceEntries:Number(row.maintenanceEntries)});
  for(const reading of readings){const row=rows.get(key(reading));if(row)row.distanceKm=Math.max(0,Number(reading.lastOdometer)-Number(reading.firstOdometer));}
  const result=[...rows.values()].map(row=>{const totalCost=row.fuelCost+row.repairCost+row.serviceCost+row.inspectionCost;
    return {...row,totalCost,costPerKm:row.distanceKm>0?Math.round(totalCost/row.distanceKm*100)/100:null};});
  const totals=result.reduce((sum,row)=>({fuelLitres:sum.fuelLitres+row.fuelLitres,fuelCost:sum.fuelCost+row.fuelCost,
    repairCost:sum.repairCost+row.repairCost,serviceCost:sum.serviceCost+row.serviceCost,
    inspectionCost:sum.inspectionCost+row.inspectionCost,distanceKm:sum.distanceKm+row.distanceKm,totalCost:sum.totalCost+row.totalCost}),
    {fuelLitres:0,fuelCost:0,repairCost:0,serviceCost:0,inspectionCost:0,distanceKm:0,totalCost:0});
  res.json({company,period,rows:result.sort((a,b)=>a.registration.localeCompare(b.registration)||a.project.localeCompare(b.project)),
    totals:{...totals,costPerKm:totals.distanceKm>0?Math.round(totals.totalCost/totals.distanceKm*100)/100:null}});
}));

router.get('/:id', auth, permit('transport.view','transport.manage'), wrap(async (req, res) => {
  const vehicle = await getOne(`${select} WHERE f.id=?`, [req.params.id]);
  if (!vehicle) return res.status(404).json({ error: 'Asset not found' });
  const [documents, fuel, maintenance, running, drivers, readings, renewals] = await Promise.all([
    query('SELECT id,doc_type docType,reference,expiry_date expiryDate,cost FROM vehicle_documents WHERE vehicle_id=? ORDER BY expiry_date', [vehicle.id]),
    query(`SELECT f.id,f.fuel_date fuelDate,f.litres,f.cost,f.odometer,f.driver,p.name project,
      pcf.name fuelFloat FROM fuel_records f
      LEFT JOIN projects p ON p.id=f.project_id
      LEFT JOIN petty_cash_entries pce ON pce.fuel_record_id=f.id
      LEFT JOIN petty_cash_floats pcf ON pcf.id=pce.float_id
      WHERE f.vehicle_id=? ORDER BY f.fuel_date DESC LIMIT 50`, [vehicle.id]),
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
        const [[employee]]=await connection.execute("SELECT name FROM employees WHERE id=? AND status='Active'",[body.driverEmployeeId]);
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
      const [[employee]]=await connection.execute("SELECT name FROM employees WHERE id=? AND status='Active'",[b.employeeId]);
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
    // DATE values are calendar days, not instants. Comparing parsed Date objects
    // can shift the day when the app and database use different time zones.
    if(active&&b.assignedOn<String(active.assignedOn).slice(0,10))
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
    const [[vehicle]]=await connection.execute('SELECT id,vehicle,registration FROM fleet WHERE id=? FOR UPDATE',[req.params.id]);
    if(!vehicle)throw Object.assign(new Error('Vehicle not found'),{status:404});
    const renewedOn=body.renewedOn||today();
    const [[last]]=await connection.execute(`SELECT reference,renewed_on renewedOn,expiry_date expiryDate,cost
      FROM vehicle_document_renewals WHERE vehicle_id=? AND doc_type=? ORDER BY id DESC LIMIT 1 FOR UPDATE`,[vehicle.id,body.docType]);
    if(last&&String(last.renewedOn).slice(0,10)===renewedOn&&String(last.expiryDate).slice(0,10)===body.expiryDate
      &&(last.reference||'')===(body.reference||'')&&Number(last.cost)===Number(body.cost))
      throw Object.assign(new Error('This renewal is already recorded for this vehicle. Open the existing renewal instead of entering it twice.'),{status:409});
    await connection.execute(`INSERT INTO vehicle_documents (vehicle_id,doc_type,reference,expiry_date,cost) VALUES (?,?,?,?,?)
      ON DUPLICATE KEY UPDATE reference=VALUES(reference),expiry_date=VALUES(expiry_date),cost=VALUES(cost)`,
      [vehicle.id,body.docType,body.reference||null,body.expiryDate,body.cost]);
    await connection.execute('UPDATE fleet SET due_date=? WHERE id=? AND renewal_type=?',
      [body.expiryDate,vehicle.id,body.docType]);
    const [history]=await connection.execute(`INSERT INTO vehicle_document_renewals
      (vehicle_id,doc_type,reference,renewed_on,expiry_date,cost,recorded_by) VALUES (?,?,?,?,?,?,?)`,
      [vehicle.id,body.docType,body.reference||null,renewedOn,body.expiryDate,body.cost,req.user.id]);
    if(body.docType==='Insurance'){
      const [[policy]]=await connection.execute(`SELECT id FROM hr_insurance WHERE vehicle_id=? AND kind='Vehicle'
        AND status='Active' ORDER BY id DESC LIMIT 1 FOR UPDATE`,[vehicle.id]);
      if(policy)await connection.execute(`UPDATE hr_insurance SET policy_number=?,start_date=?,end_date=?,expiry_date=?,premium=? WHERE id=?`,
        [body.reference||'',renewedOn,body.expiryDate,body.expiryDate,body.cost,policy.id]);
      else await connection.execute(`INSERT INTO hr_insurance
        (name,kind,vehicle_id,policy_number,start_date,end_date,expiry_date,premium,reminders,notes,created_by)
        VALUES (?,'Vehicle',?,?,?,?,? ,?,'[]',?,?)`,
        [`${vehicle.vehicle} (${vehicle.registration}) insurance`,vehicle.id,body.reference||'',renewedOn,
          body.expiryDate,body.expiryDate,body.cost,'Recorded from Fleet; HR may add insurer, cover and reminders.',req.user.id]);
    }
    await audit(connection,req.user.id,'RENEWAL','vehicle_document',history.insertId,null,body,req.ip);
  });
  const row = await getOne('SELECT * FROM vehicle_documents WHERE vehicle_id=? AND doc_type=?', [req.params.id, body.docType]);
  res.status(201).json({ ...row, due: dueLabel(row.expiry_date) });
}));

router.post('/:id/fuel', auth, permit('transport.manage'), validate(z.object({
  fuelFloatId: z.number().int().positive(),
  projectId: z.number().int().positive().nullable().optional(),
  fuelDate: isoDate,
  litres: z.number().positive().max(2000),
  cost: z.number().positive(),
  odometer: z.number().int().positive(),
  vendor: z.string().trim().max(180).optional(),
  driver: z.string().max(120).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const id=await transaction(async connection=>{
    const [[vehicle]]=await connection.execute('SELECT * FROM fleet WHERE id=? FOR UPDATE',[req.params.id]);
    if(!vehicle)throw Object.assign(new Error('Vehicle not found'),{status:404});
    if(body.odometer<Number(vehicle.odometer))throw Object.assign(new Error(
      `The odometer cannot go backwards — ${vehicle.registration} was last recorded at ${vehicle.odometer} km`),{status:409});
    const projectId=body.projectId===undefined?vehicle.project_id:body.projectId;
    const [[fuelFloat]]=await connection.execute(`SELECT id,name,company_id companyId,project_id projectId
      FROM petty_cash_floats WHERE id=? AND account_type='Fuel' AND active=1 FOR UPDATE`,[body.fuelFloatId]);
    if(!fuelFloat)throw Object.assign(new Error('Choose an active fuel float before recording fuel'),{status:400});
    if(projectId){
      const [[project]]=await connection.execute('SELECT id,company_id companyId FROM projects WHERE id=? AND active=1',[projectId]);
      if(!project)throw Object.assign(new Error('Project site not found'),{status:400});
      if(Number(project.companyId)!==Number(fuelFloat.companyId))throw Object.assign(new Error(
        'The selected fuel float belongs to a different company than this project. Choose the matching float or project.'),{status:400});
    }
    const [[{balance}]]=await connection.execute('SELECT COALESCE(SUM(amount),0) balance FROM petty_cash_entries WHERE float_id=?',[fuelFloat.id]);
    if(Number(body.cost)>Number(balance)+0.001)throw Object.assign(new Error(
      `The ${fuelFloat.name} fuel float has ${money(balance)} available. Top it up in Finance or enter an amount within the balance.`),{status:409});
    const [result]=await connection.execute(`INSERT INTO fuel_records
      (vehicle_id,company_id,project_id,fuel_date,litres,cost,odometer,driver,created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [vehicle.id,fuelFloat.companyId,projectId,body.fuelDate,body.litres,body.cost,body.odometer,body.driver||vehicle.driver,req.user.id]);
    await connection.execute(`INSERT INTO petty_cash_entries
      (float_id,kind,amount,entry_date,description,category,project_id,fuel_record_id,payee,recorded_by)
      VALUES (?,'Spend',?,?,?,'Fuel',?,?,?,?)`,
      [fuelFloat.id,-body.cost,body.fuelDate,`Fuel — ${vehicle.vehicle} (${vehicle.registration})`,projectId,result.insertId,body.vendor||null,req.user.id]);
    await connection.execute('UPDATE fleet SET odometer=GREATEST(odometer,?) WHERE id=?',[body.odometer,vehicle.id]);
    await connection.execute(`INSERT INTO vehicle_odometer_readings
      (vehicle_id,company_id,project_id,reading_date,odometer,source,source_id,recorded_by) VALUES (?,?,?,?,?,'Fuel',?,?)`,
      [vehicle.id,fuelFloat.companyId,projectId,body.fuelDate,body.odometer,result.insertId,req.user.id]);
    if(projectId)await connection.execute(`INSERT INTO expenses
      (project_id,source,description,amount,expense_date,origin_type,origin_id,created_by)
      VALUES (?,'Fuel',?,?,?,'fuel_record',?,?)`,
      [projectId,`Fuel — ${vehicle.vehicle} (${vehicle.registration})`,body.cost,body.fuelDate,String(result.insertId),req.user.id]);
    await audit(connection,req.user.id,'CREATE','fuel_record',result.insertId,null,{...body,projectId},req.ip);
    return result.insertId;
  });
  const row=await getOne('SELECT * FROM fuel_records WHERE id=?',[id]);
  publishChange('fleet', { vehicleId: Number(req.params.id) });
  publishChange('receivables', {});
  res.status(201).json(row);
}));

router.post('/:id/maintenance', auth, permit('transport.manage'), validate(z.object({
  companyId:z.number().int().positive().optional(),
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
    let companyId=body.companyId||null;
    if(body.projectId){const [[project]]=await connection.execute('SELECT id,company_id companyId FROM projects WHERE id=? AND active=1',[body.projectId]);
      if(!project)throw Object.assign(new Error('Project site not found'),{status:400});
      if(companyId&&Number(project.companyId)!==Number(companyId))throw Object.assign(new Error('The selected project belongs to a different company.'),{status:400});
      companyId=project.companyId;}
    if(!companyId&&vehicle.project_id){const [[assignedProject]]=await connection.execute('SELECT company_id companyId FROM projects WHERE id=?',[vehicle.project_id]);companyId=assignedProject?.companyId||null;}
    const [[company]]=companyId?await connection.execute('SELECT id FROM companies WHERE id=? AND active=1',[companyId]):[[null]];
    if(!company)throw Object.assign(new Error('Operating company not found'),{status:400});
    const [result]=await connection.execute(`INSERT INTO vehicle_maintenance
      (vehicle_id,company_id,project_id,service_date,maintenance_kind,description,cost,garage,odometer,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [vehicle.id,companyId,body.projectId||null,body.serviceDate,body.kind,body.description,body.cost,body.garage||null,body.odometer,req.user.id]);
    if(body.kind==='Service')await connection.execute(`UPDATE fleet SET last_service_date=?,last_service_odometer=?,
      odometer=GREATEST(odometer,?),status=COALESCE(?,status) WHERE id=?`,
      [body.serviceDate,body.odometer,body.odometer,body.setStatus||null,vehicle.id]);
    else await connection.execute('UPDATE fleet SET odometer=GREATEST(odometer,?),status=COALESCE(?,status) WHERE id=?',
      [body.odometer,body.setStatus||null,vehicle.id]);
    await connection.execute(`INSERT INTO vehicle_odometer_readings
      (vehicle_id,company_id,project_id,reading_date,odometer,source,source_id,recorded_by) VALUES (?,?,?,?,?,?,?,?)`,
      [vehicle.id,companyId,body.projectId||null,body.serviceDate,body.odometer,body.kind,result.insertId,req.user.id]);
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
