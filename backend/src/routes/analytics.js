import { Router } from 'express';
import { query, spendSql } from '../db.js';
import { auth, wrap } from '../lib/http.js';

const router = Router();

/**
 * PID 2.12 — system-generated reports across every operational area, replacing
 * spreadsheets compiled by hand from figures that were already out of date.
 */
const range = req => {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || '') ? req.query.to : new Date().toISOString().slice(0, 10);
  const fallback = new Date(to);
  fallback.setDate(fallback.getDate() - 30);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || '') ? req.query.from : fallback.toISOString().slice(0, 10);
  return { from, to };
};

const builders = {
  attendance: async ({ from, to }) => ({
    columns: ['Employee', 'Role', 'Days present', 'Late days', 'Absent days'],
    rows: (await query(`SELECT employee_name employee,role,
        SUM(state IN ('On site','Late','Checked out')) present, SUM(state='Late') late, SUM(state='Absent') absent
      FROM attendance WHERE work_date BETWEEN ? AND ? GROUP BY employee_name,role ORDER BY present DESC`, [from, to]))
      .map(row => [row.employee, row.role, row.present, row.late, row.absent])
  }),
  employees: async () => ({
    columns: ['Code', 'Employee', 'Department', 'Designation', 'Status', 'Basic salary'],
    rows: (await query(`SELECT e.code,e.name,d.name department,e.designation,e.status,e.basic_salary salary
      FROM employees e LEFT JOIN departments d ON d.id=e.department_id ORDER BY e.code`))
      .map(row => [row.code, row.name, row.department || '—', row.designation, row.status, row.salary])
  }),
  projects: async () => ({
    columns: ['Project', 'Client', 'Stage', 'Progress %', 'Budget', 'Recorded cost', 'Health'],
    rows: (await query(`SELECT p.name,p.client,p.stage,p.progress,p.budget,
        ${spendSql('p')} spent,p.health
      FROM projects p WHERE p.active=1 ORDER BY p.id`))
      .map(row => [row.name, row.client, row.stage, row.progress, row.budget, row.spent, row.health])
  }),
  tasks: async () => ({
    columns: ['Project', 'Task', 'Assignee', 'Priority', 'Status', 'Due'],
    rows: (await query(`SELECT p.name project,t.title,t.assignee,t.priority,t.status,t.due FROM tasks t
      JOIN projects p ON p.id=t.project_id ORDER BY FIELD(t.status,'Blocked','Not started','In progress','Completed','Approved'),t.id`))
      .map(row => [row.project, row.title, row.assignee, row.priority, row.status, row.due])
  }),
  materials: async () => ({
    columns: ['Material', 'Store', 'In stock', 'Minimum', 'Unit cost', 'Stock value'],
    rows: (await query('SELECT name,site,stock,minimum,unit,unit_cost cost FROM materials WHERE active=1 ORDER BY name'))
      .map(row => [row.name, row.site, `${row.stock} ${row.unit}`, `${row.minimum} ${row.unit}`, row.cost, Number(row.stock) * Number(row.cost)])
  }),
  purchases: async ({ from, to }) => ({
    columns: ['Reference', 'Supplier', 'Project', 'Order date', 'Total', 'Status'],
    rows: (await query(`SELECT o.reference,s.name supplier,p.name project,o.order_date,o.total,o.status
      FROM purchase_orders o JOIN suppliers s ON s.id=o.supplier_id JOIN projects p ON p.id=o.project_id
      WHERE o.order_date BETWEEN ? AND ? ORDER BY o.id DESC`, [from, to]))
      .map(row => [row.reference, row.supplier, row.project, row.order_date, row.total, row.status])
  }),
  vehicles: async () => ({
    columns: ['Vehicle', 'Registration', 'Status', 'Fuel cost', 'Maintenance cost', 'Next expiry'],
    rows: (await query(`SELECT f.vehicle,f.registration,f.status,
        COALESCE((SELECT SUM(cost) FROM fuel_records WHERE vehicle_id=f.id),0) fuel,
        COALESCE((SELECT SUM(cost) FROM vehicle_maintenance WHERE vehicle_id=f.id),0) maintenance,
        (SELECT MIN(expiry_date) FROM vehicle_documents WHERE vehicle_id=f.id) expiry
      FROM fleet f ORDER BY f.id`))
      .map(row => [row.vehicle, row.registration, row.status, row.fuel, row.maintenance, row.expiry || '—'])
  }),
  equipment: async () => ({
    columns: ['Code', 'Equipment', 'Category', 'Status', 'Assigned to', 'Maintenance cost'],
    rows: (await query(`SELECT e.code,e.name,e.category,e.status,
        (SELECT CONCAT(a.assigned_to,' — ',p.name) FROM equipment_assignments a JOIN projects p ON p.id=a.project_id
          WHERE a.equipment_id=e.id AND a.returned_at IS NULL ORDER BY a.id DESC LIMIT 1) holder,
        COALESCE((SELECT SUM(cost) FROM equipment_maintenance WHERE equipment_id=e.id),0) maintenance
      FROM equipment e ORDER BY e.code`))
      .map(row => [row.code, row.name, row.category, row.status, row.holder || '—', row.maintenance])
  }),
  budget: async () => ({
    columns: ['Project', 'Approved budget', 'Recorded cost', 'Variance', 'Used %'],
    rows: (await query(`SELECT p.name,p.budget,${spendSql('p')} spent
      FROM projects p WHERE p.active=1 ORDER BY p.id`))
      .map(row => [row.name, row.budget, row.spent, Number(row.budget) - Number(row.spent),
        row.budget ? ((Number(row.spent) / Number(row.budget)) * 100).toFixed(1) : '0.0'])
  }),
  profit: async () => ({
    columns: ['Project', 'Income received', 'Cost recorded', 'Margin', 'Margin %'],
    rows: (await query(`SELECT p.name,
        COALESCE((SELECT SUM(i.amount) FROM incomes i WHERE i.project_id=p.id),0) income,
        ${spendSql('p')} spent
      FROM projects p WHERE p.active=1 ORDER BY p.id`))
      .map(row => {
        const margin = Number(row.income) - Number(row.spent);
        return [row.name, row.income, row.spent, margin, row.income ? ((margin / Number(row.income)) * 100).toFixed(1) : '0.0'];
      })
  }),
  progress: async ({ from, to }) => ({
    columns: ['Date', 'Site', 'Supervisor', 'Workforce', 'Work completed', 'Delay hours'],
    rows: (await query(`SELECT DATE_FORMAT(r.report_date,'%Y-%m-%d') date,p.name site,r.supervisor,r.workforce,r.work_completed work,r.delay_hours delay
      FROM daily_reports r JOIN projects p ON p.id=r.project_id WHERE r.report_date BETWEEN ? AND ? ORDER BY r.report_date DESC`, [from, to]))
      .map(row => [row.date, row.site, row.supervisor, row.workforce, row.work, row.delay])
  })
};

export const REPORT_TYPES = Object.keys(builders);

router.get('/', auth, (_req, res) => res.json(REPORT_TYPES));

router.get('/:type', auth, wrap(async (req, res) => {
  const build = builders[req.params.type];
  if (!build) return res.status(404).json({ error: 'Unknown report' });
  const window = range(req);
  const report = await build(window);
  res.json({ type: req.params.type, ...window, ...report });
}));

export default router;
