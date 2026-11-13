import { spendSql, transaction } from '../db.js';

// Explicit column lists keep private file locations, employee identifiers used for
// biometrics, bank details and internal configuration out of the portable report.
const groups = [
  ['Programme and site history', [], [
    ['Original enquiries', 'inquiries', 'reference,customer_name,contact_person,location,description,expected_value,expected_start,source,status,created_at', 'created_at'],
    ['Awards', 'project_awards', 'award_date,reference,notes,recorded_at', 'award_date'],
    ['Work authorisations', 'project_work_authorisations', 'authorised_at,notes', 'authorised_at'],
    ['Project stage and progress history', `audit_logs a LEFT JOIN users u ON u.id=a.user_id`,
      `a.created_at AS changed_at,u.name AS changed_by,
        JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.stage')) AS previous_stage,JSON_UNQUOTE(JSON_EXTRACT(a.after_json, '$.stage')) AS new_stage,
        JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.progress')) AS previous_progress,JSON_UNQUOTE(JSON_EXTRACT(a.after_json, '$.progress')) AS new_progress,
        JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.health')) AS previous_health,JSON_UNQUOTE(JSON_EXTRACT(a.after_json, '$.health')) AS new_health`, 'a.id', [],
      `a.entity='project' AND BINARY a.entity_id=CAST(? AS BINARY) AND a.action IN ('CREATE','UPDATE')
        AND (NOT (JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.stage')) <=> JSON_UNQUOTE(JSON_EXTRACT(a.after_json, '$.stage')))
          OR NOT (JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.progress')) <=> JSON_UNQUOTE(JSON_EXTRACT(a.after_json, '$.progress')))
          OR NOT (JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.health')) <=> JSON_UNQUOTE(JSON_EXTRACT(a.after_json, '$.health'))))`],
    ['Completion extensions', 'project_extensions', 'reference,request_date,previous_end_date,new_end_date,reason', 'request_date'],
    ['Milestones', 'project_milestones', 'title,due_date,status,completed_at,notes', 'due_date'],
    ['Site status changes', 'site_status_log', 'from_status,to_status,effective_date,reason,created_at', 'effective_date'],
    ['Activity and issues', 'project_updates', 'kind,title,details,category,status,priority,owner,due_date,created_at,updated_at', 'created_at'],
    ['Tasks', 'tasks', 'id,title,assignee,due_date,due,priority,status,notes,created_at,updated_at', 'created_at', [
      ['Assigned employees', 'visible_task_assignees a JOIN visible_employees e ON e.id=a.employee_id', 'e.name,a.assigned_at', 'a.task_id', 'a.assigned_at'],
      ['Comments', 'task_comments c JOIN users u ON u.id=c.user_id', 'u.name AS author,c.comment,c.created_at', 'c.task_id', 'c.created_at'],
      ['Task attachments', 'task_attachments', 'title,kind,created_at', 'task_id', 'created_at'],
      ['Uploaded files', "visible_attachments a JOIN tasks t ON a.owner_type='task' AND t.id=a.owner_id", 'a.title,a.filename,a.category,a.created_at', 't.id', 'a.created_at'],
      ['Status history', `audit_logs a JOIN tasks t ON a.entity='task' AND BINARY a.entity_id=CAST(t.id AS BINARY)
        AND JSON_UNQUOTE(JSON_EXTRACT(a.after_json, '$.status')) IS NOT NULL
        AND NOT (JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.status')) <=> JSON_UNQUOTE(JSON_EXTRACT(a.after_json, '$.status')))
        LEFT JOIN users u ON u.id=a.user_id`,
        `a.created_at AS changed_at,u.name AS changed_by,JSON_UNQUOTE(JSON_EXTRACT(a.before_json, '$.status')) AS previous_status,
          JSON_UNQUOTE(JSON_EXTRACT(a.after_json, '$.status')) AS new_status,JSON_UNQUOTE(JSON_EXTRACT(a.after_json, '$.statusReason')) AS reason`, 't.id', 'a.id']
    ]],
    ['Daily site reports', 'daily_reports', 'id,report_date,supervisor,workforce,work_completed,issue,weather,delay_hours,created_at', 'report_date', [
      ['Report attachments', "visible_attachments a JOIN daily_reports r ON a.owner_type='report' AND r.id=a.owner_id", 'a.title,a.filename,a.category,a.created_at', 'r.id', 'a.created_at']
    ]]
  ]],
  ['Project team', [], [
    ['Team assignments', 'visible_project_team a JOIN visible_employees e ON e.id=a.employee_id', 'e.name,a.project_role,a.assigned_at,a.released_at', 'a.assigned_at'],
    ['Manager assignments', 'visible_project_manager_assignments a JOIN visible_employees e ON e.id=a.employee_id', 'e.name,a.assigned_at,a.released_at', 'a.assigned_at']
  ]],
  ['Attendance', ['hr.attendance','hr.manage'], [
    ['Attendance records', 'visible_attendance', 'work_date,employee_name,role,state,check_in,site_stop,check_out,work_location,source,needs_review,correction_reason', 'work_date'],
    ['Site attendance submissions', 'visible_site_attendance_submissions a JOIN visible_employees e ON e.id=a.employee_id', 'e.name,a.work_date,a.state,a.status,a.submitted_at,a.reviewed_at,a.review_note', 'a.work_date']
  ]],
  ['Bills of quantities and variations', ['qs.view','qs.boq'], [
    ['Bills of quantities', 'boqs', 'id,reference,title,version,status,total,notes,created_at,approved_at', 'created_at', [
      ['BOQ items', 'boq_items', 'category,description,unit,quantity,rate,amount,method,notes', 'boq_id', 'id'],
      ['Change requests', 'boq_change_requests', 'action,reason,status,decision_note,created_at,decided_at', 'boq_id', 'id']
    ]],
    ['Variations', 'variation_orders', 'reference,boq_id,description,amount,status,created_at', 'created_at'],
    ['Cost forecasts', 'project_cost_forecasts f JOIN boq_items i ON i.id=f.boq_item_id JOIN boqs b ON b.id=i.boq_id', 'b.reference,i.description,f.forecast_quantity,f.forecast_rate,f.forecast_amount,f.reason,f.updated_at', 'f.updated_at']
  ]],
  ['Client quotations', ['qs.view','finance.invoice'], [
    ['Quotations', 'quotations_client', 'id,reference,title,client_name,quote_date,valid_until,status,revision_number,boq_id,subtotal,markup_percent,vat_percent,total,prepared_by_name,prepared_by_designation,location,contact,notes,payment_terms,additional_notes,terms,finalized_at', 'quote_date', [
      ['Quotation items', 'quotation_items', 'category,description,unit,quantity,rate,amount,method_statement', 'quotation_id', 'id']
    ], 'project_id=? OR (project_id IS NULL AND (boq_id IN (SELECT id FROM boqs WHERE project_id=?) OR inquiry_id IN (SELECT id FROM inquiries WHERE project_id=?)))', 3]
  ]],
  ['Progress claims', ['qs.view','qs.boq','qs.approve','finance.view','finance.invoice'], [
    ['Valuation schedules', 'progress_schedules', 'version_no,source,status,contract_reference,agreement_reference,internal_reference,revision_reason,created_at,items', 'version_no'],
    ['Claims and certificates', 'progress_claims c JOIN progress_schedules s ON s.id=c.schedule_id LEFT JOIN client_invoices i ON i.id=c.invoice_id',
      'c.id,c.reference,s.version_no AS schedule_version,c.application_date,c.period_from,c.period_to,c.status,c.submitted_amount,c.certified_date,c.certificate_reference,COALESCE(i.reference,c.invoice_reference) AS invoice_reference,c.notes,c.submitted_items,c.certified_items,c.certification', 'c.application_date', [
      ['Certificate attachments', "visible_attachments a JOIN progress_claims c ON a.owner_type='progress_certificate' AND c.id=a.owner_id", 'a.title,a.filename,a.category,a.created_at', 'c.id', 'a.created_at']
    ]]
  ]],
  ['Client invoices and receipts', ['finance.view','finance.invoice'], [
    ['Client invoices', 'client_invoices', 'id,reference,document_type,kind,title,client,invoice_date,delivery_date AS date_of_supply,place_of_supply,due_date,period_from,period_to,status,gross,taxable_base,tax_treatment,vat_rate,vat_amount,retention_amount,advance_recovery,other_deductions,deduction_note,net_payable,paid_amount,payment_mode,notes,issued_at', 'invoice_date', [
      ['Invoice items', 'client_invoice_items', 'description,unit,quantity,rate,amount,boq_item_id,quotation_item_id', 'invoice_id', 'id'],
      ['Receipts', 'client_receipts', 'received_date,amount,method,reference', 'invoice_id', 'received_date']
    ]],
    ['Billing plans', 'quotation_billing_plans p JOIN quotations_client q ON q.id=p.quotation_id', 'p.id,q.reference,p.document_type,p.tax_treatment,p.vat_rate,p.created_at', 'p.created_at', [
      ['Billing terms', 'quotation_billing_terms t LEFT JOIN client_invoices i ON i.id=t.invoice_id', 't.sequence_no,t.label,t.percentage,t.amount,t.due_date,i.reference AS invoice_reference', 't.plan_id', 't.sequence_no']
    ]],
    ['Received cheques', 'received_cheques', 'cheque_number,bank,payer,purpose,amount,received_date,cheque_date,deposit_by,status,notes,deposited_at,confirmed_at', 'received_date'],
    ['Bank bonds', 'bank_bonds', 'id,reference,kind,beneficiary,bank,bond_number,amount,margin_held,commission,issued_date,expiry_date,status,released_date,notes', 'issued_date', [
      ['Bond extensions', 'bank_bond_extensions', 'previous_expiry,new_expiry,extended_on', 'bond_id', 'extended_on']
    ]]
  ]],
  ['Retentions', ['qs.view','finance.view','qs.retention','finance.manage'], [
    ['Retention register', 'retentions', 'description,amount,percent,held_from,release_date,defect_liability_ends,released_amount,status,notes', 'held_from']
  ]],
  ['Daily cost sheets', ['qs.view','qs.boq','qs.costControl','finance.view','finance.manage','finance.costReview'], [
    ['Cost sheets', 'daily_cost_sheets', 'id,work_date,status,notes,review_note,reviewed_at,created_at', 'work_date', [
      ['Cost lines', `daily_cost_lines l LEFT JOIN visible_employees e ON e.id=l.employee_id LEFT JOIN fleet f ON f.id=l.vehicle_id
        LEFT JOIN boq_items b ON b.id=l.boq_item_id LEFT JOIN tasks t ON t.id=l.task_id`,
        'l.source,l.cost_type,l.description,l.quantity,l.unit,l.unit_rate,l.amount,e.name AS employee,f.registration,t.title AS task,b.description AS boq_item,l.labour_hours,l.quoted_recovery,l.reference,l.fuel_origin', 'l.sheet_id', 'l.id']
    ]]
  ]],
  ['Recorded expenses and income', ['finance.view','finance.manage'], [
    ['Expenses', 'expenses', 'expense_date,source,cost_type,description,amount,quantity,unit,unit_rate,payee,payment_method,paid_date,reference,boq_item_id', 'expense_date'],
    ['Income', 'incomes', 'received_date,description,amount,method,reference', 'received_date'],
    ['Operating bills', 'operating_bills', 'bill_date,bill_type,provider,reference,period_from,period_to,due_date,net_amount,vat_amount,total_amount,status,paid_date,payment_method,payment_reference,notes', 'bill_date'],
    ['Petty cash entries', 'petty_cash_entries', 'entry_date,kind,amount,description,category', 'entry_date']
  ]],
  ['Materials and equipment', ['store.view','store.manage'], [
    ['Stock movements', 'stock_movements a JOIN materials m ON m.id=a.material_id', 'm.name,m.unit,a.movement_type,a.quantity,a.destination,a.reference,a.notes,a.created_at', 'a.created_at'],
    ['Site material usage', 'site_material_consumption a JOIN materials m ON m.id=a.material_id', 'm.name,m.unit,a.quantity,a.consumed_on,a.notes', 'a.consumed_on'],
    ['Site stock counts', 'site_material_counts a JOIN materials m ON m.id=a.material_id', 'm.name,m.unit,a.counted_quantity,a.baseline_issued,a.baseline_consumed,a.notes,a.counted_at', 'a.counted_at'],
    ['Stock loans', 'stock_loans a JOIN materials m ON m.id=a.material_id', 'm.name,m.unit,a.quantity,a.returned_quantity,a.taken_by,a.handed_over_by,a.received_back_by,a.issued_at,a.returned_at,a.condition_out,a.condition_in,a.reference', 'a.issued_at'],
    ['Equipment assignments', 'visible_equipment_assignments a JOIN equipment e ON e.id=a.equipment_id', 'e.code,e.name,e.category,a.assigned_to,a.assigned_at,a.returned_at,a.condition_note', 'a.assigned_at']
  ]],
  ['Fleet and fuel', ['transport.view','transport.manage'], [
    ['Currently assigned vehicles', 'fleet', 'vehicle,registration,driver,status,odometer', 'vehicle'],
    ['Fuel records', 'fuel_records a JOIN fleet f ON f.id=a.vehicle_id', 'f.vehicle,f.registration,a.fuel_date,a.litres,a.cost,a.odometer,a.driver', 'a.fuel_date']
  ]],
  ['Fuel submissions', ['fuel.view','fuel.review','transport.view','transport.manage','finance.view','finance.manage','qs.view','qs.costControl','hr.view','hr.manage','projects.view'], [
    ['Fuel submissions', 'fuel_submissions a JOIN fleet f ON f.id=a.vehicle_id JOIN users u ON u.id=a.submitted_by',
      'f.vehicle,f.registration,u.name AS submitted_by,a.details,a.status,a.review_note,a.reviewed_at,a.created_at', 'a.created_at']
  ]],
  ['Resource transfers', ['resources.view'], [
    ['Resource transfers', 'resource_reassignments r LEFT JOIN projects p ON p.id=r.from_project_id LEFT JOIN projects t ON t.id=r.to_project_id',
      'r.resource_type,r.resource_name,p.name AS moved_from,t.name AS moved_to,r.reason,r.created_at', 'r.created_at', [],
      'r.from_project_id=? OR r.to_project_id=?', 2]
  ]],
  ['Purchase requests', ['store.view','store.manage','projects.manage'], [
    ['Purchase requests', 'purchase_requests', 'id,reference,needed_by,status,notes,created_at,decided_at', 'created_at', [
      ['Requested items', 'purchase_request_items', 'description,unit,quantity,estimated_rate', 'request_id', 'id'],
      ['Supplier quotes', 'quotations q JOIN suppliers s ON s.id=q.supplier_id', 's.name AS supplier,q.amount,q.lead_time_days,q.selected,q.notes,q.created_at', 'q.request_id', 'q.created_at']
    ]]
  ]],
  ['Purchase orders and deliveries', ['store.view','store.manage','finance.pay'], [
    ['Purchase orders', 'purchase_orders a JOIN suppliers s ON s.id=a.supplier_id', 'a.id,a.reference,s.name AS supplier,a.order_date,a.total,a.status,a.revision', 'a.order_date', [
      ['Ordered items', 'purchase_order_items', 'item_no,description,unit,quantity,rate,amount_override,received_quantity', 'order_id', 'id'],
      ['Delivery items', 'goods_receipts r JOIN goods_receipt_items ri ON ri.receipt_id=r.id JOIN purchase_order_items i ON i.id=ri.order_item_id', 'r.id AS delivery_id,r.created_at,r.notes,i.description,ri.quantity,ri.unit_rate', 'r.order_id', 'r.id,ri.id']
    ]]
  ]],
  ['Supplier invoices and payments', ['finance.view','finance.pay'], [
    ['Supplier invoices', 'supplier_invoices i JOIN purchase_orders a ON a.id=i.order_id JOIN suppliers s ON s.id=i.supplier_id LEFT JOIN supplier_credit_reminders cr ON cr.invoice_id=i.id', 'i.id,i.invoice_no,a.reference AS order_reference,s.name AS supplier,i.invoice_date,i.due_date,i.net_amount,i.vat_amount,i.amount,i.paid_amount,i.status,cr.description AS credit_description,cr.frequency AS reminder_frequency', 'i.invoice_date', [
      ['Supplier payments', 'supplier_payments', 'paid_date,amount,method,reference', 'invoice_id', 'paid_date']
    ], 'a.project_id=?']
  ]],
  ['Subcontractors', [], [
    ['Agreed rates', 'subcontractor_project_rates a JOIN subcontractors s ON s.id=a.subcontractor_id', 's.name AS subcontractor,a.work_item,a.unit,a.rate,a.agreed_on,a.valid_until,a.notes', 'a.agreed_on'],
    ['Subcontractor quotations', 'subcontractor_quotations a JOIN subcontractors s ON s.id=a.subcontractor_id', 'a.id,a.reference,s.name AS subcontractor,a.their_reference,a.package,a.quote_date,a.valid_until,a.subtotal,a.discount_total,a.total,a.status,a.notes,a.decision_note', 'a.quote_date', [
      ['Quoted items', 'subcontractor_quotation_items', 'description,unit,quantity,rate,discount,amount', 'quotation_id', 'position,id']
    ]]
  ]],
  ['Subcontractor bills', ['qs.view','finance.view'], [
    ['Subcontractor bills', 'subcontractor_bills a JOIN subcontractors s ON s.id=a.subcontractor_id', 'a.reference,s.name AS subcontractor,a.description,a.amount,a.paid_amount,a.bill_date,a.due_date,a.status', 'a.bill_date']
  ]],
  ['Tenders', ['qs.view'], [
    ['Tenders', 'tenders', 'id,reference,title,client,source,closing_date,submitted_date,estimated_value,bid_value,status,documents_note,outcome_note', 'closing_date', [
      ['Tender checklist', 'tender_checklist', 'item,mandatory,done,note,done_at', 'tender_id', 'position,id']
    ]]
  ]],
  ['Correspondence', [], [
    ['Client communications', 'client_communications', 'direction,channel,contact_person,contact_party,summary,happened_at,follow_up_date,follow_up_done_at', 'happened_at', [], 'project_id=? OR (project_id IS NULL AND inquiry_id IN (SELECT id FROM inquiries WHERE project_id=?))', 2]
  ]],
  ['Incoming letters', ['enquiries.manage'], [
    ['Incoming letters', 'incoming_letters', 'received_date,sender,letter_reference,subject,description,document_type,status', 'received_date']
  ]],
  ['Document and photo register', [], [
    ['Project documents', 'project_documents', 'title,category,created_at', 'created_at'],
    ['Project attachments', 'visible_attachments', 'title,filename,category,mime,size_bytes,created_at', 'created_at', [], "owner_type='project' AND owner_id=?"],
    ['Gallery photos', 'gallery_photos p LEFT JOIN gallery_folders f ON f.id=p.folder_id', 'p.filename,p.caption,f.name AS folder,p.captured_at', 'p.captured_at', [], 'p.project_id=? AND p.removed_at IS NULL']
  ]]
];

