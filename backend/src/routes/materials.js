import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, transaction } from '../db.js';
import { auth, permit, validate, wrap } from '../lib/http.js';
import { correctedStock } from '../lib/stock-corrections.js';
import { publishChange } from '../lib/realtime.js';
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
  res.json(await query(`SELECT m.id,m.material_id materialId,m.project_id projectId,m.origin_type originType,m.movement_type type,m.quantity,m.reference,m.notes,m.destination,m.created_at createdAt,
    mat.name material,mat.unit,u.name recordedBy,p.name project
    FROM stock_movements m JOIN materials mat ON mat.id=m.material_id JOIN users u ON u.id=m.user_id
    LEFT JOIN projects p ON p.id=m.project_id ${where} ORDER BY m.id DESC LIMIT 200`, params));
}));

router.get('/inventory',auth,permit('store.view','store.manage','projects.view'),wrap(async(req,res)=>{
  const [materials,loans,siteIssues,consumed,counts,allowances,quoted,planned,vehicles,equipment]=await Promise.all([
    query('SELECT id,name,unit,stock,minimum,site,stock_kind stockKind,category,procurement_route procurementRoute,unit_cost unitCost FROM materials WHERE active=1 ORDER BY name'),
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
      FROM equipment e LEFT JOIN visible_equipment_assignments a ON a.equipment_id=e.id AND a.returned_at IS NULL
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

router.get('/site-position',auth,permit('store.manage','site.reports'),wrap(async(req,res)=>{
  const projectId=Number(req.query.projectId),materialId=Number(req.query.materialId);
  if(!Number.isInteger(projectId)||projectId<1||!Number.isInteger(materialId)||materialId<1)
    return res.status(400).json({error:'Choose a project and material.'});
  const position=await transaction(connection=>sitePosition(connection,materialId,projectId));
  res.json({projectId,materialId,balance:Math.max(0,position.balance)});
}));

router.post('/site-counts',auth,permit('store.manage','site.reports'),validate(z.object({
  materialId:z.number().int().positive(),projectId:z.number().int().positive(),
  countedQuantity:z.number().nonnegative(),notes:z.string().max(500).optional(),clientRef:z.string().min(8).max(120).optional()
})),wrap(async(req,res)=>{const b=req.body;
  if(b.clientRef){const existing=await getOne('SELECT id FROM site_material_counts WHERE client_ref=?',[b.clientRef]);if(existing)return res.json(existing);}
  const id=await transaction(async connection=>{
    const [[material]]=await connection.execute('SELECT id,stock_kind FROM materials WHERE id=? FOR UPDATE',[b.materialId]);
    if(!material||material.stock_kind!=='Consumable')throw Object.assign(new Error('Choose a consumable material'),{status:400});
    const [[project]]=await connection.execute('SELECT id FROM projects WHERE id=? AND active=1',[b.projectId]);
    if(!project)throw Object.assign(new Error('Project not found'),{status:404});
    const position=await sitePosition(connection,b.materialId,b.projectId);
    const [created]=await connection.execute(`INSERT INTO site_material_counts
      (material_id,project_id,counted_quantity,baseline_issued,baseline_consumed,notes,counted_by,client_ref) VALUES (?,?,?,?,?,?,?,?)`,
      [b.materialId,b.projectId,b.countedQuantity,position.issued,position.consumed,b.notes||null,req.user.id,b.clientRef||null]);
    await audit(connection,req.user.id,'COUNT','site_material',created.insertId,position,{countedQuantity:b.countedQuantity,...b},req.ip);
    return created.insertId;
  });res.status(201).json({id});
}));

router.post('/site-consumption',auth,permit('store.manage','site.reports'),validate(z.object({
  materialId:z.number().int().positive(),projectId:z.number().int().positive(),quantity:z.number().positive(),
  consumedOn:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),notes:z.string().max(500).optional(),clientRef:z.string().min(8).max(120).optional()
})),wrap(async(req,res)=>{const b=req.body;
  if(b.clientRef){const existing=await getOne('SELECT id FROM site_material_consumption WHERE client_ref=?',[b.clientRef]);if(existing)return res.json(existing);}
  const id=await transaction(async connection=>{
    const [[material]]=await connection.execute('SELECT id,stock_kind FROM materials WHERE id=? FOR UPDATE',[b.materialId]);
    if(!material||material.stock_kind!=='Consumable')throw Object.assign(new Error('Choose a consumable material'),{status:400});
    const position=await sitePosition(connection,b.materialId,b.projectId);
    if(position.balance<b.quantity-.0001)
      throw Object.assign(new Error('The site does not have enough unconsumed material'),{status:409});
    const [created]=await connection.execute(`INSERT INTO site_material_consumption
      (material_id,project_id,quantity,consumed_on,notes,recorded_by,client_ref) VALUES (?,?,?,?,?,?,?)`,
      [b.materialId,b.projectId,b.quantity,b.consumedOn,b.notes||null,req.user.id,b.clientRef||null]);
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
      (material_id,movement_type,quantity,reference,notes,project_id,destination,user_id,origin_type) VALUES (?,'Issue',?,?,?,?,?,?,'Stock loan')`,
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
      (material_id,movement_type,quantity,reference,notes,project_id,destination,user_id,origin_type) VALUES (?,'Return',?,?,?,?,?,?,'Stock loan')`,
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
  ,stockKind:z.enum(['Consumable','Returnable']).default('Consumable'),
  category:z.string().trim().min(2).max(80).default('General'),
  procurementRoute:z.enum(['Purchase order','Direct delivery']).default('Purchase order')
})), wrap(async (req, res) => {
  const body = req.body;
  const result = await query('INSERT INTO materials (name,unit,stock,minimum,site,supplier,unit_cost,stock_kind,category,procurement_route) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [body.name, body.unit, body.stock, body.minimum, body.site, body.supplier || null, body.unitCost,body.stockKind,body.category,body.procurementRoute]);
  const row = await getOne('SELECT * FROM materials WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'material', row.id, null, row, req.ip);
  res.status(201).json({ ...row, state: stockState(row) });
}));

router.patch('/:id', auth, permit('store.manage'), validate(z.object({
  name:z.string().trim().min(2).max(180).optional(), unit:z.string().trim().min(1).max(30).optional(),
  stock:z.number().nonnegative().multipleOf(0.001).optional(), minimum:z.number().nonnegative().optional(),
  site:z.string().trim().min(2).max(180).optional(), unitCost:z.number().nonnegative().optional(),
  supplier:z.string().max(180).optional(),stockKind:z.enum(['Consumable','Returnable']).optional(),
  category:z.string().trim().min(2).max(80).optional(), procurementRoute:z.enum(['Purchase order','Direct delivery']).optional(),
  reason:z.string().trim().min(3).max(500).optional(), expectedStock:z.number().nonnegative().optional()
})), wrap(async(req,res)=>{
  const row = await transaction(async connection=>{
    const [[before]]=await connection.execute('SELECT * FROM materials WHERE id=? AND active=1 FOR UPDATE',[req.params.id]);
    if(!before)throw Object.assign(new Error('Material not found'),{status:404});
    const {reason,expectedStock,...body}=req.body;
    if(body.stock!==undefined && expectedStock!==undefined && Math.abs(Number(before.stock)-expectedStock)>.0001)
      throw Object.assign(new Error('Stock changed while this material was being edited. Refresh and check the current quantity.'),{status:409});
    if(body.stockKind && body.stockKind!==before.stock_kind){
      const [[activity]]=await connection.execute(`SELECT (SELECT COUNT(*) FROM stock_movements WHERE material_id=?)+
        (SELECT COUNT(*) FROM stock_loans WHERE material_id=?)+(SELECT COUNT(*) FROM site_material_consumption WHERE material_id=?) total`,[before.id,before.id,before.id]);
      if(Number(activity.total)>0)throw Object.assign(new Error('A material with stock activity must keep its Consumable/Returnable type. Its other details can still be edited.'),{status:409});
    }
    const delta=body.stock===undefined?0:Math.round((body.stock-Number(before.stock))*1000)/1000;
    if(delta && !reason)throw Object.assign(new Error('Enter a reason for correcting the stock quantity.'),{status:400});
    const columns={unitCost:'unit_cost',stockKind:'stock_kind',procurementRoute:'procurement_route'};
    const entries=Object.entries(body);
    if(entries.length)await connection.execute(`UPDATE materials SET ${entries.map(([key])=>`${columns[key]||key}=?`).join(',')} WHERE id=?`,[...entries.map(([,value])=>value),before.id]);
    if(delta)await connection.execute(`INSERT INTO stock_movements
      (material_id,movement_type,quantity,reference,notes,user_id,origin_type) VALUES (?,?,?,?,?,?,'Manual')`,
      [before.id,delta>0?'Receipt':'Adjustment',Math.abs(delta),'Stock correction',reason,req.user.id]);
    const [[after]]=await connection.execute('SELECT * FROM materials WHERE id=?',[before.id]);
    await audit(connection,req.user.id,'UPDATE','material',before.id,before,{...after,reason:reason||null},req.ip);
    return after;
  });
  publishChange('materials',{});
  res.json({...row,state:stockState(row)});
}));

router.patch('/movements/:movementId',auth,permit('store.manage'),validate(z.object({
  type:z.enum(['Receipt','Issue','Return','Adjustment','Transfer']).optional(),quantity:z.number().positive().max(1000000).multipleOf(.001).optional(),
  projectId:z.number().int().positive().nullable().optional(),destination:z.string().max(180).nullable().optional(),
  reference:z.string().max(120).optional(),notes:z.string().max(500).optional(),reason:z.string().trim().min(3).max(500),
  expectedQuantity:z.number().positive().optional()
})),wrap(async(req,res)=>{
  const b=req.body;
  const row=await transaction(async connection=>{
    // All stock writers lock the material first, then the movement, to serialize corrections.
    const [[identity]]=await connection.execute('SELECT material_id FROM stock_movements WHERE id=?',[req.params.movementId]);
    if(!identity)throw Object.assign(new Error('Movement not found'),{status:404});
    const [[material]]=await connection.execute('SELECT * FROM materials WHERE id=? FOR UPDATE',[identity.material_id]);
    const [[before]]=await connection.execute('SELECT * FROM stock_movements WHERE id=? FOR UPDATE',[req.params.movementId]);
    for(const [key,column] of Object.entries({type:'movement_type',quantity:'quantity',projectId:'project_id',destination:'destination',reference:'reference',notes:'notes'})) {
      if(b[key]===undefined)b[key]=before[column];
    }
    if(b.expectedQuantity!==undefined && Math.abs(Number(before.quantity)-b.expectedQuantity)>.0001)
      throw Object.assign(new Error('This movement changed while you were editing it. Refresh and try again.'),{status:409});
    const changed=before.movement_type!==b.type || Math.abs(Number(before.quantity)-b.quantity)>.0001 || Number(before.project_id||0)!==Number(b.projectId||0);
    const linked=before.origin_type && before.origin_type!=='Manual';
    if(linked && (changed || (b.reference??'')!==(before.reference||'') || (b.destination||null)!==(before.destination||null)))
      throw Object.assign(new Error(`This movement comes from ${before.origin_type}. Its linked quantities cannot be changed independently; only movement notes can be changed here.`),{status:409});
    if(changed){
      if(b.type==='Transfer')throw Object.assign(new Error('Use a linked transfer workflow rather than changing a movement into a transfer.'),{status:400});
      if(material.stock_kind==='Returnable'&&['Issue','Return'].includes(b.type))throw Object.assign(new Error('Use tool handovers and returns for returnable stock.'),{status:400});
      if(['Issue','Return'].includes(b.type)&&!b.projectId)throw Object.assign(new Error('Choose the site for this issue or return.'),{status:400});
      if(b.projectId && Number(b.projectId)!==Number(before.project_id)){
        const [[project]]=await connection.execute('SELECT id FROM projects WHERE id=? AND active=1',[b.projectId]);
        if(!project)throw Object.assign(new Error('Choose an active project.'),{status:400});
      }
      // A later verified site count supersedes the earlier ledger; preserve that checkpoint.
      const affected=[...new Set([before.project_id,b.projectId].filter(Boolean).map(Number))];
      for(const projectId of affected){
        if(!['Issue','Return'].includes(before.movement_type) && !['Issue','Return'].includes(b.type))continue;
        const [[count]]=await connection.execute('SELECT id FROM site_material_counts WHERE material_id=? AND project_id=? AND counted_at>=? LIMIT 1',[material.id,projectId,before.created_at]);
        if(count)throw Object.assign(new Error('A later verified site count covers this movement. Keep its quantity and site, and record a new adjustment instead.'),{status:409});
      }
      const [history]=await connection.execute('SELECT id,movement_type,quantity FROM stock_movements WHERE material_id=? ORDER BY id',[material.id]);
      const stock=correctedStock(material.stock,history,before.id,b);
      await connection.execute('UPDATE materials SET stock=? WHERE id=?',[stock,material.id]);
    }
    await connection.execute('UPDATE stock_movements SET movement_type=?,quantity=?,project_id=?,destination=?,reference=?,notes=? WHERE id=?',
      [b.type,b.quantity,b.projectId||null,b.destination||null,b.reference||'',b.notes||'',before.id]);
    if(changed){
      for(const projectId of new Set([before.project_id,b.projectId].filter(Boolean))){
        const position=await sitePosition(connection,material.id,projectId);
        if(position.balance<-.0001)throw Object.assign(new Error('This correction would leave the site with less material than has already been used or returned.'),{status:409});
      }
    }
    const [expenses]=await connection.execute("SELECT * FROM expenses WHERE origin_type='stock_movement' AND origin_id=? FOR UPDATE",[String(before.id)]);
    if(!linked && changed){
      if(expenses.length>1)throw Object.assign(new Error('Multiple project costs are linked to this movement. Reconcile those costs before changing it.'),{status:409});
      const rate=before.unit_cost_snapshot!==null?Number(before.unit_cost_snapshot):expenses.length?Number(expenses[0].amount)/Number(before.quantity):before.movement_type==='Issue'?0:Number(material.unit_cost);
      if(b.type==='Issue' && b.projectId && rate>0){
        if(expenses.length)await connection.execute("UPDATE expenses SET project_id=?,amount=?,reference=?,description=? WHERE origin_type='stock_movement' AND origin_id=?",
          [b.projectId,Math.round(b.quantity*rate*100)/100,b.reference||'',`${material.name} issued to site (${b.quantity} ${material.unit})`,String(before.id)]);
        else await connection.execute(`INSERT INTO expenses(project_id,source,description,amount,expense_date,reference,origin_type,origin_id,created_by)
          VALUES (?,'Material',?,?,DATE(?),?,'stock_movement',?,?)`,[b.projectId,`${material.name} issued to site (${b.quantity} ${material.unit})`,Math.round(b.quantity*rate*100)/100,before.created_at,b.reference||'',String(before.id),req.user.id]);
      }else if(expenses.length)await connection.execute("DELETE FROM expenses WHERE origin_type='stock_movement' AND origin_id=?",[String(before.id)]);
      await connection.execute('UPDATE stock_movements SET unit_cost_snapshot=? WHERE id=?',[rate,before.id]);
    }
    if(!linked && !changed && (b.reference||'')!==(before.reference||'')) await connection.execute(
      "UPDATE expenses SET reference=? WHERE origin_type='stock_movement' AND origin_id=?",[b.reference||'',String(before.id)]);
    const [updatedExpenses]=await connection.execute("SELECT * FROM expenses WHERE origin_type='stock_movement' AND origin_id=?",[String(before.id)]);
    const [[balance]]=await connection.execute('SELECT stock FROM materials WHERE id=?',[material.id]);
    const [[after]]=await connection.execute('SELECT * FROM stock_movements WHERE id=?',[before.id]);
    await audit(connection,req.user.id,'CORRECT','stock_movement',before.id,{...before,stock:material.stock,expenses},{...after,stock:balance.stock,expenses:updatedExpenses,reason:b.reason},req.ip);
    return after;
  });
  publishChange('materials',{});publishChange('finance',{});
  res.json(row);
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
      const [movement] = await connection.execute(`INSERT INTO stock_movements (material_id,movement_type,quantity,reference,notes,project_id,destination,user_id,origin_type,unit_cost_snapshot)
        VALUES (?,?,?,?,?,?,?,?,'Manual',?)`, [before.id, body.type, body.quantity, body.reference || '', body.notes || '',
        body.projectId || null, body.destination || null, req.user.id, Number(before.unit_cost)]);

      /* Issuing material to a project is a project cost, so record it against the budget straight away. */
      if (body.type === 'Issue' && body.projectId && Number(before.unit_cost) > 0) {
        await connection.execute(`INSERT INTO expenses (project_id,source,description,amount,expense_date,reference,origin_type,origin_id,created_by)
          VALUES (?,'Material',?,?,CURDATE(),?, 'stock_movement', ?, ?)`,
        [body.projectId, `${before.name} issued to site (${body.quantity} ${before.unit})`,
          body.quantity * Number(before.unit_cost), body.reference || '', String(movement.insertId), req.user.id]);
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
