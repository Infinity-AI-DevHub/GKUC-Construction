import { getOne } from '../db.js';

/** New screens send an employee ID; older integrations may still send a name. */
export async function resolveProjectManager(body, { optional = false } = {}) {
  if (body.managerEmployeeId) {
    const employee = await getOne("SELECT id,name FROM employees WHERE id=? AND status IN ('Active','On leave')", [body.managerEmployeeId]);
    if (!employee) throw Object.assign(new Error('Choose an active employee as project manager.'), { status: 400 });
    return { managerEmployeeId: employee.id, manager: employee.name };
  }
  if (body.manager?.trim()) {
    const matches = await getOne(`SELECT MIN(id) id,COUNT(*) matches FROM employees
      WHERE LOWER(TRIM(name))=LOWER(TRIM(?))`, [body.manager]);
    return { managerEmployeeId: Number(matches?.matches) === 1 ? matches.id : null, manager: body.manager.trim() };
  }
  if (optional) return { managerEmployeeId: null, manager: 'To be assigned' };
  throw Object.assign(new Error('Choose an employee as project manager.'), { status: 400 });
}
