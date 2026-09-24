import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, nextReference, pool, query, transaction } from '../db.js';
import { optionsFor } from '../lib/options.js';
import { auth, permit, validate, wrap, fromOptions } from '../lib/http.js';
import { assertUniqueManualEntry } from '../lib/ledger-duplicates.js';
import { boqDocument, documentContext } from '../lib/documents.js';
import { sendDocument } from '../lib/document-pdf.js';
import { notify } from '../alerts.js';

const router = Router();
/* Kept only as the fallback grouping for the cost comparison below; the values people
   may choose come from the option list, which the company maintains itself. */
const CATEGORIES = ['Material', 'Labour', 'Equipment', 'Subcontract', 'Overhead'];

const select = `SELECT b.id,b.reference,b.title,b.status,b.version,b.total,b.notes,b.terms,b.project_id projectId,p.name project,p.client_id clientId,COALESCE(d.name,p.client) client,
  p.company_id companyId,c.name company,
  u.name preparedBy,a.name approvedBy,b.approved_at approvedAt,b.created_at createdAt
  FROM boqs b JOIN projects p ON p.id=b.project_id JOIN companies c ON c.id=p.company_id LEFT JOIN clients d ON d.id=p.client_id
  JOIN users u ON u.id=b.prepared_by LEFT JOIN users a ON a.id=b.approved_by`;

/**
 * A project's approved budget is the sum of its approved BOQ packages plus approved
 * variation orders. Projects with no approved BOQ keep the figure entered by hand,
 * so recalculating never wipes a budget that the estimating workflow does not own.
 */
async function recalculateBudget(connection, projectId) {
  const [rows] = await connection.execute(`SELECT
      (SELECT COUNT(*) FROM boqs WHERE project_id=? AND status='Approved') packages,
      (SELECT COALESCE(SUM(total),0) FROM boqs WHERE project_id=? AND status='Approved') boqTotal,
      (SELECT COALESCE(SUM(amount),0) FROM variation_orders WHERE project_id=? AND status='Approved') variations`,
  [projectId, projectId, projectId]);
  if (!rows[0].packages) return;
  await connection.execute('UPDATE projects SET budget=? WHERE id=?', [Number(rows[0].boqTotal) + Number(rows[0].variations), projectId]);
}

const itemSchema = z.object({
  category: z.string().trim().min(1).max(60),
  description: z.string().min(2).max(300),
  unit: z.string().min(1).max(30),
  quantity: z.number().positive(),
  rate: z.number().nonnegative(),
  materialId: z.number().int().positive().optional(),
  subcontractRateId:z.number().int().positive().optional()
});

/*
 * A bill arrives with all its lines at once, so each line's category is checked rather
 * than one field on the body. Same list, same message, applied across the array.
 */
const checkItemCategories = async (req, res, next) => {
  try {
    const allowed = await optionsFor('boq.category');
    const wrong = (req.body.items || []).find(item => !allowed.includes(item.category));
    if (wrong) {
      return res.status(400).json({
        error: `"${wrong.category}" is not one of the BOQ categories.`,
        issues: { fieldErrors: { category: [`Choose one of: ${allowed.join(', ')}`] } }
      });
    }
    next();
  } catch (error) { next(error); }
};

router.get('/', auth, permit('qs.view','qs.boq'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  res.json(await query(`${select} ${companyId > 0 ? 'WHERE p.company_id=?' : ''} ORDER BY b.id DESC`, companyId > 0 ? [companyId] : []));
}));

