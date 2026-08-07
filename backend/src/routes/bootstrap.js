import { Router } from 'express';
import { query } from '../db.js';
import { auth, wrap } from '../lib/http.js';
import { runAlertScan } from '../alerts.js';

const router = Router();

export const stockState = material =>
  Number(material.stock) >= Number(material.minimum) ? 'Available'
    : Number(material.stock) < Number(material.minimum) * 0.5 ? 'Critical' : 'Low stock';

export const dueLabel = date => {
  const remaining = Math.ceil((new Date(date) - new Date(new Date().toISOString().slice(0, 10))) / 86400000);
  return remaining < 0 ? `Overdue ${Math.abs(remaining)} days` : `${remaining} days`;
};

/** Everything the signed-in workspace renders on first paint, in one round trip. */
router.get('/', auth, wrap(async (req, res) => {
  await runAlertScan().catch(error => console.error('Alert scan failed', error));

  const [projects, tasks, attendance, materials, fleet, reports, employees, departments, equipment,
    suppliers, purchaseRequests, boqs, milestones, notifications, finance] = await Promise.all([
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
      (SELECT COUNT(*) FROM purchase_request_items i WHERE i.request_id=r.id) lines,
      (SELECT COALESCE(SUM(i.quantity*i.estimated_rate),0) FROM purchase_request_items i WHERE i.request_id=r.id) estimate
      FROM purchase_requests r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.requested_by ORDER BY r.id DESC`),
    query(`SELECT b.id,b.reference,b.title,b.status,b.total,b.version,p.name project,b.project_id projectId,u.name preparedBy
      FROM boqs b JOIN projects p ON p.id=b.project_id JOIN users u ON u.id=b.prepared_by ORDER BY b.id DESC`),
    query(`SELECT m.id,m.title,m.due_date dueDate,m.status,m.project_id projectId,p.name project
      FROM project_milestones m JOIN projects p ON p.id=m.project_id ORDER BY m.due_date`),
    query(`SELECT id,title,message,severity,status,channel,reference_type referenceType,reference_id referenceId,created_at createdAt
      FROM notifications WHERE user_id IS NULL OR user_id=? OR audience=? ORDER BY id DESC LIMIT 40`, [req.user.id, req.user.role]),
    query(`SELECT p.id projectId,p.name project,p.budget,
      COALESCE((SELECT SUM(e.amount) FROM expenses e WHERE e.project_id=p.id),0) expenses,
      COALESCE((SELECT SUM(i.amount) FROM incomes i WHERE i.project_id=p.id),0) income
      FROM projects p WHERE p.active=1 ORDER BY p.id`)
  ]);

  res.json({
    user: req.user,
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
      finance
    }
  });
}));

export default router;
