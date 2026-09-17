import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { stockState } from './bootstrap.js';

const router = Router();

/** Receipts and returns add to stock; issues, transfers and negative adjustments remove from it. */
const INBOUND = ['Receipt', 'Return'];
async function sitePosition(connection,materialId,projectId){
  const [[totals]]=await connection.execute(`SELECT
    COALESCE((SELECT SUM(CASE WHEN movement_type='Issue' THEN quantity WHEN movement_type='Return' THEN -quantity ELSE 0 END)
      FROM stock_movements WHERE material_id=? AND project_id=? AND movement_type IN ('Issue','Return')),0) issued,
    COALESCE((SELECT SUM(quantity) FROM site_material_consumption WHERE material_id=? AND project_id=?),0) consumed`,
    [materialId,projectId,materialId,projectId]);
  const [[checkpoint]]=await connection.execute(`SELECT counted_quantity countedQuantity,baseline_issued baselineIssued,
    baseline_consumed baselineConsumed FROM site_material_counts WHERE material_id=? AND project_id=? ORDER BY id DESC LIMIT 1`,
    [materialId,projectId]);
  const issued=Number(totals.issued),consumed=Number(totals.consumed);
  return{issued,consumed,checkpoint,balance:checkpoint
    ? Number(checkpoint.countedQuantity)+(issued-Number(checkpoint.baselineIssued))-(consumed-Number(checkpoint.baselineConsumed))
    : issued-consumed};
}

router.get('/', auth, permit('store.view','store.manage'), wrap(async (_req, res) => {
  const materials = await query('SELECT * FROM materials WHERE active=1 ORDER BY id');
  res.json(materials.map(material => ({ ...material, state: stockState(material) })));
}));

router.get('/movements', auth, permit('store.view','store.manage'), wrap(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.materialId) { filters.push('m.material_id=?'); params.push(req.query.materialId); }
  if (req.query.projectId) { filters.push('m.project_id=?'); params.push(req.query.projectId); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`SELECT m.id,m.movement_type type,m.quantity,m.reference,m.notes,m.destination,m.created_at createdAt,
    mat.name material,mat.unit,u.name recordedBy,p.name project
    FROM stock_movements m JOIN materials mat ON mat.id=m.material_id JOIN users u ON u.id=m.user_id
    LEFT JOIN projects p ON p.id=m.project_id ${where} ORDER BY m.id DESC LIMIT 200`, params));
}));