/** Live site cost control: approved estimate, daily actuals, forecasts and exceptions. */
router.get('/cost-control', auth, permit('qs.view','qs.boq','finance.view','finance.manage'), wrap(async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isInteger(projectId) || projectId < 1) return res.status(400).json({ error: 'Choose a project site' });
  const project = await getOne('SELECT id,name,site,budget,progress,health FROM projects WHERE id=? AND active=1', [projectId]);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const [items, expenses, variations, daily, committed, sheets, recoveries] = await Promise.all([
    query(`SELECT bi.id,bi.category,bi.description,bi.unit,bi.quantity,bi.rate,bi.amount expectedAmount,
      b.reference boqReference,b.title boqTitle,b.status boqStatus,
      f.forecast_quantity forecastQuantity,f.forecast_rate forecastRate,f.forecast_amount forecastAmount,f.reason forecastReason,
      COALESCE(SUM(e.amount),0) actualAmount,COALESCE(SUM(e.quantity),0) actualQuantity,COUNT(e.id) expenseCount
      FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id
      LEFT JOIN project_cost_forecasts f ON f.boq_item_id=bi.id
      LEFT JOIN expenses e ON e.boq_item_id=bi.id
      WHERE b.project_id=? AND (b.status='Approved' OR NOT EXISTS
        (SELECT 1 FROM boqs approved WHERE approved.project_id=b.project_id AND approved.status='Approved'))
      GROUP BY bi.id,b.reference,b.title,b.status,f.forecast_quantity,f.forecast_rate,f.forecast_amount,f.reason
      ORDER BY b.id,bi.id`, [projectId]),
    query(`SELECT e.id,e.expense_date expenseDate,e.source,e.cost_type costType,e.description,e.amount,e.quantity,e.unit,e.unit_rate unitRate,
      e.reference,e.boq_item_id boqItemId,bi.description boqItem,u.name recordedBy
      FROM expenses e LEFT JOIN boq_items bi ON bi.id=e.boq_item_id JOIN users u ON u.id=e.created_by
      WHERE e.project_id=? ORDER BY e.expense_date DESC,e.id DESC LIMIT 1000`, [projectId]),
    query(`SELECT id,reference,description,amount,status,created_at createdAt FROM variation_orders
      WHERE project_id=? ORDER BY id DESC`, [projectId]),
    query(`SELECT expense_date expenseDate,SUM(amount) total,
      SUM(CASE WHEN cost_type='Unexpected' THEN amount ELSE 0 END) unexpected,COUNT(*) entries FROM expenses WHERE project_id=?
      GROUP BY expense_date ORDER BY expense_date DESC LIMIT 120`, [projectId]),
    getOne(`SELECT COALESCE(SUM(total),0) total FROM purchase_orders
      WHERE project_id=? AND status<>'Cancelled'`, [projectId]),
    query(`SELECT s.id,s.work_date workDate,s.status,s.notes,s.review_note reviewNote,
      submitter.name submittedBy,reviewer.name reviewedBy,
      COALESCE(SUM(l.amount),0) totalCost,COALESCE(SUM(l.quoted_recovery),0) quotedRecovery,
      COUNT(l.id) lineCount FROM daily_cost_sheets s
      JOIN users submitter ON submitter.id=s.submitted_by
      LEFT JOIN users reviewer ON reviewer.id=s.reviewed_by
      LEFT JOIN daily_cost_lines l ON l.sheet_id=s.id
      WHERE s.project_id=? GROUP BY s.id ORDER BY s.work_date DESC,s.id DESC LIMIT 120`, [projectId]),
    query(`SELECT s.work_date workDate,COALESCE(SUM(l.quoted_recovery),0) quotedRecovery
      FROM daily_cost_sheets s JOIN daily_cost_lines l ON l.sheet_id=s.id
      WHERE s.project_id=? AND s.status='Approved' GROUP BY s.work_date`, [projectId])
  ]);
  const number = value => Number(value || 0);
  const costItems = items.map(item => {
    const expected = number(item.expectedAmount); const actual = number(item.actualAmount);
    const forecast = item.forecastAmount === null ? expected : number(item.forecastAmount);
    const finalForecast = Math.max(forecast, actual);
    return { ...item, expectedAmount: expected, actualAmount: actual, forecastAmount: forecast,
      finalForecast, variance: actual - expected, forecastVariance: finalForecast - expected,
      variancePercent: expected ? Number(((actual - expected) / expected * 100).toFixed(1)) : (actual ? 100 : 0) };
  });
  const baseline = costItems.reduce((sum, item) => sum + item.expectedAmount, 0);
  const actual = expenses.reduce((sum, item) => sum + number(item.amount), 0);
  const approvedChanges = variations.filter(item => item.status === 'Approved').reduce((sum, item) => sum + number(item.amount), 0);
  const unexpected = expenses.filter(item => item.costType === 'Unexpected').reduce((sum, item) => sum + number(item.amount), 0);
  const unallocated = expenses.filter(item => !item.boqItemId).reduce((sum, item) => sum + number(item.amount), 0);
  /* Unlinked legacy costs are already part of actual-to-date. Adding them to the complete
     baseline would count the same expected work twice; explicit unexpected cost is the
     part that sits outside the approved estimate. */
  const forecast = Math.max(costItems.reduce((sum, item) => sum + item.finalForecast, 0) + unexpected, actual);
  const currentBudget = baseline ? baseline + approvedChanges : number(project.budget);
  const categories = [...costItems.reduce((map, item) => {
    const row = map.get(item.category) || { category: item.category, expected: 0, actual: 0, forecast: 0 };
    row.expected += item.expectedAmount; row.actual += item.actualAmount; row.forecast += item.finalForecast;
    map.set(item.category, row); return map;
  }, new Map()).values()];
  const recoveryByDate = new Map(recoveries.map(row => [String(row.workDate).slice(0,10),number(row.quotedRecovery)]));
  const dailyCommercial = daily.map(row => ({ ...row,quotedRecovery:recoveryByDate.get(String(row.expenseDate).slice(0,10)) || 0,
    netAgainstQuote:(recoveryByDate.get(String(row.expenseDate).slice(0,10)) || 0)-number(row.total) }));
  res.json({ project, summary: { baseline, approvedChanges, currentBudget, actual, unexpected, unallocated, committed: number(committed.total), forecast,
    actualVariance: actual - currentBudget, forecastVariance: forecast - currentBudget }, items: costItems, expenses, variations, daily:dailyCommercial, categories, sheets });
}));

const dailyLineSchema = z.object({
  taskId: z.number().int().positive(), boqItemId: z.number().int().positive().nullable().optional(),
  source: z.enum(['Material','Labour','Fuel','Equipment','Subcontractor','Overhead','Other']),
  costType: z.enum(['Expected','Variation','Unexpected']).default('Expected'),
  description: z.string().trim().min(2).max(400),
  quantity: z.number().positive().nullable().optional(), unit: z.string().trim().max(30).nullable().optional(),
  unitRate: z.number().nonnegative().nullable().optional(), amount: z.number().positive(),
  employeeId: z.number().int().positive().nullable().optional(), vehicleId: z.number().int().positive().nullable().optional(),
  fuelOrigin: z.enum(['Station','Reserve']).nullable().optional(),
  fuelRecordId: z.number().int().positive().nullable().optional(),
  fuelFloatId: z.number().int().positive().nullable().optional(), odometer: z.number().int().positive().nullable().optional(),
  reserveMaterialId: z.number().int().positive().nullable().optional(),
  reference: z.string().trim().max(120).nullable().optional(),
  quotationItemId: z.number().int().positive().nullable().optional(), quotedRecovery: z.number().nonnegative().default(0)
});

const costError = (message, status = 400) => Object.assign(new Error(message), { status });

