import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, query, transaction } from '../db.js';
import { auth, can, fail, permit, validate, wrap } from '../lib/http.js';
import { postFuelRecord } from '../lib/fuel-posting.js';
import { publishChange } from '../lib/realtime.js';
import { isLocalStore, localPathFor, pipeStoredObject, readUpload, remove, store } from '../lib/storage.js';

const router = Router();
const readers = ['fuel.view', 'fuel.review', 'transport.view', 'transport.manage', 'finance.view',
  'finance.manage', 'qs.view', 'qs.costControl', 'hr.view', 'hr.manage', 'projects.view', 'projects.manage'];
const viewAll = req => readers.some(key => can(req, key));
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const positiveId = z.number().int().positive();
const odometer = positiveId.max(4294967295);
const submission = z.object({
  clientRef: z.string().uuid(),
  replacesId: positiveId.optional(),
  vehicleId: positiveId,
  companyId: positiveId,
  projectId: positiveId.nullable().default(null),
  fuelDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }),
  litres: z.number().positive().max(2000).multipleOf(.01),
  cost: z.number().positive().max(9999999999.99).multipleOf(.01),
  odometer: odometer.optional(),
  vendor: z.string().trim().max(180).optional()
});

router.use(auth);
router.get('/options', permit('fuel.submit', 'fuel.review'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  if (!Number.isSafeInteger(companyId) || companyId < 1) throw fail(400, 'Choose a company.');
  const [vehicles, projects, floats] = await Promise.all([
    can(req, 'fuel.submit') ? query("SELECT id,vehicle,registration FROM fleet WHERE status<>'Inactive' ORDER BY vehicle,registration") : [],
    can(req, 'fuel.submit') ? query('SELECT id,name FROM projects WHERE active=1 AND company_id=? ORDER BY name', [companyId]) : [],
    can(req, 'fuel.review') ? query("SELECT id,name FROM petty_cash_floats WHERE account_type='Fuel' AND active=1 ORDER BY name") : []
  ]);
  res.json({ vehicles, projects, floats });
}));

router.get('/', permit('fuel.submit', ...readers), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  if (!Number.isSafeInteger(companyId) || companyId < 1) throw fail(400, 'Choose a company.');
  const rows = await query(`SELECT s.id,s.details,s.vehicle_id vehicleId,s.company_id companyId,s.project_id projectId,s.status,s.photo IS NOT NULL hasPhoto,s.created_at createdAt,
    s.reviewed_at reviewedAt,s.review_note reviewNote,s.fuel_record_id fuelRecordId,s.submitted_by submittedById,
    s.replaces_id replacesId,next.id replacementId,prior.details previousDetails,
    assignee.name assignedTo,s.assigned_to assignedToId,
    DATE_FORMAT(DATE_ADD(s.created_at,INTERVAL 1 DAY),'%Y-%m-%d') reviewDue,
    f.vehicle,f.registration,u.name submittedBy,r.name reviewedBy,p.name project
    FROM fuel_submissions s JOIN fleet f ON f.id=s.vehicle_id JOIN users u ON u.id=s.submitted_by
    LEFT JOIN users r ON r.id=s.reviewed_by LEFT JOIN users assignee ON assignee.id=s.assigned_to AND assignee.active=1
    LEFT JOIN fuel_submissions prior ON prior.id=s.replaces_id LEFT JOIN fuel_submissions next ON next.replaces_id=s.id
    LEFT JOIN projects p ON p.id=s.project_id
    WHERE s.company_id=? ${viewAll(req) ? '' : 'AND s.submitted_by=?'}
    ORDER BY (s.status='Pending') DESC,s.id DESC`, viewAll(req) ? [companyId] : [companyId,req.user.id]);
  res.json(rows.map(({details,previousDetails,...row}) => ({...json(details),...row,previousDetails:json(previousDetails)})));
}));

router.get('/:id/photo', permit('fuel.submit', ...readers), wrap(async (req, res) => {
  const row = await getOne('SELECT photo,submitted_by FROM fuel_submissions WHERE id=?', [req.params.id]);
  if (!row?.photo || (!viewAll(req) && Number(row.submitted_by) !== Number(req.user.id))) {
    throw fail(404, 'Photo not found.');
  }
  const photo = json(row.photo);
  res.type(photo.mime);
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  if (!isLocalStore()) return pipeStoredObject(photo.key, res);
  res.sendFile(localPathFor(photo.key), error => {
    if (error && !res.headersSent) res.status(404).json({error:'Photo file not found.'});
  });
}));

