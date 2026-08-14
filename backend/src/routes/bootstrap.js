import { Router } from 'express';
import { query, spendSql, today } from '../db.js';
import { auth, wrap } from '../lib/http.js';
import { runAlertScan } from '../alerts.js';

const router = Router();

export const stockState = material =>
  Number(material.stock) >= Number(material.minimum) ? 'Available'
    : Number(material.stock) < Number(material.minimum) * 0.5 ? 'Critical' : 'Low stock';

export const dueLabel = date => {
  const remaining = Math.ceil((new Date(date) - new Date(today())) / 86400000);
  return remaining < 0 ? `Overdue ${Math.abs(remaining)} days` : `${remaining} days`;
};

/** Everything the signed-in workspace renders on first paint, in one round trip. */
router.get('/', auth, wrap(async (req, res) => {
  await runAlertScan().catch(error => console.error('Alert scan failed', error));

  const [projects, tasks, attendance, materials, fleet, reports, employees, departments, equipment,
    suppliers, purchaseRequests, boqs, milestones, notifications, finance, inquiries, weekly] = await Promise.all([
    query('SELECT * FROM projects WHERE active=1 ORDER BY id'),
    query('SELECT t.*,p.name project FROM tasks t JOIN projects p ON p.id=t.project_id ORDER BY t.id'),
    query(`SELECT a.id,a.employee_name name,a.role,p.name site,a.check_in \`in\`,a.check_out \`out\`,a.state,a.work_date workDate
      FROM attendance a JOIN projects p ON p.id=a.project_id WHERE a.work_date=CURDATE() ORDER BY a.id`),
    query('SELECT * FROM materials WHERE active=1 ORDER BY id'),
    query(`SELECT f.id,f.vehicle,f.registration reg,f.driver,f.status,f.renewal_type renewal,f.due_date,f.odometer,p.name project
      FROM fleet f LEFT JOIN projects p ON p.id=f.project_id ORDER BY f.id`),
    query(`SELECT r.id,r.project_id projectId,p.name site,r.supervisor,DATE_FORMAT(r.report_date,'%d %b %Y') date,
      r.workforce,r.work_completed work,r.issue,r.weather,r.delay_hours delayHours
      FROM daily_reports r JOIN projects p ON p.id=r.project_id ORDER BY r.report_date DESC,r.id DESC LIMIT 60`),
    query(`SELECT e.id,e.code,e.name,e.designation,e.phone,e.email,e.status,e.basic_salary basicSalary,e.daily_rate dailyRate,
      e.overtime_rate overtimeRate,e.join_date joinDate,d.name department,e.department_id departmentId
      FROM employees e LEFT JOIN departments d ON d.id=e.department_id ORDER BY e.code`),
    query('SELECT id,name,description FROM departments ORDER BY name'),
    query(`SELECT e.id,e.code,e.name,e.category,e.status,e.purchase_cost purchaseCost,
      (SELECT p.name FROM equipment_assignments a JOIN projects p ON p.id=a.project_id
        WHERE a.equipment_id=e.id AND a.returned_at IS NULL ORDER BY a.id DESC LIMIT 1) project
      FROM equipment e ORDER BY e.code`),
    query('SELECT id,name,contact_person contact,phone,email,address FROM suppliers WHERE active=1 ORDER BY name'),
    query(`SELECT r.id,r.reference,r.status,r.needed_by neededBy,r.notes,p.name project,u.name requestedBy,
      (SELECT COUNT(*) FROM purchase_request_items i WHERE i.request_id=r.id) lineCount,
      (SELECT COALESCE(SUM(i.quantity*i.estimated_rate),0) FROM purchase_request_items i WHERE i.request_id=r.id) estimate
      FROM purchase_requests r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.requested_by ORDER BY r.id DESC`),
    query(`SELECT b.id,b.reference,b.title,b.status,b.total,b.version,p.name project,b.project_id projectId,u.name preparedBy
      FROM boqs b JOIN projects p ON p.id=b.project_id JOIN users u ON u.id=b.prepared_by ORDER BY b.id DESC`),
    query(`SELECT m.id,m.title,m.due_date dueDate,m.status,m.project_id projectId,p.name project
      FROM project_milestones m JOIN projects p ON p.id=m.project_id ORDER BY m.due_date`),
    query(`SELECT id,title,message,severity,status,channel,reference_type referenceType,reference_id referenceId,created_at createdAt
      FROM notifications WHERE user_id IS NULL OR user_id=? OR audience IN (?) ORDER BY id DESC LIMIT 40`,
      [req.user.id, req.user.permissions.length ? req.user.permissions : ['']]),
    query(`SELECT p.id projectId,p.name project,p.budget,
      ${spendSql('p')} expenses,
      COALESCE((SELECT SUM(i.amount) FROM incomes i WHERE i.project_id=p.id),0) income
      FROM projects p WHERE p.active=1 ORDER BY p.id`),
    query(`SELECT i.id,i.reference,i.customer_name customer,i.location,i.status,i.expected_value expectedValue,
      i.expected_start expectedStart,i.project_id projectId FROM inquiries i ORDER BY i.id DESC LIMIT 40`),
    /* Real site activity for the last seven days, replacing the placeholder chart. */
    query(`SELECT DATE_FORMAT(d.day,'%a') label, DATE_FORMAT(d.day,'%Y-%m-%d') day,
        (SELECT COUNT(*) FROM attendance a WHERE a.work_date=d.day AND a.state IN ('On site','Late','Checked out')) workforce,
        (SELECT COUNT(*) FROM daily_reports r WHERE r.report_date=d.day) reports
      FROM (SELECT CURDATE() - INTERVAL n DAY day FROM
        (SELECT 6 n UNION SELECT 5 UNION SELECT 4 UNION SELECT 3 UNION SELECT 2 UNION SELECT 1 UNION SELECT 0) days) d
      ORDER BY d.day`)
  ]);

  /* Delayed = past its target completion date with work outstanding, or flagged at risk. */
  const todayIso = today();
  const delayed = projects.filter(project =>
    project.health === 'At risk'
    || (project.end_date && new Date(project.end_date).toISOString().slice(0, 10) < todayIso && project.progress < 100));
  const revenue = finance.reduce((sum, row) => sum + Number(row.income), 0);
  const spend = finance.reduce((sum, row) => sum + Number(row.expenses), 0);

  res.json({
    user: { ...req.user, permissions: req.user.permissions },
    data: {
      projects,
      tasks,
      attendance,
      materials: materials.map(material => ({ ...material, state: stockState(material) })),
      fleet: fleet.map(vehicle => ({ ...vehicle, due: dueLabel(vehicle.due_date) })),
      reports,
      employees,
      departments,
      equipment,
      suppliers,
      purchaseRequests,
      boqs,
      milestones,
      notifications,
      finance,
      inquiries,
      dashboard: {
        weekly,
        delayed: delayed.map(project => ({ id: project.id, name: project.name, health: project.health, progress: project.progress })),
        revenue,
        spend,
        margin: revenue - spend,
        overBudget: finance.filter(row => Number(row.budget) > 0 && Number(row.expenses) > Number(row.budget)).length
      }
    }
  });
}));

export default router;
