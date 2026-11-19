import { assertUniqueManualEntry } from './ledger-duplicates.js';
import { z } from 'zod';
import { calculateQuotation, CALCULATION_MODES } from './quotation-calculations.js';

export const commercialKinds = new Set(['quotations', 'costs', 'retentions']);
const clean = value => String(value ?? '').trim();
const optionalText = limit => z.string().max(limit).optional();
const amount = z.number().min(0).max(9999999999999.99).multipleOf(0.01);
const percent = z.number().min(0).max(100).multipleOf(0.01);
const day = z.string().date();

export function resolveImportCompany(value, companies) {
  const normalize = text => clean(text).toLowerCase().replace(/\(pvt\)\s*ltd\.?$/i, '').replace(/[^a-z0-9]/g, '');
  const key = normalize(value);
  return companies.find(company => [company.name, company.code, company.code === 'GKUC' ? 'GKUC Construction' :
    company.code === 'GKRM' ? 'GKUC Readymix' : ''].some(alias => key && normalize(alias) === key));
}

const schemas = {
  costs: z.object({
    description: z.string().min(2).max(400), source: z.string().min(1).max(60),
    costType: z.enum(['Expected','Variation','Unexpected']), amount: amount.positive(),
    date: day, reference: z.string().min(1).max(120), payee: optionalText(180),
    method: z.enum(['Bank transfer','Card','Cash','Cheque']).optional(), paidDate: day.optional()
  }).refine(row => (!row.method || row.payee) && (!row.paidDate || row.method),
    'Payment method requires a payee, and paid date requires a payment method.'),
  retentions: z.object({
    description: z.string().min(3).max(300), amount: amount.positive(), percent,
    heldFrom: day, releaseDate: day, defectsEnd: day.optional(), released: amount,
    status: z.enum(['Held','Partially released','Released','Written off']), notes: optionalText(600)
  }).refine(row => row.releaseDate >= row.heldFrom && (!row.defectsEnd || row.defectsEnd >= row.heldFrom),
    'Release and defects dates must be on or after the held date.')
    .refine(row => row.released <= row.amount && ({
      Held: row.released === 0, 'Partially released': row.released > 0 && row.released < row.amount,
      Released: row.released === row.amount, 'Written off': row.released < row.amount
    })[row.status], 'Released amount does not match the retention status.'),
  quotations: z.object({
    reference: z.string().min(1).max(60), title: z.string().min(3).max(200),
    date: day, validUntil: day.optional(), subtotal: amount, total: amount, markupPercent: percent, vatPercent: percent,
    calculationMode: z.enum(CALCULATION_MODES), status: z.enum(['Draft','Sent','Accepted','Declined','Expired']),
    engagement: z.enum(['Direct','As subcontractor']), mainContractor: optionalText(180),
    notes: optionalText(1000), terms: optionalText(2000), paymentTerms: optionalText(2000),
    additionalNotes: optionalText(2000), preparedBy: optionalText(180), designation: optionalText(180)
  }).refine(row => !row.validUntil || row.validUntil >= row.date, 'Valid until must be on or after the quotation date.')
};
const lineSchema = z.object({
  category: z.string().min(1).max(40), description: z.string().min(1).max(300), unit: z.string().min(1).max(30),
  quantity: z.number().positive().max(99999999999.999).multipleOf(0.001),
  rate: z.number().min(0).max(999999999999.99).multipleOf(0.01), amount, method: optionalText(10000)
});
const numeric = value => /^[+-]?\d+(?:\.\d+)?$/.test(clean(value)) ? Number(value) : NaN;