router.get('/inventory',auth,permit('store.view','store.manage','projects.view'),wrap(async(req,res)=>{
  const [materials,loans,siteIssues,consumed,counts,allowances,quoted,planned,vehicles,equipment]=await Promise.all([
    query('SELECT id,name,unit,stock,minimum,site,stock_kind stockKind,unit_cost unitCost FROM materials WHERE active=1 ORDER BY name'),
    query(`SELECT l.id,l.material_id materialId,l.project_id projectId,p.name project,m.name material,m.unit,
      l.quantity,l.returned_quantity returnedQuantity,(l.quantity-l.returned_quantity) outstanding,
      l.taken_by takenBy,l.handed_over_by handedOverBy,l.received_back_by receivedBackBy,
      l.issued_at issuedAt,l.returned_at returnedAt,l.condition_out conditionOut,l.condition_in conditionIn,l.reference
      FROM stock_loans l JOIN materials m ON m.id=l.material_id JOIN projects p ON p.id=l.project_id ORDER BY l.id DESC LIMIT 400`),
    query(`SELECT sm.material_id materialId,sm.project_id projectId,p.name project,m.name material,m.unit,
      SUM(CASE WHEN sm.movement_type='Issue' THEN sm.quantity WHEN sm.movement_type='Return' THEN -sm.quantity ELSE 0 END) quantity
      FROM stock_movements sm JOIN materials m ON m.id=sm.material_id JOIN projects p ON p.id=sm.project_id
      WHERE m.stock_kind='Consumable' AND sm.movement_type IN ('Issue','Return')
      GROUP BY sm.material_id,sm.project_id,p.name,m.name,m.unit HAVING quantity>0`),
    query(`SELECT project_id projectId,material_id materialId,SUM(quantity) quantity
      FROM site_material_consumption GROUP BY project_id,material_id`),
    query(`SELECT c.project_id projectId,c.material_id materialId,m.name material,m.unit,p.name project,
      c.counted_quantity countedQuantity,c.baseline_issued baselineIssued,
      c.baseline_consumed baselineConsumed,c.counted_at countedAt
      FROM site_material_counts c JOIN (SELECT project_id,material_id,MAX(id) id FROM site_material_counts
      GROUP BY project_id,material_id) latest ON latest.id=c.id
      JOIN materials m ON m.id=c.material_id JOIN projects p ON p.id=c.project_id`),
    query(`SELECT b.project_id projectId,bi.material_id materialId,m.name material,m.unit,p.name project,
      SUM(bi.quantity) allowedQuantity FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id
      JOIN materials m ON m.id=bi.material_id JOIN projects p ON p.id=b.project_id WHERE b.status='Approved'
      GROUP BY b.project_id,bi.material_id,m.name,m.unit,p.name`),
    query(`SELECT q.project_id projectId,qi.material_id materialId,m.name material,m.unit,p.name project,
      SUM(qi.quantity) quotedQuantity FROM quotation_items qi JOIN quotations_client q ON q.id=qi.quotation_id
      JOIN materials m ON m.id=qi.material_id JOIN projects p ON p.id=q.project_id
      WHERE q.status='Accepted' GROUP BY q.project_id,qi.material_id,m.name,m.unit,p.name`),
    query(`SELECT r.project_id projectId,i.material_id materialId,m.name material,m.unit,p.name project,
      SUM(i.quantity) quantity
      FROM purchase_request_items i JOIN purchase_requests r ON r.id=i.request_id
      JOIN materials m ON m.id=i.material_id JOIN projects p ON p.id=r.project_id
      WHERE i.material_id IS NOT NULL AND r.status IN ('Pending','Approved')
      GROUP BY r.project_id,i.material_id,m.name,m.unit,p.name`),
    query(`SELECT f.id,f.vehicle,f.registration,f.status,f.project_id projectId,p.name project,f.driver
      FROM fleet f LEFT JOIN projects p ON p.id=f.project_id WHERE f.status<>'Inactive' ORDER BY f.vehicle`),
    query(`SELECT e.id,e.name,e.code,e.status,a.project_id projectId,p.name project,a.assigned_to assignedTo
      FROM equipment e LEFT JOIN equipment_assignments a ON a.equipment_id=e.id AND a.returned_at IS NULL
      LEFT JOIN projects p ON p.id=a.project_id ORDER BY e.name`)
  ]);
  const allowed=new Map(allowances.map(row=>[`${row.projectId}:${row.materialId}`,Number(row.allowedQuantity)]));
  const quoteAllowed=new Map(quoted.map(row=>[`${row.projectId}:${row.materialId}`,Number(row.quotedQuantity)]));
  const consumedMap=new Map(consumed.map(row=>[`${row.projectId}:${row.materialId}`,Number(row.quantity)]));
  const countsMap=new Map(counts.map(row=>[`${row.projectId}:${row.materialId}`,row]));
  const plannedMap=new Map(planned.map(row=>[`${row.projectId}:${row.materialId}`,Number(row.quantity)]));
  const keys=new Map(siteIssues.map(row=>[`${row.projectId}:${row.materialId}`,row]));
  for(const row of [...allowances,...quoted])if(!keys.has(`${row.projectId}:${row.materialId}`))
    keys.set(`${row.projectId}:${row.materialId}`,{projectId:row.projectId,materialId:row.materialId,material:row.material,unit:row.unit,project:row.project,quantity:0});
  for(const row of counts)if(!keys.has(`${row.projectId}:${row.materialId}`))
    keys.set(`${row.projectId}:${row.materialId}`,{projectId:row.projectId,materialId:row.materialId,material:row.material,unit:row.unit,project:row.project,quantity:0});
  for(const row of planned)if(!keys.has(`${row.projectId}:${row.materialId}`))
    keys.set(`${row.projectId}:${row.materialId}`,{projectId:row.projectId,materialId:row.materialId,material:row.material,unit:row.unit,project:row.project,quantity:0});
  const usage=[...keys.entries()].map(([key,row])=>{const quantity=Number(row.quantity),allowedQuantity=allowed.get(key)??null,
    quotedQuantity=quoteAllowed.get(key)??null,
    plannedQuantity=plannedMap.get(key)||0,forecastQuantity=quantity+plannedQuantity;
    const checkpoint=countsMap.get(key),consumedQuantity=consumedMap.get(key)||0;
    const siteBalance=checkpoint?Number(checkpoint.countedQuantity)+(quantity-Number(checkpoint.baselineIssued))
      -(consumedQuantity-Number(checkpoint.baselineConsumed)):quantity-consumedQuantity;
    return{...row,quantity,consumedQuantity,siteBalance:Math.max(0,siteBalance),
      balanceVerified:Boolean(checkpoint),lastCountedAt:checkpoint?.countedAt||null,
      plannedQuantity,forecastQuantity,allowedQuantity,quotedQuantity,
      overrun:allowedQuantity!==null&&quantity>allowedQuantity,
      forecastOverrun:allowedQuantity!==null&&forecastQuantity>allowedQuantity,
      quoteOverrun:quotedQuantity!==null&&quantity>quotedQuantity,
      quoteForecastOverrun:quotedQuantity!==null&&forecastQuantity>quotedQuantity,
      unplanned:allowedQuantity===null&&quotedQuantity===null&&forecastQuantity>0};});
  res.json({materials,loans,siteIssues:usage,vehicles,equipment});
}));