router.get('/cost-control/options', auth, permit('qs.view','qs.boq','finance.view','finance.manage'), wrap(async (req, res) => {
  const projectId = Number(req.query.projectId);
  const project = await getOne('SELECT id,company_id companyId FROM projects WHERE id=? AND active=1', [projectId]);
  if (!project) return res.status(404).json({ error: 'Choose an active project site.' });
  const [tasks, employees, vehicles, reserves, fuel, quotationItems, fuelFloats] = await Promise.all([
    query('SELECT id,title,status FROM tasks WHERE project_id=? ORDER BY title', [projectId]),
    query("SELECT id,name,code,daily_rate dailyRate FROM employees WHERE status IN ('Active','On leave') ORDER BY name"),
    query('SELECT id,vehicle,registration FROM fleet WHERE status<>\'Inactive\' ORDER BY vehicle'),
    query("SELECT id,name,unit,stock,unit_cost unitCost,site FROM materials WHERE active=1 AND LOWER(unit) IN ('l','litre','litres','liter','liters') ORDER BY name"),
    query(`SELECT f.id,f.vehicle_id vehicleId,f.fuel_date fuelDate,f.litres,f.cost,v.vehicle,v.registration
      FROM fuel_records f JOIN fleet v ON v.id=f.vehicle_id
      WHERE f.project_id=? AND NOT EXISTS(SELECT 1 FROM daily_cost_lines l JOIN daily_cost_sheets s ON s.id=l.sheet_id
        WHERE l.fuel_record_id=f.id AND s.status IN ('Submitted','Approved'))
      ORDER BY f.fuel_date DESC,f.id DESC LIMIT 300`, [projectId]),
    query(`SELECT qi.id,qi.description,qi.unit,qi.quantity,qi.amount,q.reference
      FROM quotation_items qi JOIN quotations_client q ON q.id=qi.quotation_id
      WHERE q.project_id=? AND q.status='Accepted' ORDER BY q.id DESC,qi.id`, [projectId]),
    query(`SELECT f.id,f.name,COALESCE(SUM(e.amount),0) balance FROM petty_cash_floats f
      LEFT JOIN petty_cash_entries e ON e.float_id=f.id WHERE f.company_id=? AND f.account_type='Fuel' AND f.active=1
      GROUP BY f.id,f.name ORDER BY f.name`, [project.companyId])
  ]);
  res.json({ tasks, employees, vehicles, reserves, fuel, quotationItems, fuelFloats });
}));

router.get('/cost-control/review-queue', auth, permit('finance.view','finance.manage'), wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  if (!Number.isInteger(companyId) || companyId < 1) return res.status(400).json({ error:'Choose a company.' });
  res.json(await query(`SELECT s.id,s.project_id projectId,p.name project,s.work_date workDate,s.status,
    u.name submittedBy,COALESCE(SUM(l.amount),0) totalCost,COALESCE(SUM(l.quoted_recovery),0) quotedRecovery,
    COUNT(l.id) lineCount FROM daily_cost_sheets s JOIN projects p ON p.id=s.project_id
    JOIN users u ON u.id=s.submitted_by LEFT JOIN daily_cost_lines l ON l.sheet_id=s.id
    WHERE p.company_id=? GROUP BY s.id ORDER BY (s.status='Submitted') DESC,s.work_date DESC,s.id DESC LIMIT 200`, [companyId]));
}));

router.get('/cost-control/daily-sheets/:id', auth, permit('qs.view','qs.boq','finance.view','finance.manage'), wrap(async (req, res) => {
  const sheet = await getOne(`SELECT s.*,p.name project,p.company_id companyId,u.name submittedBy,r.name reviewedBy
    FROM daily_cost_sheets s JOIN projects p ON p.id=s.project_id
    JOIN users u ON u.id=s.submitted_by LEFT JOIN users r ON r.id=s.reviewed_by WHERE s.id=?`, [req.params.id]);
  if (!sheet) return res.status(404).json({ error: 'Daily cost sheet not found.' });
  const lines = await query(`SELECT l.*,t.title work,e.name employee,v.vehicle,v.registration,m.name reserveMaterial,
    pf.name fuelFloat,
    qi.description quotationItem FROM daily_cost_lines l JOIN tasks t ON t.id=l.task_id
    LEFT JOIN employees e ON e.id=l.employee_id LEFT JOIN fleet v ON v.id=l.vehicle_id
    LEFT JOIN materials m ON m.id=l.reserve_material_id
    LEFT JOIN petty_cash_floats pf ON pf.id=l.fuel_float_id
    LEFT JOIN quotation_items qi ON qi.id=l.quotation_item_id
    WHERE l.sheet_id=? ORDER BY l.id`, [sheet.id]);
  res.json({ ...sheet, lines });
}));

