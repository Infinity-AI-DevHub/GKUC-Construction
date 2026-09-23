import { Router } from 'express';
import { z } from 'zod';
import { pool, query, getOne, audit, transaction, nextReference } from '../db.js';
import { auth, permit, validate, fail } from '../lib/http.js';
import { certificate } from '../lib/invoice-maths.js';
import { publishChange } from '../lib/realtime.js';
import { notify } from '../alerts.js';
import { sendDailySummary } from '../lib/daily-summary.js';
import { documentContext, invoiceDocument, receiptDocument } from '../lib/documents.js';
import { sendDocument } from '../lib/document-pdf.js';

const router = Router();

const money = value => `LKR ${Number(value || 0).toLocaleString('en-LK', { maximumFractionDigits: 0 })}`;
const companyParam = req => {
  const value = Number(req.query.companyId);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const billingPlanSchema = z.object({
  quotationId: z.coerce.number().int().positive(),
  documentType: z.enum(['Tax Invoice', 'Invoice']),
  taxTreatment: z.enum(['Standard', 'SVAT', 'Exempt']),
  vatRate: z.coerce.number().min(0).max(100).default(18),
  terms: z.array(z.object({
    label: z.string().trim().min(2).max(160),
    percentage: z.coerce.number().positive().max(100),
    dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional()
  })).min(1).max(20)
});

router.get('/receivables/accepted-quotations', auth, permit('finance.view', 'finance.invoice'), async (req, res, next) => {
  try {
    const companyId = companyParam(req);
    res.json(await query(`SELECT q.id,q.reference,q.title,q.project_id projectId,p.name project,
      q.client_id clientId,q.client_name client,q.company_id companyId,q.subtotal,q.markup_percent markupPercent,
      q.vat_percent vatPercent,q.total,b.id billingPlanId
      FROM quotations_client q LEFT JOIN projects p ON p.id=q.project_id
      LEFT JOIN quotation_billing_plans b ON b.quotation_id=q.id
      WHERE q.status='Accepted' ${companyId ? 'AND q.company_id=?' : ''} ORDER BY q.id DESC`, companyId ? [companyId] : []));
  } catch (error) { next(error); }
});

router.get('/receivables/quotation-plans', auth, permit('finance.view', 'finance.invoice'), async (req, res, next) => {
  try {
    const companyId = companyParam(req);
    const plans = await query(`SELECT b.id,b.quotation_id quotationId,q.reference quotationReference,q.title,
      q.client_name client,q.total quotationTotal,b.company_id companyId,b.project_id projectId,
      b.document_type documentType,b.tax_treatment taxTreatment,b.vat_rate vatRate
      FROM quotation_billing_plans b JOIN quotations_client q ON q.id=b.quotation_id
      WHERE 1=1 ${companyId ? 'AND b.company_id=?' : ''} ORDER BY b.id DESC`, companyId ? [companyId] : []);
    if (!plans.length) return res.json([]);
    const terms = await query(`SELECT t.id,t.plan_id planId,t.sequence_no sequenceNo,t.label,t.percentage,t.amount,
      t.due_date dueDate,t.invoice_id invoiceId,i.reference invoiceReference,i.status invoiceStatus,
      i.paid_amount paidAmount,i.net_payable netPayable
      FROM quotation_billing_terms t LEFT JOIN client_invoices i ON i.id=t.invoice_id
      WHERE t.plan_id IN (${plans.map(() => '?').join(',')}) ORDER BY t.plan_id,t.sequence_no`, plans.map(plan => plan.id));
    res.json(plans.map(plan => ({ ...plan, terms: terms.filter(term => Number(term.planId) === Number(plan.id)) })));
  } catch (error) { next(error); }
});

router.post('/receivables/quotation-plans', auth, permit('finance.invoice'), validate(billingPlanSchema), async (req, res, next) => {
  try {
    const { quotationId, documentType, taxTreatment, vatRate, terms } = req.body;
    if ((documentType === 'Invoice') !== (taxTreatment === 'Exempt'))
      throw fail(400, 'Choose Exempt for a normal invoice, or Standard/SVAT for a tax invoice.');
    const basisPoints = terms.map(term => Math.round(term.percentage * 10000));
    if (basisPoints.reduce((sum, points) => sum + points, 0) !== 1000000)
      throw fail(400, 'The invoice terms must add up to exactly 100%.');
    const quotation = await getOne(`SELECT id,reference,status,project_id projectId,client_id clientId,company_id companyId,
      subtotal,markup_percent markupPercent,total FROM quotations_client WHERE id=?`, [quotationId]);
    if (!quotation || quotation.status !== 'Accepted') throw fail(409, 'Choose a quotation that QS has marked Accepted.');
    if (!quotation.clientId) throw fail(400, 'Link the accepted quotation to a saved client before making an invoice plan.');
    if (await getOne('SELECT id FROM quotation_billing_plans WHERE quotation_id=?', [quotationId]))
      throw fail(409, 'This quotation already has a billing plan. Open that plan instead.');
    const agreedTotal = taxTreatment === 'SVAT'
      ? Math.round(Number(quotation.subtotal) * (1 + Number(quotation.markupPercent) / 100) * 100) / 100
      : Number(quotation.total);
    let allocated = 0;
    const id = await transaction(async connection => {
      const [created] = await connection.execute(`INSERT INTO quotation_billing_plans
        (quotation_id,company_id,project_id,client_id,document_type,tax_treatment,vat_rate,created_by)
        VALUES (?,?,?,?,?,?,?,?)`, [quotation.id, quotation.companyId, quotation.projectId,
        quotation.clientId, documentType, taxTreatment, documentType === 'Invoice' ? 0 : vatRate, req.user.id]);
      for (const [index, term] of terms.entries()) {
        const amount = index === terms.length - 1 ? Math.round((agreedTotal - allocated) * 100) / 100
          : Math.round(agreedTotal * term.percentage) / 100;
        allocated += amount;
        await connection.execute(`INSERT INTO quotation_billing_terms
          (plan_id,sequence_no,label,percentage,amount,due_date) VALUES (?,?,?,?,?,?)`,
        [created.insertId, index + 1, term.label, term.percentage, amount, term.dueDate || null]);
      }
      return created.insertId;
    });
    await audit(pool, req.user.id, 'CREATE', 'quotation_billing_plan', id, null, { quotationId, terms }, req.ip);
    publishChange('receivables', {});
    res.status(201).json({ id, quotationId });
  } catch (error) { next(error); }
});

/* ---- what the client owes ------------------------------------------------ */

router.get('/receivables/invoices', auth, permit('finance.view', 'finance.invoice'),
  async (req, res, next) => {
    try {
      const companyId = companyParam(req);
      res.json(await query(`
        SELECT i.id,i.reference,i.project_id projectId,COALESCE(p.name,'No project') project,
               i.company_id companyId,i.client,i.kind,i.document_type documentType,i.title,
               i.invoice_date invoiceDate,i.due_date dueDate,i.gross,i.tax_treatment taxTreatment,
               i.vat_rate vatRate,i.vat_amount vatAmount,i.svat_voucher svatVoucher,
               i.retention_percent retentionPercent,i.retention_amount retentionAmount,
               i.advance_recovery advanceRecovery,i.other_deductions otherDeductions,
               i.net_payable netPayable,i.paid_amount paidAmount,
               (i.net_payable - i.paid_amount) outstanding,
               i.status,i.created_at createdAt,u.name createdBy,
               DATEDIFF(CURDATE(), i.due_date) daysOverdue
          FROM client_invoices i
          LEFT JOIN projects p ON p.id=i.project_id
          JOIN users u ON u.id=i.created_by
         ${companyId ? 'WHERE i.company_id=?' : ''}
         ORDER BY i.id DESC LIMIT 300`, companyId ? [companyId] : []));
    } catch (error) { next(error); }
  });

/** The ageing view: who owes what, and for how long. */
router.get('/receivables/ageing', auth, permit('finance.view', 'finance.invoice'),
  async (req, res, next) => {
    try {
      const companyId = companyParam(req);
      const rows = await query(`
        SELECT i.client, COALESCE(p.name,'No project') project,
               SUM(i.net_payable - i.paid_amount) outstanding,
               SUM(CASE WHEN DATEDIFF(CURDATE(), i.due_date) <= 0
                        THEN i.net_payable - i.paid_amount ELSE 0 END) current,
               SUM(CASE WHEN DATEDIFF(CURDATE(), i.due_date) BETWEEN 1 AND 30
                        THEN i.net_payable - i.paid_amount ELSE 0 END) upTo30,
               SUM(CASE WHEN DATEDIFF(CURDATE(), i.due_date) BETWEEN 31 AND 60
                        THEN i.net_payable - i.paid_amount ELSE 0 END) upTo60,
               SUM(CASE WHEN DATEDIFF(CURDATE(), i.due_date) > 60
                        THEN i.net_payable - i.paid_amount ELSE 0 END) over60,
               COUNT(*) invoices
          FROM client_invoices i LEFT JOIN projects p ON p.id=i.project_id
         WHERE i.status IN ('Issued','Part paid') AND i.net_payable > i.paid_amount
           ${companyId ? 'AND i.company_id=?' : ''}
         GROUP BY i.client, COALESCE(p.name,'No project')
         ORDER BY outstanding DESC`, companyId ? [companyId] : []);
      const [totals] = await query(`
        SELECT COALESCE(SUM(i.net_payable - i.paid_amount),0) outstanding,
               COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), i.due_date) > 0
                                 THEN i.net_payable - i.paid_amount ELSE 0 END),0) overdue,
               COALESCE(SUM(i.retention_amount),0) retentionHeld
          FROM client_invoices i
         WHERE i.status IN ('Issued','Part paid') ${companyId ? 'AND i.company_id=?' : ''}`,
        companyId ? [companyId] : []);
      res.json({ rows, totals });
    } catch (error) { next(error); }
  });

const invoiceSchema = z.object({
  companyId: z.coerce.number().int().positive().optional(),
  projectId: z.coerce.number().int().positive().nullable().optional(),
  clientId: z.coerce.number().int().positive().optional(),
  documentType: z.enum(['Tax Invoice','Invoice']).optional(),
  kind: z.enum(['Interim', 'Final', 'Advance', 'Variation', 'Other']).default('Interim'),
  title: z.string().trim().min(3).max(200),
  invoiceDate: z.string().min(10).max(10),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  placeOfSupply: z.string().trim().max(300).optional(),
  paymentMode: z.enum(['Cheque', 'Cash', 'Bank transfer', 'Card', 'Other']).optional(),
  dueDate: z.string().min(10).max(10).optional(),
  periodFrom: z.string().min(10).max(10).optional(),
  periodTo: z.string().min(10).max(10).optional(),
  taxTreatment: z.enum(['Standard', 'SVAT', 'Exempt']).default('Standard'),
  vatRate: z.coerce.number().min(0).max(100).optional(),
  svatVoucher: z.string().trim().max(60).optional(),
  retentionPercent: z.coerce.number().min(0).max(50).default(0),
  advanceRecovery: z.coerce.number().min(0).default(0),
  otherDeductions: z.coerce.number().min(0).default(0),
  deductionNote: z.string().trim().max(300).optional(),
  notes: z.string().trim().max(1000).optional(),
  billingTermId: z.coerce.number().int().positive().optional(),
  items: z.array(z.object({
    description: z.string().trim().min(1).max(300),
    unit: z.string().trim().max(30).optional(),
    quantity: z.coerce.number().min(0).default(0),
    rate: z.coerce.number().min(0).default(0),
    quotationItemId:z.coerce.number().int().positive().optional(),
    boqItemId:z.coerce.number().int().positive().optional()
  })).min(1, 'An invoice needs at least one line')
});

router.get('/receivables/quote-lines',auth,permit('finance.view','finance.invoice'),async(req,res,next)=>{try{
  const projectId=Number(req.query.projectId);
  if(!Number.isInteger(projectId)||projectId<1)throw fail(400,'Choose a project');
  res.json(await query(`SELECT qi.id,qi.quotation_id quotationId,q.reference,q.status,qi.category,qi.description,qi.unit,
    qi.quantity,ROUND(qi.rate*(1+q.markup_percent/100),2) rate,qi.source_subquote_id sourceSubquoteId
    FROM quotation_items qi JOIN quotations_client q ON q.id=qi.quotation_id
    WHERE q.project_id=? AND q.status='Accepted' ORDER BY q.id DESC,qi.id`,[projectId]));
}catch(error){next(error);}});

router.get('/receivables/boq-lines',auth,permit('finance.view','finance.invoice'),async(req,res,next)=>{try{
  const projectId=Number(req.query.projectId);
  if(!Number.isInteger(projectId)||projectId<1)throw fail(400,'Choose a project to see its approved BOQ items');
  res.json(await query(`SELECT bi.id,b.reference,bi.category,bi.description,bi.unit,bi.quantity,bi.rate,
    GREATEST(0,bi.quantity-COALESCE((SELECT SUM(ii.quantity) FROM client_invoice_items ii
      JOIN client_invoices ci ON ci.id=ii.invoice_id
      WHERE ii.boq_item_id=bi.id AND ci.status<>'Cancelled'),0)) remainingQuantity
    FROM boq_items bi JOIN boqs b ON b.id=bi.boq_id
    WHERE b.project_id=? AND b.status='Approved' ORDER BY b.id DESC,bi.id`,[projectId]));
}catch(error){next(error);}});

/**
 * Raises a certificate.
 *
 * The totals are worked out here rather than accepted from the request. A client invoice is
 * the figure the company stands behind; taking the arithmetic from the browser would mean
 * standing behind whatever it sent.
 */
const createInvoice = async (req, res, next) => {
    try {
      let billingTerm = null;
      if (req.body.billingTermId) {
        billingTerm = await getOne(`SELECT t.id,t.label,t.amount,t.due_date dueDate,t.invoice_id invoiceId,
          b.quotation_id quotationId,b.company_id companyId,b.project_id projectId,b.client_id clientId,
          b.document_type documentType,b.tax_treatment taxTreatment,b.vat_rate vatRate,
          q.reference quotationReference,q.status quotationStatus
          FROM quotation_billing_terms t JOIN quotation_billing_plans b ON b.id=t.plan_id
          JOIN quotations_client q ON q.id=b.quotation_id WHERE t.id=?`, [req.body.billingTermId]);
        if (!billingTerm) throw fail(404, 'That quotation billing term was not found.');
        if (billingTerm.quotationStatus !== 'Accepted') throw fail(409, 'The quotation is no longer accepted. Ask QS to review it.');
        if (billingTerm.invoiceId) throw fail(409, 'This billing term already has an invoice. Open that invoice instead.');
        const amount = Number(billingTerm.amount);
        const rate = Number(billingTerm.vatRate);
        const base = billingTerm.taxTreatment === 'Standard'
          ? Math.round(amount / (1 + rate / 100) * 100) / 100 : amount;
        req.body = { ...req.body, companyId: Number(billingTerm.companyId),
          projectId: billingTerm.projectId ? Number(billingTerm.projectId) : null,
          clientId: Number(billingTerm.clientId), documentType: billingTerm.documentType,
          taxTreatment: billingTerm.taxTreatment, vatRate: rate,
          kind: 'Interim', title: `${billingTerm.label} — ${billingTerm.quotationReference}`,
          dueDate: billingTerm.dueDate ? new Date(billingTerm.dueDate).toISOString().slice(0, 10) : req.body.dueDate,
          retentionPercent: 0, advanceRecovery: 0, otherDeductions: 0,
          items: [{ description: `${billingTerm.label} — accepted quotation ${billingTerm.quotationReference}`,
            unit: 'term', quantity: 1, rate: base }] };
      }
      const project = req.body.projectId ? await getOne(`SELECT p.id,p.name,p.site,COALESCE(c.name,p.client) client,
        p.client_id clientId,p.company_id companyId FROM projects p LEFT JOIN clients c ON c.id=p.client_id
        WHERE p.id=? AND p.active=1`, [req.body.projectId]) : null;
      if (req.body.projectId && !project) throw fail(404, 'That project does not exist');
      if (!project && !req.body.clientId) throw fail(400, 'Choose a saved client for an invoice without a project');
      if (project?.clientId && req.body.clientId && Number(req.body.clientId) !== Number(project.clientId))
        throw fail(400, 'The selected client does not match the project client. Choose a project for that client.');
      const clientId = req.body.clientId || project?.clientId || null;
      const client = clientId ? await getOne(`SELECT id,name,COALESCE(NULLIF(tin,''),tax_number) buyerTin,
        vat_number buyerVatNumber,billing_address buyerAddress,phone buyerPhone,site_address clientSite
        FROM clients WHERE id=? AND active=1`, [clientId]) : null;
      if (clientId && !client) throw fail(400, 'That client is not in the active client directory');
      const companyId = Number(project?.companyId || req.body.companyId);
      if (!Number.isInteger(companyId) || companyId < 1) throw fail(400, 'Choose GKUC Construction or GKUC Readymix');
      if (req.body.companyId && Number(req.body.companyId) !== companyId)
        throw fail(400, 'The project belongs to the other operating company');
      const documentType = req.body.documentType || (req.body.taxTreatment === 'Exempt' ? 'Invoice' : 'Tax Invoice');
      if (documentType === 'Invoice' && req.body.taxTreatment !== 'Exempt')
        throw fail(400, 'A standard invoice must not charge VAT. Choose a tax invoice to charge or suspend VAT.');
      if (documentType === 'Tax Invoice' && req.body.taxTreatment === 'Exempt')
        throw fail(400, 'A tax invoice needs VAT treatment. Choose a standard invoice for no VAT.');
      const company = await getOne(`SELECT COALESCE(NULLIF(default_vat_rate,0),18) defaultVatRate
        FROM companies WHERE id=? AND active=1`, [companyId]);
      if (!company) throw fail(400, 'That operating company is not active');
      const vatRate = req.body.vatRate ?? Number(company?.defaultVatRate ?? 18);

      const priced=[];
      for(const item of req.body.items){
        if(item.quotationItemId && item.boqItemId) throw fail(400, 'Choose either a BOQ item or a quotation line for each invoice row');
        if(item.quotationItemId){
          if (!project) throw fail(400, 'Quotation lines require a project');
          const line=await getOne(`SELECT qi.id,qi.rate,q.markup_percent markupPercent
            FROM quotation_items qi JOIN quotations_client q ON q.id=qi.quotation_id
            WHERE qi.id=? AND q.project_id=? AND q.status='Accepted'`,[item.quotationItemId,project.id]);
          if(!line)throw fail(400,'That accepted quotation line does not belong to this project');
          priced.push({...item,rate:Math.round(Number(line.rate)*(1+Number(line.markupPercent)/100)*100)/100});
        }else if(item.boqItemId){
          if (!project) throw fail(400, 'BOQ lines require a project');
          const line = await getOne(`SELECT bi.id,bi.rate,bi.quantity FROM boq_items bi
            JOIN boqs b ON b.id=bi.boq_id WHERE bi.id=? AND b.project_id=? AND b.status='Approved'`,
          [item.boqItemId, project.id]);
          if (!line) throw fail(400, 'That BOQ item is not in an approved BOQ for this project');
          priced.push({...item,rate:Number(line.rate)});
        }else priced.push(item);
      }
      const gross = priced.reduce((sum, item) => sum + item.quantity * item.rate, 0);
      const sums = certificate({ ...req.body, gross, vatRate });
      if (sums.netPayable <= 0) throw fail(400, 'Invoice deductions cannot be equal to or greater than the amount payable');
      const reference = await nextReference('INV', 'client_invoices');

      const id = await transaction(async connection => {
        const requestedBoqQuantities = new Map();
        for (const item of priced) if (item.boqItemId)
          requestedBoqQuantities.set(item.boqItemId, (requestedBoqQuantities.get(item.boqItemId) || 0) + Number(item.quantity));
        for (const [boqItemId, requested] of requestedBoqQuantities) {
          const [[boqItem]] = await connection.execute('SELECT quantity FROM boq_items WHERE id=? FOR UPDATE', [boqItemId]);
          const [[billed]] = await connection.execute(`SELECT COALESCE(SUM(ii.quantity),0) quantity
            FROM client_invoice_items ii JOIN client_invoices ci ON ci.id=ii.invoice_id
            WHERE ii.boq_item_id=? AND ci.status<>'Cancelled'`, [boqItemId]);
          const remaining = Number(boqItem.quantity) - Number(billed.quantity);
          if (requested > remaining + 0.0001) throw fail(409,
            `The BOQ item has only ${remaining.toFixed(3)} unit(s) left to invoice. Reduce this quantity or add an approved variation.`);
        }
        const [created] = await connection.execute(
          `INSERT INTO client_invoices
             (reference,project_id,company_id,client_id,client,kind,document_type,title,invoice_date,delivery_date,place_of_supply,payment_mode,
              buyer_tin,buyer_vat_number,buyer_address,buyer_phone,due_date,period_from,period_to,
              gross,tax_treatment,vat_rate,vat_amount,svat_voucher,retention_percent,retention_amount,
              advance_recovery,other_deductions,deduction_note,net_payable,notes,created_by,quotation_id,billing_term_id)
           VALUES (${Array(34).fill('?').join(',')})`,
          [reference, project?.id || null, companyId, clientId, client?.name || project?.client,
            req.body.kind, documentType, req.body.title,
            req.body.invoiceDate, req.body.deliveryDate || null, req.body.placeOfSupply || client?.clientSite || project?.site || null,
            req.body.paymentMode || null, client?.buyerTin || null, client?.buyerVatNumber || null,
            client?.buyerAddress || null, client?.buyerPhone || null, req.body.dueDate || null,
            req.body.periodFrom || null, req.body.periodTo || null,
            sums.gross, req.body.taxTreatment, sums.vatRate, sums.vatAmount,
            req.body.svatVoucher || null, req.body.retentionPercent, sums.retentionAmount,
            sums.advanceRecovery, sums.otherDeductions, req.body.deductionNote || null,
            sums.netPayable, req.body.notes || null, req.user.id,
            billingTerm?.quotationId || null, billingTerm?.id || null]);

        for (const item of priced) {
          await connection.execute(
            `INSERT INTO client_invoice_items (invoice_id,description,unit,quantity,rate,amount,quotation_item_id,boq_item_id)
             VALUES (?,?,?,?,?,?,?,?)`,
            [created.insertId, item.description, item.unit || null, item.quantity, item.rate,
              Math.round(item.quantity * item.rate * 100) / 100,item.quotationItemId||null,item.boqItemId||null]);
        }
        if (billingTerm) await connection.execute('UPDATE quotation_billing_terms SET invoice_id=? WHERE id=? AND invoice_id IS NULL',
          [created.insertId, billingTerm.id]);
        return created.insertId;
      });

      await audit(pool, req.user.id, 'CREATE', 'client_invoice', id, null,
        { reference, gross: sums.gross, net: sums.netPayable, treatment: req.body.taxTreatment }, req.ip);
      publishChange('receivables', {});
      res.status(201).json({ id, reference, billingTermId: billingTerm?.id || null, ...sums });
    } catch (error) { next(error); }
};

router.post('/receivables/invoices', auth, permit('finance.invoice'), validate(invoiceSchema), createInvoice);

router.post('/receivables/quotation-terms/:id/invoice', auth, permit('finance.invoice'),
  validate(z.object({ invoiceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    placeOfSupply: z.string().trim().max(300).optional(),
    paymentMode: z.enum(['Cheque','Cash','Bank transfer','Card','Other']).optional(),
    notes: z.string().trim().max(1000).optional() })),
  async (req, res, next) => {
    req.body.billingTermId = Number(req.params.id);
    await createInvoice(req, res, next);
  });

/** A preview of the working, so the figures can be checked before anything is raised. */
router.post('/receivables/preview', auth, permit('finance.invoice'),
  validate(invoiceSchema.partial({ items: true, title: true, invoiceDate: true, projectId: true })),
  async (req, res, next) => {
    try {
      let companyId = Number(req.body.companyId) || 1;
      if (req.body.projectId) {
        const project = await getOne('SELECT company_id FROM projects WHERE id=?', [req.body.projectId]);
        if (project) companyId = project.company_id;
      }
      const company = await getOne(`SELECT COALESCE(NULLIF(default_vat_rate,0),18) defaultVatRate
        FROM companies WHERE id=? AND active=1`, [companyId])
        .catch(() => null);
      const gross = (req.body.items || []).reduce((sum, item) => sum + item.quantity * item.rate, 0);
      res.json(certificate({
        ...req.body, gross,
        vatRate: req.body.vatRate ?? Number(company?.defaultVatRate ?? 18)
      }));
    } catch (error) { next(error); }
  });

router.get('/receivables/invoices/:id/document', auth, permit('finance.view', 'finance.invoice'),
  async (req, res, next) => {
    try {
      const invoice = await getOne(`SELECT i.reference,i.client,i.kind,i.document_type documentType,i.title,i.invoice_date invoiceDate,
        i.delivery_date deliveryDate,i.place_of_supply placeOfSupply,i.payment_mode paymentMode,
        i.buyer_tin buyerTin,i.buyer_vat_number buyerVatNumber,i.buyer_address buyerAddress,
        i.buyer_phone buyerPhone,i.due_date dueDate,i.gross,i.tax_treatment taxTreatment,
        i.vat_rate vatRate,i.vat_amount vatAmount,i.retention_amount retentionAmount,
        i.advance_recovery advanceRecovery,i.other_deductions otherDeductions,i.net_payable netPayable,
        i.notes,p.name project,i.company_id companyId FROM client_invoices i
        LEFT JOIN projects p ON p.id=i.project_id WHERE i.id=?`, [req.params.id]);
      if (!invoice) throw fail(404, 'That invoice was not found');
      const [items, context] = await Promise.all([
        query('SELECT description,unit,quantity,rate,amount FROM client_invoice_items WHERE invoice_id=? ORDER BY id', [req.params.id]),
        documentContext(getOne, invoice.companyId)
      ]);
      await sendDocument(req, res, invoiceDocument({ ...context, invoice, items }), `${invoice.reference}.pdf`);
    } catch (error) { next(error); }
  });

router.get('/receivables/invoices/:id', auth, permit('finance.view', 'finance.invoice'),
  async (req, res, next) => {
    try {
      const invoice = await getOne(`
        SELECT i.*, p.name project FROM client_invoices i
          LEFT JOIN projects p ON p.id=i.project_id WHERE i.id=?`, [req.params.id]);
      if (!invoice) throw fail(404, 'That invoice was not found');
      invoice.items = await query(
        'SELECT description,unit,quantity,rate,amount FROM client_invoice_items WHERE invoice_id=?',
        [req.params.id]);
      invoice.receipts = await query(`
        SELECT r.id,r.amount,r.received_date receivedDate,r.method,r.reference,u.name recordedBy
          FROM client_receipts r JOIN users u ON u.id=r.recorded_by
         WHERE r.invoice_id=? ORDER BY r.received_date,r.id`, [req.params.id]);
      res.json(invoice);
    } catch (error) { next(error); }
  });

router.get('/receivables/receipts/:id/document', auth, permit('finance.view', 'finance.invoice'),
  async (req, res, next) => {
    try {
      const receipt = await getOne(`SELECT r.id,r.amount,r.received_date receivedDate,r.method,r.reference,
        i.reference invoiceReference,i.title invoiceTitle,i.client,i.buyer_address buyerAddress,
        i.net_payable netPayable,i.paid_amount paidAmount,i.company_id companyId,p.name project
        FROM client_receipts r JOIN client_invoices i ON i.id=r.invoice_id
        LEFT JOIN projects p ON p.id=i.project_id WHERE r.id=?`, [req.params.id]);
      if (!receipt) throw fail(404, 'That payment receipt was not found.');
      const context = await documentContext(getOne, receipt.companyId);
      const name = `RCPT-${new Date(receipt.receivedDate).getFullYear()}-${String(receipt.id).padStart(5, '0')}.pdf`;
      await sendDocument(req, res, receiptDocument({ ...context, receipt }), name);
    } catch (error) { next(error); }
  });

async function announceProjectPayment(receipt) {
  if (!receipt.projectId) return;
  for (const audience of ['qs.view', 'projects.view']) await notify({
    key: `client-payment:${receipt.id}:${audience}`, audience, severity: 'Info',
    title: `Client payment received — ${receipt.invoiceReference}`,
    message: `${money(receipt.amount)} was recorded for ${receipt.project}. The receipt is ready in Finance.`,
    referenceType: 'project', referenceId: receipt.projectId
  });
}

router.post('/receivables/invoices/:id/issue', auth, permit('finance.invoice'),
  async (req, res, next) => {
    try {
      const invoice = await getOne('SELECT * FROM client_invoices WHERE id=?', [req.params.id]);
      if (!invoice) throw fail(404, 'That invoice was not found');
      if (invoice.status !== 'Draft') throw fail(409, 'That invoice has already been issued');
      await query("UPDATE client_invoices SET status='Issued', issued_at=NOW() WHERE id=?", [req.params.id]);
      await audit(pool, req.user.id, 'ISSUE', 'client_invoice', req.params.id,
        { status: 'Draft' }, { status: 'Issued' }, req.ip);
      publishChange('receivables', {});
      res.status(204).end();
    } catch (error) { next(error); }
  });

/** Money in against a certificate. */
router.post('/receivables/invoices/:id/receipts', auth, permit('finance.invoice'),
  validate(z.object({
    amount: z.coerce.number().positive(),
    receivedDate: z.string().min(10).max(10),
    method: z.enum(['Cash','Cheque','Bank transfer','Card']).default('Bank transfer'),
    reference: z.string().trim().max(120).optional()
  })),
  async (req, res, next) => {
    try {
      if(req.body.method==='Cheque')throw fail(400,'Record the cheque in Received cheques and clear it there; that posts the invoice receipt and income once.');
      const recorded = await transaction(async connection => {
        const [[invoice]]=await connection.execute('SELECT * FROM client_invoices WHERE id=? FOR UPDATE',[req.params.id]);
        if(!invoice)throw fail(404,'That invoice was not found');
        if(['Draft','Cancelled'].includes(invoice.status))throw fail(409,'Issue the invoice before recording money against it');
        const outstanding=Number(invoice.net_payable)-Number(invoice.paid_amount);
        if(req.body.amount>outstanding+0.001)throw fail(409,`That is more than is outstanding. ${money(outstanding)} remains on this invoice.`);
        if(req.body.reference){
          const [[existing]]=await connection.execute(`SELECT id FROM client_receipts
            WHERE invoice_id=? AND reference=? AND amount=? LIMIT 1`,[invoice.id,req.body.reference,req.body.amount]);
          if(existing)throw fail(409,'That payment reference and amount are already recorded against this invoice');
        }
        const [created] = await connection.execute(
          `INSERT INTO client_receipts (invoice_id,amount,received_date,method,reference,recorded_by)
           VALUES (?,?,?,?,?,?)`,
          [invoice.id, req.body.amount, req.body.receivedDate, req.body.method,
            req.body.reference || null, req.user.id]);
        const paid = Number(invoice.paid_amount) + req.body.amount;
        await connection.execute('UPDATE client_invoices SET paid_amount=?, status=? WHERE id=?',
          [paid, paid >= Number(invoice.net_payable) - 0.001 ? 'Paid' : 'Part paid', invoice.id]);
        /* Money received is income against the project, recorded once and in one place. */
        await connection.execute(
          `INSERT INTO incomes (project_id,company_id,description,amount,received_date,method,reference,created_by)
           VALUES (?,?,?,?,?,?,?,?)`,
          [invoice.project_id, invoice.company_id, `${invoice.reference} — ${invoice.title}`, req.body.amount,
            req.body.receivedDate, req.body.method, req.body.reference || invoice.reference, req.user.id]);
        return { id: created.insertId, projectId: invoice.project_id, invoiceReference: invoice.reference,
          amount: req.body.amount };
      });

      await audit(pool, req.user.id, 'RECEIPT', 'client_invoice', req.params.id, null,
        { amount: req.body.amount, reference: req.body.reference }, req.ip);
      publishChange('receivables', {});
      if (recorded.projectId) {
        const project = await getOne('SELECT name FROM projects WHERE id=?', [recorded.projectId]);
        await announceProjectPayment({ ...recorded, project: project?.name || 'the project' });
      }
      res.status(201).json({ recorded: true, receiptId: recorded.id });
    } catch (error) { next(error); }
  });

/* ---- cheques received from clients -------------------------------------- */
router.get('/receivables/cheques', auth, permit('finance.view','finance.invoice'), async (req,res,next) => {
  try { const companyId=companyParam(req); res.json(await query(`SELECT c.id,c.project_id projectId,c.invoice_id invoiceId,c.cheque_number chequeNumber,
    c.bank,c.payer,c.purpose,c.amount,c.received_date receivedDate,c.cheque_date chequeDate,c.deposit_by depositBy,
    c.reminder_days reminderDays,c.status,c.notes,c.deposited_at depositedAt,c.confirmed_at confirmedAt,
    p.name project,i.reference invoiceReference,DATEDIFF(c.deposit_by,CURDATE()) daysToDeposit,
    DATEDIFF(c.cheque_date,CURDATE()) daysToCheque,u.name createdBy,cu.name confirmedBy
    FROM received_cheques c LEFT JOIN projects p ON p.id=c.project_id LEFT JOIN client_invoices i ON i.id=c.invoice_id
    JOIN users u ON u.id=c.created_by LEFT JOIN users cu ON cu.id=c.confirmed_by
    ${companyId?'WHERE c.company_id=?':''}
    ORDER BY CASE WHEN c.status IN ('On hand','Deposited','Re-deposited') THEN 0 ELSE 1 END,c.cheque_date,c.id`,companyId?[companyId]:[])); }
  catch(error){ next(error); }
});

router.post('/receivables/cheques', auth, permit('finance.invoice'), validate(z.object({
  companyId:z.coerce.number().int().positive().default(1),
  projectId:z.coerce.number().int().positive().nullable().optional(),invoiceId:z.coerce.number().int().positive().nullable().optional(),
  chequeNumber:z.string().trim().min(1).max(80),bank:z.string().trim().min(2).max(180),payer:z.string().trim().min(2).max(180),
  purpose:z.string().trim().min(2).max(400),amount:z.coerce.number().positive(),receivedDate:z.string().min(10).max(10),
  chequeDate:z.string().min(10).max(10),depositBy:z.string().min(10).max(10),
  reminderDays:z.coerce.number().int().min(0).max(30).default(2),notes:z.string().max(600).optional()
})),async(req,res,next)=>{try{
  let projectId=req.body.projectId||null;
  if(req.body.chequeDate<req.body.receivedDate) throw fail(400,'Cheque date cannot be before it was received');
  if(req.body.depositBy<req.body.receivedDate) throw fail(400,'Deposit reminder date cannot be before receipt');
  if(req.body.invoiceId){
    const invoice=await getOne('SELECT * FROM client_invoices WHERE id=?',[req.body.invoiceId]);
    if(!invoice) throw fail(404,'Client invoice not found');
    if(['Draft','Cancelled'].includes(invoice.status)) throw fail(409,'The linked client invoice must be issued');
    if(Number(invoice.company_id)!==req.body.companyId) throw fail(400,'That invoice belongs to the other company');
    if(projectId&&Number(projectId)!==Number(invoice.project_id)) throw fail(400,'That invoice belongs to a different project');
    projectId=invoice.project_id;
    if(req.body.amount>Number(invoice.net_payable)-Number(invoice.paid_amount)+0.001) throw fail(409,'Cheque amount exceeds the client invoice balance');
  }
  if(!projectId && !req.body.invoiceId) throw fail(400,'Choose a project or link a client invoice');
  if(projectId){
    const project=await getOne('SELECT id FROM projects WHERE id=? AND company_id=?',[projectId,req.body.companyId]);
    if(!project) throw fail(400,'That project belongs to the other company');
  }
  const result=await query(`INSERT INTO received_cheques
    (company_id,project_id,invoice_id,cheque_number,bank,payer,purpose,amount,received_date,cheque_date,deposit_by,reminder_days,notes,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[req.body.companyId,projectId,req.body.invoiceId||null,req.body.chequeNumber,req.body.bank,req.body.payer,
    req.body.purpose,req.body.amount,req.body.receivedDate,req.body.chequeDate,req.body.depositBy,req.body.reminderDays,req.body.notes||null,req.user.id]);
  const row=await getOne('SELECT * FROM received_cheques WHERE id=?',[result.insertId]);
  await audit(pool,req.user.id,'RECEIVE','received_cheque',row.id,null,row,req.ip);publishChange('receivables',{});res.status(201).json(row);
}catch(error){if(error.code==='ER_DUP_ENTRY') return res.status(409).json({error:'That received cheque is already recorded'});next(error);}});

router.patch('/receivables/cheques/:id',auth,permit('finance.invoice'),validate(z.object({
  status:z.enum(['Deposited','Cleared','Returned','Re-deposited','Cancelled']),notes:z.string().max(600).optional()
})),async(req,res,next)=>{try{
  const result=await transaction(async connection=>{
    const [[cheque]]=await connection.execute('SELECT * FROM received_cheques WHERE id=? FOR UPDATE',[req.params.id]);
    if(!cheque)throw fail(404,'Received cheque not found');
    if(cheque.status==='Cleared'&&req.body.status!=='Cleared')throw fail(409,'A cleared receipt cannot be reversed from this screen');
    if(cheque.status==='Cleared')return cheque;
    if(req.body.status==='Cleared'){
      if(cheque.invoice_id){
        const [rows]=await connection.execute('SELECT * FROM client_invoices WHERE id=? FOR UPDATE',[cheque.invoice_id]);
        const invoice=rows[0],paid=Number(invoice.paid_amount)+Number(cheque.amount);
        if(paid>Number(invoice.net_payable)+0.001) throw Object.assign(new Error('Cheque exceeds the remaining client balance'),{status:409});
        await connection.execute('UPDATE client_invoices SET paid_amount=?,status=? WHERE id=?',[paid,paid>=Number(invoice.net_payable)-1?'Paid':'Part paid',invoice.id]);
        await connection.execute(`INSERT INTO client_receipts (invoice_id,amount,received_date,method,reference,recorded_by)
          VALUES (?,?,CURDATE(),'Cheque',?,?)`,[invoice.id,cheque.amount,cheque.cheque_number,req.user.id]);
      }
      await connection.execute(`INSERT INTO incomes (project_id,company_id,description,amount,received_date,method,reference,created_by)
        VALUES (?,?,?,?,CURDATE(),'Cheque',?,?)`,[cheque.project_id,cheque.company_id,
          `Cheque cleared — ${cheque.purpose}`,cheque.amount,cheque.cheque_number,req.user.id]);
    }
    await connection.execute(`UPDATE received_cheques SET status=?,notes=COALESCE(?,notes),
      deposited_at=CASE WHEN ? IN ('Deposited','Re-deposited') THEN CURDATE() ELSE deposited_at END,
      confirmed_at=CASE WHEN ? IN ('Cleared','Returned','Cancelled') THEN NOW() ELSE confirmed_at END,confirmed_by=? WHERE id=?`,
    [req.body.status,req.body.notes||null,req.body.status,req.body.status,req.user.id,cheque.id]);
    await audit(connection,req.user.id,'CONFIRM','received_cheque',cheque.id,cheque,{status:req.body.status,notes:req.body.notes},req.ip);
    return cheque;
  });publishChange('receivables',{});res.json(await getOne('SELECT * FROM received_cheques WHERE id=?',[result.id]));
}catch(error){next(error);}});

/* ---- bank bonds ----------------------------------------------------------- */

router.get('/receivables/bonds', auth, permit('finance.view', 'finance.invoice'),
  async (req, res, next) => {
    try {
      const companyId = companyParam(req);
      res.json(await query(`
        SELECT b.*,b.reminder_days reminderDays,p.name project,DATEDIFF(b.expiry_date,CURDATE()) daysLeft,
          (SELECT COUNT(*) FROM bank_bond_extensions x WHERE x.bond_id=b.id) extensions
          FROM bank_bonds b LEFT JOIN projects p ON p.id=b.project_id
         ${companyId ? 'WHERE b.company_id=?' : ''}
         ORDER BY FIELD(b.status,'Live','Expired','Called','Released'), b.expiry_date`, companyId ? [companyId] : []));
    } catch (error) { next(error); }
  });

router.post('/receivables/bonds', auth, permit('finance.invoice'),
  validate(z.object({
    companyId: z.coerce.number().int().positive().default(1),
    projectId: z.coerce.number().int().positive().nullable().optional(),
    kind: z.enum(['Advance payment', 'Performance', 'Retention', 'Bid', 'Other']),
    beneficiary: z.string().trim().min(2).max(180),
    bank: z.string().trim().min(2).max(180),
    bondNumber: z.string().trim().max(80).optional(),
    amount: z.coerce.number().positive(),
    marginHeld: z.coerce.number().min(0).default(0),
    commission: z.coerce.number().min(0).default(0),
    issuedDate: z.string().min(10).max(10),
    expiryDate: z.string().min(10).max(10),
    reminderDays: z.coerce.number().int().min(0).max(180).default(30),
    notes: z.string().trim().max(600).optional()
  })),
  async (req, res, next) => {
    try {
      if (req.body.projectId) {
        const project = await getOne('SELECT id FROM projects WHERE id=? AND company_id=?',
          [req.body.projectId, req.body.companyId]);
        if (!project) throw fail(400, 'That project belongs to the other company');
      }
      const reference = await nextReference('BND', 'bank_bonds');
      const result = await query(
        `INSERT INTO bank_bonds (company_id,reference,project_id,kind,beneficiary,bank,bond_number,amount,
           margin_held,commission,issued_date,expiry_date,reminder_days,notes,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [req.body.companyId, reference, req.body.projectId || null, req.body.kind, req.body.beneficiary, req.body.bank,
          req.body.bondNumber || null, req.body.amount, req.body.marginHeld, req.body.commission,
          req.body.issuedDate,req.body.expiryDate,req.body.reminderDays,req.body.notes||null,req.user.id]);
      await audit(pool, req.user.id, 'CREATE', 'bank_bond', result.insertId, null,
        { reference, kind: req.body.kind, amount: req.body.amount }, req.ip);
      publishChange('receivables', {});
      res.status(201).json({ id: result.insertId, reference });
    } catch (error) { next(error); }
  });

router.patch('/receivables/bonds/:id', auth, permit('finance.invoice'),
  validate(z.object({
    status: z.enum(['Live', 'Expired', 'Released', 'Called']),
    releasedDate: z.string().min(10).max(10).optional()
  })),
  async (req, res, next) => {
    try {
      const bond = await getOne('SELECT * FROM bank_bonds WHERE id=?', [req.params.id]);
      if (!bond) throw fail(404, 'That bond was not found');
      await query('UPDATE bank_bonds SET status=?, released_date=? WHERE id=?',
        [req.body.status, req.body.releasedDate || null, req.params.id]);
      await audit(pool, req.user.id, 'UPDATE', 'bank_bond', req.params.id,
        { status: bond.status }, { status: req.body.status }, req.ip);
      publishChange('receivables', {});
      res.status(204).end();
    } catch (error) { next(error); }
  });

router.post('/receivables/bonds/:id/extend',auth,permit('finance.invoice'),validate(z.object({
  newExpiryDate:z.string().min(10).max(10),extendedOn:z.string().min(10).max(10),
  reminderDays:z.coerce.number().int().min(0).max(180),additionalCommission:z.coerce.number().min(0).default(0),
  note:z.string().trim().max(600).optional()
})),async(req,res,next)=>{try{
  const bond=await getOne('SELECT * FROM bank_bonds WHERE id=?',[req.params.id]);if(!bond)throw fail(404,'That bond was not found');
  const oldExpiry=bond.expiry_date instanceof Date
    ? bond.expiry_date.toISOString().slice(0,10)
    : String(bond.expiry_date).slice(0,10);
  if(req.body.newExpiryDate<=oldExpiry)throw fail(400,'The extended expiry must be later than the current expiry');
  await transaction(async connection=>{
    await connection.execute(`INSERT INTO bank_bond_extensions
      (bond_id,previous_expiry,new_expiry,extended_on,additional_commission,note,created_by) VALUES (?,?,?,?,?,?,?)`,
      [bond.id,oldExpiry,req.body.newExpiryDate,req.body.extendedOn,req.body.additionalCommission,req.body.note||null,req.user.id]);
    await connection.execute(`UPDATE bank_bonds SET expiry_date=?,reminder_days=?,commission=commission+?,status='Live',notes=COALESCE(?,notes) WHERE id=?`,
      [req.body.newExpiryDate,req.body.reminderDays,req.body.additionalCommission,req.body.note||null,bond.id]);
    await audit(connection,req.user.id,'EXTEND','bank_bond',bond.id,bond,{newExpiryDate:req.body.newExpiryDate,...req.body},req.ip);
  });publishChange('receivables',{});res.json({extended:true,newExpiryDate:req.body.newExpiryDate});
}catch(error){next(error);}});

/* ---- petty cash ------------------------------------------------------------ */

router.get('/receivables/petty-cash', auth, permit('finance.view', 'finance.manage'),
  async (req, res, next) => {
    try {
      const companyId = companyParam(req);
      /* The balance is the sum of what happened, never a stored figure that can drift. */
      res.json(await query(`
        SELECT f.id,f.name,f.account_type accountType,f.holder_name holderName,f.project_id projectId,p.name project,
               f.ceiling,f.low_at lowAt,f.active,
               COALESCE((SELECT SUM(e.amount) FROM petty_cash_entries e WHERE e.float_id=f.id),0) balance,
               (SELECT MAX(e.entry_date) FROM petty_cash_entries e WHERE e.float_id=f.id) lastMovement
          FROM petty_cash_floats f LEFT JOIN projects p ON p.id=f.project_id
         WHERE f.active=1 ${companyId ? 'AND f.company_id=?' : ''} ORDER BY f.name`, companyId ? [companyId] : []));
    } catch (error) { next(error); }
  });

router.post('/receivables/petty-cash', auth, permit('finance.manage'),
  validate(z.object({
    companyId: z.coerce.number().int().positive().default(1),
    name: z.string().trim().min(2).max(120),
    accountType: z.enum(['Office expenses', 'Salary advance', 'Fuel']),
    holderName: z.string().trim().min(2).max(120),
    holderId: z.coerce.number().int().positive().nullable().optional(),
    projectId: z.coerce.number().int().positive().nullable().optional(),
    ceiling: z.coerce.number().min(0).default(0),
    lowAt: z.coerce.number().min(0).default(0)
  })),
  async (req, res, next) => {
    try {
      if (req.body.projectId) {
        const project = await getOne('SELECT id FROM projects WHERE id=? AND company_id=?',
          [req.body.projectId, req.body.companyId]);
        if (!project) throw fail(400, 'That project belongs to the other company');
      }
      const result = await query(
        `INSERT INTO petty_cash_floats (company_id,name,account_type,holder_name,holder_id,project_id,ceiling,low_at,created_by)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [req.body.companyId, req.body.name, req.body.accountType, req.body.holderName, req.body.holderId || null, req.body.projectId || null,
          req.body.ceiling, req.body.lowAt, req.user.id]);
      res.status(201).json({ id: result.insertId });
    } catch (error) { next(error); }
  });

router.get('/receivables/petty-cash/:id/entries', auth, permit('finance.view', 'finance.manage'),
  async (req, res, next) => {
    try {
      res.json(await query(`
        SELECT e.id,e.kind,e.amount,e.entry_date entryDate,e.description,e.category,
               e.employee_id employeeId,emp.name employee,emp.code employeeCode,
               e.fuel_record_id fuelRecordId,fr.vehicle_id vehicleId,v.vehicle vehicle,v.registration registration,
               CASE WHEN f.account_type='Salary advance' AND e.kind='Spend'
                    THEN GREATEST(0,ABS(e.amount)-COALESCE((SELECT SUM(r.amount) FROM salary_advance_recoveries r WHERE r.entry_id=e.id),0))
                    ELSE NULL END outstandingAdvance,
               p.name project,u.name recordedBy
          FROM petty_cash_entries e JOIN users u ON u.id=e.recorded_by
          JOIN petty_cash_floats f ON f.id=e.float_id
          LEFT JOIN employees emp ON emp.id=e.employee_id
          LEFT JOIN fuel_records fr ON fr.id=e.fuel_record_id
          LEFT JOIN fleet v ON v.id=fr.vehicle_id
          LEFT JOIN projects p ON p.id=e.project_id
         WHERE e.float_id=? ORDER BY e.entry_date DESC, e.id DESC LIMIT 300`, [req.params.id]));
    } catch (error) { next(error); }
  });

router.post('/receivables/petty-cash/:id/entries', auth, permit('finance.manage'),
  validate(z.object({
    kind: z.enum(['Top up', 'Spend', 'Return', 'Adjustment']),
    amount: z.coerce.number().positive(),
    entryDate: z.string().min(10).max(10),
    description: z.string().trim().min(2).max(300),
    category: z.string().trim().max(60).optional(),
    projectId: z.coerce.number().int().positive().nullable().optional(),
    employeeId: z.coerce.number().int().positive().nullable().optional()
  })),
  async (req, res, next) => {
    try {
      const float = await getOne('SELECT * FROM petty_cash_floats WHERE id=? AND active=1', [req.params.id]);
      if (!float) throw fail(404, 'That float was not found');
      if (float.account_type === 'Fuel' && req.body.kind === 'Spend')
        throw fail(400, 'Record fuel in Fleet. Choose the vehicle and this fuel float there; the spending will appear here automatically.');
      if (float.account_type === 'Salary advance' && req.body.kind === 'Spend' && !req.body.employeeId)
        throw fail(400, 'Choose the employee receiving this salary advance');
      if (req.body.employeeId) {
        const employee = await getOne("SELECT id FROM employees WHERE id=? AND status<>'Left'", [req.body.employeeId]);
        if (!employee) throw fail(400, 'That employee is not active');
      }
      const projectId = req.body.projectId || float.project_id;
      if (projectId) {
        const project = await getOne('SELECT id FROM projects WHERE id=? AND company_id=?', [projectId, float.company_id]);
        if (!project) throw fail(400, 'That project belongs to the other company');
      }

      /* Money out is stored negative, so the balance is a plain sum. */
      const signed = ['Spend', 'Return'].includes(req.body.kind)
        ? -Math.abs(req.body.amount) : Math.abs(req.body.amount);

      await transaction(async connection => {
        const [[lockedFloat]]=await connection.execute('SELECT id FROM petty_cash_floats WHERE id=? AND active=1 FOR UPDATE',[req.params.id]);
        if(!lockedFloat)throw fail(404,'That float is no longer active');
        const [[{balance}]]=await connection.execute('SELECT COALESCE(SUM(amount),0) balance FROM petty_cash_entries WHERE float_id=?',[req.params.id]);
        if(signed<0&&Number(balance)+signed<-.001)throw fail(400,`The float only holds ${money(balance)}. Record a top-up before spending more.`);
        const [entry]=await connection.execute(
          `INSERT INTO petty_cash_entries (float_id,kind,amount,entry_date,description,category,project_id,employee_id,recorded_by)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [req.params.id, req.body.kind, signed, req.body.entryDate, req.body.description,
            req.body.category || float.account_type, projectId,
            req.body.employeeId || null, req.user.id]);
        /* Petty cash spent on a site is a project cost like any other. */
        if (req.body.kind === 'Spend' && float.account_type !== 'Salary advance' && projectId) {
          await connection.execute(
            `INSERT INTO expenses (project_id,source,description,amount,expense_date,created_by,reference,origin_type,origin_id)
             VALUES (?,?,?,?,?,?,?,?,?)`,
            [projectId, float.account_type === 'Fuel' ? 'Fuel' : 'Overhead',
              `Petty cash — ${req.body.description}`, Math.abs(req.body.amount),
              req.body.entryDate, req.user.id, float.name,'petty_cash',String(entry.insertId)]);
        }
      });

      publishChange('receivables', {});
      res.status(201).json({ recorded: true });
    } catch (error) { next(error); }
  });

/* ---- the evening summary --------------------------------------------------- */

/** What tonight's message would say, without sending it. */
router.get('/summary/preview', auth, permit('reports.daily-summary', 'admin.audit'),
  async (_req, res, next) => {
    try { res.json(await sendDailySummary({ dryRun: true })); }
    catch (error) { next(error); }
  });

/** Sends it now — for testing the WhatsApp path, and for a day somebody wants it early. */
router.post('/summary/send', auth, permit('admin.audit'), async (req, res, next) => {
  try {
    const result = await sendDailySummary();
    await audit(pool, req.user.id, 'SEND', 'daily_summary', new Date().toISOString().slice(0, 10),
      null, { recipients: result.sent.length }, req.ip);
    res.json(result);
  } catch (error) { next(error); }
});

export default router;
