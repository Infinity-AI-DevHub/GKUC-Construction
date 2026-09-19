import { ddl, query } from './db.js';
import { DEFAULT_ROLES, LEGACY_ROLE_MAP, PERMISSIONS } from './lib/permissions.js';

export const ROLES = [
  'Owner / Director', 'Administrator', 'Project Manager', 'Site Supervisor', 'Storekeeper',
  'Finance / Accounts', 'HR', 'QS / Estimator', 'Transport Officer', 'Employee', 'Read-Only Viewer'
];

const enumList = values => values.map(value => `'${value}'`).join(',');

async function columnExists(table, column) {
  const rows = await query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',
    [table, column]
  );
  return rows.length > 0;
}

async function addColumn(table, column, definition) {
  if (await columnExists(table, column)) return;
  await query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

async function indexExists(table, name) {
  const rows = await query(
    'SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=?',
    [table, name]
  );
  return rows.length > 0;
}

async function addIndex(table, name, definition) {
  if (await indexExists(table, name)) return;
  await query(`ALTER TABLE ${table} ADD ${definition}`);
}

async function dropIndex(table, name) {
  if (!await indexExists(table, name)) return;
  await query(`ALTER TABLE ${table} DROP INDEX ${name}`);
}

/*
 * ALTER ... MODIFY rebuilds the table on most MySQL versions, and these run on every boot.
 * On attendance and stock_movements — the two tables that grow every working day — that
 * turns each restart into a full table copy. Applied only when the column is not already
 * what it should be.
 */
async function columnType(table, column) {
  const rows = await query(
    'SELECT COLUMN_TYPE type FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',
    [table, column]
  );
  return rows[0]?.type || '';
}

async function modifyColumn(table, column, definition) {
  const wanted = definition.trim().toLowerCase();
  const current = (await columnType(table, column)).toLowerCase();
  if (!current || wanted.startsWith(current)) return;
  await query(`ALTER TABLE ${table} MODIFY ${column} ${definition}`);
}

async function columnIsNullable(table, column) {
  const rows = await query(
    'SELECT IS_NULLABLE nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?',
    [table, column]
  );
  return rows[0]?.nullable === 'YES';
}

async function constraintExists(table, name) {
  const rows = await query(
    `SELECT 1 FROM information_schema.table_constraints
     WHERE table_schema=DATABASE() AND table_name=? AND constraint_name=? AND constraint_type='FOREIGN KEY'`,
    [table, name]
  );
  return rows.length > 0;
}

/*
 * Foreign keys have to be looked for as constraints, not as indexes.
 *
 * MySQL usually creates an index named after the constraint, which made indexExists() a
 * near-enough proxy — until a table already carried a suitable index of its own. Then
 * MySQL reuses that one, no index by the constraint's name ever appears, and every
 * subsequent startup tries to add the key again and dies on the duplicate name. That is a
 * migration that only fails the *second* time it runs, which is the worst kind.
 */
async function addForeignKey(table, name, definition) {
  if (await constraintExists(table, name)) return;
  await query(`ALTER TABLE ${table} ADD ${definition}`);
}

/**
 * The two legal entities share people and physical resources, but never a commercial
 * ledger. A project's company becomes the authoritative owner for every document and
 * financial posting beneath it.
 */
async function createCompaniesTable() {
  await query(`CREATE TABLE IF NOT EXISTS companies (
    id TINYINT UNSIGNED PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(180) NOT NULL UNIQUE,
    address VARCHAR(400) NOT NULL DEFAULT '', telephone VARCHAR(120) NOT NULL DEFAULT '',
    email VARCHAR(180) NOT NULL DEFAULT '', tin VARCHAR(40) NOT NULL DEFAULT '',
    vat_number VARCHAR(40) NOT NULL DEFAULT '', svat_number VARCHAR(40) NOT NULL DEFAULT '',
    bank_details VARCHAR(400) NOT NULL DEFAULT '', default_vat_rate DECIMAL(5,2) NOT NULL DEFAULT 18,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await query(`INSERT IGNORE INTO companies (id,code,name) VALUES
    (1,'GKUC','GKUC Construction'),(2,'GKRM','GKUC Readymix')`);
}

/** Core tables that existed before the module expansion. */
async function createCoreTables() {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL, role ENUM(${enumList(ROLES)}) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS sessions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, token_hash CHAR(64) NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_sessions_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, INDEX idx_sessions_expiry(expires_at)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS projects (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(180) NOT NULL, client VARCHAR(180) NOT NULL, manager VARCHAR(120) NOT NULL,
    progress TINYINT UNSIGNED NOT NULL DEFAULT 0, budget DECIMAL(15,2) NOT NULL DEFAULT 0, actual DECIMAL(15,2) NOT NULL DEFAULT 0,
    health ENUM('On track','Watch','At risk') NOT NULL DEFAULT 'On track', stage VARCHAR(150) NOT NULL, site VARCHAR(180) NOT NULL,
    start_date DATE NULL, end_date DATE NULL, active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT chk_project_progress CHECK(progress BETWEEN 0 AND 100)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS tasks (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, title VARCHAR(220) NOT NULL, project_id BIGINT UNSIGNED NOT NULL, assignee VARCHAR(120) NOT NULL,
    due VARCHAR(100) NOT NULL, priority ENUM('Low','Medium','High') NOT NULL, status ENUM('Not started','In progress','Blocked','Completed','Approved') NOT NULL,
    notes TEXT NOT NULL, due_date DATE NULL, approved_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_tasks_project FOREIGN KEY(project_id) REFERENCES projects(id), CONSTRAINT fk_tasks_approver FOREIGN KEY(approved_by) REFERENCES users(id),
    INDEX idx_tasks_project(project_id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS attendance (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, employee_name VARCHAR(120) NOT NULL, role VARCHAR(100) NOT NULL, project_id BIGINT UNSIGNED NOT NULL,
    work_date DATE NOT NULL, check_in TIME NULL, check_out TIME NULL, state ENUM('On site','Late','Checked out','Absent','On leave','Business trip') NOT NULL,
    confirmed_by BIGINT UNSIGNED NULL, correction_reason VARCHAR(500) NULL,
    CONSTRAINT fk_attendance_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_attendance_confirmer FOREIGN KEY(confirmed_by) REFERENCES users(id),
    UNIQUE KEY uq_employee_day(employee_name,work_date), INDEX idx_attendance_day(work_date)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS materials (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(180) NOT NULL, unit VARCHAR(30) NOT NULL, stock DECIMAL(14,3) NOT NULL DEFAULT 0,
    minimum DECIMAL(14,3) NOT NULL DEFAULT 0, site VARCHAR(180) NOT NULL, supplier VARCHAR(180) NULL, unit_cost DECIMAL(14,2) NOT NULL DEFAULT 0,
    active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS stock_movements (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, material_id BIGINT UNSIGNED NOT NULL,
    movement_type ENUM('Receipt','Issue','Return','Adjustment','Transfer') NOT NULL,
    quantity DECIMAL(14,3) NOT NULL, reference VARCHAR(120) NULL, notes VARCHAR(500) NULL, project_id BIGINT UNSIGNED NULL,
    destination VARCHAR(180) NULL, user_id BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_movement_material FOREIGN KEY(material_id) REFERENCES materials(id), CONSTRAINT fk_movement_user FOREIGN KEY(user_id) REFERENCES users(id),
    CONSTRAINT chk_movement_quantity CHECK(quantity > 0), INDEX idx_movement_created(created_at)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS fleet (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, vehicle VARCHAR(180) NOT NULL, registration VARCHAR(60) NOT NULL UNIQUE, driver VARCHAR(120) NULL,
    status ENUM('Available','Assigned','Repair','Inactive') NOT NULL, renewal_type VARCHAR(100) NOT NULL, due_date DATE NOT NULL,
    project_id BIGINT UNSIGNED NULL, odometer INT UNSIGNED NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS daily_reports (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, supervisor VARCHAR(120) NOT NULL, report_date DATE NOT NULL,
    workforce INT UNSIGNED NOT NULL, work_completed TEXT NOT NULL, issue TEXT NOT NULL, weather VARCHAR(100) NOT NULL,
    delay_hours DECIMAL(5,2) NOT NULL DEFAULT 0, created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_report_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_report_user FOREIGN KEY(created_by) REFERENCES users(id), UNIQUE KEY uq_project_report(project_id,report_date)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS audit_logs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NULL, action VARCHAR(60) NOT NULL, entity VARCHAR(80) NOT NULL,
    entity_id VARCHAR(80) NULL, before_json JSON NULL, after_json JSON NULL, ip_address VARCHAR(64) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_audit_user FOREIGN KEY(user_id) REFERENCES users(id), INDEX idx_audit_created(created_at)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NULL, channel ENUM('In-app','WhatsApp','SMS','Email') NOT NULL DEFAULT 'In-app',
    severity ENUM('Info','Warning','Critical') NOT NULL DEFAULT 'Info',
    title VARCHAR(180) NOT NULL, message VARCHAR(1000) NOT NULL, status ENUM('Queued','Sent','Delivered','Failed','Read') NOT NULL DEFAULT 'Queued',
    reference_type VARCHAR(80) NULL, reference_id VARCHAR(80) NULL, dedupe_key VARCHAR(190) NULL UNIQUE,
    audience VARCHAR(120) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_notification_user FOREIGN KEY(user_id) REFERENCES users(id), INDEX idx_notifications_user(user_id,status)
  ) ENGINE=InnoDB`);
}

/** 2.2 Employee Management. */
async function createHrTables() {
  await query(`CREATE TABLE IF NOT EXISTS departments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE, description VARCHAR(400) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS payroll_policies (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, effective_from DATE NOT NULL UNIQUE,
    office_ot_rate DECIMAL(10,2) NOT NULL DEFAULT 225,
    site_labour_site_ot_rate DECIMAL(10,2) NOT NULL DEFAULT 200,
    site_labour_travel_ot_rate DECIMAL(10,2) NOT NULL DEFAULT 100,
    driver_ot_rate DECIMAL(10,2) NOT NULL DEFAULT 225,
    supervisor_site_ot_rate DECIMAL(10,2) NOT NULL DEFAULT 225,
    supervisor_travel_ot_rate DECIMAL(10,2) NOT NULL DEFAULT 100,
    epf_employee_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
    epf_employer_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
    etf_employer_rate DECIMAL(6,3) NOT NULL DEFAULT 0,
    epf_basis ENUM('Basic earnings','Gross earnings') NOT NULL DEFAULT 'Basic earnings',
    etf_basis ENUM('Basic earnings','Gross earnings') NOT NULL DEFAULT 'Basic earnings',
    created_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_payroll_policy_user FOREIGN KEY(created_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await query(`INSERT INTO payroll_policies
    (effective_from,office_ot_rate,site_labour_site_ot_rate,site_labour_travel_ot_rate,
     driver_ot_rate,supervisor_site_ot_rate,supervisor_travel_ot_rate)
    SELECT '2000-01-01',225,200,100,225,225,100
    WHERE NOT EXISTS (SELECT 1 FROM payroll_policies)`);
  await query(`CREATE TABLE IF NOT EXISTS employees (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, code VARCHAR(40) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL,
    department_id BIGINT UNSIGNED NULL, designation VARCHAR(120) NOT NULL, phone VARCHAR(40) NULL, email VARCHAR(190) NULL,
    user_id BIGINT UNSIGNED NULL, join_date DATE NOT NULL, basic_salary DECIMAL(12,2) NOT NULL DEFAULT 0,
    daily_rate DECIMAL(10,2) NOT NULL DEFAULT 0, weekly_rate DECIMAL(12,2) NOT NULL DEFAULT 0,
    overtime_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
    pay_basis ENUM('Monthly salary','Weekly rate','Daily rate') NOT NULL DEFAULT 'Monthly salary',
    pay_frequency ENUM('Daily','Weekly','Monthly') NOT NULL DEFAULT 'Monthly',
    payroll_category ENUM('Office employee','Site labourer','Driver','Supervisor','Custom') NOT NULL DEFAULT 'Site labourer',
    compensation_effective_from DATE NULL,
    epf_eligible BOOLEAN NOT NULL DEFAULT FALSE, etf_eligible BOOLEAN NOT NULL DEFAULT FALSE,
    custom_office_ot_rate DECIMAL(10,2) NULL, custom_site_ot_rate DECIMAL(10,2) NULL,
    custom_travel_ot_rate DECIMAL(10,2) NULL,
    status ENUM('Active','On leave','Suspended','Left') NOT NULL DEFAULT 'Active', notes VARCHAR(600) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_employee_department FOREIGN KEY(department_id) REFERENCES departments(id),
    CONSTRAINT fk_employee_user FOREIGN KEY(user_id) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await addColumn('employees', 'weekly_rate', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('employees', 'pay_basis', "ENUM('Monthly salary','Weekly rate','Daily rate') NOT NULL DEFAULT 'Monthly salary'");
  await addColumn('employees', 'pay_frequency', "ENUM('Daily','Weekly','Monthly') NOT NULL DEFAULT 'Monthly'");
  const hadPayrollCategory = await columnExists('employees', 'payroll_category');
  await addColumn('employees', 'payroll_category', "ENUM('Office employee','Site labourer','Driver','Supervisor','Custom') NOT NULL DEFAULT 'Site labourer'");
  await addColumn('employees', 'compensation_effective_from', 'DATE NULL');
  await addColumn('employees', 'epf_eligible', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await addColumn('employees', 'etf_eligible', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await addColumn('employees', 'custom_office_ot_rate', 'DECIMAL(10,2) NULL');
  await addColumn('employees', 'custom_site_ot_rate', 'DECIMAL(10,2) NULL');
  await addColumn('employees', 'custom_travel_ot_rate', 'DECIMAL(10,2) NULL');
  await query(`UPDATE employees SET
    pay_basis=CASE WHEN basic_salary>0 THEN 'Monthly salary' ELSE 'Daily rate' END,
    compensation_effective_from=COALESCE(compensation_effective_from,join_date)
    WHERE compensation_effective_from IS NULL`);
  if (!hadPayrollCategory) await query(`UPDATE employees e LEFT JOIN departments d ON d.id=e.department_id
    SET e.payroll_category=CASE
      WHEN LOWER(e.designation) LIKE '%driver%' THEN 'Driver'
      WHEN LOWER(e.designation) LIKE '%supervisor%' THEN 'Supervisor'
      WHEN LOWER(COALESCE(d.name,'')) REGEXP 'human resources|(^| )hr($| )|account|finance|administration|(^| )admin($| )|quantity survey|(^| )qs($| )'
        THEN 'Office employee' ELSE 'Site labourer' END`);
  await query(`CREATE TABLE IF NOT EXISTS employee_pay_components (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(120) NOT NULL, kind ENUM('Allowance','Deduction','Reimbursement') NOT NULL,
    amount DECIMAL(12,2) NOT NULL, pay_frequency ENUM('Daily','Weekly','Monthly') NOT NULL,
    effective_from DATE NOT NULL, effective_to DATE NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_pay_component_employee FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_pay_component_user FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT chk_pay_component_amount CHECK(amount >= 0),
    INDEX idx_pay_component_period(employee_id,pay_frequency,effective_from,effective_to,active)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS leave_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT UNSIGNED NOT NULL,
    leave_type ENUM('Annual','Casual','Medical','Unpaid','Other') NOT NULL, from_date DATE NOT NULL, to_date DATE NOT NULL,
    days DECIMAL(5,1) NOT NULL, reason VARCHAR(600) NOT NULL, status ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
    decided_by BIGINT UNSIGNED NULL, decided_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_leave_employee FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_leave_decider FOREIGN KEY(decided_by) REFERENCES users(id), INDEX idx_leave_status(status)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS overtime_records (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT UNSIGNED NOT NULL, project_id BIGINT UNSIGNED NULL,
    work_date DATE NOT NULL, overtime_type ENUM('Office','Site','Travel') NOT NULL DEFAULT 'Site',
    hours DECIMAL(5,2) NOT NULL, rate DECIMAL(10,2) NOT NULL DEFAULT 0, policy_id BIGINT UNSIGNED NULL,
    status ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending', approved_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_overtime_employee FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_overtime_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_overtime_policy FOREIGN KEY(policy_id) REFERENCES payroll_policies(id),
    CONSTRAINT fk_overtime_approver FOREIGN KEY(approved_by) REFERENCES users(id),
    CONSTRAINT chk_overtime_hours CHECK(hours > 0)
  ) ENGINE=InnoDB`);
  await addColumn('overtime_records', 'overtime_type', "ENUM('Office','Site','Travel') NOT NULL DEFAULT 'Site'");
  await addColumn('overtime_records', 'policy_id', 'BIGINT UNSIGNED NULL');
  await addForeignKey('overtime_records', 'fk_overtime_policy', 'CONSTRAINT fk_overtime_policy FOREIGN KEY(policy_id) REFERENCES payroll_policies(id)');
  await query(`CREATE TABLE IF NOT EXISTS employee_documents (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT UNSIGNED NOT NULL, title VARCHAR(180) NOT NULL,
    doc_type VARCHAR(80) NOT NULL, reference VARCHAR(180) NULL, expiry_date DATE NULL, file_ref VARCHAR(400) NULL,
    uploaded_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_empdoc_employee FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_empdoc_user FOREIGN KEY(uploaded_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
}

/** 2.3 / 2.4 Task and project detail. */
async function createProjectDetailTables() {
  await query(`CREATE TABLE IF NOT EXISTS task_comments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, task_id BIGINT UNSIGNED NOT NULL, user_id BIGINT UNSIGNED NOT NULL,
    comment VARCHAR(2000) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_comment_task FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    CONSTRAINT fk_comment_user FOREIGN KEY(user_id) REFERENCES users(id), INDEX idx_comment_task(task_id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS task_attachments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, task_id BIGINT UNSIGNED NOT NULL, title VARCHAR(180) NOT NULL,
    kind ENUM('File','Site photo') NOT NULL DEFAULT 'File', file_ref VARCHAR(400) NOT NULL, uploaded_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_attachment_task FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE,
    CONSTRAINT fk_attachment_user FOREIGN KEY(uploaded_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS project_milestones (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, title VARCHAR(180) NOT NULL,
    due_date DATE NOT NULL, status ENUM('Pending','In progress','Completed','Delayed') NOT NULL DEFAULT 'Pending',
    completed_at DATE NULL, notes VARCHAR(600) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_milestone_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    INDEX idx_milestone_project(project_id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS project_documents (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, title VARCHAR(180) NOT NULL,
    category VARCHAR(80) NOT NULL, file_ref VARCHAR(400) NOT NULL, uploaded_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_projdoc_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_projdoc_user FOREIGN KEY(uploaded_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS project_team (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, employee_id BIGINT UNSIGNED NOT NULL,
    project_role VARCHAR(120) NOT NULL, assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, released_at DATE NULL,
    CONSTRAINT fk_team_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_team_employee FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    UNIQUE KEY uq_project_member(project_id,employee_id)
  ) ENGINE=InnoDB`);
}

/** 2.5 BOQ & Estimation. */
async function createBoqTables() {
  await query(`CREATE TABLE IF NOT EXISTS boqs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, reference VARCHAR(60) NOT NULL UNIQUE,
    title VARCHAR(180) NOT NULL, version INT UNSIGNED NOT NULL DEFAULT 1,
    status ENUM('Draft','Submitted','Approved','Rejected') NOT NULL DEFAULT 'Draft',
    total DECIMAL(15,2) NOT NULL DEFAULT 0, prepared_by BIGINT UNSIGNED NOT NULL, approved_by BIGINT UNSIGNED NULL,
    approved_at DATETIME NULL, notes VARCHAR(1000) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_boq_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_boq_preparer FOREIGN KEY(prepared_by) REFERENCES users(id),
    CONSTRAINT fk_boq_approver FOREIGN KEY(approved_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS boq_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, boq_id BIGINT UNSIGNED NOT NULL,
    category ENUM('Material','Labour','Equipment','Subcontract','Overhead') NOT NULL, description VARCHAR(300) NOT NULL,
    unit VARCHAR(30) NOT NULL, quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) NOT NULL,
    amount DECIMAL(15,2) NOT NULL, material_id BIGINT UNSIGNED NULL,
    CONSTRAINT fk_boqitem_boq FOREIGN KEY(boq_id) REFERENCES boqs(id) ON DELETE CASCADE,
    CONSTRAINT fk_boqitem_material FOREIGN KEY(material_id) REFERENCES materials(id), INDEX idx_boqitem_boq(boq_id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS variation_orders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, boq_id BIGINT UNSIGNED NULL,
    reference VARCHAR(60) NOT NULL UNIQUE, description VARCHAR(600) NOT NULL, amount DECIMAL(15,2) NOT NULL,
    status ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending', raised_by BIGINT UNSIGNED NOT NULL,
    approved_by BIGINT UNSIGNED NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_vo_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_vo_boq FOREIGN KEY(boq_id) REFERENCES boqs(id),
    CONSTRAINT fk_vo_raiser FOREIGN KEY(raised_by) REFERENCES users(id),
    CONSTRAINT fk_vo_approver FOREIGN KEY(approved_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS project_cost_forecasts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, boq_item_id BIGINT UNSIGNED NOT NULL,
    forecast_quantity DECIMAL(14,3) NULL, forecast_rate DECIMAL(14,2) NULL, forecast_amount DECIMAL(15,2) NOT NULL,
    reason VARCHAR(600) NOT NULL, updated_by BIGINT UNSIGNED NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_costforecast_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_costforecast_item FOREIGN KEY(boq_item_id) REFERENCES boq_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_costforecast_user FOREIGN KEY(updated_by) REFERENCES users(id),
    UNIQUE KEY uq_costforecast_item(boq_item_id), INDEX idx_costforecast_project(project_id)
  ) ENGINE=InnoDB`);
}

/** 2.7 Purchase Management. */
async function createPurchasingTables() {
  await query(`CREATE TABLE IF NOT EXISTS suppliers (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(180) NOT NULL UNIQUE, contact_person VARCHAR(120) NULL,
    phone VARCHAR(40) NULL, email VARCHAR(190) NULL, address VARCHAR(400) NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS purchase_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, reference VARCHAR(60) NOT NULL UNIQUE, project_id BIGINT UNSIGNED NOT NULL,
    needed_by DATE NOT NULL, notes VARCHAR(600) NULL, status ENUM('Pending','Approved','Rejected','Ordered') NOT NULL DEFAULT 'Pending',
    requested_by BIGINT UNSIGNED NOT NULL, decided_by BIGINT UNSIGNED NULL, decided_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_pr_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_pr_requester FOREIGN KEY(requested_by) REFERENCES users(id),
    CONSTRAINT fk_pr_decider FOREIGN KEY(decided_by) REFERENCES users(id), INDEX idx_pr_status(status)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS purchase_request_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, request_id BIGINT UNSIGNED NOT NULL, material_id BIGINT UNSIGNED NULL,
    description VARCHAR(300) NOT NULL, unit VARCHAR(30) NOT NULL, quantity DECIMAL(14,3) NOT NULL,
    estimated_rate DECIMAL(14,2) NOT NULL DEFAULT 0,
    CONSTRAINT fk_pritem_request FOREIGN KEY(request_id) REFERENCES purchase_requests(id) ON DELETE CASCADE,
    CONSTRAINT fk_pritem_material FOREIGN KEY(material_id) REFERENCES materials(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS quotations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, request_id BIGINT UNSIGNED NOT NULL, supplier_id BIGINT UNSIGNED NOT NULL,
    amount DECIMAL(15,2) NOT NULL, lead_time_days INT UNSIGNED NOT NULL DEFAULT 0, notes VARCHAR(600) NULL,
    selected BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_quote_request FOREIGN KEY(request_id) REFERENCES purchase_requests(id) ON DELETE CASCADE,
    CONSTRAINT fk_quote_supplier FOREIGN KEY(supplier_id) REFERENCES suppliers(id),
    UNIQUE KEY uq_request_supplier(request_id,supplier_id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS purchase_orders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, reference VARCHAR(60) NOT NULL UNIQUE, request_id BIGINT UNSIGNED NULL,
    supplier_id BIGINT UNSIGNED NOT NULL, project_id BIGINT UNSIGNED NOT NULL, order_date DATE NOT NULL,
    total DECIMAL(15,2) NOT NULL DEFAULT 0, status ENUM('Issued','Partially received','Received','Cancelled') NOT NULL DEFAULT 'Issued',
    issued_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_po_request FOREIGN KEY(request_id) REFERENCES purchase_requests(id),
    CONSTRAINT fk_po_supplier FOREIGN KEY(supplier_id) REFERENCES suppliers(id),
    CONSTRAINT fk_po_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_po_user FOREIGN KEY(issued_by) REFERENCES users(id), INDEX idx_po_status(status)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS purchase_order_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id BIGINT UNSIGNED NOT NULL, material_id BIGINT UNSIGNED NULL,
    description VARCHAR(300) NOT NULL, unit VARCHAR(30) NOT NULL, quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) NOT NULL,
    received_quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
    CONSTRAINT fk_poitem_order FOREIGN KEY(order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
    CONSTRAINT fk_poitem_material FOREIGN KEY(material_id) REFERENCES materials(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS goods_receipts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id BIGINT UNSIGNED NOT NULL, received_by BIGINT UNSIGNED NOT NULL,
    notes VARCHAR(500) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_grn_order FOREIGN KEY(order_id) REFERENCES purchase_orders(id) ON DELETE CASCADE,
    CONSTRAINT fk_grn_user FOREIGN KEY(received_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS supplier_invoices (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id BIGINT UNSIGNED NULL, supplier_id BIGINT UNSIGNED NOT NULL,
    invoice_no VARCHAR(80) NOT NULL, amount DECIMAL(15,2) NOT NULL, paid_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    invoice_date DATE NOT NULL, due_date DATE NULL, status ENUM('Unpaid','Partially paid','Paid') NOT NULL DEFAULT 'Unpaid',
    recorded_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_invoice_order FOREIGN KEY(order_id) REFERENCES purchase_orders(id),
    CONSTRAINT fk_invoice_supplier FOREIGN KEY(supplier_id) REFERENCES suppliers(id),
    CONSTRAINT fk_invoice_user FOREIGN KEY(recorded_by) REFERENCES users(id),
    UNIQUE KEY uq_supplier_invoice(supplier_id,invoice_no)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS supplier_payments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, invoice_id BIGINT UNSIGNED NOT NULL, amount DECIMAL(15,2) NOT NULL,
    paid_date DATE NOT NULL, method ENUM('Cash','Cheque','Bank transfer','Card') NOT NULL DEFAULT 'Bank transfer',
    reference VARCHAR(120) NULL, created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_payment_invoice FOREIGN KEY(invoice_id) REFERENCES supplier_invoices(id) ON DELETE CASCADE,
    CONSTRAINT fk_payment_user FOREIGN KEY(created_by) REFERENCES users(id), CONSTRAINT chk_payment_amount CHECK(amount > 0)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS issued_cheques (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    supplier_id BIGINT UNSIGNED NULL, invoice_id BIGINT UNSIGNED NULL,
    cheque_number VARCHAR(80) NOT NULL, bank VARCHAR(180) NOT NULL, payee VARCHAR(180) NOT NULL,
    purpose VARCHAR(400) NOT NULL, amount DECIMAL(15,2) NOT NULL,
    issue_date DATE NOT NULL, cheque_date DATE NOT NULL, reminder_days SMALLINT UNSIGNED NOT NULL DEFAULT 3,
    status ENUM('Prepared','Issued','Cleared','Returned','Cancelled','Replaced') NOT NULL DEFAULT 'Issued',
    notes VARCHAR(600) NULL, confirmed_at DATETIME NULL, confirmed_by BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_cheque_supplier FOREIGN KEY(supplier_id) REFERENCES suppliers(id),
    CONSTRAINT fk_cheque_invoice FOREIGN KEY(invoice_id) REFERENCES supplier_invoices(id),
    CONSTRAINT fk_cheque_confirmer FOREIGN KEY(confirmed_by) REFERENCES users(id),
    CONSTRAINT fk_cheque_creator FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT chk_cheque_amount CHECK(amount > 0), UNIQUE KEY uq_cheque_bank_number(bank,cheque_number),
    INDEX idx_cheque_followup(status,cheque_date)
  ) ENGINE=InnoDB`);
}

/** 2.8 Fleet compliance + 2.9 Equipment. */
async function createAssetTables() {
  await query(`CREATE TABLE IF NOT EXISTS vehicle_documents (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, vehicle_id BIGINT UNSIGNED NOT NULL,
    doc_type ENUM('Insurance','Revenue licence','Emission test','Service','Fitness certificate') NOT NULL,
    reference VARCHAR(120) NULL, expiry_date DATE NOT NULL, cost DECIMAL(12,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_vehdoc_vehicle FOREIGN KEY(vehicle_id) REFERENCES fleet(id) ON DELETE CASCADE,
    UNIQUE KEY uq_vehicle_doc(vehicle_id,doc_type), INDEX idx_vehdoc_expiry(expiry_date)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS fuel_records (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, vehicle_id BIGINT UNSIGNED NOT NULL, project_id BIGINT UNSIGNED NULL,
    fuel_date DATE NOT NULL, litres DECIMAL(10,2) NOT NULL, cost DECIMAL(12,2) NOT NULL, odometer INT UNSIGNED NOT NULL DEFAULT 0,
    driver VARCHAR(120) NULL, created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_fuel_vehicle FOREIGN KEY(vehicle_id) REFERENCES fleet(id) ON DELETE CASCADE,
    CONSTRAINT fk_fuel_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_fuel_user FOREIGN KEY(created_by) REFERENCES users(id), CONSTRAINT chk_fuel_litres CHECK(litres > 0)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS vehicle_maintenance (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, vehicle_id BIGINT UNSIGNED NOT NULL, service_date DATE NOT NULL,
    description VARCHAR(400) NOT NULL, cost DECIMAL(12,2) NOT NULL DEFAULT 0, garage VARCHAR(180) NULL,
    odometer INT UNSIGNED NOT NULL DEFAULT 0, created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_vehmaint_vehicle FOREIGN KEY(vehicle_id) REFERENCES fleet(id) ON DELETE CASCADE,
    CONSTRAINT fk_vehmaint_user FOREIGN KEY(created_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS equipment (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, code VARCHAR(40) NOT NULL UNIQUE, name VARCHAR(180) NOT NULL,
    category VARCHAR(100) NOT NULL, status ENUM('Available','Assigned','Maintenance','Retired') NOT NULL DEFAULT 'Available',
    purchase_date DATE NULL, purchase_cost DECIMAL(14,2) NOT NULL DEFAULT 0, notes VARCHAR(600) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS equipment_assignments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, equipment_id BIGINT UNSIGNED NOT NULL, project_id BIGINT UNSIGNED NOT NULL,
    assigned_to VARCHAR(120) NOT NULL, assigned_at DATE NOT NULL, returned_at DATE NULL, condition_note VARCHAR(500) NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_eqassign_equipment FOREIGN KEY(equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
    CONSTRAINT fk_eqassign_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_eqassign_user FOREIGN KEY(created_by) REFERENCES users(id), INDEX idx_eqassign_open(equipment_id,returned_at)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS equipment_maintenance (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, equipment_id BIGINT UNSIGNED NOT NULL,
    maintenance_type ENUM('Service','Repair','Inspection') NOT NULL, performed_at DATE NOT NULL,
    cost DECIMAL(12,2) NOT NULL DEFAULT 0, notes VARCHAR(600) NULL, created_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_eqmaint_equipment FOREIGN KEY(equipment_id) REFERENCES equipment(id) ON DELETE CASCADE,
    CONSTRAINT fk_eqmaint_user FOREIGN KEY(created_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
}

/** 2.10 Finance. */
async function createFinanceTables() {
  await query(`CREATE TABLE IF NOT EXISTS expense_categories (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS expenses (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, category_id BIGINT UNSIGNED NULL,
    source ENUM('Material','Labour','Fuel','Equipment','Subcontractor','Overhead','Other') NOT NULL DEFAULT 'Other',
    description VARCHAR(400) NOT NULL, amount DECIMAL(15,2) NOT NULL, expense_date DATE NOT NULL, reference VARCHAR(120) NULL,
    origin_type VARCHAR(60) NULL, origin_id VARCHAR(60) NULL, boq_item_id BIGINT UNSIGNED NULL,
    cost_type ENUM('Expected','Variation','Unexpected') NOT NULL DEFAULT 'Expected',
    quantity DECIMAL(14,3) NULL, unit VARCHAR(30) NULL, unit_rate DECIMAL(14,2) NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_expense_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_expense_category FOREIGN KEY(category_id) REFERENCES expense_categories(id),
    CONSTRAINT fk_expense_user FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT fk_expense_boq_item FOREIGN KEY(boq_item_id) REFERENCES boq_items(id),
    CONSTRAINT chk_expense_amount CHECK(amount > 0), INDEX idx_expense_project(project_id,expense_date)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS incomes (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL, description VARCHAR(400) NOT NULL,
    amount DECIMAL(15,2) NOT NULL, received_date DATE NOT NULL,
    method ENUM('Cash','Cheque','Bank transfer','Card') NOT NULL DEFAULT 'Bank transfer', reference VARCHAR(120) NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_income_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_income_user FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT chk_income_amount CHECK(amount > 0), INDEX idx_income_project(project_id,received_date)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS operating_bills (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, company_id TINYINT UNSIGNED NOT NULL,
    project_id BIGINT UNSIGNED NULL, bill_type VARCHAR(80) NOT NULL, provider VARCHAR(180) NOT NULL,
    account_number VARCHAR(100) NULL, reference VARCHAR(100) NOT NULL, period_from DATE NULL, period_to DATE NULL,
    bill_date DATE NOT NULL, due_date DATE NOT NULL, net_amount DECIMAL(15,2) NOT NULL,
    tax_treatment ENUM('Standard','Exempt') NOT NULL DEFAULT 'Standard', vat_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    vat_amount DECIMAL(15,2) NOT NULL DEFAULT 0, total_amount DECIMAL(15,2) NOT NULL,
    reminder_days SMALLINT UNSIGNED NOT NULL DEFAULT 5,
    status ENUM('Unpaid','Paid','Cancelled') NOT NULL DEFAULT 'Unpaid', paid_date DATE NULL,
    payment_method VARCHAR(60) NULL, payment_reference VARCHAR(120) NULL, notes VARCHAR(600) NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_operating_bill_company FOREIGN KEY(company_id) REFERENCES companies(id),
    CONSTRAINT fk_operating_bill_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_operating_bill_user FOREIGN KEY(created_by) REFERENCES users(id),
    UNIQUE KEY uq_operating_bill(company_id,provider,reference), INDEX idx_operating_bill_due(company_id,status,due_date)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS company_credit_cards (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, company_id TINYINT UNSIGNED NOT NULL,
    name VARCHAR(120) NOT NULL, bank VARCHAR(180) NOT NULL, last_four CHAR(4) NOT NULL,
    cardholder VARCHAR(180) NOT NULL, credit_limit DECIMAL(15,2) NOT NULL DEFAULT 0,
    default_reminder_days SMALLINT UNSIGNED NOT NULL DEFAULT 5, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_credit_card_company FOREIGN KEY(company_id) REFERENCES companies(id),
    CONSTRAINT fk_credit_card_user FOREIGN KEY(created_by) REFERENCES users(id),
    UNIQUE KEY uq_company_card(company_id,bank,last_four)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS credit_card_statements (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, card_id BIGINT UNSIGNED NOT NULL,
    statement_date DATE NOT NULL, period_from DATE NULL, period_to DATE NULL, due_date DATE NOT NULL,
    amount DECIMAL(15,2) NOT NULL, minimum_due DECIMAL(15,2) NOT NULL DEFAULT 0,
    paid_amount DECIMAL(15,2) NOT NULL DEFAULT 0, reminder_days SMALLINT UNSIGNED NOT NULL DEFAULT 5,
    status ENUM('Unpaid','Partially paid','Paid','Cancelled') NOT NULL DEFAULT 'Unpaid', notes VARCHAR(600) NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_card_statement_card FOREIGN KEY(card_id) REFERENCES company_credit_cards(id) ON DELETE CASCADE,
    CONSTRAINT fk_card_statement_user FOREIGN KEY(created_by) REFERENCES users(id),
    UNIQUE KEY uq_card_statement(card_id,statement_date), INDEX idx_card_statement_due(status,due_date)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS credit_card_payments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, statement_id BIGINT UNSIGNED NOT NULL,
    amount DECIMAL(15,2) NOT NULL, paid_date DATE NOT NULL, method VARCHAR(60) NOT NULL,
    reference VARCHAR(120) NULL, created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_card_payment_statement FOREIGN KEY(statement_id) REFERENCES credit_card_statements(id) ON DELETE CASCADE,
    CONSTRAINT fk_card_payment_user FOREIGN KEY(created_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
}

/** 2.11 Daily site report detail. */
async function createReportDetailTables() {
  await query(`CREATE TABLE IF NOT EXISTS report_materials (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, report_id BIGINT UNSIGNED NOT NULL, material_id BIGINT UNSIGNED NOT NULL,
    quantity DECIMAL(14,3) NOT NULL,
    CONSTRAINT fk_repmat_report FOREIGN KEY(report_id) REFERENCES daily_reports(id) ON DELETE CASCADE,
    CONSTRAINT fk_repmat_material FOREIGN KEY(material_id) REFERENCES materials(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS report_equipment (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, report_id BIGINT UNSIGNED NOT NULL, equipment_id BIGINT UNSIGNED NOT NULL,
    hours DECIMAL(6,2) NOT NULL DEFAULT 0,
    CONSTRAINT fk_repeq_report FOREIGN KEY(report_id) REFERENCES daily_reports(id) ON DELETE CASCADE,
    CONSTRAINT fk_repeq_equipment FOREIGN KEY(equipment_id) REFERENCES equipment(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS report_photos (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, report_id BIGINT UNSIGNED NOT NULL, caption VARCHAR(200) NULL,
    file_ref VARCHAR(400) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_repphoto_report FOREIGN KEY(report_id) REFERENCES daily_reports(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
}

/** Uploaded files. One table for every module so storage rules live in one place. */
async function createAttachmentTables() {
  await query(`CREATE TABLE IF NOT EXISTS attachments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    owner_type ENUM('task','project','employee','report','vehicle','equipment') NOT NULL,
    owner_id BIGINT UNSIGNED NOT NULL, storage_key VARCHAR(400) NOT NULL, url VARCHAR(600) NOT NULL,
    filename VARCHAR(200) NOT NULL, mime VARCHAR(120) NOT NULL, size_bytes BIGINT UNSIGNED NOT NULL,
    title VARCHAR(200) NULL, category VARCHAR(80) NULL, kind ENUM('File','Site photo') NOT NULL DEFAULT 'File',
    expiry_date DATE NULL, uploaded_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_upload_user FOREIGN KEY(uploaded_by) REFERENCES users(id),
    INDEX idx_attachment_owner(owner_type,owner_id), INDEX idx_attachment_expiry(expiry_date)
  ) ENGINE=InnoDB`);
}

/** 2.2 payroll and performance, and PID section 3 step 1 (customer inquiry). */
async function createLifecycleTables() {
  await query(`CREATE TABLE IF NOT EXISTS inquiries (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, reference VARCHAR(60) NOT NULL UNIQUE,
    customer_name VARCHAR(180) NOT NULL, contact_person VARCHAR(120) NULL, phone VARCHAR(40) NULL, email VARCHAR(190) NULL,
    location VARCHAR(180) NOT NULL, description TEXT NOT NULL, expected_value DECIMAL(15,2) NOT NULL DEFAULT 0,
    expected_start DATE NULL, source VARCHAR(80) NULL,
    status ENUM('New','In discussion','Quoted','Won','Lost') NOT NULL DEFAULT 'New',
    project_id BIGINT UNSIGNED NULL, lost_reason VARCHAR(400) NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_inquiry_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_inquiry_user FOREIGN KEY(created_by) REFERENCES users(id), INDEX idx_inquiry_status(status)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS payroll_runs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, reference VARCHAR(60) NOT NULL UNIQUE,
    period_start DATE NOT NULL, period_end DATE NOT NULL, pay_frequency ENUM('Daily','Weekly','Monthly') NOT NULL DEFAULT 'Monthly',
    policy_id BIGINT UNSIGNED NULL, status ENUM('Draft','Approved','Paid') NOT NULL DEFAULT 'Draft',
    total DECIMAL(15,2) NOT NULL DEFAULT 0, created_by BIGINT UNSIGNED NOT NULL, approved_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_payroll_user FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT fk_payroll_approver FOREIGN KEY(approved_by) REFERENCES users(id),
    CONSTRAINT fk_payroll_policy FOREIGN KEY(policy_id) REFERENCES payroll_policies(id),
    UNIQUE KEY uq_payroll_period_frequency(period_start,period_end,pay_frequency)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS payslips (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, run_id BIGINT UNSIGNED NOT NULL, employee_id BIGINT UNSIGNED NOT NULL,
    days_present DECIMAL(5,1) NOT NULL DEFAULT 0, days_absent DECIMAL(5,1) NOT NULL DEFAULT 0,
    overtime_hours DECIMAL(7,2) NOT NULL DEFAULT 0, basic DECIMAL(12,2) NOT NULL DEFAULT 0,
    overtime_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
    office_ot_hours DECIMAL(7,2) NOT NULL DEFAULT 0, office_ot_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
    site_ot_hours DECIMAL(7,2) NOT NULL DEFAULT 0, site_ot_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
    travel_ot_hours DECIMAL(7,2) NOT NULL DEFAULT 0, travel_ot_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
    allowance_total DECIMAL(12,2) NOT NULL DEFAULT 0, reimbursement_total DECIMAL(12,2) NOT NULL DEFAULT 0,
    gross_earnings DECIMAL(12,2) NOT NULL DEFAULT 0,
    epf_employee_deduction DECIMAL(12,2) NOT NULL DEFAULT 0,
    epf_employer_contribution DECIMAL(12,2) NOT NULL DEFAULT 0,
    etf_employer_contribution DECIMAL(12,2) NOT NULL DEFAULT 0,
    other_deduction DECIMAL(12,2) NOT NULL DEFAULT 0,
    unpaid_leave_deduction DECIMAL(12,2) NOT NULL DEFAULT 0,
    salary_advance_deduction DECIMAL(12,2) NOT NULL DEFAULT 0,
    deductions DECIMAL(12,2) NOT NULL DEFAULT 0,
    net_pay DECIMAL(12,2) NOT NULL DEFAULT 0, employer_cost DECIMAL(12,2) NOT NULL DEFAULT 0,
    CONSTRAINT fk_payslip_run FOREIGN KEY(run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
    CONSTRAINT fk_payslip_employee FOREIGN KEY(employee_id) REFERENCES employees(id),
    UNIQUE KEY uq_run_employee(run_id,employee_id)
  ) ENGINE=InnoDB`);
  await addColumn('payslips', 'unpaid_leave_deduction', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'salary_advance_deduction', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payroll_runs', 'pay_frequency', "ENUM('Daily','Weekly','Monthly') NOT NULL DEFAULT 'Monthly'");
  await addColumn('payroll_runs', 'policy_id', 'BIGINT UNSIGNED NULL');
  await addForeignKey('payroll_runs', 'fk_payroll_policy', 'CONSTRAINT fk_payroll_policy FOREIGN KEY(policy_id) REFERENCES payroll_policies(id)');
  await dropIndex('payroll_runs', 'uq_payroll_period');
  await addIndex('payroll_runs', 'uq_payroll_period_frequency', 'UNIQUE KEY uq_payroll_period_frequency(period_start,period_end,pay_frequency)');
  await addColumn('payslips', 'office_ot_hours', 'DECIMAL(7,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'office_ot_pay', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'site_ot_hours', 'DECIMAL(7,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'site_ot_pay', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'travel_ot_hours', 'DECIMAL(7,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'travel_ot_pay', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'allowance_total', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'reimbursement_total', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'gross_earnings', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'epf_employee_deduction', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'epf_employer_contribution', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'etf_employer_contribution', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'other_deduction', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('payslips', 'employer_cost', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  /* Existing salary sheets predate typed overtime and employer-cost reporting. Preserve
     their stored totals while presenting them through the expanded breakdown. */
  await query(`UPDATE payslips SET site_ot_hours=overtime_hours,site_ot_pay=overtime_pay
    WHERE office_ot_hours=0 AND site_ot_hours=0 AND travel_ot_hours=0 AND overtime_hours<>0`);
  await query(`UPDATE payslips SET gross_earnings=basic+overtime_pay
    WHERE gross_earnings=0 AND (basic<>0 OR overtime_pay<>0)`);
  await query(`UPDATE payslips SET employer_cost=gross_earnings
    WHERE employer_cost=0 AND gross_earnings<>0`);
  await query(`CREATE TABLE IF NOT EXISTS payslip_components (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, payslip_id BIGINT UNSIGNED NOT NULL,
    source_component_id BIGINT UNSIGNED NULL, name VARCHAR(120) NOT NULL,
    kind ENUM('Allowance','Deduction','Reimbursement') NOT NULL, amount DECIMAL(12,2) NOT NULL,
    CONSTRAINT fk_slip_component_payslip FOREIGN KEY(payslip_id) REFERENCES payslips(id) ON DELETE CASCADE,
    CONSTRAINT fk_slip_component_source FOREIGN KEY(source_component_id) REFERENCES employee_pay_components(id),
    INDEX idx_slip_components(payslip_id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS performance_reviews (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, employee_id BIGINT UNSIGNED NOT NULL, review_date DATE NOT NULL,
    period VARCHAR(60) NOT NULL, quality TINYINT UNSIGNED NOT NULL, productivity TINYINT UNSIGNED NOT NULL,
    safety TINYINT UNSIGNED NOT NULL, reliability TINYINT UNSIGNED NOT NULL, overall DECIMAL(3,1) NOT NULL,
    strengths VARCHAR(1000) NULL, improvements VARCHAR(1000) NULL, reviewer_id BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_review_employee FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_review_user FOREIGN KEY(reviewer_id) REFERENCES users(id),
    CONSTRAINT chk_review_scores CHECK(quality BETWEEN 1 AND 5 AND productivity BETWEEN 1 AND 5
      AND safety BETWEEN 1 AND 5 AND reliability BETWEEN 1 AND 5)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS notification_deliveries (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, notification_id BIGINT UNSIGNED NOT NULL,
    channel ENUM('WhatsApp','SMS','Email') NOT NULL, recipient VARCHAR(190) NOT NULL,
    status ENUM('Queued','Sent','Failed','Skipped') NOT NULL DEFAULT 'Queued', provider VARCHAR(60) NULL,
    detail VARCHAR(500) NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_delivery_notification FOREIGN KEY(notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
    INDEX idx_delivery_status(status)
  ) ENGINE=InnoDB`);
}

/** PID v3 §2.2 — roles and permissions live in data so the MD can change them at runtime. */
async function createAccessTables() {
  await query(`CREATE TABLE IF NOT EXISTS roles (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE,
    description VARCHAR(400) NULL, is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS role_permissions (
    role_id BIGINT UNSIGNED NOT NULL, permission_key VARCHAR(80) NOT NULL,
    PRIMARY KEY(role_id,permission_key),
    CONSTRAINT fk_roleperm_role FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  /* Delegation: the MD hands one authority to one person, optionally for a limited time. */
  await query(`CREATE TABLE IF NOT EXISTS user_permissions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL,
    permission_key VARCHAR(80) NOT NULL, effect ENUM('Grant','Revoke') NOT NULL DEFAULT 'Grant',
    reason VARCHAR(400) NULL, expires_at DATE NULL, granted_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_userperm_user FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_userperm_granter FOREIGN KEY(granted_by) REFERENCES users(id),
    UNIQUE KEY uq_user_permission(user_id,permission_key)
  ) ENGINE=InnoDB`);
}

/** PID v3 §4.3 — the two-site scheduling problem: status, the reason, and who moved where. */
async function createSiteOpsTables() {
  await query(`CREATE TABLE IF NOT EXISTS site_status_log (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL,
    from_status VARCHAR(40) NULL, to_status VARCHAR(40) NOT NULL,
    reason VARCHAR(500) NOT NULL, effective_date DATE NULL,
    notified INT UNSIGNED NOT NULL DEFAULT 0, changed_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_sitelog_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_sitelog_user FOREIGN KEY(changed_by) REFERENCES users(id),
    INDEX idx_sitelog_project(project_id,created_at)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS resource_reassignments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    resource_type ENUM('Labour','Driver','Vehicle','Equipment') NOT NULL, resource_id BIGINT UNSIGNED NOT NULL,
    resource_name VARCHAR(180) NOT NULL, from_project_id BIGINT UNSIGNED NULL, to_project_id BIGINT UNSIGNED NULL,
    reason VARCHAR(500) NULL, moved_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_reassign_from FOREIGN KEY(from_project_id) REFERENCES projects(id),
    CONSTRAINT fk_reassign_to FOREIGN KEY(to_project_id) REFERENCES projects(id),
    CONSTRAINT fk_reassign_user FOREIGN KEY(moved_by) REFERENCES users(id),
    INDEX idx_reassign_created(created_at)
  ) ENGINE=InnoDB`);
}

/** PID v3 §3.3 — QS: quotations built from the BOQ, tender filing, retention, subcontractors. */
/**
 * Who GKUC is, as it should appear on anything sent to a client.
 *
 * Kept as one editable record rather than constants in the code: a TIN, an address or a
 * bank account changes without a developer, and every document has to change with it. One
 * row, so there is never a question of which set of details is current.
 */
/**
 * One counter per document series and year. Exists so a reference can be reserved in a
 * single atomic statement rather than by reading the last one and adding to it.
 */
async function createSequenceTable() {
  await query(`CREATE TABLE IF NOT EXISTS document_sequences (
    scope VARCHAR(40) PRIMARY KEY,
    next_value INT UNSIGNED NOT NULL DEFAULT 1
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function createCompanyTable() {
  await query(`CREATE TABLE IF NOT EXISTS company_settings (
    id TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
    name VARCHAR(180) NOT NULL,
    address VARCHAR(400) NOT NULL DEFAULT '',
    telephone VARCHAR(120) NOT NULL DEFAULT '',
    email VARCHAR(180) NOT NULL DEFAULT '',
    tin VARCHAR(40) NOT NULL DEFAULT '',
    vat_number VARCHAR(40) NOT NULL DEFAULT '',
    bank_details VARCHAR(400) NOT NULL DEFAULT '',
    quotation_terms TEXT NULL,
    vat_percent DECIMAL(6,2) NOT NULL DEFAULT 18,
    updated_by BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT one_company CHECK (id = 1)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* Seeded with what is publicly known and blanks for the rest, so the document renders
     from day one and the MD fills in the tax numbers when they have them. */
  await query(`INSERT IGNORE INTO company_settings (id,name,address,telephone,email,quotation_terms)
    VALUES (1,'G.K.U.C. Construction (Pvt) Ltd','','','',?)`,
  ['Validity: 30 days from the date of this quotation.\nPayment: as per the agreed payment schedule.\nThis quotation is subject to the conditions of contract agreed between both parties.']);
}

/**
 * How documents should look and what they should say.
 *
 * Separate from the company's identity because these are presentation choices GKUC will
 * want to change — the accent colour to match their letterhead, whether a bill of
 * quantities carries signature lines, what standing text sits under each type. Kept as one
 * row for the same reason as the company details: there is only ever one current answer.
 */
async function createDocumentSettingsTable() {
  await query(`CREATE TABLE IF NOT EXISTS document_settings (
    id TINYINT UNSIGNED PRIMARY KEY DEFAULT 1,
    accent_colour CHAR(7) NOT NULL DEFAULT '#16305c',
    paper_size ENUM('A4','Letter') NOT NULL DEFAULT 'A4',
    show_logo TINYINT(1) NOT NULL DEFAULT 1,
    show_signatures TINYINT(1) NOT NULL DEFAULT 1,
    show_amount_in_words TINYINT(1) NOT NULL DEFAULT 1,
    show_bank_details TINYINT(1) NOT NULL DEFAULT 1,
    footer_note VARCHAR(300) NOT NULL DEFAULT '',
    quotation_terms TEXT NULL,
    boq_terms TEXT NULL,
    invoice_terms TEXT NULL,
    updated_by BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT one_document_settings CHECK (id = 1)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query('INSERT IGNORE INTO document_settings (id) VALUES (1)');
  /* The whole design — page, palette, type, and the order and styling of every block — as
     one document, because it is edited as one thing and read as one thing. */
  await addColumn('document_settings', 'design', 'JSON NULL');

  /* The terms already typed against the company move across, so nothing is lost. */
  await query(`UPDATE document_settings d
    JOIN company_settings c ON c.id=1
    SET d.quotation_terms = COALESCE(d.quotation_terms, c.quotation_terms)
    WHERE d.id=1 AND d.quotation_terms IS NULL`);
}

/**
 * The methods GKUC sells, and what each one costs.
 *
 * Their small-works quotations are not built from a bill of quantities at all: the same
 * yard can be surfaced by tarring, by asphalt carpet, by cold mix or in concrete, and a
 * quotation usually offers two or three of those side by side so the client can choose. So
 * the quotation is assembled from a catalogue of methods rather than from measured items —
 * each carrying its own unit, its usual rate, the steps it involves, and how it is paid for.
 *
 * The rate is a starting point, not a fixed price: the same method was quoted at 350, 380,
 * 390 and 400 a square foot across these jobs, because area and location move it.
 */
/**
 * PID v3 §3.5 — "Client coordination and communication history".
 *
 * Every call, message, meeting and site visit against the client it concerns, so a
 * relationship is not held in one person's memory or their own phone. A record attaches to
 * an enquiry, to a project, or to both: an enquiry that becomes a project should not lose
 * the conversations that won it, so once converted the earlier history follows the project.
 */
/*
 * The project gallery.
 *
 * This is not a photo album, it is evidence. The client photographs every corner of a plot
 * before a spade goes in — "to prove how it was" — and keeps adding through the job until
 * handover. If a dispute follows, these pictures answer it, so what matters is not that the
 * date is displayed but that it cannot be moved.
 *
 * Three things are therefore fixed once written: when the photo was received, the object it
 * points at, and the checksum of that object. A caption can be corrected, and a photo can be
 * withdrawn from view, but neither the clock nor the file behind it can be rewritten — and
 * a withdrawn photo leaves its record behind, so the gallery cannot be quietly thinned out.
 */
async function hardenSessions() {
  /* Sessions expired 12 hours after sign-in whatever happened in between, so a browser left
     open on a site office desk stayed usable all day. Recording last use lets an idle one
     lapse on its own. */
  await addColumn('sessions', 'last_seen_at', 'DATETIME NULL');
  await addColumn('sessions', 'user_agent', 'VARCHAR(255) NULL');
  await addIndex('sessions', 'idx_session_seen', 'INDEX idx_session_seen(last_seen_at)');
}

async function createGalleryTables() {
  await query(`CREATE TABLE IF NOT EXISTS gallery_folders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    name VARCHAR(140) NOT NULL,
    description VARCHAR(400) NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_folder_name (project_id, name),
    CONSTRAINT fk_gallery_folder_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_gallery_folder_user FOREIGN KEY(created_by) REFERENCES users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS gallery_photos (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,
    folder_id BIGINT UNSIGNED NULL,
    storage_key VARCHAR(400) NOT NULL,
    thumb_key VARCHAR(400) NULL,
    filename VARCHAR(255) NOT NULL,
    mime VARCHAR(120) NOT NULL,
    size_bytes INT UNSIGNED NOT NULL,
    checksum CHAR(64) NOT NULL,
    caption VARCHAR(400) NULL,
    /* Set by the server on receipt. No route accepts it and the trigger below refuses to
       let it change, so "the date and time can never be edited from anywhere" holds even
       against someone with a database client. */
    captured_at DATETIME NOT NULL,
    uploaded_by BIGINT UNSIGNED NOT NULL,
    removed_at DATETIME NULL,
    removed_by BIGINT UNSIGNED NULL,
    removed_reason VARCHAR(300) NULL,
    CONSTRAINT fk_gallery_photo_project FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CONSTRAINT fk_gallery_photo_folder FOREIGN KEY(folder_id) REFERENCES gallery_folders(id) ON DELETE SET NULL,
    CONSTRAINT fk_gallery_photo_user FOREIGN KEY(uploaded_by) REFERENCES users(id),
    INDEX idx_gallery_project (project_id, folder_id),
    INDEX idx_gallery_taken (project_id, captured_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await lockGalleryTimestamps();
}

/*
 * Enforced by the database, not only by the routes.
 *
 * A guard that lives in application code is a guard that a future endpoint, a migration
 * script or a person at a SQL prompt can walk straight past. The trigger makes the promise
 * the client was given true of the data itself.
 *
 * If the database user has not been granted TRIGGER, the application still runs and the
 * routes still refuse to touch these columns — but the stronger guarantee is not in force,
 * so it says so loudly rather than pretending.
 */
async function lockGalleryTimestamps() {
  const existing = await query(
    `SELECT TRIGGER_NAME FROM information_schema.triggers
     WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='gallery_photo_evidence_lock'`);
  if (existing.length) return;
  try {
    await ddl(`CREATE TRIGGER gallery_photo_evidence_lock BEFORE UPDATE ON gallery_photos
      FOR EACH ROW
      BEGIN
        IF NEW.captured_at <> OLD.captured_at
           OR NEW.storage_key <> OLD.storage_key
           OR NEW.checksum <> OLD.checksum THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'A gallery photo\\'s timestamp, file and checksum are fixed once recorded';
        END IF;
      END`);
  } catch (error) {
    console.warn('Gallery evidence lock not installed (needs the TRIGGER privilege):', error.message);
  }
}

async function createCommunicationTable() {
  await query(`CREATE TABLE IF NOT EXISTS client_communications (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    inquiry_id BIGINT UNSIGNED NULL,
    project_id BIGINT UNSIGNED NULL,
    direction ENUM('Incoming','Outgoing') NOT NULL DEFAULT 'Outgoing',
    channel ENUM('Call','WhatsApp','Email','Meeting','Site visit','Letter') NOT NULL DEFAULT 'Call',
    contact_person VARCHAR(120) NULL,
    summary VARCHAR(1000) NOT NULL,
    happened_at DATETIME NOT NULL,
    follow_up_date DATE NULL,
    logged_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_communication_inquiry (inquiry_id),
    KEY idx_communication_project (project_id),
    KEY idx_communication_followup (follow_up_date)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await addForeignKey('client_communications', 'fk_communication_inquiry',
    'CONSTRAINT fk_communication_inquiry FOREIGN KEY(inquiry_id) REFERENCES inquiries(id)');
  await addForeignKey('client_communications', 'fk_communication_project',
    'CONSTRAINT fk_communication_project FOREIGN KEY(project_id) REFERENCES projects(id)');
  await addForeignKey('client_communications', 'fk_communication_user',
    'CONSTRAINT fk_communication_user FOREIGN KEY(logged_by) REFERENCES users(id)');
}

async function createMethodTables() {
  await query(`CREATE TABLE IF NOT EXISTS work_methods (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(20) NOT NULL,
    name VARCHAR(180) NOT NULL,
    category VARCHAR(60) NOT NULL DEFAULT 'Surfacing',
    description VARCHAR(600) NOT NULL DEFAULT '',
    unit VARCHAR(20) NOT NULL,
    default_rate DECIMAL(14,2) NOT NULL DEFAULT 0,
    method_statement TEXT NULL,
    payment_terms TEXT NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_work_method (name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* A quotation records which methods it offered, so the reference and the method
     statements on the page follow from the work rather than being typed again. */
  await addColumn('quotations_client', 'method_codes', 'VARCHAR(120) NULL');
  await addColumn('quotations_client', 'location', 'VARCHAR(180) NULL');
  await addColumn('quotations_client', 'contact', 'VARCHAR(120) NULL');
  await addColumn('quotations_client', 'payment_terms', 'TEXT NULL');
  await addColumn('quotation_items', 'method_id', 'BIGINT UNSIGNED NULL');
}

async function createQsTables() {
  await query(`CREATE TABLE IF NOT EXISTS quotations_client (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, reference VARCHAR(60) NOT NULL UNIQUE,
    boq_id BIGINT UNSIGNED NULL, project_id BIGINT UNSIGNED NULL, inquiry_id BIGINT UNSIGNED NULL,
    client_name VARCHAR(180) NOT NULL, title VARCHAR(200) NOT NULL, quote_date DATE NOT NULL,
    valid_until DATE NULL, subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
    markup_percent DECIMAL(6,2) NOT NULL DEFAULT 0, vat_percent DECIMAL(6,2) NOT NULL DEFAULT 0,
    total DECIMAL(15,2) NOT NULL DEFAULT 0, notes VARCHAR(1000) NULL,
    status ENUM('Draft','Sent','Accepted','Declined','Expired') NOT NULL DEFAULT 'Draft',
    prepared_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_quote_boq FOREIGN KEY(boq_id) REFERENCES boqs(id),
    CONSTRAINT fk_quote_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_quote_inquiry FOREIGN KEY(inquiry_id) REFERENCES inquiries(id),
    CONSTRAINT fk_quote_user FOREIGN KEY(prepared_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS quotation_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, quotation_id BIGINT UNSIGNED NOT NULL,
    category VARCHAR(40) NOT NULL, description VARCHAR(300) NOT NULL, unit VARCHAR(30) NOT NULL,
    quantity DECIMAL(14,3) NOT NULL, rate DECIMAL(14,2) NOT NULL, amount DECIMAL(15,2) NOT NULL,
    CONSTRAINT fk_quoteitem_quote FOREIGN KEY(quotation_id) REFERENCES quotations_client(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS tenders (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, reference VARCHAR(60) NOT NULL UNIQUE,
    title VARCHAR(220) NOT NULL, client VARCHAR(180) NOT NULL, source VARCHAR(120) NULL,
    closing_date DATE NOT NULL, submitted_date DATE NULL, estimated_value DECIMAL(15,2) NOT NULL DEFAULT 0,
    bid_value DECIMAL(15,2) NOT NULL DEFAULT 0, documents_note VARCHAR(600) NULL,
    status ENUM('Identified','Preparing','Submitted','Won','Lost','Withdrawn') NOT NULL DEFAULT 'Identified',
    outcome_note VARCHAR(600) NULL, project_id BIGINT UNSIGNED NULL,
    owner_id BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_tender_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_tender_user FOREIGN KEY(owner_id) REFERENCES users(id), INDEX idx_tender_closing(closing_date)
  ) ENGINE=InnoDB`);
  /*
   * Everything a Sri Lankan public-works bid actually turns on, taken from the bidding
   * documents GKUC bid against: an RDA sand-sealing contract, a Sabaragamuwa Provincial
   * Council road, and a Department of Buildings package.
   *
   * The employer's own contract number is not our reference — RDA calls one bid
   * "RDA/DDG(RM&M)/EP/CE(T)/RMTF/2025/15" while we file it as TEN-2026-0001 — so both are
   * kept. Bids are submitted by one of two companies (G.K.U.C. Construction and G.K.U.C.
   * Ready Mix), and which one bid matters when the award lands.
   */
  await addColumn('tenders', 'contract_no', 'VARCHAR(120) NULL AFTER reference');
  await addColumn('tenders', 'source_file_key', 'VARCHAR(400) NULL');
  await addColumn('tenders', 'source_filename', 'VARCHAR(190) NULL');
  await addColumn('tenders', 'source_checksum', 'CHAR(64) NULL');
  await addColumn('tenders', 'bidding_entity', "VARCHAR(120) NULL");
  await addColumn('tenders', 'procurement_method', "ENUM('National Competitive Bidding','International Competitive Bidding','Shopping','Direct') NOT NULL DEFAULT 'National Competitive Bidding'");
  await addColumn('tenders', 'specialty', "ENUM('Highways','Bridges','Buildings','Irrigation','Water Supply','Other') NOT NULL DEFAULT 'Highways'");
  await addColumn('tenders', 'cida_grade', 'VARCHAR(40) NULL');
  await addColumn('tenders', 'employer_office', 'VARCHAR(220) NULL');
  await addColumn('tenders', 'employer_contact', 'VARCHAR(220) NULL');
  await addColumn('tenders', 'max_contract_value', 'DECIMAL(15,2) NOT NULL DEFAULT 0');

  /* The document is bought inside a window, for a non-refundable fee, against a receipt. */
  await addColumn('tenders', 'document_fee', 'DECIMAL(12,2) NOT NULL DEFAULT 0');
  await addColumn('tenders', 'docs_from', 'DATE NULL');
  await addColumn('tenders', 'docs_until', 'DATE NULL');
  await addColumn('tenders', 'receipt_no', 'VARCHAR(60) NULL');
  await addColumn('tenders', 'purchased_date', 'DATE NULL');

  /* Bids close at an hour, not on a day: "10:00 hrs on 23-07-2026". */
  await addColumn('tenders', 'closing_time', "TIME NOT NULL DEFAULT '10:00:00'");
  await addColumn('tenders', 'opening_date', 'DATE NULL');
  await addColumn('tenders', 'validity_days', 'SMALLINT UNSIGNED NOT NULL DEFAULT 91');

  /* Bid security: an amount, in someone's favour, valid until a date of its own. */
  await addColumn('tenders', 'security_amount', 'DECIMAL(14,2) NOT NULL DEFAULT 0');
  await addColumn('tenders', 'security_in_favour_of', 'VARCHAR(180) NULL');
  await addColumn('tenders', 'security_form', "ENUM('Bank guarantee','Insurance bond','Cash deposit','Not required') NOT NULL DEFAULT 'Bank guarantee'");
  await addColumn('tenders', 'security_valid_until', 'DATE NULL');
  await addColumn('tenders', 'security_released_on', 'DATE NULL');

  /* The Form of Bid amount is stated excluding VAT, in words and figures. */
  await addColumn('tenders', 'vat_amount', 'DECIMAL(15,2) NOT NULL DEFAULT 0');

  /* What came back after opening. */
  await addColumn('tenders', 'award_value', 'DECIMAL(15,2) NOT NULL DEFAULT 0');
  await addColumn('tenders', 'awarded_to', 'VARCHAR(180) NULL');
  await addColumn('tenders', 'our_rank', 'SMALLINT UNSIGNED NULL');
  await addColumn('tenders', 'bidders_count', 'SMALLINT UNSIGNED NULL');
  await addColumn('tenders', 'opened_date', 'DATE NULL');

  await modifyColumn('tenders', 'status', "ENUM('Identified','Document purchased','Preparing','Submitted','Opened','Won','Lost','Withdrawn','Cancelled') NOT NULL DEFAULT 'Identified'");
  await addIndex('tenders', 'idx_tender_status', 'INDEX idx_tender_status(status)');

  /*
   * A bid is rejected for a missing certificate as readily as for a bad price — the
   * Department of Buildings says outright that a bid without the PCA-03 cannot be awarded,
   * and the affidavit of outstanding work carries "shall be treated as non-responsive".
   * So the paperwork is tracked item by item rather than trusted to memory.
   */
  await query(`CREATE TABLE IF NOT EXISTS tender_checklist (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, tender_id BIGINT UNSIGNED NOT NULL,
    item VARCHAR(220) NOT NULL, mandatory BOOLEAN NOT NULL DEFAULT TRUE,
    done BOOLEAN NOT NULL DEFAULT FALSE, note VARCHAR(400) NULL,
    done_by BIGINT UNSIGNED NULL, done_at TIMESTAMP NULL,
    position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    CONSTRAINT fk_checklist_tender FOREIGN KEY(tender_id) REFERENCES tenders(id) ON DELETE CASCADE,
    CONSTRAINT fk_checklist_user FOREIGN KEY(done_by) REFERENCES users(id),
    INDEX idx_checklist_tender(tender_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await query(`CREATE TABLE IF NOT EXISTS retentions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL,
    description VARCHAR(300) NOT NULL, amount DECIMAL(15,2) NOT NULL,
    percent DECIMAL(6,2) NOT NULL DEFAULT 0, held_from DATE NOT NULL, release_date DATE NOT NULL,
    defect_liability_ends DATE NULL, released_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    status ENUM('Held','Partially released','Released','Written off') NOT NULL DEFAULT 'Held',
    notes VARCHAR(600) NULL, created_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_retention_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_retention_user FOREIGN KEY(created_by) REFERENCES users(id),
    INDEX idx_retention_release(release_date)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS subcontractors (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(180) NOT NULL UNIQUE,
    trade VARCHAR(120) NOT NULL, contact_person VARCHAR(120) NULL, phone VARCHAR(40) NULL,
    email VARCHAR(190) NULL, notes VARCHAR(600) NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS subcontractor_bills (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, subcontractor_id BIGINT UNSIGNED NOT NULL,
    project_id BIGINT UNSIGNED NOT NULL, reference VARCHAR(80) NOT NULL, description VARCHAR(400) NULL,
    amount DECIMAL(15,2) NOT NULL, paid_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    bill_date DATE NOT NULL, due_date DATE NULL,
    status ENUM('Unpaid','Partially paid','Paid') NOT NULL DEFAULT 'Unpaid',
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_subbill_sub FOREIGN KEY(subcontractor_id) REFERENCES subcontractors(id),
    CONSTRAINT fk_subbill_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_subbill_user FOREIGN KEY(created_by) REFERENCES users(id),
    UNIQUE KEY uq_sub_bill(subcontractor_id,reference)
  ) ENGINE=InnoDB`);
}

/*
 * Subcontract quotations, in both directions.
 *
 * GKUC keep no standing panel of subcontractors. When a job needs one they ask for a price,
 * the subcontractor sends a quotation, and that figure is carried into GKUC's own quotation
 * to the client and later into the invoice. So the received quotation is not a filing-cabinet
 * document — it is where a cost line in GKUC's own pricing comes from, and the link between
 * the two is the thing worth recording.
 *
 * The columns follow a real one: a supplier reference of their own, a delivery address that
 * is the site rather than the office, per-line discounts, and a validity measured in days —
 * the example on file stands for seven, which is short enough that knowing when it lapses
 * matters.
 *
 * The other direction needs no new table. GKUC quote main contractors using the same
 * quotation the product already produces; what was missing was any record that a particular
 * quotation was issued as a subcontractor rather than direct to an end client.
 */
/*
 * Messages a person composed and sent, as opposed to alerts the system raised.
 *
 * Kept separate from `notifications` on purpose. A notification is a condition the system
 * detected and can dedupe by day; this is somebody choosing to write to named people, and
 * it needs a different record — who sent it, exactly who it went to, and what the provider
 * said about each one. "We told the site" has to be provable per recipient.
 */
/*
 * Text read out of scanned documents and photographs.
 *
 * Held beside the attachment rather than inside it: the text of a forty-page scan dwarfs
 * every other column on that row, and a table that is read on every attachment listing
 * should not carry it. A FULLTEXT index is what makes searching the contents possible
 * without reading every document back out of the database.
 *
 * The queue is a table rather than anything cleverer for the same reason the rest of this
 * system avoids extra moving parts: one process, one database, and a job that can be seen
 * and retried with a SELECT.
 */
/*
 * Importing a bill of quantities from a spreadsheet.
 *
 * The rows land here first, not in the bill itself. A spreadsheet filled in by hand always
 * carries something the system cannot take at face value — a category spelled differently,
 * a quantity with a note beside it, a rate left blank — and committing that straight into a
 * live bill would mean discovering it later, in a quotation already sent to a client.
 *
 * So an import is staged, shown back to the person who uploaded it with every problem
 * marked against the row it came from, corrected on screen, and only then committed. What
 * gets committed is what they approved, not what the file happened to contain.
 */
/*
 * Lists the company controls itself.
 *
 * Most of the choices offered in a dropdown are classifications: what kind of cost this
 * is, what sort of leave, which document on a vehicle. Those belong to the business, and
 * the business changes — a new kind of subcontract, a document the RDA starts asking for.
 * Holding them in the code meant every such change was a code change.
 *
 * Workflow statuses are deliberately NOT here, and that is not an oversight. The system
 * decides what to do by reading them: an invoice that is "Approved" can be paid, a BOQ
 * that is "Approved" locks, a tender that is "Submitted" stops warning about its closing
 * date. A status somebody invented would be a value nothing knows how to act on, and the
 * record would sit in a state no part of the system could move it out of.
 */
/*
 * Whether somebody has been shown round the system yet.
 *
 * On the user record rather than in the browser: a supervisor who signs in on the site
 * tablet one day and the office computer the next is the same person, and being walked
 * through the same introduction a second time reads as the system having forgotten them.
 */
/*
 * Messaging between the people who use the system.
 *
 * A site supervisor asking the storekeeper whether the cement arrived should not have to
 * leave the system to do it — and when that conversation happens on a personal phone, the
 * company has no record of what was agreed. Kept here, it sits beside the work it is about.
 *
 * The delivery marks are the WhatsApp ones because that is what everybody already reads:
 * one tick means the server has it, two mean it reached them, two filled mean they opened
 * it. That needs a row per person per message, which is why receipts are their own table
 * rather than a column — in a group of twelve, "delivered" is twelve separate facts.
 */
/*
 * Watching the company's own records for the things that cost construction firms money.
 *
 * Two different problems wear the same clothes. Somebody fat-fingering 850,000 where they
 * meant 85,000 and somebody quietly inflating a supplier invoice produce the same row in
 * the same table, and neither announces itself. What separates them is pattern — one is a
 * single wrong figure, the other is a habit — so the detectors here look at each entry
 * against its own history rather than against a fixed rule.
 *
 * Findings are raised for review, not enforced. A system that refuses a legitimate unusual
 * entry at six in the evening on a pour day gets worked around within a week, and then the
 * company has neither the control nor the record. The few things that are refused outright
 * are the ones that cannot be legitimate under any reading — see the engine.
 */
/*
 * The company's own document store.
 *
 * Folders and files, shared the way people expect from Drive or OneDrive — which means the
 * hard part is not the storing but the answer to "who can see this". That answer has to be
 * obvious to whoever set it, because this is the same system that holds payslips, identity
 * documents and priced tenders, and a folder quietly inheriting a public link would be a
 * serious matter rather than an inconvenience.
 *
 * So access is accumulated up the tree — sharing a folder shares what is inside it, as
 * everybody expects — and the public flag is deliberately not something a file can acquire
 * by being moved. Making something public is always a decision somebody took about that
 * thing, and it is written into the audit trail.
 */
/*
 * The money the company is owed, and the money it holds on trust.
 *
 * Everything here already existed on the supplier side — bills coming in, and reminders when
 * they fall due. This is the other direction, which for a contractor is the harder half: an
 * interim certificate is not a simple bill. Retention is held back, an advance is recovered
 * against it, and the tax may be charged, suspended under SVAT, or not applicable at all.
 * Getting those three wrong is how a contractor invoices confidently for the wrong figure.
 */
async function createReceivableTables() {
  await addColumn('projects', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addColumn('company_settings', 'vat_number', 'VARCHAR(40) NULL');
  await addColumn('company_settings', 'svat_number', 'VARCHAR(40) NULL');
  await addColumn('company_settings', 'default_vat_rate', 'DECIMAL(5,2) NOT NULL DEFAULT 18.00');

  await query(`CREATE TABLE IF NOT EXISTS client_invoices (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    reference VARCHAR(60) NOT NULL UNIQUE,
    project_id BIGINT UNSIGNED NULL,
    company_id TINYINT UNSIGNED NULL,
    client VARCHAR(180) NOT NULL,
    document_type ENUM('Tax Invoice','Invoice') NOT NULL DEFAULT 'Tax Invoice',
    /* An interim certificate bills the work done to date; a final one closes the account. */
    kind ENUM('Interim','Final','Advance','Variation','Other') NOT NULL DEFAULT 'Interim',
    title VARCHAR(200) NOT NULL,
    invoice_date DATE NOT NULL,
    due_date DATE NULL,
    period_from DATE NULL,
    period_to DATE NULL,

    /* Work in this certificate, before anything is added or held back. */
    gross DECIMAL(15,2) NOT NULL DEFAULT 0,

    /*
     * How the tax is treated.
     *   Standard  — VAT charged and collected in the ordinary way.
     *   SVAT      — suspended: the figure is shown and a credit voucher passes instead of
     *               money, which is how registered purchasers here settle.
     *   Exempt    — no VAT applies to this work.
     */
    tax_treatment ENUM('Standard','SVAT','Exempt') NOT NULL DEFAULT 'Standard',
    vat_rate DECIMAL(5,2) NOT NULL DEFAULT 0,
    vat_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    svat_voucher VARCHAR(60) NULL,

    /* Held back against defects, released later — tracked in retentions once certified. */
    retention_percent DECIMAL(5,2) NOT NULL DEFAULT 0,
    retention_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    /* An advance already paid is recovered a slice at a time out of each certificate. */
    advance_recovery DECIMAL(15,2) NOT NULL DEFAULT 0,
    other_deductions DECIMAL(15,2) NOT NULL DEFAULT 0,
    deduction_note VARCHAR(300) NULL,

    net_payable DECIMAL(15,2) NOT NULL DEFAULT 0,
    paid_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    status ENUM('Draft','Issued','Part paid','Paid','Cancelled') NOT NULL DEFAULT 'Draft',
    notes VARCHAR(1000) NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    issued_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_cinvoice_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_cinvoice_user FOREIGN KEY(created_by) REFERENCES users(id),
    INDEX idx_cinvoice_due (status, due_date)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS client_invoice_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    invoice_id BIGINT UNSIGNED NOT NULL,
    boq_item_id BIGINT UNSIGNED NULL,
    description VARCHAR(300) NOT NULL,
    unit VARCHAR(30) NULL,
    quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
    rate DECIMAL(14,2) NOT NULL DEFAULT 0,
    amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    CONSTRAINT fk_cinvoice_item FOREIGN KEY(invoice_id) REFERENCES client_invoices(id) ON DELETE CASCADE,
    INDEX idx_cinvoice_item (invoice_id)
  ) ENGINE=InnoDB`);
  await addColumn('client_invoices', 'delivery_date', 'DATE NULL');
  await addColumn('client_invoices', 'place_of_supply', 'VARCHAR(300) NULL');
  await addColumn('client_invoices', 'payment_mode', 'VARCHAR(80) NULL');
  await addColumn('client_invoices', 'buyer_tin', 'VARCHAR(100) NULL');
  await addColumn('client_invoices', 'buyer_vat_number', 'VARCHAR(100) NULL');
  await addColumn('client_invoices', 'buyer_address', 'VARCHAR(500) NULL');
  await addColumn('client_invoices', 'buyer_phone', 'VARCHAR(40) NULL');
  await addColumn('client_invoices', 'company_id', 'TINYINT UNSIGNED NULL');
  await addColumn('client_invoices', 'document_type', "ENUM('Tax Invoice','Invoice') NOT NULL DEFAULT 'Tax Invoice'");
  if (!(await columnIsNullable('client_invoices', 'project_id')))
    await query('ALTER TABLE client_invoices MODIFY project_id BIGINT UNSIGNED NULL');
  await query(`UPDATE client_invoices i JOIN projects p ON p.id=i.project_id
    SET i.company_id=p.company_id WHERE i.company_id IS NULL`);
  await query(`UPDATE client_invoices SET document_type='Invoice'
    WHERE tax_treatment='Exempt' AND document_type='Tax Invoice'`);
  await addColumn('incomes', 'company_id', 'TINYINT UNSIGNED NULL');
  if (!(await columnIsNullable('incomes', 'project_id')))
    await query('ALTER TABLE incomes MODIFY project_id BIGINT UNSIGNED NULL');
  await query(`UPDATE incomes i JOIN projects p ON p.id=i.project_id
    SET i.company_id=p.company_id WHERE i.company_id IS NULL`);
  await addIndex('client_invoices', 'idx_cinvoice_company', 'INDEX idx_cinvoice_company(company_id,status)');

  await query(`CREATE TABLE IF NOT EXISTS client_receipts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    invoice_id BIGINT UNSIGNED NOT NULL,
    amount DECIMAL(15,2) NOT NULL,
    received_date DATE NOT NULL,
    method VARCHAR(60) NOT NULL DEFAULT 'Bank transfer',
    reference VARCHAR(120) NULL,
    recorded_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_receipt_invoice FOREIGN KEY(invoice_id) REFERENCES client_invoices(id) ON DELETE CASCADE,
    CONSTRAINT fk_receipt_recorder FOREIGN KEY(recorded_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS received_cheques (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NULL, invoice_id BIGINT UNSIGNED NULL,
    cheque_number VARCHAR(80) NOT NULL, bank VARCHAR(180) NOT NULL, payer VARCHAR(180) NOT NULL,
    purpose VARCHAR(400) NOT NULL, amount DECIMAL(15,2) NOT NULL,
    received_date DATE NOT NULL, cheque_date DATE NOT NULL, deposit_by DATE NOT NULL,
    reminder_days SMALLINT UNSIGNED NOT NULL DEFAULT 2,
    status ENUM('On hand','Deposited','Cleared','Returned','Re-deposited','Cancelled') NOT NULL DEFAULT 'On hand',
    notes VARCHAR(600) NULL, deposited_at DATE NULL, confirmed_at DATETIME NULL,
    confirmed_by BIGINT UNSIGNED NULL, created_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_received_cheque_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_received_cheque_invoice FOREIGN KEY(invoice_id) REFERENCES client_invoices(id),
    CONSTRAINT fk_received_cheque_confirmer FOREIGN KEY(confirmed_by) REFERENCES users(id),
    CONSTRAINT fk_received_cheque_creator FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT chk_received_cheque_amount CHECK(amount > 0),
    UNIQUE KEY uq_received_cheque(bank,cheque_number,payer), INDEX idx_received_cheque_followup(status,deposit_by,cheque_date)
  ) ENGINE=InnoDB`);

  /*
   * Bank guarantees.
   *
   * A contractor's bonds are money the bank has promised on their behalf, against security
   * the company has actually put up. They expire, and an expired advance-payment bond on a
   * live contract is a breach; an unreleased one after completion is the company's own cash
   * sitting in somebody else's account. Both are worth being told about.
   */
  await query(`CREATE TABLE IF NOT EXISTS bank_bonds (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    reference VARCHAR(60) NOT NULL UNIQUE,
    project_id BIGINT UNSIGNED NULL,
    kind ENUM('Advance payment','Performance','Retention','Bid','Other') NOT NULL DEFAULT 'Performance',
    beneficiary VARCHAR(180) NOT NULL,
    bank VARCHAR(180) NOT NULL,
    bond_number VARCHAR(80) NULL,
    amount DECIMAL(15,2) NOT NULL,
    /* What the bank holds against it — usually cash or a lien, and the company's money. */
    margin_held DECIMAL(15,2) NOT NULL DEFAULT 0,
    commission DECIMAL(15,2) NOT NULL DEFAULT 0,
    issued_date DATE NOT NULL,
    expiry_date DATE NOT NULL,
    status ENUM('Live','Expired','Released','Called') NOT NULL DEFAULT 'Live',
    released_date DATE NULL,
    notes VARCHAR(600) NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_bond_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_bond_user FOREIGN KEY(created_by) REFERENCES users(id),
    INDEX idx_bond_expiry (status, expiry_date)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS bank_bond_extensions (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,bond_id BIGINT UNSIGNED NOT NULL,
    previous_expiry DATE NOT NULL,new_expiry DATE NOT NULL,extended_on DATE NOT NULL,
    additional_commission DECIMAL(15,2) NOT NULL DEFAULT 0,note VARCHAR(600) NULL,
    created_by BIGINT UNSIGNED NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_bond_extension_bond FOREIGN KEY(bond_id) REFERENCES bank_bonds(id) ON DELETE CASCADE,
    CONSTRAINT fk_bond_extension_user FOREIGN KEY(created_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);

  /*
   * Petty cash.
   *
   * A float given to a site, spent in small amounts, topped up when it runs low. Kept as a
   * running account rather than a balance field so the balance is always the sum of what
   * happened — a stored balance and a list of movements will disagree eventually, and then
   * nobody knows which to believe.
   */
  await query(`CREATE TABLE IF NOT EXISTS petty_cash_floats (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(120) NOT NULL,
    account_type ENUM('Office expenses','Salary advance','Fuel') NOT NULL DEFAULT 'Office expenses',
    project_id BIGINT UNSIGNED NULL,
    holder_id BIGINT UNSIGNED NULL,
    holder_name VARCHAR(120) NOT NULL,
    /* What it is meant to hold, so a top-up knows what it is topping up to. */
    ceiling DECIMAL(15,2) NOT NULL DEFAULT 0,
    low_at DECIMAL(15,2) NOT NULL DEFAULT 0,
    active TINYINT(1) NOT NULL DEFAULT 1,
    created_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_float_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_float_holder FOREIGN KEY(holder_id) REFERENCES users(id),
    CONSTRAINT fk_float_creator FOREIGN KEY(created_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  await addColumn('petty_cash_floats', 'account_type',
    "ENUM('Office expenses','Salary advance','Fuel') NOT NULL DEFAULT 'Office expenses'");

  await query(`CREATE TABLE IF NOT EXISTS petty_cash_entries (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    float_id BIGINT UNSIGNED NOT NULL,
    kind ENUM('Top up','Spend','Return','Adjustment') NOT NULL,
    /* Positive puts money in, negative takes it out. One column, so the balance is a sum. */
    amount DECIMAL(15,2) NOT NULL,
    entry_date DATE NOT NULL,
    description VARCHAR(300) NOT NULL,
    category VARCHAR(60) NULL,
    employee_id BIGINT UNSIGNED NULL,
    project_id BIGINT UNSIGNED NULL,
    receipt_attachment_id BIGINT UNSIGNED NULL,
    recorded_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_petty_float FOREIGN KEY(float_id) REFERENCES petty_cash_floats(id) ON DELETE CASCADE,
    CONSTRAINT fk_petty_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_petty_employee FOREIGN KEY(employee_id) REFERENCES employees(id),
    CONSTRAINT fk_petty_user FOREIGN KEY(recorded_by) REFERENCES users(id),
    INDEX idx_petty_float (float_id, entry_date)
  ) ENGINE=InnoDB`);
  await addColumn('petty_cash_entries', 'employee_id', 'BIGINT UNSIGNED NULL');
  await addForeignKey('petty_cash_entries', 'fk_petty_employee',
    'CONSTRAINT fk_petty_employee FOREIGN KEY(employee_id) REFERENCES employees(id)');
  /* Fleet owns fuel spending; its matching cash movement points back to the one fuel record. */
  await addColumn('petty_cash_entries', 'fuel_record_id', 'BIGINT UNSIGNED NULL');
  await addIndex('petty_cash_entries', 'uq_petty_fuel_record', 'UNIQUE KEY uq_petty_fuel_record(fuel_record_id)');
  await addForeignKey('petty_cash_entries', 'fk_petty_fuel_record',
    'CONSTRAINT fk_petty_fuel_record FOREIGN KEY(fuel_record_id) REFERENCES fuel_records(id)');

  /* A large advance can take more than one salary run to recover. Allocations preserve
     every instalment instead of marking the whole advance as deducted too early. */
  await query(`CREATE TABLE IF NOT EXISTS salary_advance_recoveries (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    entry_id BIGINT UNSIGNED NOT NULL,
    payslip_id BIGINT UNSIGNED NOT NULL,
    amount DECIMAL(12,2) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_advance_recovery_entry FOREIGN KEY(entry_id) REFERENCES petty_cash_entries(id),
    CONSTRAINT fk_advance_recovery_payslip FOREIGN KEY(payslip_id) REFERENCES payslips(id) ON DELETE CASCADE,
    CONSTRAINT chk_advance_recovery_amount CHECK(amount > 0),
    UNIQUE KEY uq_advance_recovery_run(entry_id,payslip_id), INDEX idx_advance_recovery_payslip(payslip_id)
  ) ENGINE=InnoDB`);

  /*
   * Tools go out and are meant to come back.
   *
   * The lending record existed but had no date by which anything was due, so nothing could
   * be overdue and nothing was ever chased. A due date is what turns a list of what went out
   * into a list of what has not come back.
   */
  await addColumn('equipment_assignments', 'due_back', 'DATE NULL');
  await addColumn('equipment_assignments', 'issued_condition', "VARCHAR(60) NULL");
  await addColumn('equipment_assignments', 'returned_condition', "VARCHAR(60) NULL");
  await addColumn('equipment_assignments', 'employee_id', 'BIGINT UNSIGNED NULL');

  /*
   * What each person is entitled to in a year.
   *
   * Held per employee rather than as one company figure: the statutory minimum is a floor,
   * and a firm that has been running a while has people on better terms than that. A single
   * constant would quietly overwrite those arrangements.
   */
  await addColumn('employees', 'annual_leave_entitlement', 'DECIMAL(5,1) NOT NULL DEFAULT 14');
  await addColumn('employees', 'casual_leave_entitlement', 'DECIMAL(5,1) NOT NULL DEFAULT 7');
}

async function createDriveTables() {
  await query(`CREATE TABLE IF NOT EXISTS drive_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    parent_id BIGINT UNSIGNED NULL,
    kind ENUM('Folder','File') NOT NULL,
    name VARCHAR(255) NOT NULL,
    owner_id BIGINT UNSIGNED NOT NULL,
    /* Optional: a folder can belong to a project, which is how most site paperwork is found. */
    project_id BIGINT UNSIGNED NULL,

    storage_key VARCHAR(400) NULL,
    size_bytes BIGINT UNSIGNED NULL,
    mime VARCHAR(160) NULL,
    checksum CHAR(64) NULL,

    /*
     * 'Private'      — the owner, and nobody else
     * 'People'       — the owner and whoever is named in drive_shares
     * 'Organisation' — anybody signed in, at org_role
     * The public link is separate and additive: something can be shared with named people
     * and also carry a link, and revoking one does not touch the other.
     */
    visibility ENUM('Private','People','Organisation') NOT NULL DEFAULT 'Private',
    org_role ENUM('View','Edit') NOT NULL DEFAULT 'View',

    /* Unguessable, revocable, and never inherited from a parent. */
    public_token CHAR(43) NULL,
    public_expires_at DATETIME NULL,
    public_created_by BIGINT UNSIGNED NULL,
    public_downloads INT UNSIGNED NOT NULL DEFAULT 0,

    /* Withdrawn rather than erased, so a deletion can be undone and can be accounted for. */
    trashed_at DATETIME NULL,
    trashed_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    CONSTRAINT fk_drive_parent FOREIGN KEY(parent_id) REFERENCES drive_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_drive_owner FOREIGN KEY(owner_id) REFERENCES users(id),
    CONSTRAINT fk_drive_project FOREIGN KEY(project_id) REFERENCES projects(id),
    UNIQUE KEY uq_drive_public (public_token),
    INDEX idx_drive_parent (parent_id, trashed_at),
    INDEX idx_drive_owner (owner_id, trashed_at)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS drive_shares (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    role ENUM('View','Edit') NOT NULL DEFAULT 'View',
    granted_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_share_item FOREIGN KEY(item_id) REFERENCES drive_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_share_user FOREIGN KEY(user_id) REFERENCES users(id),
    CONSTRAINT fk_share_granter FOREIGN KEY(granted_by) REFERENCES users(id),
    UNIQUE KEY uq_drive_share (item_id, user_id),
    INDEX idx_share_user (user_id)
  ) ENGINE=InnoDB`);

  /*
   * Somebody asking to be let in.
   *
   * Better than the alternative, which is a phone call the owner forgets and a colleague
   * who works around the system instead.
   */
  await query(`CREATE TABLE IF NOT EXISTS drive_access_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    item_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    requested_role ENUM('View','Edit') NOT NULL DEFAULT 'View',
    message VARCHAR(500) NULL,
    status ENUM('Pending','Granted','Refused') NOT NULL DEFAULT 'Pending',
    decided_by BIGINT UNSIGNED NULL,
    decided_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_request_item FOREIGN KEY(item_id) REFERENCES drive_items(id) ON DELETE CASCADE,
    CONSTRAINT fk_request_user FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE KEY uq_drive_request (item_id, user_id, status),
    INDEX idx_request_status (status, id)
  ) ENGINE=InnoDB`);
}

async function createIntegrityTables() {
  await query(`CREATE TABLE IF NOT EXISTS risk_findings (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    /* The detector that raised it, so a noisy one can be traced and tuned. */
    rule VARCHAR(60) NOT NULL,
    category ENUM('Fraud','Error','Control','Integrity') NOT NULL,
    severity ENUM('Low','Medium','High','Critical') NOT NULL DEFAULT 'Medium',
    /* What it is about: the table and row, so the reviewer can go and look. */
    entity VARCHAR(60) NOT NULL,
    entity_id VARCHAR(60) NOT NULL,
    project_id BIGINT UNSIGNED NULL,
    subject_user_id BIGINT UNSIGNED NULL,
    amount DECIMAL(15,2) NULL,
    title VARCHAR(200) NOT NULL,
    /* Written for a person, not a log: what was seen, what was expected, why it matters. */
    detail VARCHAR(1200) NOT NULL,
    evidence_json JSON NULL,
    /* A number, so a list can be ranked rather than read end to end. */
    score SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    status ENUM('Open','Confirmed','Dismissed','Resolved') NOT NULL DEFAULT 'Open',
    /* One finding per rule per record, so a nightly sweep does not pile up duplicates. */
    fingerprint VARCHAR(190) NOT NULL,
    reviewed_by BIGINT UNSIGNED NULL,
    reviewed_at DATETIME NULL,
    review_note VARCHAR(1000) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_finding_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_finding_subject FOREIGN KEY(subject_user_id) REFERENCES users(id),
    CONSTRAINT fk_finding_reviewer FOREIGN KEY(reviewed_by) REFERENCES users(id),
    UNIQUE KEY uq_finding (fingerprint),
    INDEX idx_finding_open (status, severity, id),
    INDEX idx_finding_entity (entity, entity_id)
  ) ENGINE=InnoDB`);

  /*
   * What the company considers normal, so the thresholds are theirs rather than mine.
   *
   * Every figure a detector compares against is here and editable. A rule nobody can tune
   * is a rule that gets switched off the first time it is wrong.
   */
  await query(`CREATE TABLE IF NOT EXISTS risk_settings (
    setting_key VARCHAR(80) NOT NULL PRIMARY KEY,
    value VARCHAR(200) NOT NULL,
    label VARCHAR(200) NOT NULL,
    help VARCHAR(500) NULL,
    updated_by BIGINT UNSIGNED NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);

  const defaults = [
    ['approval.threshold', '250000', 'Purchase approval threshold (LKR)',
      'Orders above this need sign-off. Used to spot purchases split to stay just underneath it.'],
    ['split.window.days', '7', 'Window for spotting split purchases (days)',
      'Several orders to one supplier inside this many days are judged together against the threshold.'],
    ['outlier.sigma', '3', 'How far from normal counts as unusual',
      'Measured in robust standard deviations from that category\'s own history. Lower catches more.'],
    ['outlier.minimum.history', '8', 'Least history before judging an amount unusual',
      'Below this the system has nothing to compare against and says nothing.'],
    ['duplicate.window.days', '30', 'Window for spotting duplicate payments (days)', null],
    ['round.amount.floor', '100000', 'Round-figure watch starts at (LKR)',
      'Fabricated amounts cluster on round numbers. Small round figures are ordinary; large ones less so.'],
    ['overtime.daily.max', '6', 'Overtime hours in a day before it is questioned', null],
    ['fuel.variance.percent', '40', 'Fuel cost variance before it is questioned (%)', null],
    ['workday.start', '06:00', 'Working day starts', 'Entries outside these hours are noted, not refused.'],
    ['workday.end', '20:00', 'Working day ends', null],
    ['benford.minimum.sample', '60', 'Least records before testing digit distribution',
      'Benford\'s law needs a reasonable sample before it says anything useful.']
  ];
  for (const [key, value, label, help] of defaults) {
    await query('INSERT IGNORE INTO risk_settings (setting_key,value,label,help) VALUES (?,?,?,?)',
      [key, value, label, help]);
  }
}

async function createChatTables() {
  await query(`CREATE TABLE IF NOT EXISTS conversations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    kind ENUM('Direct','Group') NOT NULL DEFAULT 'Direct',
    /* Null for a direct chat: it is named by whoever you are talking to. */
    name VARCHAR(120) NULL,
    topic VARCHAR(300) NULL,
    project_id BIGINT UNSIGNED NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    last_message_id BIGINT UNSIGNED NULL,
    last_message_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_conversation_creator FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT fk_conversation_project FOREIGN KEY(project_id) REFERENCES projects(id),
    INDEX idx_conversation_recent (last_message_at)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS conversation_members (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    conversation_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    role ENUM('Member','Admin') NOT NULL DEFAULT 'Member',
    /* How far down they have read, which is what the unread count is measured against. */
    last_read_message_id BIGINT UNSIGNED NULL,
    muted TINYINT(1) NOT NULL DEFAULT 0,
    joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME NULL,
    CONSTRAINT fk_member_conversation FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_member_user FOREIGN KEY(user_id) REFERENCES users(id),
    UNIQUE KEY uq_conversation_member (conversation_id, user_id),
    INDEX idx_member_user (user_id, left_at)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS chat_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    conversation_id BIGINT UNSIGNED NOT NULL,
    sender_id BIGINT UNSIGNED NOT NULL,
    body VARCHAR(4000) NOT NULL,
    /* A message about a particular record links to it, so a conversation can be followed
       back to the work it concerned. */
    reference_type VARCHAR(60) NULL,
    reference_id VARCHAR(60) NULL,
    reply_to_id BIGINT UNSIGNED NULL,
    /* Withdrawn rather than erased: the fact that something was said and then taken back
       is itself part of the record. */
    deleted_at DATETIME NULL,
    edited_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_message_conversation FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    CONSTRAINT fk_message_sender FOREIGN KEY(sender_id) REFERENCES users(id),
    INDEX idx_message_conversation (conversation_id, id)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS chat_receipts (
    message_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    delivered_at DATETIME NULL,
    read_at DATETIME NULL,
    PRIMARY KEY (message_id, user_id),
    CONSTRAINT fk_receipt_message FOREIGN KEY(message_id) REFERENCES chat_messages(id) ON DELETE CASCADE,
    CONSTRAINT fk_receipt_user FOREIGN KEY(user_id) REFERENCES users(id),
    INDEX idx_receipt_user (user_id, read_at)
  ) ENGINE=InnoDB`);

  /*
   * When somebody was last using the system, for "last seen".
   *
   * Separate from sessions.last_seen_at, which exists to expire an idle session and is
   * written at most once a minute per session. This is about the person, across whatever
   * they are signed in on.
   */
  await addColumn('users', 'last_active_at', 'DATETIME NULL');

  /*
   * Messaging is granted to every role that exists, once.
   *
   * The permission is there so it can be taken away from somebody, not so it has to be
   * handed out one role at a time — a system where colleagues cannot reach each other just
   * moves the conversation to personal phones, where the company has no record of it.
   * Done as a one-off: a role the MD later creates decides for itself, and a grant removed
   * on purpose is not quietly restored on the next restart.
   */
  for (const key of ['chat.use', 'drive.use']) {
    const [{ done }] = await query(
      'SELECT COUNT(*) done FROM role_permissions WHERE permission_key=?', [key]);
    if (done) continue;
    for (const role of await query('SELECT id FROM roles')) {
      await query('INSERT IGNORE INTO role_permissions (role_id,permission_key) VALUES (?,?)',
        [role.id, key]);
    }
  }
}

async function createOnboardingColumns() {
  await addColumn('users', 'tour_seen_at', 'DATETIME NULL');
}

async function createOptionTables() {
  await query(`CREATE TABLE IF NOT EXISTS option_lists (
    list_key VARCHAR(60) NOT NULL PRIMARY KEY,
    label VARCHAR(120) NOT NULL,
    description VARCHAR(400) NULL,
    department VARCHAR(60) NOT NULL DEFAULT 'General',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS option_values (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    list_key VARCHAR(60) NOT NULL,
    value VARCHAR(120) NOT NULL,
    sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 100,
    active TINYINT(1) NOT NULL DEFAULT 1,
    /* Shipped with the system. Can be renamed or retired, but not deleted outright:
       records already refer to it, and a report on last year should still read correctly. */
    is_system TINYINT(1) NOT NULL DEFAULT 0,
    /*
     * The system reads this exact word to decide something, so it cannot be renamed or
     * retired. "Unpaid" leave is the example: payroll finds unpaid days by matching that
     * word, and renaming it would stop the deduction without any visible sign.
     */
    locked TINYINT(1) NOT NULL DEFAULT 0,
    created_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_option_value_list FOREIGN KEY(list_key) REFERENCES option_lists(list_key) ON DELETE CASCADE,
    UNIQUE KEY uq_option_value (list_key, value),
    INDEX idx_option_value_list (list_key, active, sort_order)
  ) ENGINE=InnoDB`);

  /*
   * The columns these lists feed become VARCHAR.
   *
   * An ENUM can only hold what was written into the table definition, so adding an option
   * would mean altering the table every time. The value is checked against the list on the
   * way in instead, which is the same guarantee enforced somewhere it can change.
   */
  await addColumn('option_values', 'locked', 'TINYINT(1) NOT NULL DEFAULT 0');

  await modifyColumn('boq_items', 'category', "VARCHAR(60) NOT NULL DEFAULT 'Material'");
  await modifyColumn('expenses', 'source', "VARCHAR(60) NOT NULL DEFAULT 'Other'");
  await modifyColumn('leave_requests', 'leave_type', "VARCHAR(60) NOT NULL DEFAULT 'Annual'");
  await modifyColumn('vehicle_documents', 'doc_type', "VARCHAR(60) NOT NULL DEFAULT 'Insurance'");
  await modifyColumn('client_communications', 'channel', "VARCHAR(60) NOT NULL DEFAULT 'Call'");
  await modifyColumn('vehicle_maintenance', 'maintenance_type', "VARCHAR(60) NOT NULL DEFAULT 'Service'");
  await modifyColumn('incomes', 'method', "VARCHAR(60) NOT NULL DEFAULT 'Bank transfer'");

  const lists = [
    ['boq.category', 'BOQ categories', 'How each line of a bill of quantities is classified.',
      'Quantity Surveying', ['Material', 'Labour', 'Equipment', 'Subcontract', 'Overhead']],
    ['boq.unit', 'Units of measure', 'Offered when pricing a BOQ line. Anything may still be typed in.',
      'Quantity Surveying', ['m', 'm2', 'm3', 'kg', 'MT', 'ltr', 'nos', 'item', 'day', 'hour', 'LS']],
    ['expense.source', 'Expense types', 'What a recorded cost was spent on.',
      'Finance', ['Material', 'Labour', 'Fuel', 'Equipment', 'Subcontractor', 'Overhead', 'Other']],
    ['income.method', 'Payment methods', 'How money was received.',
      'Finance', ['Cash', 'Cheque', 'Bank transfer', 'Card']],
    ['leave.type', 'Leave types', 'The kinds of leave an employee may request.',
      'Human Resources', ['Annual', 'Casual', 'Medical', 'Unpaid', 'Other']],
    ['vehicle.document', 'Vehicle document types', 'Papers tracked against a vehicle, with expiry dates.',
      'Transport', ['Insurance', 'Revenue licence', 'Emission test', 'Service', 'Fitness certificate']],
    ['vehicle.maintenance', 'Maintenance types', 'What a workshop visit was for.',
      'Transport', ['Service', 'Repair', 'Inspection']],
    ['client.channel', 'Client contact methods', 'How a conversation with a client happened.',
      'Construction & Coordination', ['Call', 'WhatsApp', 'Email', 'Meeting', 'Site visit', 'Letter']],
    ['material.category', 'Material categories', 'How stock is grouped in the store.',
      'Stores', ['Cement', 'Aggregate', 'Steel', 'Timber', 'Bitumen', 'Consumables', 'Tools', 'Other']],
    ['employee.designation', 'Designations', 'Job titles used on employee records.',
      'Human Resources', ['Site Supervisor', 'Mason', 'Carpenter', 'Bar bender', 'Driver',
        'Machine operator', 'Labourer', 'Storekeeper', 'Quantity Surveyor', 'Engineer']]
  ];

  /* Values the code matches on by name. Everything else is free to be renamed. */
  const LOCKED = { 'leave.type': ['Unpaid'] };

  for (const [key, label, description, department, values] of lists) {
    await query('INSERT IGNORE INTO option_lists (list_key,label,description,department) VALUES (?,?,?,?)',
      [key, label, description, department]);
    let order = 10;
    for (const value of values) {
      await query('INSERT IGNORE INTO option_values (list_key,value,sort_order,is_system,locked) VALUES (?,?,?,1,?)',
        [key, value, order, (LOCKED[key] || []).includes(value) ? 1 : 0]);
      order += 10;
    }
  }
}

async function createBoqImportTables() {
  /*
   * The file exactly as it arrived, kept as evidence.
   *
   * A bill priced by somebody else is a commercial document: it is what was quoted, by whom
   * and when. Reading the figures out of it and discarding the file would leave the system
   * holding numbers with nothing behind them — no use in a dispute, and no way to check
   * later whether a line was read correctly. The original stays, and stays reachable from
   * the bill it produced.
   */
  /* Method statements belong on the line, not only in the method library: a bill imported
     from a spreadsheet carries the wording the estimator wrote for that specific item. */
  await addColumn('boq_items', 'method', 'TEXT NULL');
  await addColumn('boq_items', 'notes', 'VARCHAR(600) NULL');

  await query(`CREATE TABLE IF NOT EXISTS boq_imports (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NULL,
    boq_id BIGINT UNSIGNED NULL,
    filename VARCHAR(190) NOT NULL,
    storage_key VARCHAR(400) NULL,
    file_url VARCHAR(600) NULL,
    file_size BIGINT UNSIGNED NULL,
    file_mime VARCHAR(120) NULL,
    /* Fingerprinted on arrival, so the stored file can be shown to be the file received. */
    checksum CHAR(64) NULL,
    source ENUM('Template','Foreign') NOT NULL DEFAULT 'Template',
    layout_json JSON NULL,
    title VARCHAR(180) NULL,
    client VARCHAR(180) NULL,
    document_reference VARCHAR(120) NULL,
    location VARCHAR(500) NULL,
    document_date VARCHAR(30) NULL,
    notes VARCHAR(1000) NULL,
    status ENUM('Review','Committed','Discarded') NOT NULL DEFAULT 'Review',
    row_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    problem_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    total DECIMAL(15,2) NOT NULL DEFAULT 0,
    uploaded_by BIGINT UNSIGNED NOT NULL,
    committed_by BIGINT UNSIGNED NULL,
    committed_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_boqimport_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_boqimport_boq FOREIGN KEY(boq_id) REFERENCES boqs(id),
    CONSTRAINT fk_boqimport_user FOREIGN KEY(uploaded_by) REFERENCES users(id),
    INDEX idx_boqimport_status(status, id)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS boq_import_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    import_id BIGINT UNSIGNED NOT NULL,
    source_row SMALLINT UNSIGNED NOT NULL,
    category VARCHAR(60) NULL,
    description VARCHAR(300) NULL,
    unit VARCHAR(30) NULL,
    quantity DECIMAL(14,3) NULL,
    rate DECIMAL(14,2) NULL,
    amount DECIMAL(15,2) NULL,
    method TEXT NULL,
    notes VARCHAR(600) NULL,
    /* What the file said, kept verbatim, so a correction can always be compared with it. */
    raw_json JSON NULL,
    problems VARCHAR(600) NULL,
    /* Worth saying, but not a reason to stop: the amount typed in the file disagreeing
       with quantity x rate, for instance, when the system uses quantity x rate anyway. */
    notice VARCHAR(600) NULL,
    include TINYINT(1) NOT NULL DEFAULT 1,
    CONSTRAINT fk_boqimportitem_import FOREIGN KEY(import_id) REFERENCES boq_imports(id) ON DELETE CASCADE,
    INDEX idx_boqimportitem_import(import_id, source_row)
  ) ENGINE=InnoDB`);

  /*
   * Changing a bill that has already been approved.
   *
   * An approved BOQ is what quotations, invoices and the project budget are built on, so
   * amending one quietly would change figures other people have already relied on. The
   * change is recorded, the reason with it, and it applies only once somebody holding the
   * approval permission agrees.
   */
  for (const [column, definition] of [
    ['storage_key', 'VARCHAR(400) NULL'], ['file_url', 'VARCHAR(600) NULL'],
    ['file_size', 'BIGINT UNSIGNED NULL'], ['file_mime', 'VARCHAR(120) NULL'],
    ['checksum', 'CHAR(64) NULL'], ['layout_json', 'JSON NULL'],
    ['source', "ENUM('Template','Foreign') NOT NULL DEFAULT 'Template'"],
    ['document_reference', 'VARCHAR(120) NULL'], ['location', 'VARCHAR(500) NULL'],
    ['document_date', 'VARCHAR(30) NULL'], ['notes', 'VARCHAR(1000) NULL']
  ]) await addColumn('boq_imports', column, definition);

  /* Reachable from the bill itself, not only from the import that produced it. */
  await addColumn('boqs', 'import_id', 'BIGINT UNSIGNED NULL');

  await query(`CREATE TABLE IF NOT EXISTS boq_change_requests (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    boq_id BIGINT UNSIGNED NOT NULL,
    item_id BIGINT UNSIGNED NULL,
    action ENUM('Edit','Add','Remove') NOT NULL,
    reason VARCHAR(600) NOT NULL,
    before_json JSON NULL,
    after_json JSON NULL,
    status ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending',
    requested_by BIGINT UNSIGNED NOT NULL,
    decided_by BIGINT UNSIGNED NULL,
    decided_at DATETIME NULL,
    decision_note VARCHAR(600) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_boqchange_boq FOREIGN KEY(boq_id) REFERENCES boqs(id) ON DELETE CASCADE,
    CONSTRAINT fk_boqchange_requester FOREIGN KEY(requested_by) REFERENCES users(id),
    CONSTRAINT fk_boqchange_decider FOREIGN KEY(decided_by) REFERENCES users(id),
    INDEX idx_boqchange_status(status, id)
  ) ENGINE=InnoDB`);

  /* For databases created before advisory notes were separated from blocking problems.
     Declared after the table it alters, or a fresh install fails here on the first boot. */
  await addColumn('boq_import_items', 'notice', 'VARCHAR(600) NULL');
}

async function createOcrTables() {
  await query(`CREATE TABLE IF NOT EXISTS attachment_text (
    attachment_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    content MEDIUMTEXT NOT NULL,
    source ENUM('text-layer','ocr','unsupported') NOT NULL,
    pages SMALLINT UNSIGNED NULL,
    characters INT UNSIGNED NOT NULL DEFAULT 0,
    extracted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_attachment_text FOREIGN KEY(attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
    FULLTEXT KEY ft_attachment_content (content)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS ocr_jobs (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    attachment_id BIGINT UNSIGNED NOT NULL,
    status ENUM('Queued','Running','Done','Failed','Skipped') NOT NULL DEFAULT 'Queued',
    attempts TINYINT UNSIGNED NOT NULL DEFAULT 0,
    detail VARCHAR(500) NULL,
    started_at DATETIME NULL,
    finished_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_ocr_job_attachment FOREIGN KEY(attachment_id) REFERENCES attachments(id) ON DELETE CASCADE,
    UNIQUE KEY uq_ocr_job_attachment (attachment_id),
    INDEX idx_ocr_job_status (status, id)
  ) ENGINE=InnoDB`);
}

async function createMessagingTables() {
  await query(`CREATE TABLE IF NOT EXISTS outbound_messages (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    channel ENUM('WhatsApp','SMS','Email') NOT NULL DEFAULT 'WhatsApp',
    subject VARCHAR(180) NULL,
    body VARCHAR(2000) NOT NULL,
    sent_by BIGINT UNSIGNED NOT NULL,
    recipient_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    sent_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    failed_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_outbound_sender FOREIGN KEY(sent_by) REFERENCES users(id),
    INDEX idx_outbound_created(created_at)
  ) ENGINE=InnoDB`);

  await query(`CREATE TABLE IF NOT EXISTS outbound_message_recipients (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    message_id BIGINT UNSIGNED NOT NULL,
    recipient_kind ENUM('Employee','User','Number') NOT NULL,
    recipient_id BIGINT UNSIGNED NULL,
    name VARCHAR(160) NOT NULL,
    address VARCHAR(190) NOT NULL,
    status ENUM('Sent','Failed','Skipped') NOT NULL,
    provider VARCHAR(60) NULL,
    detail VARCHAR(500) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_outbound_recipient_message FOREIGN KEY(message_id) REFERENCES outbound_messages(id) ON DELETE CASCADE,
    INDEX idx_outbound_recipient_message(message_id)
  ) ENGINE=InnoDB`);

  /*
   * A WhatsApp number for people who are not on the payroll — the MD, office staff, anyone
   * with a login but no employee record. Without it those accounts could be picked as
   * recipients and then silently skipped for having no address on file.
   */
  await addColumn('users', 'whatsapp_phone', 'VARCHAR(40) NULL');
}

async function createSubcontractQuotationTables() {
  await query(`CREATE TABLE IF NOT EXISTS subcontractor_quotations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    reference VARCHAR(60) NOT NULL UNIQUE,
    subcontractor_id BIGINT UNSIGNED NOT NULL,
    project_id BIGINT UNSIGNED NULL,
    boq_id BIGINT UNSIGNED NULL,
    /* Their number for it, which is what either side will quote on the telephone. */
    their_reference VARCHAR(80) NULL,
    package VARCHAR(200) NOT NULL,
    quote_date DATE NOT NULL,
    validity_days SMALLINT UNSIGNED NOT NULL DEFAULT 7,
    valid_until DATE NULL,
    site_address VARCHAR(300) NULL,
    contact_person VARCHAR(120) NULL,
    contact_phone VARCHAR(40) NULL,
    subtotal DECIMAL(15,2) NOT NULL DEFAULT 0,
    discount_total DECIMAL(15,2) NOT NULL DEFAULT 0,
    total DECIMAL(15,2) NOT NULL DEFAULT 0,
    notes VARCHAR(1000) NULL,
    source_file_key VARCHAR(400) NULL,
    source_filename VARCHAR(190) NULL,
    source_checksum CHAR(64) NULL,
    status ENUM('Received','Accepted','Rejected','Expired','Superseded') NOT NULL DEFAULT 'Received',
    decided_at DATETIME NULL, decided_by BIGINT UNSIGNED NULL, decision_note VARCHAR(400) NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_subquote_sub FOREIGN KEY(subcontractor_id) REFERENCES subcontractors(id),
    CONSTRAINT fk_subquote_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_subquote_boq FOREIGN KEY(boq_id) REFERENCES boqs(id),
    CONSTRAINT fk_subquote_user FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT fk_subquote_decider FOREIGN KEY(decided_by) REFERENCES users(id),
    INDEX idx_subquote_project (project_id, status),
    INDEX idx_subquote_valid (valid_until)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  await addColumn('subcontractor_quotations', 'source_file_key', 'VARCHAR(400) NULL');
  await addColumn('subcontractor_quotations', 'source_filename', 'VARCHAR(190) NULL');
  await addColumn('subcontractor_quotations', 'source_checksum', 'CHAR(64) NULL');

  await query(`CREATE TABLE IF NOT EXISTS subcontractor_quotation_items (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    quotation_id BIGINT UNSIGNED NOT NULL,
    description VARCHAR(300) NOT NULL,
    unit VARCHAR(30) NULL,
    quantity DECIMAL(14,3) NOT NULL DEFAULT 1,
    rate DECIMAL(14,2) NOT NULL DEFAULT 0,
    discount DECIMAL(14,2) NOT NULL DEFAULT 0,
    amount DECIMAL(15,2) NOT NULL DEFAULT 0,
    position SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    CONSTRAINT fk_subquoteitem_quote FOREIGN KEY(quotation_id) REFERENCES subcontractor_quotations(id) ON DELETE CASCADE,
    INDEX idx_subquoteitem_quote (quotation_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  /* Which subcontract price ended up inside which of GKUC's own quotations, and at what
     markup — the answer to "why is this line priced as it is" a year later. */
  await addColumn('quotation_items', 'source_subquote_id', 'BIGINT UNSIGNED NULL');
  await addIndex('quotation_items', 'idx_quoteitem_subquote', 'INDEX idx_quoteitem_subquote(source_subquote_id)');
  await addForeignKey('quotation_items', 'fk_quoteitem_subquote',
    'CONSTRAINT fk_quoteitem_subquote FOREIGN KEY(source_subquote_id) REFERENCES subcontractor_quotations(id)');

  /* A bill from a subcontractor should be traceable to the price that was agreed. */
  await addColumn('subcontractor_bills', 'quotation_id', 'BIGINT UNSIGNED NULL');
  await addForeignKey('subcontractor_bills', 'fk_subbill_quote',
    'CONSTRAINT fk_subbill_quote FOREIGN KEY(quotation_id) REFERENCES subcontractor_quotations(id)');

  /* GKUC quoting a main contractor rather than an end client. */
  await addColumn('quotations_client', 'engagement',
    "ENUM('Direct','As subcontractor') NOT NULL DEFAULT 'Direct'");
  await addColumn('quotations_client', 'main_contractor', 'VARCHAR(180) NULL');
}

async function createConstructionOperationsTables() {
  await addColumn('quotation_items','material_id','BIGINT UNSIGNED NULL');
  await addForeignKey('quotation_items','fk_quoteitem_material',
    'CONSTRAINT fk_quoteitem_material FOREIGN KEY(material_id) REFERENCES materials(id)');
  await addColumn('materials','stock_kind',"ENUM('Consumable','Returnable') NOT NULL DEFAULT 'Consumable'");
  await addColumn('subcontractors','address','VARCHAR(400) NULL');
  await addColumn('subcontractors','business_id','VARCHAR(100) NULL');
  await addColumn('subcontractors','contact_type',"ENUM('Company','Individual') NOT NULL DEFAULT 'Company'");
  await addColumn('boq_items','subcontract_rate_id','BIGINT UNSIGNED NULL');
  await addColumn('client_invoice_items','quotation_item_id','BIGINT UNSIGNED NULL');
  await query(`CREATE TABLE IF NOT EXISTS project_updates (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL,
    kind ENUM('Update','Issue') NOT NULL DEFAULT 'Update', title VARCHAR(220) NOT NULL,
    details TEXT NOT NULL, category VARCHAR(80) NOT NULL DEFAULT 'General',
    status ENUM('Open','In progress','Resolved') NOT NULL DEFAULT 'Open',
    priority ENUM('Low','Medium','High') NOT NULL DEFAULT 'Medium',
    owner VARCHAR(120) NULL, due_date DATE NULL, created_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_pupdate_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_pupdate_user FOREIGN KEY(created_by) REFERENCES users(id),
    INDEX idx_pupdate_project(project_id,status,created_at)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS subcontractor_project_rates (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, project_id BIGINT UNSIGNED NOT NULL,
    subcontractor_id BIGINT UNSIGNED NOT NULL, work_item VARCHAR(220) NOT NULL,
    unit VARCHAR(30) NOT NULL, rate DECIMAL(14,2) NOT NULL,
    agreed_on DATE NULL, valid_until DATE NULL, notes VARCHAR(600) NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_subrate_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_subrate_sub FOREIGN KEY(subcontractor_id) REFERENCES subcontractors(id),
    CONSTRAINT fk_subrate_user FOREIGN KEY(created_by) REFERENCES users(id),
    UNIQUE KEY uq_subrate_project_work(project_id,subcontractor_id,work_item),
    INDEX idx_subrate_project(project_id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS stock_loans (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, material_id BIGINT UNSIGNED NOT NULL,
    project_id BIGINT UNSIGNED NOT NULL, quantity DECIMAL(14,3) NOT NULL,
    returned_quantity DECIMAL(14,3) NOT NULL DEFAULT 0,
    taken_by VARCHAR(120) NOT NULL, handed_over_by VARCHAR(120) NOT NULL,
    received_back_by VARCHAR(120) NULL, issued_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    returned_at DATETIME NULL, condition_out VARCHAR(300) NULL,
    condition_in VARCHAR(300) NULL, reference VARCHAR(120) NULL,
    created_by BIGINT UNSIGNED NOT NULL,
    CONSTRAINT fk_stockloan_material FOREIGN KEY(material_id) REFERENCES materials(id),
    CONSTRAINT fk_stockloan_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_stockloan_user FOREIGN KEY(created_by) REFERENCES users(id),
    INDEX idx_stockloan_open(material_id,project_id,returned_at)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS site_material_consumption (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,material_id BIGINT UNSIGNED NOT NULL,
    project_id BIGINT UNSIGNED NOT NULL,quantity DECIMAL(14,3) NOT NULL,
    consumed_on DATE NOT NULL,notes VARCHAR(500) NULL,recorded_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_siteuse_material FOREIGN KEY(material_id) REFERENCES materials(id),
    CONSTRAINT fk_siteuse_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_siteuse_user FOREIGN KEY(recorded_by) REFERENCES users(id),
    INDEX idx_siteuse_project(project_id,material_id,consumed_on)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS site_material_counts (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,material_id BIGINT UNSIGNED NOT NULL,
    project_id BIGINT UNSIGNED NOT NULL,counted_quantity DECIMAL(14,3) NOT NULL,
    baseline_issued DECIMAL(14,3) NOT NULL,baseline_consumed DECIMAL(14,3) NOT NULL,
    notes VARCHAR(500) NULL,counted_by BIGINT UNSIGNED NOT NULL,
    counted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_sitecount_material FOREIGN KEY(material_id) REFERENCES materials(id),
    CONSTRAINT fk_sitecount_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_sitecount_user FOREIGN KEY(counted_by) REFERENCES users(id),
    INDEX idx_sitecount_latest(project_id,material_id,id)
  ) ENGINE=InnoDB`);
  await addForeignKey('boq_items','fk_boqitem_subrate',
    'CONSTRAINT fk_boqitem_subrate FOREIGN KEY(subcontract_rate_id) REFERENCES subcontractor_project_rates(id)');
  await addForeignKey('client_invoice_items','fk_invoiceitem_quoteline',
    'CONSTRAINT fk_invoiceitem_quoteline FOREIGN KEY(quotation_item_id) REFERENCES quotation_items(id)');
}

async function createFleetHistoryTables() {
  await addColumn('vehicle_maintenance','maintenance_kind',"ENUM('Service','Repair','Inspection') NOT NULL DEFAULT 'Service'");
  await addColumn('vehicle_maintenance','project_id','BIGINT UNSIGNED NULL');
  await addForeignKey('vehicle_maintenance','fk_vehmaint_project',
    'CONSTRAINT fk_vehmaint_project FOREIGN KEY(project_id) REFERENCES projects(id)');
  await query(`CREATE TABLE IF NOT EXISTS vehicle_driver_assignments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,vehicle_id BIGINT UNSIGNED NOT NULL,
    employee_id BIGINT UNSIGNED NULL,driver_name VARCHAR(120) NOT NULL,
    project_id BIGINT UNSIGNED NULL,assigned_on DATE NOT NULL,ended_on DATE NULL,
    notes VARCHAR(500) NULL,assigned_by BIGINT UNSIGNED NULL,
    CONSTRAINT fk_vdriver_vehicle FOREIGN KEY(vehicle_id) REFERENCES fleet(id),
    CONSTRAINT fk_vdriver_employee FOREIGN KEY(employee_id) REFERENCES employees(id),
    CONSTRAINT fk_vdriver_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_vdriver_user FOREIGN KEY(assigned_by) REFERENCES users(id),
    INDEX idx_vdriver_vehicle(vehicle_id,ended_on,assigned_on)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS vehicle_odometer_readings (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,vehicle_id BIGINT UNSIGNED NOT NULL,
    reading_date DATE NOT NULL,odometer INT UNSIGNED NOT NULL,
    source ENUM('Manual','Fuel','Service','Repair','Inspection') NOT NULL,
    source_id BIGINT UNSIGNED NULL,notes VARCHAR(300) NULL,recorded_by BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_vodo_vehicle FOREIGN KEY(vehicle_id) REFERENCES fleet(id),
    CONSTRAINT fk_vodo_user FOREIGN KEY(recorded_by) REFERENCES users(id),
    INDEX idx_vodo_vehicle(vehicle_id,reading_date,id),UNIQUE KEY uq_vodo_source(source,source_id)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS vehicle_document_renewals (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,vehicle_id BIGINT UNSIGNED NOT NULL,
    doc_type VARCHAR(60) NOT NULL,reference VARCHAR(120) NULL,
    renewed_on DATE NOT NULL,expiry_date DATE NOT NULL,cost DECIMAL(12,2) NOT NULL DEFAULT 0,
    recorded_by BIGINT UNSIGNED NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_vrenew_vehicle FOREIGN KEY(vehicle_id) REFERENCES fleet(id),
    CONSTRAINT fk_vrenew_user FOREIGN KEY(recorded_by) REFERENCES users(id),
    INDEX idx_vrenew_vehicle(vehicle_id,doc_type,renewed_on)
  ) ENGINE=InnoDB`);
  await addIndex('vehicle_odometer_readings','uq_vodo_source',
    'UNIQUE INDEX uq_vodo_source(source,source_id)');
  await query(`INSERT INTO vehicle_driver_assignments
    (vehicle_id,employee_id,driver_name,project_id,assigned_on,notes)
    SELECT f.id,f.driver_employee_id,COALESCE(e.name,f.driver),f.project_id,CURDATE(),
      'Current driver imported; original assignment date is unknown'
    FROM fleet f LEFT JOIN employees e ON e.id=f.driver_employee_id
    WHERE COALESCE(e.name,f.driver) IS NOT NULL AND NOT EXISTS
      (SELECT 1 FROM vehicle_driver_assignments a WHERE a.vehicle_id=f.id)`);
  await query(`INSERT INTO vehicle_odometer_readings
    (vehicle_id,reading_date,odometer,source,source_id,notes,recorded_by)
    SELECT f.vehicle_id,f.fuel_date,f.odometer,'Fuel',f.id,'Imported from existing fuel record',f.created_by
    FROM fuel_records f WHERE f.odometer>0 AND NOT EXISTS
      (SELECT 1 FROM vehicle_odometer_readings r WHERE r.source='Fuel' AND r.source_id=f.id)`);
  await query(`INSERT INTO vehicle_odometer_readings
    (vehicle_id,reading_date,odometer,source,source_id,notes,recorded_by)
    SELECT m.vehicle_id,m.service_date,m.odometer,m.maintenance_kind,m.id,
      'Imported from existing workshop record',m.created_by
    FROM vehicle_maintenance m WHERE m.odometer>0 AND NOT EXISTS
      (SELECT 1 FROM vehicle_odometer_readings r WHERE r.source_id=m.id
        AND r.source IN ('Service','Repair','Inspection'))`);
}

/** Non-destructive upgrades for databases created by an earlier version. */
async function migrateExistingInstalls() {
  /* The role column was an ENUM, which cannot hold roles the MD invents. It becomes a plain
     name mirroring roles.name, with role_id as the real relationship. */
  await modifyColumn('users', 'role', 'VARCHAR(120) NOT NULL');
  await addColumn('users', 'role_id', 'BIGINT UNSIGNED NULL');
  await addForeignKey('users', 'fk_users_role', 'CONSTRAINT fk_users_role FOREIGN KEY(role_id) REFERENCES roles(id)');
  await modifyColumn('attendance', 'state', "ENUM('On site','Late','Checked out','Absent','On leave','Business trip') NOT NULL");
  await modifyColumn('stock_movements', 'movement_type', "ENUM('Receipt','Issue','Return','Adjustment','Transfer') NOT NULL");
  await addColumn('materials', 'unit_cost', 'DECIMAL(14,2) NOT NULL DEFAULT 0');

  /* Shared registers deliberately have no company_id. Commercial ownership begins at a
     project or, for a document raised before a project exists, on that document itself. */
  await addColumn('projects', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('projects', 'fk_project_company', 'CONSTRAINT fk_project_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await addIndex('projects', 'idx_project_company', 'INDEX idx_project_company(company_id,active)');
  await addColumn('inquiries', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('inquiries', 'fk_inquiry_company', 'CONSTRAINT fk_inquiry_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await addColumn('quotations_client', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('quotations_client', 'fk_quote_company', 'CONSTRAINT fk_quote_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await addColumn('tenders', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('tenders', 'fk_tender_company', 'CONSTRAINT fk_tender_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await addColumn('employees', 'payroll_company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('employees', 'fk_employee_payroll_company', 'CONSTRAINT fk_employee_payroll_company FOREIGN KEY(payroll_company_id) REFERENCES companies(id)');
  await addColumn('payroll_runs', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('payroll_runs', 'fk_payroll_company', 'CONSTRAINT fk_payroll_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await dropIndex('payroll_runs', 'uq_payroll_period_frequency');
  await addIndex('payroll_runs', 'uq_payroll_company_period_frequency',
    'UNIQUE KEY uq_payroll_company_period_frequency(company_id,period_start,period_end,pay_frequency)');
  await addColumn('payroll_policies', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('payroll_policies', 'fk_payroll_policy_company', 'CONSTRAINT fk_payroll_policy_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await dropIndex('payroll_policies', 'effective_from');
  await addIndex('payroll_policies', 'uq_payroll_policy_company_date',
    'UNIQUE KEY uq_payroll_policy_company_date(company_id,effective_from)');
  await query(`INSERT INTO payroll_policies
    (company_id,effective_from,office_ot_rate,site_labour_site_ot_rate,site_labour_travel_ot_rate,
     driver_ot_rate,supervisor_site_ot_rate,supervisor_travel_ot_rate)
    SELECT 2,'2000-01-01',225,200,100,225,225,100
    WHERE NOT EXISTS (SELECT 1 FROM payroll_policies WHERE company_id=2)`);
  await addColumn('supplier_invoices', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addColumn('supplier_invoices', 'net_amount', 'DECIMAL(15,2) NOT NULL DEFAULT 0');
  await addColumn('supplier_invoices', 'tax_treatment', "ENUM('Standard','Exempt') NOT NULL DEFAULT 'Exempt'");
  await addColumn('supplier_invoices', 'vat_rate', 'DECIMAL(5,2) NOT NULL DEFAULT 0');
  await addColumn('supplier_invoices', 'vat_amount', 'DECIMAL(15,2) NOT NULL DEFAULT 0');
  await query('UPDATE supplier_invoices SET net_amount=amount WHERE net_amount=0');
  await addForeignKey('supplier_invoices', 'fk_supplier_invoice_company', 'CONSTRAINT fk_supplier_invoice_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await addColumn('issued_cheques', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('issued_cheques', 'fk_issued_cheque_company', 'CONSTRAINT fk_issued_cheque_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await addColumn('received_cheques', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('received_cheques', 'fk_received_cheque_company', 'CONSTRAINT fk_received_cheque_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await addColumn('bank_bonds', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addColumn('bank_bonds', 'reminder_days', 'SMALLINT UNSIGNED NOT NULL DEFAULT 30');
  await addForeignKey('bank_bonds', 'fk_bond_company', 'CONSTRAINT fk_bond_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await addColumn('petty_cash_floats', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('petty_cash_floats', 'fk_float_company', 'CONSTRAINT fk_float_company FOREIGN KEY(company_id) REFERENCES companies(id)');
  await addColumn('subcontractor_quotations', 'company_id', 'TINYINT UNSIGNED NOT NULL DEFAULT 1');
  await addForeignKey('subcontractor_quotations', 'fk_subquote_company', 'CONSTRAINT fk_subquote_company FOREIGN KEY(company_id) REFERENCES companies(id)');

  /* Project ownership wins over legacy defaults. Pre-project tenders are recognised from
     the entity name already stored in the old bidding-entity field. */
  await query('UPDATE inquiries i JOIN projects p ON p.id=i.project_id SET i.company_id=p.company_id');
  await query(`UPDATE quotations_client q LEFT JOIN projects p ON p.id=q.project_id
    LEFT JOIN inquiries i ON i.id=q.inquiry_id SET q.company_id=COALESCE(p.company_id,i.company_id,q.company_id)`);
  await query(`UPDATE tenders SET company_id=2 WHERE LOWER(COALESCE(bidding_entity,'')) REGEXP 'ready[ ]?mix|readymix'`);
  await query('UPDATE tenders t JOIN projects p ON p.id=t.project_id SET t.company_id=p.company_id');
  await query('UPDATE supplier_invoices si JOIN purchase_orders po ON po.id=si.order_id JOIN projects p ON p.id=po.project_id SET si.company_id=p.company_id');
  await query('UPDATE issued_cheques c JOIN supplier_invoices si ON si.id=c.invoice_id SET c.company_id=si.company_id');
  await query('UPDATE received_cheques c JOIN projects p ON p.id=c.project_id SET c.company_id=p.company_id');
  await query('UPDATE bank_bonds b JOIN projects p ON p.id=b.project_id SET b.company_id=p.company_id');
  await query('UPDATE petty_cash_floats f JOIN projects p ON p.id=f.project_id SET f.company_id=p.company_id');
  await query('UPDATE subcontractor_quotations q JOIN projects p ON p.id=q.project_id SET q.company_id=p.company_id');
  await addColumn('stock_movements', 'project_id', 'BIGINT UNSIGNED NULL');
  await addColumn('stock_movements', 'destination', 'VARCHAR(180) NULL');
  await addColumn('fleet', 'project_id', 'BIGINT UNSIGNED NULL');
  await addColumn('fleet', 'odometer', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('daily_reports', 'delay_hours', 'DECIMAL(5,2) NOT NULL DEFAULT 0');
  await addColumn('attendance', 'employee_id', 'BIGINT UNSIGNED NULL');
  await addColumn('notifications', 'severity', "ENUM('Info','Warning','Critical') NOT NULL DEFAULT 'Info'");
  await addColumn('notifications', 'dedupe_key', 'VARCHAR(190) NULL');
  await addColumn('notifications', 'audience', 'VARCHAR(120) NULL');
  await addColumn('tasks', 'due_date', 'DATE NULL');
  /* A site is Active or Rescheduled; the reason for the last change travels with it. */
  await addColumn('projects', 'site_status', "ENUM('Active','Rescheduled','On hold','Completed') NOT NULL DEFAULT 'Active'");
  await addColumn('projects', 'status_reason', 'VARCHAR(500) NULL');
  await addColumn('projects', 'status_changed_at', 'DATETIME NULL');
  await addColumn('employees', 'current_project_id', 'BIGINT UNSIGNED NULL');
  await addForeignKey('employees', 'fk_employee_project', 'CONSTRAINT fk_employee_project FOREIGN KEY(current_project_id) REFERENCES projects(id)');
  await addColumn('fleet', 'driver_employee_id', 'BIGINT UNSIGNED NULL');
  await addColumn('fleet', 'service_interval_km', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('fleet', 'service_interval_months', 'TINYINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('fleet', 'last_service_date', 'DATE NULL');
  await addColumn('fleet', 'last_service_odometer', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('equipment', 'qr_token', 'CHAR(32) NULL');
  await addIndex('equipment', 'uq_equipment_qr', 'UNIQUE KEY uq_equipment_qr(qr_token)');
  await addColumn('employees', 'photo_url', 'VARCHAR(600) NULL');
  /*
   * The fingerprint terminal knows people by its own enrolment number, which has nothing to
   * do with GKUC's employee codes. Recording it once against the employee is what lets an
   * export be matched without anybody retyping names — and the mapping is remembered, so it
   * only has to be done for a person once.
   */
  /* Wording for one document, overriding the standing text — a quotation with unusual
     payment terms should not require changing the terms every other document carries. */
  await addColumn('quotations_client', 'terms', 'TEXT NULL');
  await addColumn('boqs', 'terms', 'TEXT NULL');
  await addColumn('employees', 'biometric_id', 'VARCHAR(40) NULL');
  await addIndex('employees', 'uq_employee_biometric', 'UNIQUE KEY uq_employee_biometric(biometric_id)');
  /* A person may have been enrolled under several terminal numbers. Keep the legacy
     display column, but match imports through this many-to-one identity register. */
  await query(`CREATE TABLE IF NOT EXISTS employee_biometric_ids (
    code VARCHAR(40) NOT NULL PRIMARY KEY,
    employee_id BIGINT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_biometric_identity_employee FOREIGN KEY(employee_id) REFERENCES employees(id),
    INDEX idx_biometric_identity_employee(employee_id)
  ) ENGINE=InnoDB`);
  await query(`INSERT IGNORE INTO employee_biometric_ids (code,employee_id)
    SELECT biometric_id,id FROM employees WHERE biometric_id IS NOT NULL AND biometric_id<>''`);
  /* Office employees may normally work at head office or be sent to a site. Site workers
     are either allocated to a site or available. Nullable first lets legacy rows be
     classified once without overwriting later HR decisions on every restart. */
  await addColumn('employees', 'worker_type', "ENUM('Office','Site') NULL");
  await query(`UPDATE employees e LEFT JOIN departments d ON d.id=e.department_id
    SET e.worker_type=CASE
      WHEN LOWER(COALESCE(d.name,'')) REGEXP 'human resources|(^| )hr($| )|account|finance|administration|(^| )admin($| )|quantity survey|(^| )qs($| )'
        THEN 'Office' ELSE 'Site' END
    WHERE e.worker_type IS NULL`);
  if (await columnIsNullable('employees', 'worker_type'))
    await query("ALTER TABLE employees MODIFY worker_type ENUM('Office','Site') NOT NULL DEFAULT 'Site'");
  /* A day with a single punch cannot say whether the person arrived or left; it is imported
     but flagged, so payroll is never quietly built on a guess. */
  await addColumn('attendance', 'needs_review', 'TINYINT(1) NOT NULL DEFAULT 0');
  await addColumn('attendance', 'source', "VARCHAR(20) NOT NULL DEFAULT 'Manual'");
  await addColumn('attendance', 'work_location', "ENUM('Office','Site') NOT NULL DEFAULT 'Site'");
  await modifyColumn('attendance', 'work_location', "ENUM('Office','Site','Not working') NOT NULL DEFAULT 'Site'");
  await query(`CREATE TABLE IF NOT EXISTS employee_work_locations (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    employee_id BIGINT UNSIGNED NOT NULL,
    work_date DATE NOT NULL,
    work_location ENUM('Office','Site') NOT NULL,
    project_id BIGINT UNSIGNED NULL,
    note VARCHAR(500) NOT NULL,
    updated_by BIGINT UNSIGNED NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_employee_work_location_day(employee_id,work_date),
    KEY idx_employee_work_location_date(work_date),
    CONSTRAINT fk_employee_work_location_employee FOREIGN KEY(employee_id) REFERENCES employees(id),
    CONSTRAINT fk_employee_work_location_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_employee_work_location_user FOREIGN KEY(updated_by) REFERENCES users(id)
  ) ENGINE=InnoDB`);
  if (!(await columnIsNullable('attendance', 'project_id')))
    await query('ALTER TABLE attendance MODIFY project_id BIGINT UNSIGNED NULL');
  await addColumn('expenses', 'boq_item_id', 'BIGINT UNSIGNED NULL');
  await addColumn('expenses', 'cost_type', "ENUM('Expected','Variation','Unexpected') NOT NULL DEFAULT 'Expected'");
  await addColumn('expenses', 'quantity', 'DECIMAL(14,3) NULL');
  await addColumn('expenses', 'unit', 'VARCHAR(30) NULL');
  await addColumn('expenses', 'unit_rate', 'DECIMAL(14,2) NULL');
  await addForeignKey('expenses', 'fk_expense_boq_item', 'CONSTRAINT fk_expense_boq_item FOREIGN KEY(boq_item_id) REFERENCES boq_items(id)');
  await addForeignKey('fleet', 'fk_fleet_driver', 'CONSTRAINT fk_fleet_driver FOREIGN KEY(driver_employee_id) REFERENCES employees(id)');
  await addIndex('notifications', 'uq_notification_dedupe', 'UNIQUE KEY uq_notification_dedupe(dedupe_key)');
  await addForeignKey('attendance', 'fk_attendance_employee', 'CONSTRAINT fk_attendance_employee FOREIGN KEY(employee_id) REFERENCES employees(id)');
  await onlyOneOpenLendingPerAsset();
}

/**
 * One asset can be out on one lending at a time — enforced by the database, not by hope.
 *
 * The application already refuses to lend out something that is already out, but that check
 * could only ever be as good as the column it read, and a tool was found committed to two
 * sites at once. Every screen that lists equipment then showed it twice, and React dropped
 * one of the two.
 *
 * A partial unique index would be the natural fit and MySQL has none; a generated column
 * standing in for one cannot be added to a table that carries foreign keys. So the rule is
 * stated as a trigger, the way the gallery's evidence lock already is.
 */
async function onlyOneOpenLendingPerAsset() {
  /* Older duplicates are closed first: a rule cannot be imposed on data that already breaks
     it, and refusing to migrate would leave the customer with no rule at all. */
  const duplicates = await query(`
    SELECT equipment_id, MAX(id) keep FROM equipment_assignments
     WHERE returned_at IS NULL GROUP BY equipment_id HAVING COUNT(*) > 1`);
  for (const row of duplicates) {
    await query(
      `UPDATE equipment_assignments SET returned_at = COALESCE(due_back, assigned_at),
              condition_note = CONCAT(COALESCE(condition_note,''),
                ' [closed automatically: superseded by a later lending of the same asset]')
        WHERE equipment_id = ? AND returned_at IS NULL AND id <> ?`, [row.equipment_id, row.keep]);
  }
  if (duplicates.length) {
    console.warn(`Closed stale lendings on ${duplicates.length} asset(s) that were out twice.`);
  }

  /*
   * The status column is a summary of the lending table, so drift is repaired here too: an
   * asset with an open lending reads Assigned, one without reads Available. Retired and
   * Maintenance are left alone — those say something the lending table does not.
   */
  await query(`
    UPDATE equipment eq SET eq.status='Assigned'
     WHERE eq.status='Available'
       AND EXISTS (SELECT 1 FROM equipment_assignments a
                    WHERE a.equipment_id=eq.id AND a.returned_at IS NULL)`);
  await query(`
    UPDATE equipment eq SET eq.status='Available'
     WHERE eq.status='Assigned'
       AND NOT EXISTS (SELECT 1 FROM equipment_assignments a
                        WHERE a.equipment_id=eq.id AND a.returned_at IS NULL)`);

  const existing = await query(
    `SELECT TRIGGER_NAME FROM information_schema.triggers
      WHERE TRIGGER_SCHEMA=DATABASE() AND TRIGGER_NAME='equipment_one_open_lending'`);
  if (existing.length) return;
  try {
    await ddl(`CREATE TRIGGER equipment_one_open_lending BEFORE INSERT ON equipment_assignments
      FOR EACH ROW
      BEGIN
        IF NEW.returned_at IS NULL AND EXISTS (
          SELECT 1 FROM equipment_assignments a
           WHERE a.equipment_id = NEW.equipment_id AND a.returned_at IS NULL) THEN
          SIGNAL SQLSTATE '45000'
            SET MESSAGE_TEXT = 'That equipment is already out. Record its return first.';
        END IF;
      END`);
  } catch (error) {
    console.warn('Equipment lending rule not installed (needs the TRIGGER privilege):', error.message);
  }
}


/**
 * Writes the starting roles once. It never rewrites an existing role's permissions, so a
 * change the MD makes in the product is permanent and survives every future deployment.
 */
/**
 * The catalogue as it stands in GKUC's own quotations from July and August 2026 — the rates
 * are the ones they actually quoted, so the price book is useful on the first day rather
 * than an empty table somebody has to fill in before the feature does anything.
 */
async function seedWorkMethods() {
  const [{ count }] = await query('SELECT COUNT(*) count FROM work_methods');
  if (count) return;

  const methods = [
    ['Tar', 'Tar Laying', 'Surfacing', '', 'Sq.ft', 390,
      'Clearing the surface\nABC laying & compaction (4" loose thickness)\n1½" & ¾" metal laying & compaction\nBitumen 1st coat laying & chip sealing\nBitumen 2nd coat laying & sand sealing',
      '70% - Advance payment\n20% - After ABC laying\n10% - Before Bitumen 2nd coat laying'],
    ['Asp', 'Asphalt Carpet Laying', 'Surfacing', '', 'Sq.ft', 530,
      'Clearing the surface\nRemoving the existing base failures in required areas\nABC laying & compaction for required areas\nTack coat laying\nAsphalt carpet laying using paver (2" loose thickness)\nRoller compaction',
      '60% - Advance payment\n30% - After ABC laying\n10% - Before asphalt carpet laying'],
    ['Col', 'Cold Mix / Asphalt Carpet Laying', 'Surfacing', '', 'Sq.ft', 700,
      'Clearing the surface\nABC laying & compaction (4" loose thickness)\nTack coat laying\nCold mix / asphalt carpet laying manually (2" loose thickness)\nRoller compaction',
      '70% - Advance payment\n20% - After ABC laying\n10% - Before cold mix laying'],
    ['Con', 'Concrete Laying', 'Surfacing', '', 'Sq.ft', 550, '', ''],
    ['Asp', '50mm thick Asphalt layer', 'Surfacing', '', 'M2', 7000, '', ''],
    ['CRS-01', 'Supplying CRS-01', 'Supply', 'Cationic rapid setting bitumen emulsion', 'Ltr', 370,
      '', '100% - Full payment before supply'],
    ['CSS-1', 'Prime coat bitumen emulsion CSS-1', 'Preparation',
      'At the rate of 1 Ltr/Sqm, blinding with sand', 'Ltr', 370, '', ''],
    ['CSS-1', 'Tack coat bitumen emulsion CSS-1', 'Preparation',
      'At the rate of 0.5 Ltr/Sqm', 'Ltr', 300, '', ''],
    ['Disp', 'Disposal of excavated material off-site', 'Earthworks',
      'To an approved tipping location outside the premises, including loading, haulage, tipping fees and compliance with environmental regulations; measured per trip or load',
      'Cu.m', 550, '', ''],
    ['Drain', 'Construction of 600mm x 600mm U-drain with cover slab', 'Drainage', '', 'L.m', 38000, '', '']
  ];

  for (const [code, name, category, description, unit, rate, statement, terms] of methods) {
    await query(`INSERT IGNORE INTO work_methods
      (code,name,category,description,unit,default_rate,method_statement,payment_terms)
      VALUES (?,?,?,?,?,?,?,?)`,
    [code, name, category, description, unit, rate, statement || null, terms || null]);
  }
}

async function seedAccessControl() {
  const [{ count }] = await query('SELECT COUNT(*) count FROM roles');
  if (!count) {
    for (const role of DEFAULT_ROLES) {
      const result = await query('INSERT INTO roles (name,description,is_system) VALUES (?,?,?)',
        [role.name, role.description, role.system ? 1 : 0]);
      for (const key of role.permissions()) {
        await query('INSERT IGNORE INTO role_permissions (role_id,permission_key) VALUES (?,?)', [result.insertId, key]);
      }
    }
  }

  /* A role created before a permission existed should still receive it if it holds
     everything else — this keeps the MD's "full access" role genuinely full. */
  const systemRoles = await query('SELECT id FROM roles WHERE is_system=1');
  for (const role of systemRoles) {
    for (const permission of PERMISSIONS) {
      await query('INSERT IGNORE INTO role_permissions (role_id,permission_key) VALUES (?,?)', [role.id, permission.key]);
    }
  }

  /* Point every account at a real role, translating the names used by the previous build. */
  const unassigned = await query('SELECT id,role FROM users WHERE role_id IS NULL');
  for (const user of unassigned) {
    const target = LEGACY_ROLE_MAP[user.role] || user.role;
    const role = (await query('SELECT id,name FROM roles WHERE name=?', [target]))[0]
      || (await query('SELECT id,name FROM roles WHERE name=?', ['Read-Only Viewer']))[0];
    if (role) await query('UPDATE users SET role_id=?, role=? WHERE id=?', [role.id, role.name, user.id]);
  }
}

async function createClientDirectory() {
  await query(`CREATE TABLE IF NOT EXISTS clients (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    type ENUM('Private','Organisation') NOT NULL DEFAULT 'Organisation',
    name VARCHAR(180) NOT NULL,
    contact_person VARCHAR(120) NULL,
    phone VARCHAR(40) NULL,
    alternate_phone VARCHAR(40) NULL,
    email VARCHAR(190) NULL,
    billing_address VARCHAR(500) NULL,
    site_address VARCHAR(500) NULL,
    city VARCHAR(120) NULL,
    district VARCHAR(120) NULL,
    province VARCHAR(120) NULL,
    country VARCHAR(100) NULL,
    registration_number VARCHAR(100) NULL,
    tax_number VARCHAR(100) NULL,
    tin VARCHAR(100) NULL,
    vat_number VARCHAR(100) NULL,
    notes TEXT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_clients_name(name)
  ) ENGINE=InnoDB`);
  await addColumn('clients', 'tin', 'VARCHAR(100) NULL');
  await addColumn('clients', 'vat_number', 'VARCHAR(100) NULL');
  for (const table of ['projects', 'inquiries', 'quotations_client', 'client_invoices', 'tenders']) {
    await addColumn(table, 'client_id', 'BIGINT UNSIGNED NULL');
    await addForeignKey(table, `fk_${table}_client_directory`,
      `CONSTRAINT fk_${table}_client_directory FOREIGN KEY(client_id) REFERENCES clients(id)`);
  }
  // Keep historical document names intact; the link supplies the live client profile.
  const names = await query(`SELECT DISTINCT name FROM (
    SELECT client name FROM projects WHERE client_id IS NULL UNION ALL
    SELECT customer_name name FROM inquiries WHERE client_id IS NULL UNION ALL
    SELECT client_name name FROM quotations_client WHERE client_id IS NULL UNION ALL
    SELECT client name FROM client_invoices WHERE client_id IS NULL UNION ALL
    SELECT client name FROM tenders WHERE client_id IS NULL
  ) legacy WHERE name IS NOT NULL AND TRIM(name)<>''`);
  for (const { name } of names) {
    if (!await query('SELECT id FROM clients WHERE LOWER(name)=LOWER(?) LIMIT 1', [name]).then(rows => rows[0]))
      await query('INSERT INTO clients (name) VALUES (?)', [name]);
  }
  await query(`UPDATE projects p JOIN clients c ON LOWER(c.name)=LOWER(p.client)
    SET p.client_id=c.id WHERE p.client_id IS NULL`);
  await query(`UPDATE inquiries i JOIN clients c ON LOWER(c.name)=LOWER(i.customer_name)
    SET i.client_id=c.id WHERE i.client_id IS NULL`);
  await query(`UPDATE quotations_client q JOIN clients c ON LOWER(c.name)=LOWER(q.client_name)
    SET q.client_id=c.id WHERE q.client_id IS NULL`);
  await query(`UPDATE client_invoices i JOIN clients c ON LOWER(c.name)=LOWER(i.client)
    SET i.client_id=c.id WHERE i.client_id IS NULL`);
  await query(`UPDATE tenders t JOIN clients c ON LOWER(c.name)=LOWER(t.client)
    SET t.client_id=c.id WHERE t.client_id IS NULL`);
}

async function createProjectManagerLinks() {
  await addColumn('projects', 'manager_employee_id', 'BIGINT UNSIGNED NULL');
  await addForeignKey('projects', 'fk_project_manager_employee',
    'CONSTRAINT fk_project_manager_employee FOREIGN KEY(manager_employee_id) REFERENCES employees(id)');
  // Link old names only when exactly one employee has that name. Ambiguous names need a human decision.
  await query(`UPDATE projects p JOIN (
    SELECT MIN(id) employee_id,LOWER(TRIM(name)) matched_name FROM employees
    GROUP BY LOWER(TRIM(name)) HAVING COUNT(*)=1
  ) e ON LOWER(TRIM(p.manager))=e.matched_name
    SET p.manager_employee_id=e.employee_id WHERE p.manager_employee_id IS NULL`);
  await query(`CREATE TABLE IF NOT EXISTS project_manager_assignments (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    project_id BIGINT UNSIGNED NOT NULL,employee_id BIGINT UNSIGNED NOT NULL,
    assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,released_at DATETIME NULL,
    CONSTRAINT fk_manager_assignment_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_manager_assignment_employee FOREIGN KEY(employee_id) REFERENCES employees(id),
    INDEX idx_manager_assignment_employee(employee_id,project_id)
  ) ENGINE=InnoDB`);
  await query(`INSERT INTO project_manager_assignments (project_id,employee_id,assigned_at)
    SELECT p.id,p.manager_employee_id,p.created_at FROM projects p
    WHERE p.manager_employee_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM project_manager_assignments a WHERE a.project_id=p.id AND a.released_at IS NULL)`);
  await addColumn('tasks', 'assignee_employee_id', 'BIGINT UNSIGNED NULL');
  await addForeignKey('tasks', 'fk_task_assignee_employee',
    'CONSTRAINT fk_task_assignee_employee FOREIGN KEY(assignee_employee_id) REFERENCES employees(id)');
  await query(`UPDATE tasks t JOIN (
    SELECT MIN(id) employee_id,LOWER(TRIM(name)) matched_name FROM employees
    GROUP BY LOWER(TRIM(name)) HAVING COUNT(*)=1
  ) e ON LOWER(TRIM(t.assignee))=e.matched_name
    SET t.assignee_employee_id=e.employee_id WHERE t.assignee_employee_id IS NULL`);
}

export async function migrate() {
  await createCompaniesTable();
  await createCoreTables();
  await createHrTables();
  await createProjectDetailTables();
  await createBoqTables();
  await createPurchasingTables();
  await createAssetTables();
  await createFinanceTables();
  await createReportDetailTables();
  await createAttachmentTables();
  await createLifecycleTables();
  await createAccessTables();
  await createSiteOpsTables();
  await createSequenceTable();
  await createCompanyTable();
  await createDocumentSettingsTable();
  await createQsTables();
  /* After the QS tables: this adds columns to quotations_client. */
  await createMethodTables();
  await createCommunicationTable();
  await createGalleryTables();
  await hardenSessions();
  await createSubcontractQuotationTables();
  await createMessagingTables();
  await createOcrTables();
  await createOnboardingColumns();
  await createChatTables();
  await createReceivableTables();
  await createDriveTables();
  await createIntegrityTables();
  await createOptionTables();
  await createBoqImportTables();
  await migrateExistingInstalls();
  await createConstructionOperationsTables();
  await createFleetHistoryTables();
  await createClientDirectory();
  await createProjectManagerLinks();
  await seedWorkMethods();
  await seedAccessControl();
}