router.post('/cost-control/daily-sheets', auth, permit('qs.boq'), validate(z.object({
  projectId: z.number().int().positive(), workDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(1000).nullable().optional(), lines: z.array(dailyLineSchema).min(1).max(100)
})), wrap(async (req, res) => {
  const { projectId, workDate, lines, notes } = req.body;
  const id = await transaction(async connection => {
    const [[project]] = await connection.execute('SELECT id,company_id companyId FROM projects WHERE id=? AND active=1', [projectId]);
    if (!project) throw costError('Choose an active project site.');
    const fuelRecordsOnSheet = new Set();
    const labourersOnSheet = new Set();
    for (const line of lines) {
      const [[task]] = await connection.execute('SELECT id FROM tasks WHERE id=? AND project_id=?', [line.taskId, projectId]);
      if (!task) throw costError('One selected work task does not belong to this project. Refresh the task list and try again.');
      if (line.boqItemId) {
        const [[item]] = await connection.execute(`SELECT bi.id FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id
          WHERE bi.id=? AND b.project_id=?`, [line.boqItemId, projectId]);
        if (!item) throw costError('A selected BOQ item does not belong to this project.');
      }
      if (line.costType === 'Unexpected' && (line.boqItemId || line.quotedRecovery))
        throw costError('Unexpected costs cannot be allocated to a quoted item or counted as quoted recovery.');
      if (line.quotedRecovery && !line.quotationItemId)
        throw costError('Choose an accepted quotation item before entering its recoverable amount.');
      if (line.quotationItemId) {
        const [[quoted]] = await connection.execute(`SELECT qi.id,qi.amount FROM quotation_items qi
          JOIN quotations_client q ON q.id=qi.quotation_id
          WHERE qi.id=? AND q.project_id=? AND q.status='Accepted'`, [line.quotationItemId, projectId]);
        if (!quoted) throw costError('The quotation item must belong to an accepted quotation for this project.');
      }
      if (line.source === 'Labour') {
        if (labourersOnSheet.has(line.employeeId)) throw costError('A labourer day salary can be charged only once on this sheet.');
        labourersOnSheet.add(line.employeeId);
        const [[employee]] = await connection.execute('SELECT daily_rate dailyRate FROM employees WHERE id=? AND status<>\'Left\'', [line.employeeId || 0]);
        if (!employee || Number(employee.dailyRate) <= 0 || Math.abs(Number(employee.dailyRate) - line.amount) > .01)
          throw costError('Choose a labourer with a configured daily rate. The manpower cost must equal that day salary.');
        const [[already]] = await connection.execute(`SELECT l.id FROM daily_cost_lines l
          JOIN daily_cost_sheets s ON s.id=l.sheet_id
          WHERE l.employee_id=? AND s.work_date=? AND s.status IN ('Submitted','Approved') LIMIT 1`,
          [line.employeeId,workDate]);
        if (already) throw costError('This labourer already has a day-salary cost submitted for that date. Review the earlier sheet before adding another.',409);
      }
      if (line.source === 'Fuel') {
        if (!line.vehicleId || !line.fuelOrigin) throw costError('Fuel needs a vehicle and a source: station or company reserve.');
        if (line.fuelOrigin === 'Station') {
          if (line.fuelRecordId) {
            if (line.fuelFloatId) throw costError('Choose either an existing Fleet fuel record or a new fuel-float purchase, not both.');
            if (fuelRecordsOnSheet.has(line.fuelRecordId)) throw costError('A Fleet fuel record can appear only once on a daily sheet.');
            fuelRecordsOnSheet.add(line.fuelRecordId);
            const [[fuel]] = await connection.execute(`SELECT id,vehicle_id vehicleId,project_id projectId,fuel_date fuelDate,cost
              FROM fuel_records WHERE id=?`, [line.fuelRecordId]);
            if (!fuel || Number(fuel.vehicleId) !== line.vehicleId || Number(fuel.projectId) !== projectId ||
                String(fuel.fuelDate).slice(0, 10) !== workDate || Math.abs(Number(fuel.cost) - line.amount) > .01)
              throw costError('Select the matching Fleet fuel record for this vehicle, project, date and amount. Fleet records the fuel-float spending once.');
            const [[used]] = await connection.execute(`SELECT l.id FROM daily_cost_lines l JOIN daily_cost_sheets s ON s.id=l.sheet_id
              WHERE l.fuel_record_id=? AND s.status IN ('Submitted','Approved')`, [fuel.id]);
            if (used) throw costError('That Fleet fuel record is already on a daily cost sheet.', 409);
          } else {
            if (!line.fuelFloatId || !line.quantity || !line.odometer)
              throw costError('A new station fuel purchase needs a funded fuel float, litres and vehicle odometer.');
            const [[fuelFloat]] = await connection.execute(`SELECT id FROM petty_cash_floats
              WHERE id=? AND account_type='Fuel' AND active=1 AND company_id=?`,[line.fuelFloatId,project.companyId]);
            if (!fuelFloat) throw costError('Choose an active fuel float belonging to this project company.');
            const [[vehicle]] = await connection.execute('SELECT odometer FROM fleet WHERE id=?',[line.vehicleId]);
            if (!vehicle || Number(line.odometer)<Number(vehicle.odometer))
              throw costError('The vehicle odometer cannot be less than its last Fleet reading.');
          }
        } else {
          if (line.fuelRecordId || line.fuelFloatId) throw costError('Reserve fuel is issued from stock, not a Fleet fuel purchase or petty-cash float.');
          const [[material]] = await connection.execute('SELECT unit,unit_cost unitCost FROM materials WHERE id=? AND active=1', [line.reserveMaterialId || 0]);
          if (!material || !['l','litre','litres','liter','liters'].includes(String(material.unit).toLowerCase()) || !line.quantity ||
            Math.abs(Number(material.unitCost) * line.quantity - line.amount) > .01)
            throw costError('Choose a litre-based fuel reserve item and use its stock unit cost × litres as the amount.');
        }
      } else if (line.fuelOrigin || line.fuelRecordId || line.fuelFloatId || line.reserveMaterialId) {
        throw costError('Fuel source fields can only be used on fuel cost lines.');
      }
    }
    const [created] = await connection.execute(`INSERT INTO daily_cost_sheets
      (project_id,work_date,status,notes,submitted_by) VALUES (?,?,'Submitted',?,?)`,
      [projectId, workDate, notes || null, req.user.id]);
    for (const line of lines) await connection.execute(`INSERT INTO daily_cost_lines
      (sheet_id,task_id,boq_item_id,source,cost_type,description,quantity,unit,unit_rate,amount,
       employee_id,vehicle_id,fuel_origin,fuel_record_id,fuel_float_id,odometer,reserve_material_id,reference,quotation_item_id,quoted_recovery)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [created.insertId,line.taskId,line.boqItemId || null,line.source,line.costType,line.description,
        line.quantity || null,line.unit || null,line.unitRate ?? null,line.amount,line.employeeId || null,
        line.vehicleId || null,line.fuelOrigin || null,line.fuelRecordId || null,line.fuelFloatId || null,line.odometer || null,line.reserveMaterialId || null,
        line.reference || null,line.quotationItemId || null,line.quotedRecovery]);
    await audit(connection,req.user.id,'SUBMIT','daily_cost_sheet',created.insertId,null,req.body,req.ip);
    return created.insertId;
  });
  await notify({ audience:'finance.manage', severity:'Info', title:'Daily site costs need review',
    message:`A daily cost sheet for ${workDate} is awaiting Finance review.`, referenceType:'daily_cost_sheet',referenceId:id });
  res.status(201).json({ id, status:'Submitted' });
}));

router.post('/cost-control/daily-sheets/:id/review', auth, permit('finance.manage'), validate(z.object({
  decision: z.enum(['Approved','Returned']), note: z.string().trim().max(1000).optional()
})), wrap(async (req, res) => {
  const sheetId = Number(req.params.id);
  const decision = req.body.decision;
  if (decision === 'Returned' && !req.body.note?.trim()) return res.status(400).json({ error:'Explain what QS should correct before returning this sheet.' });
  const result = await transaction(async connection => {
    const [[sheet]] = await connection.execute('SELECT * FROM daily_cost_sheets WHERE id=? FOR UPDATE', [sheetId]);
    if (!sheet) throw costError('Daily cost sheet not found.',404);
    if (sheet.status !== 'Submitted') throw costError('This sheet has already been reviewed. Refresh the page.',409);
    const [lines] = await connection.execute('SELECT * FROM daily_cost_lines WHERE sheet_id=? ORDER BY id FOR UPDATE', [sheetId]);
    if (decision === 'Approved') {
      const recovering = new Map();
      for (const line of lines) {
        let expenseId;
        if (line.quotation_item_id && Number(line.quoted_recovery) > 0) {
          const [[quoted]] = await connection.execute(`SELECT qi.amount,q.status,q.project_id FROM quotation_items qi
            JOIN quotations_client q ON q.id=qi.quotation_id WHERE qi.id=? FOR UPDATE`, [line.quotation_item_id]);
          if (!quoted || quoted.status !== 'Accepted' || Number(quoted.project_id) !== Number(sheet.project_id))
            throw costError('An accepted quotation changed since submission. Ask QS to review the quotation link.',409);
          const [[{allocated}]] = await connection.execute(`SELECT COALESCE(SUM(l.quoted_recovery),0) allocated
            FROM daily_cost_lines l JOIN daily_cost_sheets s ON s.id=l.sheet_id
            WHERE l.quotation_item_id=? AND s.status='Approved'`, [line.quotation_item_id]);
          const onThisSheet = Number(recovering.get(Number(line.quotation_item_id)) || 0) + Number(line.quoted_recovery);
          if (Number(allocated) + onThisSheet > Number(quoted.amount) + .01)
            throw costError('Quoted recovery exceeds the accepted quotation item. Return the sheet for correction.',409);
          recovering.set(Number(line.quotation_item_id),onThisSheet);
        }
        if (line.source === 'Fuel' && line.fuel_origin === 'Station') {
          if (line.fuel_record_id) {
            const [[fuel]] = await connection.execute(`SELECT f.cost,f.project_id,f.fuel_date,f.vehicle_id,
              pce.id cashEntryId,e.id expenseId FROM fuel_records f
              LEFT JOIN petty_cash_entries pce ON pce.fuel_record_id=f.id
              LEFT JOIN expenses e ON e.origin_type='fuel_record' AND CAST(e.origin_id AS UNSIGNED)=f.id
              WHERE f.id=?`, [line.fuel_record_id]);
            if (!fuel || !fuel.cashEntryId || !fuel.expenseId || Number(fuel.project_id) !== Number(sheet.project_id) ||
                String(fuel.fuel_date).slice(0,10) !== String(sheet.work_date).slice(0,10) ||
                Number(fuel.vehicle_id) !== Number(line.vehicle_id) || Math.abs(Number(fuel.cost)-Number(line.amount)) > .01)
              throw costError('The station fuel must match an existing Fleet expense and fuel-float payment. Return this sheet to QS.',409);
            expenseId = fuel.expenseId;
          } else {
            const [[project]] = await connection.execute('SELECT company_id companyId FROM projects WHERE id=?',[sheet.project_id]);
            const [[fuelFloat]] = await connection.execute(`SELECT id,name,company_id companyId FROM petty_cash_floats
              WHERE id=? AND account_type='Fuel' AND active=1 FOR UPDATE`,[line.fuel_float_id]);
            if (!fuelFloat || Number(fuelFloat.companyId)!==Number(project.companyId))
              throw costError('The chosen fuel float is no longer active for this company. Return the sheet to QS.',409);
            const [[{balance}]] = await connection.execute('SELECT COALESCE(SUM(amount),0) balance FROM petty_cash_entries WHERE float_id=?',[fuelFloat.id]);
            if (Number(balance)+.001<Number(line.amount))
              throw costError(`${fuelFloat.name} has only LKR ${Number(balance).toLocaleString('en-LK')} available. Top up the fuel float or return this sheet.`,409);
            const [[vehicle]] = await connection.execute('SELECT vehicle,registration,driver,odometer FROM fleet WHERE id=? FOR UPDATE',[line.vehicle_id]);
            if (!vehicle || Number(line.odometer)<Number(vehicle.odometer))
              throw costError('The vehicle odometer changed since QS submitted this fuel purchase. Return the sheet for correction.',409);
            const [[duplicate]] = await connection.execute(`SELECT id FROM fuel_records WHERE vehicle_id=? AND fuel_date=?
              AND litres=? AND cost=? LIMIT 1`,[line.vehicle_id,sheet.work_date,line.quantity,line.amount]);
            if (duplicate) throw costError('Fleet already has a matching fuel purchase. Return this sheet and link that Fleet record instead.',409);
            const [createdFuel] = await connection.execute(`INSERT INTO fuel_records
              (vehicle_id,project_id,fuel_date,litres,cost,odometer,driver,created_by) VALUES (?,?,?,?,?,?,?,?)`,
              [line.vehicle_id,sheet.project_id,sheet.work_date,line.quantity,line.amount,line.odometer,vehicle.driver,req.user.id]);
            await connection.execute(`INSERT INTO petty_cash_entries
              (float_id,kind,amount,entry_date,description,category,project_id,fuel_record_id,recorded_by)
              VALUES (?,'Spend',?,?,?,'Fuel',?,?,?)`,
              [fuelFloat.id,-Number(line.amount),sheet.work_date,`Fuel — ${vehicle.vehicle} (${vehicle.registration})`,
                sheet.project_id,createdFuel.insertId,req.user.id]);
            await connection.execute('UPDATE fleet SET odometer=GREATEST(odometer,?) WHERE id=?',[line.odometer,line.vehicle_id]);
            await connection.execute(`INSERT INTO vehicle_odometer_readings
              (vehicle_id,reading_date,odometer,source,source_id,recorded_by) VALUES (?,?,?,'Fuel',?,?)`,
              [line.vehicle_id,sheet.work_date,line.odometer,createdFuel.insertId,req.user.id]);
            const [posted] = await connection.execute(`INSERT INTO expenses
              (project_id,boq_item_id,source,cost_type,description,amount,quantity,unit,unit_rate,
               expense_date,reference,origin_type,origin_id,created_by)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,'fuel_record',?,?)`,
              [sheet.project_id,line.boq_item_id,'Fuel',line.cost_type,line.description,line.amount,line.quantity,
                line.unit,line.unit_rate,sheet.work_date,line.reference,String(createdFuel.insertId),req.user.id]);
            expenseId = posted.insertId;
            await connection.execute('UPDATE daily_cost_lines SET fuel_record_id=? WHERE id=?',[createdFuel.insertId,line.id]);
          }
        } else {
          await assertUniqueManualEntry(connection,'expenses',{ projectId:sheet.project_id,
            reference:line.reference,amount:Number(line.amount),date:sheet.work_date,description:line.description });
          if (line.source === 'Fuel' && line.fuel_origin === 'Reserve') {
            const [[material]] = await connection.execute('SELECT id,unit_cost,stock,unit FROM materials WHERE id=? AND active=1 FOR UPDATE', [line.reserve_material_id]);
            if (!material || Number(material.stock) < Number(line.quantity) ||
                Math.abs(Number(material.unit_cost)*Number(line.quantity)-Number(line.amount)) > .01)
              throw costError('The reserve fuel stock or unit cost changed. Return this sheet to QS for correction.',409);
            await connection.execute('UPDATE materials SET stock=stock-? WHERE id=?',[line.quantity,material.id]);
            await connection.execute(`INSERT INTO stock_movements
              (material_id,movement_type,quantity,reference,notes,project_id,destination,user_id)
              VALUES (?,'Issue',?,?,?,?,?,?)`,
              [material.id,line.quantity,`Daily cost #${sheet.id}`,`${sheet.work_date}: ${line.description}`,sheet.project_id,'Project site',req.user.id]);
          }
          const [posted] = await connection.execute(`INSERT INTO expenses
            (project_id,boq_item_id,source,cost_type,description,amount,quantity,unit,unit_rate,
             expense_date,reference,origin_type,origin_id,created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,'daily_cost_line',?,?)`,
            [sheet.project_id,line.boq_item_id,line.source,line.cost_type,line.description,line.amount,
              line.quantity,line.unit,line.unit_rate,sheet.work_date,line.reference,String(line.id),req.user.id]);
          expenseId = posted.insertId;
        }
        await connection.execute('UPDATE daily_cost_lines SET posted_expense_id=? WHERE id=?',[expenseId,line.id]);
      }
    }
    await connection.execute(`UPDATE daily_cost_sheets SET status=?,review_note=?,reviewed_by=?,reviewed_at=NOW() WHERE id=?`,
      [decision,req.body.note || null,req.user.id,sheet.id]);
    await audit(connection,req.user.id,decision === 'Approved'?'APPROVE':'RETURN','daily_cost_sheet',sheet.id,
      {status:sheet.status},{status:decision,note:req.body.note || null},req.ip);
    return sheet;
  });
  await notify({ userId:result.submitted_by,severity:decision === 'Approved'?'Info':'Warning',
    title:`Daily cost sheet ${decision.toLowerCase()}`,message:req.body.note || `Finance ${decision.toLowerCase()} the ${result.work_date} site costs.`,
    referenceType:'daily_cost_sheet',referenceId:sheetId });
  res.json({ id:sheetId,status:decision });
}));