router.post('/', permit('fuel.submit'), wrap(async (req, res) => {
  let upload;
  let photo;
  try {
    let input = req.body;
    if (req.is('multipart/form-data')) {
      upload = await readUpload(req);
      try { input = JSON.parse(upload.fields.details); }
      catch { throw fail(400, 'Invalid fuel details.'); }
    }
    const parsed = submission.safeParse(input);
    if (!parsed.success) return res.status(400).json({error:'Invalid fuel details', issues:parsed.error.flatten()});
    const {clientRef, replacesId, vehicleId, companyId, projectId, ...details} = parsed.data;
    const existing = await getOne('SELECT id,status FROM fuel_submissions WHERE submitted_by=? AND client_ref=?', [req.user.id,clientRef]);
    if (existing) return res.json(existing);
    if (!await getOne("SELECT id FROM fleet WHERE id=? AND status<>'Inactive'", [vehicleId])) throw fail(400, 'Choose an active vehicle.');
    if (!await getOne('SELECT id FROM companies WHERE id=? AND active=1', [companyId])) throw fail(400, 'Choose an active company.');
    if (upload) {
      if (!upload.file.mime.startsWith('image/')) throw fail(415, 'Choose an image for the fuel photo.');
      photo = await store({folder:'fuel-submission', ...upload.file});
    }
    const id = await transaction(async connection => {
      if (projectId) {
        const [[project]] = await connection.execute('SELECT id FROM projects WHERE id=? AND company_id=? AND active=1 FOR UPDATE', [projectId,companyId]);
        if (!project) throw fail(400, 'Choose a project belonging to this company.');
      }
      let savedPhoto = photo;
      if (replacesId) {
        const [[previous]] = await connection.execute(
          'SELECT id,photo FROM fuel_submissions WHERE id=? AND company_id=? AND submitted_by=? AND status=\'Rejected\' FOR UPDATE',
          [replacesId,companyId,req.user.id]);
        if (!previous) throw fail(404,'Returned fuel entry not found.');
        const [[replacement]] = await connection.execute('SELECT id FROM fuel_submissions WHERE replaces_id=?',[replacesId]);
        if (replacement) throw fail(409,'This fuel entry has already been resubmitted.');
        savedPhoto ||= json(previous.photo);
      }
      const [result] = await connection.execute(`INSERT INTO fuel_submissions
        (vehicle_id,company_id,project_id,submitted_by,client_ref,details,photo,replaces_id) VALUES (?,?,?,?,?,?,?,?)`,
      [vehicleId,companyId,projectId,req.user.id,clientRef,JSON.stringify(details),savedPhoto ? JSON.stringify(savedPhoto) : null,replacesId||null]);
      await audit(connection,req.user.id,'SUBMIT','fuel_submission',result.insertId,null,{vehicleId,companyId,projectId,replacesId,...details,hasPhoto:!!savedPhoto},req.ip);
      return result.insertId;
    });
    photo = null;
    publishChange('fuel-submissions');
    res.status(201).json({id,status:'Pending'});
  } catch (error) {
    if (photo) await remove(photo.key).catch(() => {});
    if (error.code === 'ER_DUP_ENTRY') throw fail(409, 'This submission already exists. Refresh to see its status.');
    throw error;
  } finally {
    if (upload) await upload.discard();
  }
}));

router.post('/:id/claim',permit('fuel.review'),wrap(async(req,res)=>{
  await transaction(async connection=>{
    const [[row]]=await connection.execute(`SELECT s.status,s.submitted_by,assignee.id owner
      FROM fuel_submissions s LEFT JOIN users assignee ON assignee.id=s.assigned_to AND assignee.active=1 WHERE s.id=? FOR UPDATE`,[req.params.id]);
    if (!row || row.status!=='Pending') throw fail(404,'Pending fuel entry not found.');
    if (Number(row.submitted_by)===Number(req.user.id)) throw fail(403,'Another reviewer must handle your submission.');
    if (row.owner && Number(row.owner)!==Number(req.user.id)) throw fail(409,'Another reviewer already owns this entry.');
    if (!row.owner) {
      await connection.execute('UPDATE fuel_submissions SET assigned_to=? WHERE id=?',[req.user.id,req.params.id]);
      await audit(connection,req.user.id,'ASSIGN','fuel_submission',req.params.id,null,{assignedTo:req.user.id},req.ip);
    }
  });
  publishChange('fuel-submissions');
  res.status(204).end();
}));

router.post('/:id/review', permit('fuel.review'), validate(z.object({
  decision: z.enum(['Approved','Rejected']),
  note: z.string().trim().max(500).optional(),
  odometer: odometer.optional(),
  fuelFloatId: positiveId.optional()
})), wrap(async (req, res) => {
  const {decision,note} = req.body;
  if (decision === 'Rejected' && !note) throw fail(400, 'Enter a rejection reason.');
  const submission = await getOne('SELECT project_id FROM fuel_submissions WHERE id=?', [req.params.id]);
  if (!submission) throw fail(404, 'Submission not found.');
  const result = await transaction(async connection => {
    if (submission.project_id) await connection.execute('SELECT id FROM projects WHERE id=? FOR UPDATE', [submission.project_id]);
    const [[row]] = await connection.execute('SELECT * FROM fuel_submissions WHERE id=? FOR UPDATE',[req.params.id]);
    if (!row) throw fail(404, 'Submission not found.');
    if (row.status !== 'Pending') throw fail(409, 'This submission has already been reviewed.');
    if (Number(row.submitted_by) === Number(req.user.id)) throw fail(403, 'Another authorized reviewer must review your submission.');
    let fuelRecordId = null;
    if (decision === 'Approved') {
      const details = json(row.details);
      const reading = req.body.odometer ?? details.odometer;
      if (!reading) throw fail(400, 'Enter the actual odometer reading before approval.');
      fuelRecordId = await postFuelRecord(connection,row.vehicle_id,
        {...details,companyId:row.company_id,projectId:row.project_id,odometer:reading,fuelFloatId:req.body.fuelFloatId},req.user.id,req.ip);
    }
    await connection.execute(`UPDATE fuel_submissions SET status=?,review_note=?,reviewed_by=?,reviewed_at=NOW(),fuel_record_id=? WHERE id=?`,
      [decision,note||null,req.user.id,fuelRecordId,row.id]);
    await audit(connection,req.user.id,'REVIEW','fuel_submission',row.id,{status:row.status},{status:decision,note,fuelRecordId},req.ip);
    return {id:row.id, status:decision, fuelRecordId, vehicleId:row.vehicle_id};
  });
  publishChange('fuel-submissions');
  if (result.fuelRecordId) {
    publishChange('fleet',{vehicleId:result.vehicleId});
    publishChange('receivables',{});
  }
  res.json(result);
}));
export default router;