const allowed = (keys, permissions) => !keys.length || keys.some(key => permissions.includes(key));

async function readRegister(read, projectId, [title, source, columns, order, children = [], filter, count = 1]) {
  const scope = filter || (source.includes(' JOIN ') ? `${source.split(' ')[1]}.project_id=?` : 'project_id=?');
  const rows = await read(`SELECT ${columns} FROM ${source} WHERE ${scope} ORDER BY ${order}`, Array(count).fill(projectId));
  const records = rows.map(row => ({ row, details: [] }));
  if (rows.length) {
    for (const [label, childSource, childColumns, parentKey, childOrder] of children) {
      const parents = new Map();
      const lines = await read(`SELECT ${parentKey} AS report_parent,${childColumns} FROM ${childSource}
        WHERE ${parentKey} IN (SELECT ${source.includes(' JOIN ') ? source.split(' ')[1] + '.' : ''}id FROM ${source} WHERE ${scope})
        ORDER BY ${parentKey},${childOrder}`, Array(count).fill(projectId));
      for (const { report_parent, ...line } of lines) {
        if (!parents.has(report_parent)) parents.set(report_parent, []);
        parents.get(report_parent).push(line);
      }
      for (const record of records) {
        const items = parents.get(record.row.id);
        if (items) record.details.push({ label, items });
      }
    }
  }
  return { title, records };
}

