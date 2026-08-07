import { hashPassword, query, today, transaction } from './db.js';

const DEMO_PASSWORD = process.env.SEED_PASSWORD || 'GKUC@2026';

/** Dates in the seed are relative to first start so alerts and expiries stay meaningful. */
const shift = days => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return today(date);
};

export async function seedIfEmpty() {
  const [{ count }] = await query('SELECT COUNT(*) count FROM users');
  if (count) return false;

  await transaction(async connection => {
    const run = (sql, params = []) => connection.execute(sql, params);
    const insert = async (sql, params) => (await run(sql, params))[0].insertId;

    const users = [
      ['Kasun Perera', 'owner@gkuc.lk', 'Owner / Director'],
      ['Admin User', 'admin@gkuc.lk', 'Administrator'],
      ['Nadeesha Silva', 'manager@gkuc.lk', 'Project Manager'],
      ['Dilan Fernando', 'supervisor@gkuc.lk', 'Site Supervisor'],
      ['Rashmi De Silva', 'store@gkuc.lk', 'Storekeeper'],
      ['Shalini Peiris', 'finance@gkuc.lk', 'Finance / Accounts'],
      ['Ishara Gunawardena', 'hr@gkuc.lk', 'HR'],
      ['Imran Zain', 'qs@gkuc.lk', 'QS / Estimator'],
      ['Ruwan Jayalath', 'transport@gkuc.lk', 'Transport Officer']
    ];
    for (const [name, email, role] of users) {
      await run('INSERT INTO users (name,email,password_hash,role) VALUES (?,?,?,?)', [name, email, hashPassword(DEMO_PASSWORD), role]);
    }

    const departments = ['Management', 'Site Operations', 'Quantity Surveying', 'Stores', 'Transport', 'Finance', 'Human Resources'];
    for (const name of departments) await run('INSERT INTO departments (name) VALUES (?)', [name]);

    const projects = [
      ['Riverside Residences', 'Harbour Holdings', 'Kasun Perera', 68, 48500000, 34700000, 'At risk', 'Structural works', 'Colombo 05', shift(-210), shift(120)],
      ['Kaduwela Warehouse', 'Lanka Distribution', 'Nadeesha Silva', 42, 27600000, 10400000, 'On track', 'Steel erection', 'Kaduwela', shift(-120), shift(160)],
      ['Lakeview Villa', 'Private Client', 'Imran Zain', 86, 14800000, 12900000, 'Watch', 'Finishing', 'Battaramulla', shift(-300), shift(40)]
    ];
    for (const project of projects) {
      await run(`INSERT INTO projects (name,client,manager,progress,budget,actual,health,stage,site,start_date,end_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, project);
    }

    const employees = [
      ['EMP-0001', 'Dilan Fernando', 2, 'Site Supervisor', '077 4412210', 'supervisor@gkuc.lk', 4, 145000, 6500, 900],
      ['EMP-0002', 'Sahan Jayasuriya', 2, 'Foreman', '071 6620194', null, null, 98000, 4400, 620],
      ['EMP-0003', 'M. Rizwan', 2, 'Steel Fixer', '076 3320981', null, null, 74000, 3300, 480],
      ['EMP-0004', 'Chamod Senanayake', 2, 'Mason', '070 8841203', null, null, 71000, 3200, 460],
      ['EMP-0005', 'P. Kumara', 2, 'Electrician', '075 2210984', null, null, 82000, 3700, 520],
      ['EMP-0006', 'Rashmi De Silva', 4, 'Storekeeper', '077 9903312', 'store@gkuc.lk', 5, 96000, 4300, 600],
      ['EMP-0007', 'Imran Zain', 3, 'Quantity Surveyor', '071 4478820', 'qs@gkuc.lk', 8, 155000, 7000, 950],
      ['EMP-0008', 'Tharushi Wickrama', 2, 'Site Engineer', '078 5512034', null, null, 132000, 5900, 820]
    ];
    for (const [code, name, department, designation, phone, email, userId, salary, daily, overtime] of employees) {
      await run(`INSERT INTO employees (code,name,department_id,designation,phone,email,user_id,join_date,basic_salary,daily_rate,overtime_rate)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [code, name, department, designation, phone, email, userId, shift(-600), salary, daily, overtime]);
    }

    const tasks = [
      ['Complete Level 4 column shuttering', 1, 'Dilan Fernando', 'Today, 4:00 PM', 'High', 'In progress'],
      ['Inspect steel frame alignment', 2, 'Nadeesha Silva', 'Today, 2:30 PM', 'High', 'Blocked'],
      ['Approve bathroom tile sample', 3, 'Imran Zain', 'Today, 11:00 AM', 'Medium', 'Completed'],
      ['Submit concrete pour checklist', 1, 'Sahan Jayasuriya', 'Yesterday', 'High', 'Not started'],
      ['Update weekly progress photos', 2, 'Tharushi Wickrama', 'Tomorrow', 'Low', 'In progress']
    ];
    for (const task of tasks) await run("INSERT INTO tasks (title,project_id,assignee,due,priority,status,notes) VALUES (?,?,?,?,?,?,'')", task);

    const attendance = [
      ['Dilan Fernando', 'Site Supervisor', 1, '07:18', null, 'On site', 1],
      ['Sahan Jayasuriya', 'Foreman', 1, '07:26', null, 'On site', 2],
      ['M. Rizwan', 'Steel Fixer', 2, '08:12', null, 'Late', 3],
      ['Chamod Senanayake', 'Mason', 3, '07:05', '16:42', 'Checked out', 4],
      ['P. Kumara', 'Electrician', 3, null, null, 'Absent', 5]
    ];
    for (const [name, role, project, checkIn, checkOut, state, employeeId] of attendance) {
      await run(`INSERT INTO attendance (employee_name,role,project_id,work_date,check_in,check_out,state,employee_id)
        VALUES (?,?,?,?,?,?,?,?)`, [name, role, project, shift(0), checkIn, checkOut, state, employeeId]);
    }
    /* A week of history so the dashboard's activity chart has something real to draw. */
    for (let back = 1; back <= 6; back += 1) {
      const day = shift(-back);
      const weekday = new Date(day).getDay();
      if (weekday === 0) continue;
      for (const [name, role, project, checkIn, , , employeeId] of attendance) {
        if (!checkIn) continue;
        await run(`INSERT INTO attendance (employee_name,role,project_id,work_date,check_in,check_out,state,employee_id)
          VALUES (?,?,?,?,?,'16:30','Checked out',?)`, [name, role, project, day, checkIn, employeeId]);
      }
    }

    const materials = [
      ['Portland cement 50kg', 'bags', 84, 100, 'Riverside Store', 2450],
      ['TMT steel 12mm', 'lengths', 342, 180, 'Central Yard', 3180],
      ['River sand', 'm³', 18, 12, 'Kaduwela Store', 14500],
      ['Concrete blocks 6in', 'blocks', 56, 250, 'Lakeview Store', 145],
      ['Marine plywood 18mm', 'sheets', 46, 30, 'Riverside Store', 8900]
    ];
    for (const material of materials) await run('INSERT INTO materials (name,unit,stock,minimum,site,unit_cost) VALUES (?,?,?,?,?,?)', material);

    const fleet = [
      ['Toyota Dyna Tipper', 'WP LD-4821', 'Ruwan', 'Assigned', 'Insurance', shift(12), 1, 148200],
      ['Mitsubishi Canter', 'WP LL-9034', 'Sampath', 'Available', 'Revenue licence', shift(28), null, 96400],
      ['JCB 3CX Backhoe', 'EQ-017', 'Nimal', 'Repair', 'Service', shift(-3), 2, 4120],
      ['Toyota Hilux', 'CAA-6827', 'Kasun', 'Assigned', 'Emission test', shift(46), 3, 72800]
    ];
    for (const vehicle of fleet) {
      await run(`INSERT INTO fleet (vehicle,registration,driver,status,renewal_type,due_date,project_id,odometer)
        VALUES (?,?,?,?,?,?,?,?)`, vehicle);
    }
    const vehicleDocuments = [
      [1, 'Insurance', 'INS-88213', shift(12), 86000], [1, 'Revenue licence', 'RL-20261', shift(74), 14500],
      [2, 'Revenue licence', 'RL-20388', shift(28), 12800], [2, 'Insurance', 'INS-77120', shift(190), 74000],
      [3, 'Service', 'SVC-4410', shift(-3), 42000], [4, 'Emission test', 'EM-9921', shift(46), 5500]
    ];
    for (const document of vehicleDocuments) {
      await run('INSERT INTO vehicle_documents (vehicle_id,doc_type,reference,expiry_date,cost) VALUES (?,?,?,?,?)', document);
    }

    const equipment = [
      ['EQP-0001', 'Concrete vibrator', 'Concreting', 'Assigned', 185000],
      ['EQP-0002', 'Bar bending machine', 'Steel works', 'Assigned', 640000],
      ['EQP-0003', 'Total station', 'Survey', 'Available', 1250000],
      ['EQP-0004', 'Diesel generator 15kVA', 'Power', 'Maintenance', 890000],
      ['EQP-0005', 'Scaffolding set (100m²)', 'Access', 'Available', 420000]
    ];
    for (const [code, name, category, status, cost] of equipment) {
      await run('INSERT INTO equipment (code,name,category,status,purchase_date,purchase_cost) VALUES (?,?,?,?,?,?)', [code, name, category, status, shift(-500), cost]);
    }
    await run(`INSERT INTO equipment_assignments (equipment_id,project_id,assigned_to,assigned_at,created_by)
      VALUES (1,1,'Dilan Fernando',?,1),(2,2,'M. Rizwan',?,1)`, [shift(-20), shift(-14)]);
    await run(`INSERT INTO equipment_maintenance (equipment_id,maintenance_type,performed_at,cost,notes,created_by)
      VALUES (4,'Repair',?,38000,'Alternator replacement',1)`, [shift(-4)]);

    const suppliers = [
      ['Ceylon Cement Distributors', 'Ajith Rodrigo', '011 2334455', 'sales@ceyloncement.lk'],
      ['Lanka Steel (Pvt) Ltd', 'Mohan Ratnayake', '011 2778899', 'orders@lankasteel.lk'],
      ['Kelani Aggregates', 'Sunil Bandara', '011 2665544', 'info@kelaniagg.lk']
    ];
    for (const supplier of suppliers) await run('INSERT INTO suppliers (name,contact_person,phone,email) VALUES (?,?,?,?)', supplier);

    const boqId = await insert(`INSERT INTO boqs (project_id,reference,title,status,total,prepared_by,notes)
      VALUES (1,'BOQ-2026-0001','Riverside Residences — structural package','Approved',0,8,'Approved for construction')`, []);
    const boqItems = [
      [boqId, 'Material', 'Grade 30 concrete supply', 'm³', 720, 27500],
      [boqId, 'Material', 'TMT reinforcement steel', 'kg', 46000, 268],
      [boqId, 'Labour', 'Formwork and shuttering crew', 'day', 310, 22000],
      [boqId, 'Equipment', 'Tower crane hire', 'month', 9, 750000],
      [boqId, 'Subcontract', 'Waterproofing works', 'm²', 2400, 1850]
    ];
    let boqTotal = 0;
    for (const [id, category, description, unit, quantity, rate] of boqItems) {
      boqTotal += quantity * rate;
      await run('INSERT INTO boq_items (boq_id,category,description,unit,quantity,rate,amount) VALUES (?,?,?,?,?,?,?)',
        [id, category, description, unit, quantity, rate, quantity * rate]);
    }
    await run('UPDATE boqs SET total=?, approved_by=1, approved_at=UTC_TIMESTAMP() WHERE id=?', [boqTotal, boqId]);
    /* The approved BOQ is the project's budget, exactly as it works once the system is live. */
    await run('UPDATE projects SET budget=? WHERE id=1', [boqTotal]);

    const requestId = await insert(`INSERT INTO purchase_requests (reference,project_id,needed_by,notes,status,requested_by)
      VALUES ('PR-2026-0001',1,?,'Cement stock below minimum at Riverside Store','Pending',5)`, [shift(5)]);
    await run(`INSERT INTO purchase_request_items (request_id,material_id,description,unit,quantity,estimated_rate)
      VALUES (?,1,'Portland cement 50kg','bags',400,2450)`, [requestId]);
    await run('INSERT INTO quotations (request_id,supplier_id,amount,lead_time_days,notes) VALUES (?,1,968000,3,?)', [requestId, 'Delivered to site']);

    for (const category of ['Materials', 'Labour', 'Fuel', 'Equipment hire', 'Subcontractors', 'Site overheads']) {
      await run('INSERT INTO expense_categories (name) VALUES (?)', [category]);
    }
    const expenses = [
      [1, 1, 'Material', 'Cement and aggregate purchases', 4820000, shift(-9)],
      [1, 2, 'Labour', 'Fortnightly labour payment', 2360000, shift(-6)],
      [2, 1, 'Material', 'Structural steel purchase', 3140000, shift(-12)],
      [3, 5, 'Subcontractor', 'Tiling subcontractor stage 2', 890000, shift(-3)],
      [1, 3, 'Fuel', 'Site vehicle fuel', 148000, shift(-2)]
    ];
    for (const expense of expenses) {
      await run('INSERT INTO expenses (project_id,category_id,source,description,amount,expense_date,created_by) VALUES (?,?,?,?,?,?,6)', expense);
    }
    const incomes = [
      [1, 'Interim payment certificate 4', 12500000, shift(-15)],
      [2, 'Advance payment', 5500000, shift(-40)],
      [3, 'Stage payment 3', 3200000, shift(-8)]
    ];
    for (const income of incomes) {
      await run('INSERT INTO incomes (project_id,description,amount,received_date,created_by) VALUES (?,?,?,?,6)', income);
    }

    await run(`INSERT INTO project_milestones (project_id,title,due_date,status) VALUES
      (1,'Structural frame complete',?,'In progress'),(1,'Roof slab casting',?,'Pending'),
      (2,'Portal frame erection complete',?,'In progress'),(3,'Handover to client',?,'Pending')`,
      [shift(30), shift(75), shift(22), shift(35)]);

    await run(`INSERT INTO inquiries (reference,customer_name,contact_person,phone,location,description,expected_value,expected_start,source,status,created_by)
      VALUES ('INQ-2026-0001','Silva Holdings','Anura Silva','077 3312450','Nugegoda',
        'Three-storey office building, approximately 8,500 sq ft.',42000000,?,'Referral','In discussion',1),
             ('INQ-2026-0002','Perera Enterprises','Nimal Perera','071 8890234','Negombo',
        'Warehouse extension with loading bay.',18500000,?,'Website','New',1)`, [shift(60), shift(95)]);

    await run(`INSERT INTO daily_reports (project_id,supervisor,report_date,workforce,work_completed,issue,weather,delay_hours,created_by)
      VALUES (1,'Dilan Fernando',?,34,'Level 4 columns and stair core','Concrete pump delayed by 55 minutes','Cloudy',0.9,4),
             (2,'Nadeesha Silva',?,21,'Portal frame assembly','Awaiting crane inspection certificate','Clear',0,3)`, [shift(0), shift(0)]);
  });

  return true;
}
