-- Take a verified database backup first. Pause payroll writes while running this.
-- Find the actual ID; do not infer the company ID from the screenshot.
SELECT r.id,c.name company,r.reference,r.period_start,r.period_end,r.pay_frequency,r.status,r.total
FROM payroll_runs r JOIN companies c ON c.id=r.company_id
ORDER BY r.id DESC;

-- Run from a fresh SQL session, not inside another transaction.
DROP PROCEDURE IF EXISTS gkuc_delete_draft_payroll_v1;
DELIMITER $$
CREATE PROCEDURE gkuc_delete_draft_payroll_v1(IN target_id BIGINT UNSIGNED)
BEGIN
DECLARE selected_company BIGINT UNSIGNED DEFAULT NULL;
DECLARE locked_company BIGINT UNSIGNED DEFAULT NULL;
DECLARE draft_id BIGINT UNSIGNED DEFAULT NULL;
DECLARE EXIT HANDLER FOR SQLEXCEPTION
BEGIN
  ROLLBACK;
  RESIGNAL;
END;
START TRANSACTION;
SELECT company_id INTO selected_company FROM payroll_runs WHERE id=target_id;
SELECT id INTO locked_company FROM companies WHERE id=selected_company FOR UPDATE;
SELECT id INTO draft_id FROM payroll_runs WHERE id=target_id AND status='Draft' FOR UPDATE;
IF draft_id IS NULL THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Choose an existing Draft payroll ID. Approved/paid payroll is protected.';
END IF;

INSERT INTO audit_logs(user_id,action,entity,entity_id,before_json,after_json,ip_address)
SELECT NULL,'DELETE','payroll_run',CAST(id AS CHAR),
  JSON_OBJECT('reference',reference,'companyId',company_id,'periodStart',period_start,
    'periodEnd',period_end,'payFrequency',pay_frequency,'status',status,'total',total),
  JSON_OBJECT('status','Deleted','source','Manual SQL; full backup required'),'manual-sql'
FROM payroll_runs WHERE id=draft_id AND status='Draft';

DELETE a FROM payroll_project_allocations a
JOIN payslips s ON s.id=a.payslip_id WHERE s.run_id=draft_id;
DELETE a FROM salary_advance_recoveries a
JOIN payslips s ON s.id=a.payslip_id WHERE s.run_id=draft_id;
DELETE a FROM payslip_components a
JOIN payslips s ON s.id=a.payslip_id WHERE s.run_id=draft_id;
DELETE FROM payslips WHERE run_id=draft_id;
DELETE FROM payroll_runs WHERE id=draft_id AND status='Draft';

COMMIT;
SELECT draft_id deleted_draft_id;
END$$
DELIMITER ;

-- Replace 0 with the ONE draft payroll ID to remove. 0 safely refuses deletion.
CALL gkuc_delete_draft_payroll_v1(0);
DROP PROCEDURE gkuc_delete_draft_payroll_v1;
-- Employee records, attendance, OT, claims, advances and petty cash are untouched.
