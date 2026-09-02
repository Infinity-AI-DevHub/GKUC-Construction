import { Router } from 'express';
import { query } from '../db.js';
import { auth, permit } from '../lib/http.js';

const router = Router();

/*
 * The two registers an HR office is actually asked for.
 *
 * Neither is new information — it is all in the attendance and leave tables already. What
 * was missing is the shape somebody needs it in: a month at a glance, and a year's leave
 * per person against what they are entitled to. A question that takes three queries to
 * answer is a question that gets answered from memory instead.
 */

const monthRange = value => {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ''));
  const now = new Date();
  const year = match ? Number(match[1]) : now.getFullYear();
  const month = match ? Number(match[2]) : now.getMonth() + 1;
  const pad = number => String(number).padStart(2, '0');
  const last = new Date(year, month, 0).getDate();
  return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${pad(last)}`, year, month, days: last };
};

/**
 * The muster roll: every employee down the side, every day of the month across.
 *
 * Returned as one row per person with a day-keyed object rather than a wide table, so the
 * interface can lay it out and a short month does not need special handling.
 */
router.get('/hr/attendance-register', auth, permit('hr.view', 'hr.attendance', 'site.attendance'),
  async (req, res, next) => {
    try {
      const period = monthRange(req.query.month);
      const rows = await query(`
        SELECT a.employee_name name, a.work_date workDate, a.state, a.check_in checkIn,
               a.check_out checkOut, p.name project
          FROM attendance a LEFT JOIN projects p ON p.id=a.project_id
         WHERE a.work_date BETWEEN ? AND ?
         ORDER BY a.employee_name, a.work_date`, [period.from, period.to]);

      const leave = await query(`
        SELECT e.name, l.from_date fromDate, l.to_date toDate, l.leave_type leaveType
          FROM leave_requests l JOIN employees e ON e.id=l.employee_id
         WHERE l.status='Approved' AND l.to_date >= ? AND l.from_date <= ?`,
      [period.from, period.to]);

      const people = new Map();
      const ensure = name => {
        if (!people.has(name)) {
          people.set(name, { name, days: {}, present: 0, late: 0, absent: 0, onLeave: 0 });
        }
        return people.get(name);
      };

      for (const row of rows) {
        const person = ensure(row.name);
        const day = Number(String(row.workDate).slice(8, 10));
        const mark = row.state === 'On site' ? 'P' : row.state === 'Late' ? 'L'
          : row.state === 'On leave' ? 'V' : row.state === 'Absent' ? 'A' : 'P';
        person.days[day] = { mark, project: row.project, in: row.checkIn, out: row.checkOut };
        if (mark === 'P') person.present += 1;
        else if (mark === 'L') { person.late += 1; person.present += 1; }
        else if (mark === 'A') person.absent += 1;
      }

      /* Approved leave fills the days it covers, so a gap in the roll is genuinely a gap. */
      for (const row of leave) {
        const person = ensure(row.name);
        for (let day = 1; day <= period.days; day += 1) {
          const date = `${period.from.slice(0, 8)}${String(day).padStart(2, '0')}`;
          if (date >= String(row.fromDate).slice(0, 10) && date <= String(row.toDate).slice(0, 10)) {
            if (!person.days[day]) {
              person.days[day] = { mark: 'V', leaveType: row.leaveType };
              person.onLeave += 1;
            }
          }
        }
      }

      res.json({
        period,
        legend: { P: 'On site', L: 'Late', V: 'On leave', A: 'Absent' },
        rows: [...people.values()].sort((a, b) => a.name.localeCompare(b.name))
      });
    } catch (error) { next(error); }
  });

/**
 * The leave register: a year per person, by type, against entitlement.
 *
 * Pending days are shown separately from taken ones. A person with two days left and three
 * awaiting approval is a conversation somebody needs to have before the approval, not after.
 */
router.get('/hr/leave-register', auth, permit('hr.view', 'hr.leave'), async (req, res, next) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const from = `${year}-01-01`;
    const to = `${year}-12-31`;

    const employees = await query(`
      SELECT e.id,e.code,e.name,e.designation,d.name department,e.join_date joinDate,
             e.annual_leave_entitlement annualEntitlement,
             e.casual_leave_entitlement casualEntitlement
        FROM employees e LEFT JOIN departments d ON d.id=e.department_id
       WHERE e.status <> 'Left' ORDER BY e.name`);

    const taken = await query(`
      SELECT l.employee_id employeeId, l.leave_type leaveType, l.status,
             SUM(l.days) days, COUNT(*) occasions
        FROM leave_requests l
       WHERE l.from_date <= ? AND l.to_date >= ? AND l.status IN ('Approved','Pending')
       GROUP BY l.employee_id, l.leave_type, l.status`, [to, from]);

    const rows = employees.map(person => {
      const mine = taken.filter(one => one.employeeId === person.id);
      const sum = (type, status) => mine
        .filter(one => one.leaveType === type && one.status === status)
        .reduce((total, one) => total + Number(one.days), 0);

      const types = [...new Set(mine.map(one => one.leaveType))];
      const byType = {};
      for (const type of types) byType[type] = { approved: sum(type, 'Approved'), pending: sum(type, 'Pending') };

      const annualTaken = sum('Annual', 'Approved');
      const casualTaken = sum('Casual', 'Approved');
      return {
        ...person,
        byType,
        annualTaken,
        casualTaken,
        annualLeft: Number(person.annualEntitlement) - annualTaken,
        casualLeft: Number(person.casualEntitlement) - casualTaken,
        pending: mine.filter(one => one.status === 'Pending').reduce((t, one) => t + Number(one.days), 0),
        totalTaken: mine.filter(one => one.status === 'Approved').reduce((t, one) => t + Number(one.days), 0)
      };
    });

    res.json({ year, rows });
  } catch (error) { next(error); }
});

export default router;