router.post('/site-counts',auth,permit('store.manage','site.reports'),validate(z.object({
  materialId:z.number().int().positive(),projectId:z.number().int().positive(),
  countedQuantity:z.number().nonnegative(),notes:z.string().max(500).optional()
})),wrap(async(req,res)=>{const b=req.body;
  const id=await transaction(async connection=>{
    const [[material]]=await connection.execute('SELECT id,stock_kind FROM materials WHERE id=? FOR UPDATE',[b.materialId]);
    if(!material||material.stock_kind!=='Consumable')throw Object.assign(new Error('Choose a consumable material'),{status:400});
    const [[project]]=await connection.execute('SELECT id FROM projects WHERE id=? AND active=1',[b.projectId]);
    if(!project)throw Object.assign(new Error('Project not found'),{status:404});
    const position=await sitePosition(connection,b.materialId,b.projectId);
    const [created]=await connection.execute(`INSERT INTO site_material_counts
      (material_id,project_id,counted_quantity,baseline_issued,baseline_consumed,notes,counted_by) VALUES (?,?,?,?,?,?,?)`,
      [b.materialId,b.projectId,b.countedQuantity,position.issued,position.consumed,b.notes||null,req.user.id]);
    await audit(connection,req.user.id,'COUNT','site_material',created.insertId,position,{countedQuantity:b.countedQuantity,...b},req.ip);
    return created.insertId;
  });res.status(201).json({id});
}));

router.post('/site-consumption',auth,permit('store.manage','site.reports'),validate(z.object({
  materialId:z.number().int().positive(),projectId:z.number().int().positive(),quantity:z.number().positive(),
  consumedOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),notes:z.string().max(500).optional()
})),wrap(async(req,res)=>{const b=req.body;
  const id=await transaction(async connection=>{
    const [[material]]=await connection.execute('SELECT id,stock_kind FROM materials WHERE id=? FOR UPDATE',[b.materialId]);
    if(!material||material.stock_kind!=='Consumable')throw Object.assign(new Error('Choose a consumable material'),{status:400});
    const position=await sitePosition(connection,b.materialId,b.projectId);
    if(position.balance<b.quantity-.0001)
      throw Object.assign(new Error('The site does not have enough unconsumed material'),{status:409});
    const [created]=await connection.execute(`INSERT INTO site_material_consumption
      (material_id,project_id,quantity,consumed_on,notes,recorded_by) VALUES (?,?,?,?,?,?)`,
      [b.materialId,b.projectId,b.quantity,b.consumedOn,b.notes||null,req.user.id]);
    await audit(connection,req.user.id,'CONSUME','site_material',created.insertId,null,b,req.ip);
    return created.insertId;
  });res.status(201).json({id});
}));

