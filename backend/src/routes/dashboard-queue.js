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
  const [sheets, claims, invoicesDue] = await Promise.all([
    financeReview || qsReview ? query(`SELECT s.id,s.project_id projectId,p.name project,
      DATE_FORMAT(s.work_date,'%Y-%m-%d') workDate,s.status,s.review_note reviewNote,
      s.submitted_by submittedBy,COUNT(l.id) lineCount
      FROM daily_cost_sheets s JOIN projects p ON p.id=s.project_id
      LEFT JOIN daily_cost_lines l ON l.sheet_id=s.id
      WHERE p.company_id=? AND (s.status='Submitted' OR (s.status='Returned' AND s.submitted_by=?
        AND s.reviewed_at>=DATE_SUB(CURDATE(),INTERVAL 30 DAY)))
      GROUP BY s.id ORDER BY s.work_date DESC,s.id DESC LIMIT 80`, [companyId, req.user.id]) : [],
    hrReview ? query(`SELECT c.id,c.kind,DATE_FORMAT(c.work_date,'%Y-%m-%d') workDate,
      c.status,e.name employee,p.name project
      FROM hr_payroll_claims c JOIN employees e ON e.id=c.employee_id
      LEFT JOIN projects p ON p.id=c.project_id
      WHERE e.payroll_company_id=? AND c.status IN ('Draft','Confirmed')
      ORDER BY c.work_date DESC,c.id DESC LIMIT 80`, [companyId]) : [],
    financeDue ? query(`SELECT i.id,i.reference,i.client,DATE_FORMAT(i.due_date,'%Y-%m-%d') dueDate,
      i.net_payable-i.paid_amount outstanding FROM client_invoices i
      WHERE i.company_id=? AND i.status IN ('Issued','Part paid') AND i.due_date=CURDATE()
      ORDER BY i.id DESC LIMIT 80`, [companyId]) : []
  ]);
  res.json({ sheets: sheets.filter(sheet => sheet.status === 'Submitted' ? financeReview || qsReview : qsReview), claims, invoicesDue });
}));

export default router;