router.post('/cost-control/expenses', auth, permit('qs.boq','finance.manage'), (_req, res) =>
  res.status(410).json({ error:'Daily costs now require a QS submission and Finance review. Open Cost control and submit a daily cost sheet.' }));

router.patch('/cost-control/expenses/:id', auth, permit('qs.boq','finance.manage'), validate(z.object({
  projectId: z.number().int().positive(),
  boqItemId: z.number().int().positive(),
  costType: z.enum(['Expected','Variation','Unexpected']).default('Expected'),
  reason: z.string().min(3).max(600)
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM expenses WHERE id=? AND project_id=?', [req.params.id, req.body.projectId]);
  if (!before) return res.status(404).json({ error: 'Project expense not found' });
  const item = await getOne(`SELECT bi.id FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id
    WHERE bi.id=? AND b.project_id=?`, [req.body.boqItemId, req.body.projectId]);
  if (!item) return res.status(400).json({ error: 'That BOQ item does not belong to this project' });
  await query('UPDATE expenses SET boq_item_id=?,cost_type=? WHERE id=?', [item.id, req.body.costType, before.id]);
  const after = await getOne('SELECT * FROM expenses WHERE id=?', [before.id]);
  await audit(pool, req.user.id, 'ALLOCATE', 'project_cost', before.id, before, { ...after, allocationReason: req.body.reason }, req.ip);
  res.json(after);
}));

router.patch('/cost-control/items/:itemId/forecast', auth, permit('qs.boq'), validate(z.object({
  projectId: z.number().int().positive(),
  forecastQuantity: z.number().positive().nullable().optional(),
  forecastRate: z.number().nonnegative().nullable().optional(),
  forecastAmount: z.number().nonnegative(),
  reason: z.string().min(3).max(600)
})), wrap(async (req, res) => {
  const item = await getOne(`SELECT bi.id,bi.amount FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id
    WHERE bi.id=? AND b.project_id=?`, [req.params.itemId, req.body.projectId]);
  if (!item) return res.status(404).json({ error: 'BOQ cost item not found' });
  const before = await getOne('SELECT * FROM project_cost_forecasts WHERE boq_item_id=?', [item.id]);
  await query(`INSERT INTO project_cost_forecasts
    (project_id,boq_item_id,forecast_quantity,forecast_rate,forecast_amount,reason,updated_by)
    VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE forecast_quantity=VALUES(forecast_quantity),forecast_rate=VALUES(forecast_rate),
    forecast_amount=VALUES(forecast_amount),reason=VALUES(reason),updated_by=VALUES(updated_by)`,
  [req.body.projectId, item.id, req.body.forecastQuantity ?? null, req.body.forecastRate ?? null,
    req.body.forecastAmount, req.body.reason, req.user.id]);
  const after = await getOne('SELECT * FROM project_cost_forecasts WHERE boq_item_id=?', [item.id]);
  await audit(pool, req.user.id, 'FORECAST', 'boq_item', item.id, before, after, req.ip);
  res.json(after);
}));

/** The bill as a document — for issuing, filing with a tender, or signing off. */
router.get('/:id/document', auth, permit('qs.view', 'qs.boq'), wrap(async (req, res) => {
  const boq = await getOne(`${select} WHERE b.id=?`, [req.params.id]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });

  const [items, variations, context] = await Promise.all([
    query(`SELECT category,description,unit,quantity,rate,amount,method FROM boq_items
      WHERE boq_id=? ORDER BY id`, [boq.id]),
    query(`SELECT reference,description,amount,status FROM variation_orders
      WHERE boq_id=? ORDER BY id`, [boq.id]),
    documentContext(getOne, boq.companyId)
  ]);

  await sendDocument(req, res, boqDocument({ ...context, boq, items, variations }), `${boq.reference}.pdf`);
}));