router.post('/loans',auth,permit('store.manage'),validate(z.object({materialId:z.number().int().positive(),projectId:z.number().int().positive(),
  quantity:z.number().positive(),takenBy:z.string().trim().min(2).max(120),handedOverBy:z.string().trim().min(2).max(120),
  conditionOut:z.string().max(300).optional(),reference:z.string().max(120).optional()})),wrap(async(req,res)=>{
  const b=req.body;
  const result=await transaction(async connection=>{
    const [[material]]=await connection.execute('SELECT * FROM materials WHERE id=? FOR UPDATE',[b.materialId]);
    if(!material||material.stock_kind!=='Returnable')throw Object.assign(new Error('Choose a returnable tool'),{status:400});
    const [[project]]=await connection.execute('SELECT id,name FROM projects WHERE id=? AND active=1',[b.projectId]);
    if(!project)throw Object.assign(new Error('Project not found'),{status:404});
    if(Number(material.stock)<b.quantity)throw Object.assign(new Error('Not enough tools available in the store'),{status:409});
    await connection.execute('UPDATE materials SET stock=stock-? WHERE id=?',[b.quantity,b.materialId]);
    const [created]=await connection.execute(`INSERT INTO stock_loans
      (material_id,project_id,quantity,taken_by,handed_over_by,condition_out,reference,created_by) VALUES (?,?,?,?,?,?,?,?)`,
      [b.materialId,b.projectId,b.quantity,b.takenBy,b.handedOverBy,b.conditionOut||null,b.reference||null,req.user.id]);
    await connection.execute(`INSERT INTO stock_movements
      (material_id,movement_type,quantity,reference,notes,project_id,destination,user_id) VALUES (?,'Issue',?,?,?,?,?,?)`,
      [b.materialId,b.quantity,b.reference||null,`Loan #${created.insertId}: ${b.handedOverBy} to ${b.takenBy}`,b.projectId,project.name,req.user.id]);
    await audit(connection,req.user.id,'ISSUE','stock_loan',created.insertId,null,b,req.ip);
    return created.insertId;
  });res.status(201).json({id:result});
}));
router.post('/loans/:id/returns',auth,permit('store.manage'),validate(z.object({quantity:z.number().positive(),
  receivedBackBy:z.string().trim().min(2).max(120),conditionIn:z.string().max(300).optional(),reference:z.string().max(120).optional()})),wrap(async(req,res)=>{
  const b=req.body;
  await transaction(async connection=>{
    const [[loan]]=await connection.execute('SELECT * FROM stock_loans WHERE id=? FOR UPDATE',[req.params.id]);
    if(!loan)throw Object.assign(new Error('Tool loan not found'),{status:404});
    if(b.quantity>Number(loan.quantity)-Number(loan.returned_quantity)+.0001)
      throw Object.assign(new Error('Return quantity exceeds tools still on site'),{status:409});
    const returned=Number(loan.returned_quantity)+b.quantity,complete=returned>=Number(loan.quantity)-.0001;
    await connection.execute(`UPDATE stock_loans SET returned_quantity=?,received_back_by=?,condition_in=?,
      returned_at=CASE WHEN ? THEN NOW() ELSE NULL END WHERE id=?`,
      [returned,b.receivedBackBy,b.conditionIn||null,complete,loan.id]);
    await connection.execute('UPDATE materials SET stock=stock+? WHERE id=?',[b.quantity,loan.material_id]);
    await connection.execute(`INSERT INTO stock_movements
      (material_id,movement_type,quantity,reference,notes,project_id,destination,user_id) VALUES (?,'Return',?,?,?,?,?,?)`,
      [loan.material_id,b.quantity,b.reference||loan.reference||null,`Loan #${loan.id}: received by ${b.receivedBackBy}`,loan.project_id,'Store',req.user.id]);
    await audit(connection,req.user.id,'RETURN','stock_loan',loan.id,loan,{returned,complete,...b},req.ip);
  });res.status(201).json({returned:true});
}));

