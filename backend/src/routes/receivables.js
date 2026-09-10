import { Router } from 'express';
import { z } from 'zod';
import { pool, query, getOne, audit, transaction, nextReference } from '../db.js';
import { auth, permit, validate, fail } from '../lib/http.js';
import { certificate } from '../lib/invoice-maths.js';
import { publishChange } from '../lib/realtime.js';
import { notify } from '../alerts.js';
import { sendDailySummary } from '../lib/daily-summary.js';

const router = Router();

const money = value => `LKR ${Number(value || 0).toLocaleString('en-LK', { maximumFractionDigits: 0 })}`;

/* ---- what the client owes ------------------------------------------------ */

router.get('/receivables/invoices', auth, permit('finance.view', 'finance.invoice'),
  async (_req, res, next) => {
    try {
      res.json(await query(`
        SELECT i.id,i.reference,i.project_id projectId,p.name project,i.client,i.kind,i.title,
               i.invoice_date invoiceDate,i.due_date dueDate,i.gross,i.tax_treatment taxTreatment,
               i.vat_rate vatRate,i.vat_amount vatAmount,i.svat_voucher svatVoucher,
               i.retention_percent retentionPercent,i.retention_amount retentionAmount,
               i.advance_recovery advanceRecovery,i.other_deductions otherDeductions,
               i.net_payable netPayable,i.paid_amount paidAmount,
               (i.net_payable - i.paid_amount) outstanding,
               i.status,i.created_at createdAt,u.name createdBy,
               DATEDIFF(CURDATE(), i.due_date) daysOverdue
          FROM client_invoices i
          JOIN projects p ON p.id=i.project_id
          JOIN users u ON u.id=i.created_by
         ORDER BY i.id DESC LIMIT 300`));
    } catch (error) { next(error); }
  });

/** The ageing view: who owes what, and for how long. */
router.get('/receivables/ageing', auth, permit('finance.view', 'finance.invoice'),
  async (_req, res, next) => {
    try {
      const rows = await query(`
        SELECT i.client, p.name project,
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
          FROM client_invoices i JOIN projects p ON p.id=i.project_id
         WHERE i.status IN ('Issued','Part paid') AND i.net_payable > i.paid_amount
         GROUP BY i.client, p.name
         ORDER BY outstanding DESC`);
      const [totals] = await query(`
        SELECT COALESCE(SUM(net_payable - paid_amount),0) outstanding,
               COALESCE(SUM(CASE WHEN DATEDIFF(CURDATE(), due_date) > 0
                                 THEN net_payable - paid_amount ELSE 0 END),0) overdue,
               COALESCE(SUM(retention_amount),0) retentionHeld
          FROM client_invoices WHERE status IN ('Issued','Part paid')`);
      res.json({ rows, totals });
    } catch (error) { next(error); }
  });

const invoiceSchema = z.object({
  projectId: z.coerce.number().int().positive(),
  kind: z.enum(['Interim', 'Final', 'Advance', 'Variation', 'Other']).default('Interim'),
  title: z.string().trim().min(3).max(200),
  invoiceDate: z.string().min(10).max(10),
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
  items: z.array(z.object({
    description: z.string().trim().min(1).max(300),
    unit: z.string().trim().max(30).optional(),
    quantity: z.coerce.number().min(0).default(0),
    rate: z.coerce.number().min(0).default(0)
  })).min(1, 'An invoice needs at least one line')
});

/**
 * Raises a certificate.
 *
 * The totals are worked out here rather than accepted from the request. A client invoice is
 * the figure the company stands behind; taking the arithmetic from the browser would mean
 * standing behind whatever it sent.
 */