export async function inspectCommercial(kind, record, { run, link, companies, sources, asDate }) {
  const d = record.data;
  const text = key => clean(d[key]) || undefined;
  const number = (key, fallback = NaN) => text(key) === undefined ? fallback : numeric(d[key]);
  const date = key => text(key) === undefined ? undefined : asDate(d[key]);
  const errors = [];
  const one = async (sql, params) => (await run(sql, params))[0];
  const projectId = link('projects', text('PROJECT_CODE'))?.targetId;
  const project = projectId && await one('SELECT id,company_id,client_id FROM projects WHERE id=? AND active=1', [projectId]);
  if ((kind !== 'quotations' || text('PROJECT_CODE')) && !project) errors.push('Link this row to an active project using its project code.');
  const company = text('COMPANY') && resolveImportCompany(d.COMPANY, companies);
  if ((text('COMPANY') || kind === 'quotations') && !company) errors.push('Choose an active operating company.');
  if (company && project && Number(company.id) !== Number(project.company_id)) errors.push('The project belongs to another operating company.');
  let values;
  if (kind === 'costs') {
    values = { description:text('DESCRIPTION'), source:text('SOURCE'), costType:text('COST_TYPE'),
      amount:number('AMOUNT_LKR'), date:date('EXPENSE_DATE'), reference:text('REFERENCE'),
      payee:text('PAYEE'), method:text('PAYMENT_METHOD'), paidDate:date('PAID_DATE') };
    if (!sources.includes(values.source)) errors.push('Choose an expense source from the active SiteOps list.');
    if (project && values.date && values.reference && Number.isFinite(values.amount) && await one(
      'SELECT id FROM expenses WHERE project_id=? AND reference=? AND amount=? LIMIT 1',
      [project.id,values.reference,values.amount])) errors.push('A matching expense already exists.');
  } else if (kind === 'retentions') {
    values = { description:text('DESCRIPTION'), amount:number('AMOUNT_LKR'), percent:number('PERCENT',0),
      heldFrom:date('HELD_FROM'), releaseDate:date('RELEASE_DATE'), defectsEnd:date('DEFECT_LIABILITY_ENDS'),
      released:number('RELEASED_AMOUNT_LKR',0), status:text('STATUS'), notes:text('REMARK') || text('NOTES') };
    if (project && values.heldFrom && Number.isFinite(values.amount) && await one(
      'SELECT id FROM retentions WHERE project_id=? AND held_from=? AND amount=? AND description=? LIMIT 1',
      [project.id,values.heldFrom,values.amount,values.description || ''])) errors.push('A matching retention already exists.');
  } else {
    values = { reference:text('ORIGINAL_REFERENCE'), title:text('TITLE'), date:date('QUOTE_DATE'), validUntil:date('VALID_UNTIL'),
      subtotal:number('SUBTOTAL_LKR'), total:number('TOTAL_LKR'), markupPercent:number('MARKUP_PERCENT',0), vatPercent:number('VAT_PERCENT',0),
      calculationMode:text('CALCULATION_MODE') || 'Combined Total', status:text('STATUS'), engagement:text('ENGAGEMENT'),
      mainContractor:text('MAIN_CONTRACTOR'), notes:text('NOTES'), terms:text('TERMS'), paymentTerms:text('PAYMENT_TERMS'),
      additionalNotes:text('ADDITIONAL_NOTES'), preparedBy:text('PREPARED_BY'), designation:text('PREPARED_BY_DESIGNATION') };
    if (values.reference && await one('SELECT id FROM quotations_client WHERE reference=?', [values.reference]))
      errors.push('This quotation reference already exists.');
  }
  const checked = schemas[kind].safeParse(values);
  if (!checked.success) errors.push(...checked.error.issues.map(issue => [issue.path.join(' '), issue.message].filter(Boolean).join(': ')));
  const data = { ...values, projectId:project?.id, companyId:company?.id };
  if (kind === 'quotations') {
    const clientId = link('clients', text('CLIENT_CODE'))?.targetId;
    const client = clientId && await one('SELECT id,name FROM clients WHERE id=? AND active=1', [clientId]);
    if (!client) errors.push('Link this quotation to an active client using its client code.');
    if (project && client && Number(project.client_id) !== Number(client.id)) errors.push('The client does not match the selected project.');
    const boqId = link('boqs', text('BOQ_CODE'))?.targetId;
    if (text('BOQ_CODE')) {
      const boq = boqId && await one('SELECT project_id FROM boqs WHERE id=?', [boqId]);
      if (!project || !boq || Number(boq.project_id) !== Number(project.id)) errors.push('The BOQ must belong to the selected project.');
    }
    const items = [];
    const seen = new Set();
    for (const line of record.items || []) {
      const source = line.data;
      const lineNo = clean(source.LINE_NO);
      if (!lineNo || seen.has(lineNo)) errors.push(`Quotation Items row ${line.row} needs a unique line number.`);
      seen.add(lineNo);
      const parsed = lineSchema.safeParse({ category:clean(source.CATEGORY), description:clean(source.DESCRIPTION),
        unit:clean(source.UNIT), quantity:numeric(source.QUANTITY), rate:numeric(source.RATE_LKR),
        amount:numeric(source.AMOUNT_LKR), method:clean(source.METHOD_STATEMENT) || undefined });
      if (parsed.success) items.push(parsed.data);
      else errors.push(`Quotation Items row ${line.row} has an invalid category, description, unit or numeric value.`);
    }
    if (!items.length) errors.push('Add at least one priced quotation item.');
    if (checked.success && items.length && !errors.length) {
      const priced = calculateQuotation(items, checked.data);
      if (priced.lines.some((line,index) => line.amount !== items[index].amount) ||
          priced.subtotal !== values.subtotal || priced.total !== values.total)
        errors.push('Line amounts, subtotal and total must match the SiteOps quotation calculation.');
    }
    Object.assign(data, { client, boqId, items });
  }
  return { errors, data };
}

export async function saveCommercial(kind, connection, run, data, user) {
  const d = data;
  if (kind === 'costs') {
    await assertUniqueManualEntry(connection, 'expenses', d);
    return (await run(`INSERT INTO expenses
    (project_id,source,cost_type,description,amount,expense_date,reference,payee,payment_method,paid_date,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [d.projectId,d.source,d.costType,d.description,d.amount,d.date,d.reference,
    d.payee || null,d.method || null,d.method ? d.paidDate || d.date : null,user.id])).insertId;
  }
  if (kind === 'retentions') return (await run(`INSERT INTO retentions
    (project_id,description,amount,percent,held_from,release_date,defect_liability_ends,released_amount,status,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [d.projectId,d.description,d.amount,d.percent,d.heldFrom,d.releaseDate,d.defectsEnd || null,
    d.released,d.status,d.notes || null,user.id])).insertId;
  const { insertId } = await run(`INSERT INTO quotations_client
    (company_id,reference,project_id,boq_id,client_id,client_name,title,quote_date,valid_until,subtotal,markup_percent,vat_percent,total,
     status,engagement,main_contractor,notes,terms,payment_terms,additional_notes,calculation_mode,prepared_by,prepared_by_name,prepared_by_designation)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [d.companyId,d.reference,d.projectId || null,d.boqId || null,
    d.client.id,d.client.name,d.title,d.date,d.validUntil || null,d.subtotal,d.markupPercent,d.vatPercent,d.total,d.status,d.engagement,
    d.mainContractor || null,d.notes || null,d.terms || null,d.paymentTerms || null,d.additionalNotes || null,d.calculationMode,
    user.id,d.preparedBy || user.name,d.designation || user.role || null]);
  for (const line of d.items) await run(`INSERT INTO quotation_items
    (quotation_id,category,description,unit,quantity,rate,amount,method_statement) VALUES (?,?,?,?,?,?,?,?)`,
  [insertId,line.category,line.description,line.unit,line.quantity,line.rate,line.amount,line.method || null]);
  return insertId;
}