router.post('/', auth, permit('store.manage'), validate(z.object({
  name: z.string().min(2).max(180),
  unit: z.string().min(1).max(30),
  stock: z.number().nonnegative().default(0),
  minimum: z.number().nonnegative(),
  site: z.string().min(2).max(180),
  unitCost: z.number().nonnegative().default(0),
  supplier: z.string().max(180).optional()
  ,stockKind:z.enum(['Consumable','Returnable']).default('Consumable')
})), wrap(async (req, res) => {
  const body = req.body;
  const result = await query('INSERT INTO materials (name,unit,stock,minimum,site,supplier,unit_cost,stock_kind) VALUES (?,?,?,?,?,?,?,?)',
    [body.name, body.unit, body.stock, body.minimum, body.site, body.supplier || null, body.unitCost,body.stockKind]);
  const row = await getOne('SELECT * FROM materials WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'material', row.id, null, row, req.ip);
  res.status(201).json({ ...row, state: stockState(row) });
}));

router.patch('/:id', auth, permit('store.manage'), validate(z.object({
  minimum: z.number().nonnegative().optional(),
  site: z.string().min(2).max(180).optional(),
  unitCost: z.number().nonnegative().optional(),
  supplier: z.string().max(180).optional()
  ,stockKind:z.enum(['Consumable','Returnable']).optional()
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM materials WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Material not found' });
  const columns = { unitCost: 'unit_cost',stockKind:'stock_kind' };
  const entries = Object.entries(req.body);
  if (entries.length) {
    await query(`UPDATE materials SET ${entries.map(([key]) => `${columns[key] || key}=?`).join(',')} WHERE id=?`,
      [...entries.map(([, value]) => value), req.params.id]);
  }
  const after = await getOne('SELECT * FROM materials WHERE id=?', [req.params.id]);
  await audit(pool, req.user.id, 'UPDATE', 'material', after.id, before, after, req.ip);
  res.json({ ...after, state: stockState(after) });
}));

/**
 * Stock movements are transactional: the balance, the movement row and the audit entry
 * either all commit or none do, so recorded stock can never drift from its history.
 */
router.post('/:id/movements', auth, permit('store.manage'), validate(z.object({
  type: z.enum(['Receipt', 'Issue', 'Return', 'Adjustment', 'Transfer']),
  quantity: z.number().positive().max(1000000),
  reference: z.string().max(120).optional(),
  notes: z.string().max(500).optional(),
  projectId: z.number().int().positive().optional(),
  destination: z.string().max(180).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  try {
    const after = await transaction(async connection => {
      const [rows] = await connection.execute('SELECT * FROM materials WHERE id=? FOR UPDATE', [req.params.id]);
      const before = rows[0];
      if (!before) throw Object.assign(new Error('Material not found'), { status: 404 });
      if(body.type==='Transfer')throw Object.assign(new Error('Direct store transfers need a receiving stock record; use a site issue or tool handover instead'),{status:400});
      if(before.stock_kind==='Returnable'&&['Issue','Return'].includes(body.type))
        throw Object.assign(new Error('Use the tool handover and return register for returnable items'),{status:400});
      const direction = INBOUND.includes(body.type) ? 1 : -1;
      const stock = Number(before.stock) + direction * body.quantity;
      if (stock < 0) throw Object.assign(new Error('Insufficient stock for this movement'), { status: 409 });
      if(before.stock_kind==='Consumable'&&body.type==='Issue'&&!body.projectId)
        throw Object.assign(new Error('Choose the site receiving this material'),{status:400});
      if(before.stock_kind==='Consumable'&&body.type==='Return'){
        if(!body.projectId)throw Object.assign(new Error('Choose the site returning unused material'),{status:400});
        const position=await sitePosition(connection,before.id,body.projectId);
        if(position.balance<body.quantity-.0001)
          throw Object.assign(new Error('The site cannot return more than its unused balance'),{status:409});
      }
      await connection.execute('UPDATE materials SET stock=? WHERE id=?', [stock, before.id]);
      await connection.execute(`INSERT INTO stock_movements (material_id,movement_type,quantity,reference,notes,project_id,destination,user_id)
        VALUES (?,?,?,?,?,?,?,?)`, [before.id, body.type, body.quantity, body.reference || '', body.notes || '',
        body.projectId || null, body.destination || null, req.user.id]);

      /* Issuing material to a project is a project cost, so record it against the budget straight away. */
      if (body.type === 'Issue' && body.projectId && Number(before.unit_cost) > 0) {
        await connection.execute(`INSERT INTO expenses (project_id,source,description,amount,expense_date,reference,origin_type,origin_id,created_by)
          VALUES (?,'Material',?,?,CURDATE(),?, 'stock_movement', ?, ?)`,
        [body.projectId, `${before.name} issued to site (${body.quantity} ${before.unit})`,
          body.quantity * Number(before.unit_cost), body.reference || '', String(before.id), req.user.id]);
      }

      const updated = { ...before, stock };
      await audit(connection, req.user.id, 'STOCK_MOVEMENT', 'material', before.id, before, updated, req.ip);
      return updated;
    });
    res.status(201).json({ ...after, state: stockState(after) });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  }
}));

export default router;
