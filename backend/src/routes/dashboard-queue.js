import { Router } from 'express';
import { query } from '../db.js';
import { auth, can, wrap } from '../lib/http.js';

const router = Router();

// Return only records that this session may work on. The dashboard must not turn a
// hidden Finance or HR workspace into a data leak through its summary cards.
router.get('/queue', auth, wrap(async (req, res) => {
  const companyId = Number(req.query.companyId);
  if (!Number.isInteger(companyId) || companyId < 1)
    return res.status(400).json({ error: 'Choose an operating company to see your work.' });

  const financeReview = can(req, 'finance.costReview');
  const qsReview = can(req, 'qs.costControl');
  const hrReview = can(req, 'hr.payroll');
  const financeDue = can(req, 'finance.view') || can(req, 'finance.invoice');
  const work = [];
  const add = async (allowed, sql, params, map) => {
    if (!allowed) return;
    const rows = await query(sql, params);
    work.push(...rows.map(map));
  };
  const [sheets, claims, invoicesDue] = await Promise.all([
    financeReview || qsReview ? query(`SELECT s.id,s.project_id projectId,p.name project,
      DATE_FORMAT(s.work_date,'%Y-%m-%d') workDate,s.status,s.review_note reviewNote,
      s.submitted_by submittedBy,s.created_at createdAt,u.name submittedByName,COUNT(l.id) lineCount
      FROM daily_cost_sheets s JOIN projects p ON p.id=s.project_id
      JOIN users u ON u.id=s.submitted_by
      LEFT JOIN daily_cost_lines l ON l.sheet_id=s.id
      WHERE p.company_id=? AND (s.status='Submitted' OR (s.status='Returned' AND s.submitted_by=?
        AND s.reviewed_at>=DATE_SUB(CURDATE(),INTERVAL 30 DAY)))
      GROUP BY s.id ORDER BY s.work_date DESC,s.id DESC LIMIT 80`, [companyId, req.user.id]) : [],
    hrReview ? query(`SELECT c.id,c.kind,DATE_FORMAT(c.work_date,'%Y-%m-%d') workDate,
      c.status,c.created_at createdAt,e.name employee,p.name project
      FROM hr_payroll_claims c JOIN employees e ON e.id=c.employee_id
      LEFT JOIN projects p ON p.id=c.project_id
      WHERE e.payroll_company_id=? AND c.status IN ('Draft','Confirmed')
      ORDER BY c.work_date DESC,c.id DESC LIMIT 80`, [companyId]) : [],
    financeDue ? query(`SELECT i.id,i.reference,i.client,i.created_at createdAt,DATE_FORMAT(i.due_date,'%Y-%m-%d') dueDate,
      i.net_payable-i.paid_amount outstanding FROM client_invoices i
      WHERE i.company_id=? AND i.status IN ('Issued','Part paid') AND i.due_date<=CURDATE()
      ORDER BY i.due_date,i.id DESC LIMIT 80`, [companyId]) : []
  ]);
  await Promise.all([
    add(can(req,'projects.manage'), `SELECT r.id,r.reference,p.name project,DATE_FORMAT(r.needed_by,'%Y-%m-%d') deadline,
      r.created_at createdAt,u.name owner FROM purchase_requests r JOIN projects p ON p.id=r.project_id
      JOIN users u ON u.id=r.requested_by WHERE p.company_id=? AND r.status='Pending' ORDER BY r.created_at LIMIT 60`,[companyId],r=>({kind:'purchase-request',id:r.id,title:`Approve ${r.reference}`,detail:r.project,owner:r.owner,deadline:r.deadline,createdAt:r.createdAt,risk:'Materials may not be ordered in time',action:'Review request',escalation:'Project management',target:['Materials','Purchase requests',r.id]})),
    add(can(req,'store.manage'), `SELECT o.id,o.reference,p.name project,DATE_FORMAT(o.order_date,'%Y-%m-%d') deadline,
      o.created_at createdAt,u.name owner FROM purchase_orders o JOIN projects p ON p.id=o.project_id
      JOIN users u ON u.id=o.issued_by WHERE p.company_id=? AND o.status IN ('Issued','Partially received')
      ORDER BY o.created_at LIMIT 60`,[companyId],r=>({kind:'purchase-order',id:r.id,title:`Receive ${r.reference}`,detail:r.project,owner:r.owner,deadline:r.deadline,createdAt:r.createdAt,risk:'Supplier delivery remains unconfirmed',action:'Open order',escalation:'Purchasing',target:['Materials','Orders',r.id]})),
    add(can(req,'hr.leave')||can(req,'hr.manage'), `SELECT l.id,e.name employee,DATE_FORMAT(l.from_date,'%Y-%m-%d') deadline,l.created_at createdAt
      FROM leave_requests l JOIN employees e ON e.id=l.employee_id WHERE l.status='Pending' AND e.payroll_company_id=?
      ORDER BY l.from_date LIMIT 60`,[companyId],r=>({kind:'leave',id:r.id,title:`Leave request · ${r.employee}`,owner:'HR',deadline:r.deadline,createdAt:r.createdAt,risk:'Leave remains undecided before absence',action:'Decide leave',escalation:'HR management',target:['People','Leave',r.id]})),
    add(can(req,'hr.payroll')||can(req,'hr.manage'), `SELECT o.id,e.name employee,DATE_FORMAT(o.work_date,'%Y-%m-%d') deadline,o.created_at createdAt
      FROM overtime_records o JOIN employees e ON e.id=o.employee_id WHERE o.status='Pending' AND e.payroll_company_id=?
      ORDER BY o.created_at LIMIT 60`,[companyId],r=>({kind:'overtime',id:r.id,title:`Overtime · ${r.employee}`,owner:'HR payroll',deadline:r.deadline,createdAt:r.createdAt,risk:'Pay input cannot enter payroll',action:'Review overtime',escalation:'HR management',target:['People','Overtime',r.id]})),
    add(can(req,'hr.attendance')||can(req,'hr.manage'), `SELECT a.id,a.employee_name employee,DATE_FORMAT(a.work_date,'%Y-%m-%d') deadline,
      a.work_date createdAt,p.name project FROM attendance a JOIN projects p ON p.id=a.project_id
      WHERE p.company_id=? AND a.needs_review=1 ORDER BY a.work_date DESC LIMIT 60`,[companyId],r=>({kind:'attendance',id:r.id,title:`Check attendance · ${r.employee}`,detail:r.project,owner:'HR attendance',deadline:r.deadline,workDate:r.deadline,createdAt:r.createdAt,risk:'Unverified time can affect pay',action:'Correct attendance',escalation:'HR management',target:['People','Attendance register',r.id]})),
    add(can(req,'hr.insurance'), `SELECT i.id,i.name,i.kind,DATE_FORMAT(COALESCE(vd.expiry_date,i.expiry_date),'%Y-%m-%d') deadline,
      NULL createdAt,u.name owner FROM hr_insurance i JOIN users u ON u.id=i.created_by
      LEFT JOIN projects p ON p.id=i.project_id LEFT JOIN vehicle_documents vd ON vd.vehicle_id=i.vehicle_id AND vd.doc_type='Insurance'
      WHERE i.status='Active' AND (p.company_id=? OR i.project_id IS NULL)
      AND COALESCE(vd.expiry_date,i.expiry_date)<=DATE_ADD(CURDATE(),INTERVAL 30 DAY)
      ORDER BY COALESCE(vd.expiry_date,i.expiry_date) LIMIT 60`,[companyId],r=>({kind:'insurance',id:r.id,title:`${r.kind} insurance · ${r.name}`,owner:r.owner,deadline:r.deadline,createdAt:r.createdAt,risk:'Insurance may lapse',action:'Review policy',escalation:'HR management',target:['People','Insurance',r.id]})),
    add(can(req,'transport.view')||can(req,'transport.manage'), `SELECT d.id,d.doc_type kind,f.vehicle,f.registration,
      DATE_FORMAT(d.expiry_date,'%Y-%m-%d') deadline,d.created_at createdAt FROM vehicle_documents d
      JOIN fleet f ON f.id=d.vehicle_id WHERE d.expiry_date<=DATE_ADD(CURDATE(),INTERVAL 30 DAY)
      AND (?=0 OR d.doc_type<>'Insurance' OR NOT EXISTS(SELECT 1 FROM hr_insurance i
        WHERE i.vehicle_id=d.vehicle_id AND i.kind='Vehicle' AND i.status='Active'))
      ORDER BY d.expiry_date LIMIT 60`,[can(req,'hr.insurance')?1:0],r=>({kind:'vehicle-renewal',id:r.id,title:`Vehicle ${r.kind} · ${r.registration}`,detail:r.vehicle,owner:'Fleet / HR',deadline:r.deadline,createdAt:r.createdAt,risk:'Vehicle compliance may lapse',action:'Renew document',escalation:'Fleet management',target:['Fleet','Compliance',r.id]})),
    add(can(req,'finance.invoice'), `SELECT c.id,c.cheque_number reference,c.payer,DATE_FORMAT(c.deposit_by,'%Y-%m-%d') deadline,
      c.created_at createdAt,u.name owner FROM received_cheques c JOIN users u ON u.id=c.created_by
      LEFT JOIN projects p ON p.id=c.project_id WHERE (p.company_id=? OR c.project_id IS NULL) AND c.status='Returned'
      ORDER BY c.created_at DESC LIMIT 60`,[companyId],r=>({kind:'returned-cheque',id:r.id,title:`Returned cheque · ${r.reference}`,detail:r.payer,owner:r.owner,deadline:r.deadline,createdAt:r.createdAt,risk:'Expected cash has not cleared',action:'Follow up cheque',escalation:'Finance management',target:['Finance','Cheques',r.id]})),
    add(can(req,'qs.view')&&can(req,'qs.tender'), `SELECT t.id,t.reference,t.title,DATE_FORMAT(t.closing_date,'%Y-%m-%d') deadline,
      t.created_at createdAt,u.name owner FROM tenders t JOIN users u ON u.id=t.owner_id
      LEFT JOIN projects p ON p.id=t.project_id WHERE t.company_id=?
      AND t.status IN ('Identified','Document purchased','Preparing') ORDER BY t.closing_date LIMIT 60`,[companyId],r=>({kind:'tender',id:r.id,title:`Tender · ${r.reference}`,detail:r.title,owner:r.owner,deadline:r.deadline,createdAt:r.createdAt,risk:'Bid deadline may be missed',action:'Prepare tender',escalation:'QS management',target:['Quantity Surveying','Tenders',r.id]})),
    add(can(req,'qs.view')&&can(req,'qs.tender'), `SELECT c.id,c.tender_id tenderId,c.item,t.reference,t.closing_date deadline,t.created_at createdAt,
      u.name owner FROM tender_checklist c JOIN tenders t ON t.id=c.tender_id JOIN users u ON u.id=t.owner_id
      LEFT JOIN projects p ON p.id=t.project_id WHERE t.company_id=?
      AND c.mandatory=1 AND c.done=0 AND t.status IN ('Identified','Document purchased','Preparing')
      ORDER BY t.closing_date LIMIT 60`,[companyId],r=>({kind:'tender-document',id:r.id,title:`Missing bid document · ${r.item}`,detail:r.reference,owner:r.owner,deadline:r.deadline,createdAt:r.createdAt,risk:'Bid may be non-responsive',action:'Complete checklist',escalation:'QS management',target:['Quantity Surveying','Tenders',r.tenderId]})),
    add(can(req,'qs.retention')||can(req,'qs.view'), `SELECT r.id,r.description,p.name project,DATE_FORMAT(r.release_date,'%Y-%m-%d') deadline,
      r.created_at createdAt,u.name owner FROM retentions r JOIN projects p ON p.id=r.project_id JOIN users u ON u.id=r.created_by
      WHERE p.company_id=? AND r.status IN ('Held','Partially released') AND r.release_date<=DATE_ADD(CURDATE(),INTERVAL 30 DAY)
      ORDER BY r.release_date LIMIT 60`,[companyId],r=>({kind:'retention',id:r.id,title:`Retention release · ${r.project}`,detail:r.description,owner:r.owner,deadline:r.deadline,createdAt:r.createdAt,risk:'Recoverable cash may remain held',action:'Review retention',escalation:'QS management',target:['Quantity Surveying','Retention',r.id]})),
    add(can(req,'finance.view')||can(req,'finance.manage'), `SELECT b.id,b.reference,b.beneficiary,DATE_FORMAT(b.expiry_date,'%Y-%m-%d') deadline,
      b.created_at createdAt,u.name owner FROM bank_bonds b JOIN users u ON u.id=b.created_by
      LEFT JOIN projects p ON p.id=b.project_id WHERE (p.company_id=? OR b.project_id IS NULL) AND b.status='Live'
      AND b.expiry_date<=DATE_ADD(CURDATE(),INTERVAL 30 DAY) ORDER BY b.expiry_date LIMIT 60`,[companyId],r=>({kind:'bond',id:r.id,title:`Bond expiring · ${r.reference}`,detail:r.beneficiary,owner:r.owner,deadline:r.deadline,createdAt:r.createdAt,risk:'Contract security may lapse',action:'Review bond',escalation:'Finance management',target:['Finance','Bonds',r.id]})),
    add(can(req,'store.manage'), `SELECT m.id,m.name,m.stock,m.minimum,m.site,m.created_at createdAt
      FROM materials m WHERE m.active=1 AND m.stock<=m.minimum ORDER BY m.stock-m.minimum LIMIT 60`,[],r=>({kind:'low-stock',id:r.id,title:`Low stock · ${r.name}`,detail:`${r.stock} available · minimum ${r.minimum} · ${r.site}`,owner:'Store',deadline:null,createdAt:r.createdAt,risk:'Work may stop without replenishment',action:'Raise purchase request',escalation:'Purchasing',target:['Materials','Stock',r.id]})),
    add(can(req,'admin.audit'), `SELECT f.id,f.title,f.severity,f.created_at createdAt,p.name project
      FROM risk_findings f LEFT JOIN projects p ON p.id=f.project_id WHERE f.status='Open'
      AND (p.company_id=? OR f.project_id IS NULL) ORDER BY FIELD(f.severity,'Critical','High','Medium','Low'),f.id DESC LIMIT 60`,[companyId],r=>({kind:'integrity',id:r.id,title:r.title,detail:r.project||r.severity,owner:'Audit reviewer',deadline:null,createdAt:r.createdAt,risk:`${r.severity} integrity finding remains open`,action:'Investigate finding',escalation:'Administration',target:['Administration','Fraud watch',r.id]})),
    add(can(req,'projects.view')&&can(req,'enquiries.manage'), `SELECT c.id,c.inquiry_id inquiryId,c.summary,DATE_FORMAT(c.follow_up_date,'%Y-%m-%d') deadline,
      c.created_at createdAt,u.name owner FROM client_communications c JOIN users u ON u.id=c.logged_by
      JOIN inquiries i ON i.id=c.inquiry_id WHERE i.company_id=? AND c.follow_up_date IS NOT NULL AND c.follow_up_done_at IS NULL
      AND c.follow_up_date<=DATE_ADD(CURDATE(),INTERVAL 7 DAY) ORDER BY c.follow_up_date LIMIT 60`,[companyId],r=>({kind:'client-followup',id:r.id,title:'Client follow-up',detail:r.summary,owner:r.owner,deadline:r.deadline,createdAt:r.createdAt,risk:'Client response may be delayed',action:'Open contact history',escalation:'Project management',target:['Coordination','Enquiries',r.inquiryId]})),
    add(can(req,'projects.manage'), `SELECT m.id,m.title,p.name project,DATE_FORMAT(m.due_date,'%Y-%m-%d') deadline,
      m.created_at createdAt FROM project_milestones m JOIN projects p ON p.id=m.project_id
      WHERE p.company_id=? AND m.status IN ('Pending','In progress','Delayed')
      AND m.due_date<=DATE_ADD(CURDATE(),INTERVAL 7 DAY) ORDER BY m.due_date LIMIT 60`,[companyId],r=>({kind:'milestone',id:r.id,title:`Milestone · ${r.title}`,detail:r.project,owner:'Project manager',deadline:r.deadline,createdAt:r.createdAt,risk:'Project programme may slip',action:'Update milestone',escalation:'Project management',target:['Projects','Milestones',r.id]}))
  ]);
  res.json({ sheets: sheets.filter(sheet => sheet.status === 'Submitted' ? financeReview || qsReview : qsReview), claims, invoicesDue, work });
}));

export default router;