router.post('/receivables/invoices', auth, permit('finance.invoice'), validate(invoiceSchema),
  async (req, res, next) => {
    try {
      const project = await getOne('SELECT id,name,client FROM projects WHERE id=? AND active=1',
        [req.body.projectId]);
      if (!project) throw fail(404, 'That project does not exist');

      const company = await getOne('SELECT default_vat_rate defaultVatRate FROM company_settings LIMIT 1')
        .catch(() => null);
      const vatRate = req.body.vatRate ?? Number(company?.defaultVatRate ?? 18);

      const gross = req.body.items.reduce((sum, item) => sum + item.quantity * item.rate, 0);
      const sums = certificate({ ...req.body, gross, vatRate });
      const reference = await nextReference('INV', 'client_invoices');

      const id = await transaction(async connection => {
        const [created] = await connection.execute(
          `INSERT INTO client_invoices
             (reference,project_id,client,kind,title,invoice_date,due_date,period_from,period_to,
              gross,tax_treatment,vat_rate,vat_amount,svat_voucher,retention_percent,retention_amount,
              advance_recovery,other_deductions,deduction_note,net_payable,notes,created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [reference, project.id, project.client, req.body.kind, req.body.title,
            req.body.invoiceDate, req.body.dueDate || null,
            req.body.periodFrom || null, req.body.periodTo || null,
            sums.gross, req.body.taxTreatment, sums.vatRate, sums.vatAmount,
            req.body.svatVoucher || null, req.body.retentionPercent, sums.retentionAmount,
            sums.advanceRecovery, sums.otherDeductions, req.body.deductionNote || null,
            sums.netPayable, req.body.notes || null, req.user.id]);

        for (const item of req.body.items) {
          await connection.execute(
            `INSERT INTO client_invoice_items (invoice_id,description,unit,quantity,rate,amount)
             VALUES (?,?,?,?,?,?)`,
            [created.insertId, item.description, item.unit || null, item.quantity, item.rate,
              Math.round(item.quantity * item.rate * 100) / 100]);
        }
        return created.insertId;
      });

      await audit(pool, req.user.id, 'CREATE', 'client_invoice', id, null,
        { reference, gross: sums.gross, net: sums.netPayable, treatment: req.body.taxTreatment }, req.ip);
      publishChange('receivables', {});
      res.status(201).json({ id, reference, ...sums });
    } catch (error) { next(error); }
  });

/** A preview of the working, so the figures can be checked before anything is raised. */
router.post('/receivables/preview', auth, permit('finance.invoice'),
  validate(invoiceSchema.partial({ items: true, title: true, invoiceDate: true, projectId: true })),
  async (req, res, next) => {
    try {
      const company = await getOne('SELECT default_vat_rate defaultVatRate FROM company_settings LIMIT 1')
        .catch(() => null);
      const gross = (req.body.items || []).reduce((sum, item) => sum + item.quantity * item.rate, 0);
      res.json(certificate({
        ...req.body, gross,
        vatRate: req.body.vatRate ?? Number(company?.defaultVatRate ?? 18)
      }));
    } catch (error) { next(error); }
  });

router.get('/receivables/invoices/:id', auth, permit('finance.view', 'finance.invoice'),
  async (req, res, next) => {
    try {
      const invoice = await getOne(`
        SELECT i.*, p.name project FROM client_invoices i
          JOIN projects p ON p.id=i.project_id WHERE i.id=?`, [req.params.id]);
      if (!invoice) throw fail(404, 'That invoice was not found');
      invoice.items = await query(
        'SELECT description,unit,quantity,rate,amount FROM client_invoice_items WHERE invoice_id=?',
        [req.params.id]);
      invoice.receipts = await query(`
        SELECT r.amount,r.received_date receivedDate,r.method,r.reference,u.name recordedBy
          FROM client_receipts r JOIN users u ON u.id=r.recorded_by
         WHERE r.invoice_id=? ORDER BY r.received_date`, [req.params.id]);
      res.json(invoice);
    } catch (error) { next(error); }
  });

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
    method: z.string().trim().min(1).max(60).default('Bank transfer'),
    reference: z.string().trim().max(120).optional()
  })),
  async (req, res, next) => {
    try {
      const invoice = await getOne('SELECT * FROM client_invoices WHERE id=?', [req.params.id]);
      if (!invoice) throw fail(404, 'That invoice was not found');
      if (invoice.status === 'Draft') throw fail(409, 'Issue the invoice before recording money against it');

      const outstanding = Number(invoice.net_payable) - Number(invoice.paid_amount);
      if (req.body.amount > outstanding + 1) {
        throw fail(400, `That is more than is outstanding. ${money(outstanding)} remains on this invoice.`);
      }

      await transaction(async connection => {
        await connection.execute(
          `INSERT INTO client_receipts (invoice_id,amount,received_date,method,reference,recorded_by)
           VALUES (?,?,?,?,?,?)`,
          [req.params.id, req.body.amount, req.body.receivedDate, req.body.method,
            req.body.reference || null, req.user.id]);
        const paid = Number(invoice.paid_amount) + req.body.amount;
        await connection.execute('UPDATE client_invoices SET paid_amount=?, status=? WHERE id=?',
          [paid, paid >= Number(invoice.net_payable) - 1 ? 'Paid' : 'Part paid', req.params.id]);
        /* Money received is income against the project, recorded once and in one place. */
        await connection.execute(
          `INSERT INTO incomes (project_id,description,amount,received_date,method,reference,created_by)
           VALUES (?,?,?,?,?,?,?)`,
          [invoice.project_id, `${invoice.reference} — ${invoice.title}`, req.body.amount,
            req.body.receivedDate, 'Bank transfer', req.body.reference || invoice.reference, req.user.id]);
      });

      await audit(pool, req.user.id, 'RECEIPT', 'client_invoice', req.params.id, null,
        { amount: req.body.amount, reference: req.body.reference }, req.ip);
      publishChange('receivables', {});
      res.status(201).json({ recorded: true });
    } catch (error) { next(error); }
  });

/* ---- bank bonds ----------------------------------------------------------- */

router.get('/receivables/bonds', auth, permit('finance.view', 'finance.invoice'),
  async (_req, res, next) => {
    try {
      res.json(await query(`
        SELECT b.*, p.name project, DATEDIFF(b.expiry_date, CURDATE()) daysLeft
          FROM bank_bonds b LEFT JOIN projects p ON p.id=b.project_id
         ORDER BY FIELD(b.status,'Live','Expired','Called','Released'), b.expiry_date`));
    } catch (error) { next(error); }
  });

router.post('/receivables/bonds', auth, permit('finance.invoice'),
  validate(z.object({
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
    notes: z.string().trim().max(600).optional()
  })),
  async (req, res, next) => {
    try {
      const reference = await nextReference('BND', 'bank_bonds');
      const result = await query(
        `INSERT INTO bank_bonds (reference,project_id,kind,beneficiary,bank,bond_number,amount,
           margin_held,commission,issued_date,expiry_date,notes,created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [reference, req.body.projectId || null, req.body.kind, req.body.beneficiary, req.body.bank,
          req.body.bondNumber || null, req.body.amount, req.body.marginHeld, req.body.commission,
          req.body.issuedDate, req.body.expiryDate, req.body.notes || null, req.user.id]);
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

/* ---- petty cash ------------------------------------------------------------ */

router.get('/receivables/petty-cash', auth, permit('finance.view', 'finance.manage'),
  async (_req, res, next) => {
    try {
      /* The balance is the sum of what happened, never a stored figure that can drift. */
      res.json(await query(`
        SELECT f.id,f.name,f.holder_name holderName,f.project_id projectId,p.name project,
               f.ceiling,f.low_at lowAt,f.active,
               COALESCE((SELECT SUM(e.amount) FROM petty_cash_entries e WHERE e.float_id=f.id),0) balance,
               (SELECT MAX(e.entry_date) FROM petty_cash_entries e WHERE e.float_id=f.id) lastMovement
          FROM petty_cash_floats f LEFT JOIN projects p ON p.id=f.project_id
         WHERE f.active=1 ORDER BY f.name`));
    } catch (error) { next(error); }
  });

router.post('/receivables/petty-cash', auth, permit('finance.manage'),
  validate(z.object({
    name: z.string().trim().min(2).max(120),
    holderName: z.string().trim().min(2).max(120),
    holderId: z.coerce.number().int().positive().nullable().optional(),
    projectId: z.coerce.number().int().positive().nullable().optional(),
    ceiling: z.coerce.number().min(0).default(0),
    lowAt: z.coerce.number().min(0).default(0)
  })),
  async (req, res, next) => {
    try {
      const result = await query(
        `INSERT INTO petty_cash_floats (name,holder_name,holder_id,project_id,ceiling,low_at,created_by)
         VALUES (?,?,?,?,?,?,?)`,
        [req.body.name, req.body.holderName, req.body.holderId || null, req.body.projectId || null,
          req.body.ceiling, req.body.lowAt, req.user.id]);
      res.status(201).json({ id: result.insertId });
    } catch (error) { next(error); }
  });

router.get('/receivables/petty-cash/:id/entries', auth, permit('finance.view', 'finance.manage'),
  async (req, res, next) => {
    try {
      res.json(await query(`
        SELECT e.id,e.kind,e.amount,e.entry_date entryDate,e.description,e.category,
               p.name project,u.name recordedBy
          FROM petty_cash_entries e JOIN users u ON u.id=e.recorded_by
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
    projectId: z.coerce.number().int().positive().nullable().optional()
  })),
  async (req, res, next) => {
    try {
      const float = await getOne('SELECT * FROM petty_cash_floats WHERE id=? AND active=1', [req.params.id]);
      if (!float) throw fail(404, 'That float was not found');

      /* Money out is stored negative, so the balance is a plain sum. */
      const signed = ['Spend', 'Return'].includes(req.body.kind)
        ? -Math.abs(req.body.amount) : Math.abs(req.body.amount);

      const [{ balance }] = await query(
        'SELECT COALESCE(SUM(amount),0) balance FROM petty_cash_entries WHERE float_id=?', [req.params.id]);
      if (signed < 0 && Number(balance) + signed < -0.001) {
        throw fail(400, `The float only holds ${money(balance)}. Record a top-up before spending more.`);
      }

      await transaction(async connection => {
        await connection.execute(
          `INSERT INTO petty_cash_entries (float_id,kind,amount,entry_date,description,category,project_id,recorded_by)
           VALUES (?,?,?,?,?,?,?,?)`,
          [req.params.id, req.body.kind, signed, req.body.entryDate, req.body.description,
            req.body.category || null, req.body.projectId || float.project_id, req.user.id]);
        /* Petty cash spent on a site is a project cost like any other. */
        if (req.body.kind === 'Spend' && (req.body.projectId || float.project_id)) {
          await connection.execute(
            `INSERT INTO expenses (project_id,source,description,amount,expense_date,created_by,reference)
             VALUES (?,?,?,?,?,?,?)`,
            [req.body.projectId || float.project_id, 'Other',
              `Petty cash — ${req.body.description}`, Math.abs(req.body.amount),
              req.body.entryDate, req.user.id, float.name]);
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
