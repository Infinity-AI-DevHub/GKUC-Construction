import { query } from '../db.js';

/** Keep one task record while showing every employee responsible for it. */
export async function withTaskAssignees(rows) {
  const tasks = Array.isArray(rows) ? rows : rows ? [rows] : [];
  if (!tasks.length) return Array.isArray(rows) ? [] : null;
  const ids = [...new Set(tasks.map(task => Number(task.id)))];
  const linked = await query(`SELECT ta.task_id taskId,e.id employeeId,e.name
    FROM task_assignees ta JOIN employees e ON e.id=ta.employee_id
    WHERE ta.task_id IN (${ids.map(() => '?').join(',')}) ORDER BY ta.task_id,ta.assigned_at,e.name,e.id`, ids);
  const byTask = new Map();
  for (const employee of linked) {
    const members = byTask.get(Number(employee.taskId)) || [];
    members.push({ id: Number(employee.employeeId), name: employee.name });
    byTask.set(Number(employee.taskId), members);
  }
  const enriched = tasks.map(task => {
    const members = byTask.get(Number(task.id)) || (task.assigneeEmployeeId
      ? [{ id: Number(task.assigneeEmployeeId), name: task.assignee }] : []);
    members.sort((a, b) => Number(b.id === Number(task.assigneeEmployeeId)) - Number(a.id === Number(task.assigneeEmployeeId)));
    return {
      ...task,
      assigneeEmployeeIds: members.map(employee => employee.id),
      assignees: members,
      assignee: members.length ? members.map(employee => employee.name).join(', ') : task.assignee
    };
  });
  return Array.isArray(rows) ? enriched : enriched[0];
}