router.get('/:id', auth, permit('qs.view','qs.boq'), wrap(async (req, res) => {
  const boq = await getOne(`${select} WHERE b.id=?`, [req.params.id]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  const [items, variations, actual] = await Promise.all([
    query('SELECT id,category,description,unit,quantity,rate,amount,method,notes,material_id materialId FROM boq_items WHERE boq_id=? ORDER BY id', [boq.id]),
    query(`SELECT v.id,v.reference,v.description,v.amount,v.status,u.name raisedBy FROM variation_orders v
      JOIN users u ON u.id=v.raised_by WHERE v.boq_id=? ORDER BY v.id DESC`, [boq.id]),
    query(`SELECT source,COALESCE(SUM(amount),0) total FROM expenses WHERE project_id=? GROUP BY source`, [boq.projectId])
  ]);
  /* Estimate against actual, by category — PID 2.5 "Final Cost Analysis". */
  const spentBySource = Object.fromEntries(actual.map(row => [row.source, Number(row.total)]));
  const comparison = CATEGORIES.map(category => {
    const estimated = items.filter(item => item.category === category).reduce((sum, item) => sum + Number(item.amount), 0);
    const sourceKey = { Subcontract: 'Subcontractor', Overhead: 'Overhead' }[category] || category;
    return { category, estimated, actual: spentBySource[sourceKey] || 0 };
  });
  res.json({ ...boq, items, variations, comparison });
}));

router.post('/', auth, permit('qs.boq'), validate(z.object({
  projectId: z.number().int().positive(),
  title: z.string().min(3).max(180),
  notes: z.string().max(1000).optional(),
  items: z.array(itemSchema).min(1)
})), checkItemCategories, wrap(async (req, res) => {
  const body = req.body;
  const priced=[];
  for(const item of body.items){
    if(item.subcontractRateId){
      if(item.category!=='Subcontract')return res.status(400).json({error:'A subcontract rate can only price a subcontract BOQ line'});
      const rate=await getOne('SELECT * FROM subcontractor_project_rates WHERE id=? AND project_id=?',
        [item.subcontractRateId,body.projectId]);
      if(!rate)return res.status(400).json({error:'That agreed subcontract rate does not belong to this project'});
      priced.push({...item,rate:Number(rate.rate),unit:rate.unit});
    }else priced.push(item);
  }
  const reference = await nextReference('BOQ', 'boqs');
  const total = priced.reduce((sum, item) => sum + item.quantity * item.rate, 0);
  const id = await transaction(async connection => {
    const [result] = await connection.execute('INSERT INTO boqs (project_id,reference,title,total,prepared_by,notes) VALUES (?,?,?,?,?,?)',
      [body.projectId, reference, body.title, total, req.user.id, body.notes || null]);
    for (const item of priced) {
      await connection.execute('INSERT INTO boq_items (boq_id,category,description,unit,quantity,rate,amount,material_id,subcontract_rate_id) VALUES (?,?,?,?,?,?,?,?,?)',
        [result.insertId, item.category, item.description, item.unit, item.quantity, item.rate, item.quantity * item.rate, item.materialId || null,item.subcontractRateId||null]);
    }
    await audit(connection, req.user.id, 'CREATE', 'boq', result.insertId, null, { reference, total }, req.ip);
    return result.insertId;
  });
  res.status(201).json(await getOne(`${select} WHERE b.id=?`, [id]));
}));

router.post('/:id/items', auth, permit('qs.boq'), validate(itemSchema),
  fromOptions({ category: 'boq.category' }), wrap(async (req, res) => {
  const boq = await getOne('SELECT * FROM boqs WHERE id=?', [req.params.id]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  if (boq.status === 'Approved') return res.status(409).json({ error: 'An approved BOQ cannot be edited — raise a variation order instead' });
  const item = req.body;
  await query('INSERT INTO boq_items (boq_id,category,description,unit,quantity,rate,amount,material_id) VALUES (?,?,?,?,?,?,?,?)',
    [boq.id, item.category, item.description, item.unit, item.quantity, item.rate, item.quantity * item.rate, item.materialId || null]);
  await query('UPDATE boqs SET total=(SELECT COALESCE(SUM(amount),0) FROM boq_items WHERE boq_id=?) WHERE id=?', [boq.id, boq.id]);
  res.status(201).json(await getOne(`${select} WHERE b.id=?`, [boq.id]));
}));

/**
 * Approving a BOQ writes its total onto the project budget, so estimates and actual
 * costs are afterwards tracked in the same place instead of a separate spreadsheet.
 */
/**
 * The wording on the printed bill — its title, notes and any terms particular to this job.
 *
 * Separate from the status route because approving a BOQ and correcting a heading are
 * different acts by different people: preparing is the QS's, approving is not. Once
 * approved the wording is fixed, since the document has become the agreed record.
 */
router.patch('/:id/wording', auth, permit('qs.boq'), validate(z.object({
  title: z.string().min(3).max(180).optional(),
  notes: z.string().max(1000).nullable().optional(),
  terms: z.string().max(2000).nullable().optional()
}).refine(value => Object.keys(value).length > 0, { message: 'Nothing to change' })),
wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM boqs WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'BOQ not found' });
  if (before.status === 'Approved') {
    return res.status(409).json({ error: 'An approved BOQ cannot be reworded. Raise a revision instead.' });
  }

  const columns = { title: 'title', notes: 'notes', terms: 'terms' };
  const edits = Object.entries(columns).filter(([key]) => req.body[key] !== undefined);
  await query(`UPDATE boqs SET ${edits.map(([, column]) => `${column}=?`).join(',')} WHERE id=?`,
    [...edits.map(([key]) => req.body[key]), before.id]);

  const after = await getOne(`${select} WHERE b.id=?`, [before.id]);
  await audit(pool, req.user.id, 'UPDATE', 'boq', before.id, before, after, req.ip);
  res.json(after);
}));