export async function loadProjectReport(projectId, permissions) {
  return transaction(async connection => {
    const read = async (sql, params) => (await connection.execute(sql, params))[0];
    const [project] = await read(`SELECT p.id,p.name,c.name AS company,COALESCE(d.name,p.client) AS client,
      CASE WHEN p.manager_employee_id IS NULL THEN p.manager ELSE e.name END AS manager,p.site,p.stage,p.health,p.site_status,p.status_reason,
      p.start_date,p.end_date,p.created_at,p.progress,p.billing_route,p.budget
      FROM projects p JOIN companies c ON c.id=p.company_id LEFT JOIN clients d ON d.id=p.client_id
      LEFT JOIN visible_employees e ON e.id=p.manager_employee_id WHERE p.id=? AND p.active=1`, [projectId]);
    if (!project) return null;
    const sections = [];
    const restricted = [];
    for (const [title, keys, registers] of groups) {
      if (!allowed(keys, permissions)) {
        restricted.push(title);
        continue;
      }
      const entries = [];
      for (const register of registers) entries.push(await readRegister(read, projectId, register));
      sections.push({ title, entries });
    }
    let finance;
    if (allowed(['finance.view','finance.manage'], permissions)) {
      [finance] = await read(`SELECT p.actual AS opening_cost,${spendSql('p')} AS recorded_cost,
        (SELECT COALESCE(SUM(amount),0) FROM incomes WHERE project_id=p.id) AS recorded_income,
        (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE project_id=p.id) AS ledger_expenses
        FROM projects p WHERE p.id=?`, [projectId]);
    }
    return { project, sections, restricted, finance };
  });
}
