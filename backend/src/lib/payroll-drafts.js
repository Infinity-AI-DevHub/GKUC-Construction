import {audit} from '../db.js';
import {fail} from './http.js';

export async function lockPayrollRun(connection,id) {
  const [[initial]]=await connection.execute('SELECT company_id FROM payroll_runs WHERE id=?',[id]);
  if(!initial)throw fail(404,'Payroll run not found.');
  await connection.execute('SELECT id FROM companies WHERE id=? FOR UPDATE',[initial.company_id]);
  const [[run]]=await connection.execute('SELECT * FROM payroll_runs WHERE id=? FOR UPDATE',[id]);
  if(!run)throw fail(404,'Payroll run not found.');
  return run;
}

export async function clearDraftPayroll(connection, run, userId, action, ip) {
  if (run.status !== 'Draft') throw fail(409,'Only draft payroll can be deleted or recalculated. Approved and paid payroll is locked.');
  const snapshot={run};
  for(const table of ['payslips','payslip_components','salary_advance_recoveries','payroll_project_allocations']) {
    const [rows]=await connection.query(table==='payslips'
      ? 'SELECT * FROM payslips WHERE run_id=? ORDER BY id FOR UPDATE'
      : `SELECT child.* FROM ${table} child JOIN payslips ps ON ps.id=child.payslip_id WHERE ps.run_id=? ORDER BY child.id FOR UPDATE`,[run.id]);
    snapshot[table]=rows;
  }
  await audit(connection,userId,action,'payroll_run',run.id,snapshot,{status:action==='DELETE'?'Deleted':'Recalculating'},ip);
  for(const table of ['payroll_project_allocations','salary_advance_recoveries','payslip_components'])
    await connection.execute(`DELETE child FROM ${table} child JOIN payslips ps ON ps.id=child.payslip_id WHERE ps.run_id=?`,[run.id]);
  await connection.execute('DELETE FROM payslips WHERE run_id=?',[run.id]);
}
