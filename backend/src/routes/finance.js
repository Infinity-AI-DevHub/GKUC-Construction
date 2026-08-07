import { Router } from 'express';
import { z } from 'zod';
import { audit, getOne, pool, query, spendSql } from '../db.js';
import { auth, permit, roles, validate, wrap } from '../lib/http.js';

const router = Router();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SOURCES = ['Material', 'Labour', 'Fuel', 'Equipment', 'Subcontractor', 'Overhead', 'Other'];

router.get('/categories', auth, wrap(async (_req, res) => res.json(await query('SELECT id,name FROM expense_categories ORDER BY name'))));

router.post('/categories', auth, permit(roles.finance), validate(z.object({ name: z.string().min(2).max(120) })), wrap(async (req, res) => {
  const result = await query('INSERT INTO expense_categories (name) VALUES (?)', [req.body.name]);
  res.status(201).json(await getOne('SELECT * FROM expense_categories WHERE id=?', [result.insertId]));
}));

router.get('/expenses', auth, wrap(async (req, res) => {
  const filters = [];
  const params = [];
  if (req.query.projectId) { filters.push('e.project_id=?'); params.push(req.query.projectId); }
  if (req.query.from) { filters.push('e.expense_date>=?'); params.push(req.query.from); }
  if (req.query.to) { filters.push('e.expense_date<=?'); params.push(req.query.to); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  res.json(await query(`SELECT e.id,e.description,e.amount,e.expense_date expenseDate,e.source,e.reference,e.origin_type originType,
    p.name project,e.project_id projectId,c.name category,u.name recordedBy
    FROM expenses e JOIN projects p ON p.id=e.project_id LEFT JOIN expense_categories c ON c.id=e.category_id
    JOIN users u ON u.id=e.created_by ${where} ORDER BY e.expense_date DESC,e.id DESC LIMIT 300`, params));
}));

router.post('/expenses', auth, permit(roles.finance), validate(z.object({
  projectId: z.number().int().positive(),
  categoryId: z.number().int().positive().optional(),
  source: z.enum(SOURCES).default('Other'),
  description: z.string().min(2).max(400),
  amount: z.number().positive(),
  expenseDate: isoDate,
  reference: z.string().max(120).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const result = await query(`INSERT INTO expenses (project_id,category_id,source,description,amount,expense_date,reference,created_by)
    VALUES (?,?,?,?,?,?,?,?)`, [body.projectId, body.categoryId || null, body.source, body.description, body.amount,
    body.expenseDate, body.reference || null, req.user.id]);
  const row = await getOne('SELECT * FROM expenses WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'expense', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

router.get('/income', auth, wrap(async (req, res) => {
  const where = req.query.projectId ? 'WHERE i.project_id=?' : '';
  const params = req.query.projectId ? [req.query.projectId] : [];
  res.json(await query(`SELECT i.id,i.description,i.amount,i.received_date receivedDate,i.method,i.reference,p.name project,i.project_id projectId,u.name recordedBy
    FROM incomes i JOIN projects p ON p.id=i.project_id JOIN users u ON u.id=i.created_by ${where}
    ORDER BY i.received_date DESC,i.id DESC LIMIT 300`, params));
}));

router.post('/income', auth, permit(roles.finance), validate(z.object({
  projectId: z.number().int().positive(),
  description: z.string().min(2).max(400),
  amount: z.number().positive(),
  receivedDate: isoDate,
  method: z.enum(['Cash', 'Cheque', 'Bank transfer', 'Card']).default('Bank transfer'),
  reference: z.string().max(120).optional()
})), wrap(async (req, res) => {
  const body = req.body;
  const result = await query('INSERT INTO incomes (project_id,description,amount,received_date,method,reference,created_by) VALUES (?,?,?,?,?,?,?)',
    [body.projectId, body.description, body.amount, body.receivedDate, body.method, body.reference || null, req.user.id]);
  const row = await getOne('SELECT * FROM incomes WHERE id=?', [result.insertId]);
  await audit(pool, req.user.id, 'CREATE', 'income', row.id, null, row, req.ip);
  res.status(201).json(row);
}));

/**
 * Budget monitoring (PID 2.10): every project's approved budget beside what has actually
 * been spent and received, so an overrun is visible while it can still be acted on.
 */
router.get('/summary', auth, wrap(async (_req, res) => {
  const projects = await query(`SELECT p.id projectId,p.name project,p.budget,p.progress,p.health,
    ${spendSql('p')} expenses,
    COALESCE((SELECT SUM(i.amount) FROM incomes i WHERE i.project_id=p.id),0) income
    FROM projects p WHERE p.active=1 ORDER BY p.id`);
  const bySource = await query('SELECT source,COALESCE(SUM(amount),0) total FROM expenses GROUP BY source');
  const monthly = await query(`SELECT DATE_FORMAT(month_start,'%Y-%m') month,
      COALESCE(SUM(expense),0) expenses, COALESCE(SUM(income),0) income FROM (
      SELECT DATE_FORMAT(expense_date,'%Y-%m-01') month_start, amount expense, 0 income FROM expenses
      UNION ALL
      SELECT DATE_FORMAT(received_date,'%Y-%m-01') month_start, 0 expense, amount income FROM incomes
    ) ledger WHERE month_start >= DATE_SUB(DATE_FORMAT(CURDATE(),'%Y-%m-01'), INTERVAL 5 MONTH)
    GROUP BY month_start ORDER BY month_start`);
  const payable = await getOne(`SELECT COALESCE(SUM(amount-paid_amount),0) outstanding,
    COALESCE(SUM(CASE WHEN due_date < CURDATE() THEN amount-paid_amount ELSE 0 END),0) overdue
    FROM supplier_invoices WHERE status<>'Paid'`);

  const totals = projects.reduce((sum, row) => ({
    budget: sum.budget + Number(row.budget),
    expenses: sum.expenses + Number(row.expenses),
    income: sum.income + Number(row.income)
  }), { budget: 0, expenses: 0, income: 0 });

  res.json({
    projects: projects.map(row => ({
      ...row,
      variance: Number(row.budget) - Number(row.expenses),
      used: Number(row.budget) ? (Number(row.expenses) / Number(row.budget)) * 100 : 0,
      profit: Number(row.income) - Number(row.expenses)
    })),
    bySource,
    monthly,
    payable,
    totals: { ...totals, profit: totals.income - totals.expenses }
  });
}));

export default router;
