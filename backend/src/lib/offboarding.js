import {query} from '../db.js';
export async function offboardingChecklist(employee){
  const [assets,store,vehicles,tasks,cases]=await Promise.all([
    query('SELECT id,asset_name name,asset_code code,condition_before conditionBefore,handed_on handedOn FROM employee_asset_handovers WHERE employee_id=? AND returned_on IS NULL',[employee.id]),
    query(`SELECT a.id,e.name,e.code,a.assigned_at handedOn FROM equipment_assignments a JOIN equipment e ON e.id=a.equipment_id WHERE a.returned_at IS NULL AND (a.employee_id=? OR (a.employee_id IS NULL AND a.assigned_to=?))`,[employee.id,employee.name]),
    query(`SELECT DISTINCT f.id,f.vehicle name,f.registration code FROM fleet f LEFT JOIN vehicle_driver_assignments a ON a.vehicle_id=f.id AND a.ended_on IS NULL WHERE f.driver_employee_id=? OR a.employee_id=? OR (a.employee_id IS NULL AND a.driver_name=?) OR (f.driver_employee_id IS NULL AND f.driver=?)`,[employee.id,employee.id,employee.name,employee.name]),
    query(`SELECT DISTINCT t.id,t.title name,t.status,p.name project FROM tasks t JOIN projects p ON p.id=t.project_id LEFT JOIN task_assignees a ON a.task_id=t.id WHERE t.status NOT IN ('Completed','Approved') AND (a.employee_id=? OR t.assignee_employee_id=? OR (t.assignee_employee_id IS NULL AND t.assignee=?))`,[employee.id,employee.id,employee.name]),
    query('SELECT id,reason,requested_on requestedOn,created_at createdAt,access_cleared_at accessClearedAt,payroll_cleared_at payrollClearedAt FROM employee_offboarding_cases WHERE employee_id=?',[employee.id])
  ]);
  const offboarding=cases[0]||null;
  return {assets,store,vehicles,tasks,offboarding,
    clear:![assets,store,vehicles,tasks].some(rows=>rows.length)
      &&(!offboarding||Boolean(offboarding.accessClearedAt&&offboarding.payrollClearedAt))};
}
