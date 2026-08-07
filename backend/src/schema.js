import { query } from './db.js';

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
    work_date DATE NOT NULL, check_in TIME NULL, check_out TIME NULL, state ENUM('On site','Late','Checked out','Absent','On leave') NOT NULL,
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
  await query(`CREATE TABLE IF NOT EXISTS employees (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, code VARCHAR(40) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL,
    department_id BIGINT UNSIGNED NULL, designation VARCHAR(120) NOT NULL, phone VARCHAR(40) NULL, email VARCHAR(190) NULL,
    user_id BIGINT UNSIGNED NULL, join_date DATE NOT NULL, basic_salary DECIMAL(12,2) NOT NULL DEFAULT 0,
    daily_rate DECIMAL(10,2) NOT NULL DEFAULT 0, overtime_rate DECIMAL(10,2) NOT NULL DEFAULT 0,
    status ENUM('Active','On leave','Suspended','Left') NOT NULL DEFAULT 'Active', notes VARCHAR(600) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_employee_department FOREIGN KEY(department_id) REFERENCES departments(id),
    CONSTRAINT fk_employee_user FOREIGN KEY(user_id) REFERENCES users(id)
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
    work_date DATE NOT NULL, hours DECIMAL(5,2) NOT NULL, rate DECIMAL(10,2) NOT NULL DEFAULT 0,
    status ENUM('Pending','Approved','Rejected') NOT NULL DEFAULT 'Pending', approved_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_overtime_employee FOREIGN KEY(employee_id) REFERENCES employees(id) ON DELETE CASCADE,
    CONSTRAINT fk_overtime_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_overtime_approver FOREIGN KEY(approved_by) REFERENCES users(id),
    CONSTRAINT chk_overtime_hours CHECK(hours > 0)
  ) ENGINE=InnoDB`);
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
    origin_type VARCHAR(60) NULL, origin_id VARCHAR(60) NULL,
    created_by BIGINT UNSIGNED NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_expense_project FOREIGN KEY(project_id) REFERENCES projects(id),
    CONSTRAINT fk_expense_category FOREIGN KEY(category_id) REFERENCES expense_categories(id),
    CONSTRAINT fk_expense_user FOREIGN KEY(created_by) REFERENCES users(id),
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
    period_start DATE NOT NULL, period_end DATE NOT NULL, status ENUM('Draft','Approved','Paid') NOT NULL DEFAULT 'Draft',
    total DECIMAL(15,2) NOT NULL DEFAULT 0, created_by BIGINT UNSIGNED NOT NULL, approved_by BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_payroll_user FOREIGN KEY(created_by) REFERENCES users(id),
    CONSTRAINT fk_payroll_approver FOREIGN KEY(approved_by) REFERENCES users(id),
    UNIQUE KEY uq_payroll_period(period_start,period_end)
  ) ENGINE=InnoDB`);
  await query(`CREATE TABLE IF NOT EXISTS payslips (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, run_id BIGINT UNSIGNED NOT NULL, employee_id BIGINT UNSIGNED NOT NULL,
    days_present DECIMAL(5,1) NOT NULL DEFAULT 0, days_absent DECIMAL(5,1) NOT NULL DEFAULT 0,
    overtime_hours DECIMAL(7,2) NOT NULL DEFAULT 0, basic DECIMAL(12,2) NOT NULL DEFAULT 0,
    overtime_pay DECIMAL(12,2) NOT NULL DEFAULT 0, deductions DECIMAL(12,2) NOT NULL DEFAULT 0,
    net_pay DECIMAL(12,2) NOT NULL DEFAULT 0,
    CONSTRAINT fk_payslip_run FOREIGN KEY(run_id) REFERENCES payroll_runs(id) ON DELETE CASCADE,
    CONSTRAINT fk_payslip_employee FOREIGN KEY(employee_id) REFERENCES employees(id),
    UNIQUE KEY uq_run_employee(run_id,employee_id)
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

/** Non-destructive upgrades for databases created by an earlier version. */
async function migrateExistingInstalls() {
  await query(`ALTER TABLE users MODIFY role ENUM(${enumList(ROLES)}) NOT NULL`);
  await query("ALTER TABLE attendance MODIFY state ENUM('On site','Late','Checked out','Absent','On leave') NOT NULL");
  await query("ALTER TABLE stock_movements MODIFY movement_type ENUM('Receipt','Issue','Return','Adjustment','Transfer') NOT NULL");
  await addColumn('materials', 'unit_cost', 'DECIMAL(14,2) NOT NULL DEFAULT 0');
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
  await addColumn('fleet', 'driver_employee_id', 'BIGINT UNSIGNED NULL');
  await addColumn('fleet', 'service_interval_km', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('fleet', 'service_interval_months', 'TINYINT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('fleet', 'last_service_date', 'DATE NULL');
  await addColumn('fleet', 'last_service_odometer', 'INT UNSIGNED NOT NULL DEFAULT 0');
  await addColumn('equipment', 'qr_token', 'CHAR(32) NULL');
  await addIndex('equipment', 'uq_equipment_qr', 'UNIQUE KEY uq_equipment_qr(qr_token)');
  await addColumn('employees', 'photo_url', 'VARCHAR(600) NULL');
  await addIndex('fleet', 'fk_fleet_driver', 'CONSTRAINT fk_fleet_driver FOREIGN KEY(driver_employee_id) REFERENCES employees(id)');
  await addIndex('notifications', 'uq_notification_dedupe', 'UNIQUE KEY uq_notification_dedupe(dedupe_key)');
  await addIndex('attendance', 'fk_attendance_employee', 'CONSTRAINT fk_attendance_employee FOREIGN KEY(employee_id) REFERENCES employees(id)');
}

export async function migrate() {
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
  await migrateExistingInstalls();
}