router.patch('/:id', auth, permit('qs.approve'), validate(z.object({
  status: z.enum(['Draft', 'Submitted', 'Approved', 'Rejected'])
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM boqs WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'BOQ not found' });
  await transaction(async connection => {
    const approved = req.body.status === 'Approved';
    await connection.execute('UPDATE boqs SET status=?,approved_by=?,approved_at=? WHERE id=?',
      [req.body.status, approved ? req.user.id : null, approved ? new Date() : null, before.id]);
    await recalculateBudget(connection, before.project_id);
    await audit(connection, req.user.id, req.body.status.toUpperCase(), 'boq', before.id, before, { status: req.body.status }, req.ip);
  });
  if (req.body.status === 'Approved') {
    await notify({
      audience: 'qs.view',
      severity: 'Info',
      title: `BOQ ${before.reference} approved`,
      message: 'The approved BOQ total is now the project budget. Actual costs are tracked against it from here.',
      referenceType: 'boq',
      referenceId: before.id
    });
  }
  res.json(await getOne(`${select} WHERE b.id=?`, [before.id]));
}));

/* Variation orders */
router.get('/variations/all', auth, permit('qs.view','qs.boq'), wrap(async (_req, res) => res.json(await query(`SELECT v.id,v.reference,v.description,v.amount,v.status,
  v.created_at createdAt,p.name project,u.name raisedBy FROM variation_orders v JOIN projects p ON p.id=v.project_id
  JOIN users u ON u.id=v.raised_by ORDER BY v.id DESC`))));

router.post('/:id/variations', auth, permit('qs.boq'), validate(z.object({
  description: z.string().min(3).max(600),
  amount: z.number()
})), wrap(async (req, res) => {
  const boq = await getOne('SELECT * FROM boqs WHERE id=?', [req.params.id]);
  if (!boq) return res.status(404).json({ error: 'BOQ not found' });
  const reference = await nextReference('VO', 'variation_orders');
  const result = await query('INSERT INTO variation_orders (project_id,boq_id,reference,description,amount,raised_by) VALUES (?,?,?,?,?,?)',
    [boq.project_id, boq.id, reference, req.body.description, req.body.amount, req.user.id]);
  const row = await getOne('SELECT * FROM variation_orders WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'variation_order', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.patch('/variations/:id', auth, permit('qs.approve'), validate(z.object({
  status: z.enum(['Pending', 'Approved', 'Rejected'])
})), wrap(async (req, res) => {
  const before = await getOne('SELECT * FROM variation_orders WHERE id=?', [req.params.id]);
  if (!before) return res.status(404).json({ error: 'Variation order not found' });
  await transaction(async connection => {
    await connection.execute('UPDATE variation_orders SET status=?,approved_by=? WHERE id=?', [req.body.status, req.user.id, before.id]);
    /* An approved variation moves the approved budget, keeping budget-vs-actual honest. */
    await recalculateBudget(connection, before.project_id);
    await audit(connection, req.user.id, req.body.status.toUpperCase(), 'variation_order', before.id, before, { status: req.body.status }, req.ip);
  });
  res.json(await getOne('SELECT * FROM variation_orders WHERE id=?', [before.id]));
}));

export default router;
