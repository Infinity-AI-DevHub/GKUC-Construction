import { query, today } from '../db.js';

/** Shared daily deployment rules for Workforce assignments and Coordination. */
export function workforcePicture({ employees, attendance, leave, assignments, locations }, date) {
  const nameCounts = new Map();
  for (const person of employees) nameCounts.set(person.name, (nameCounts.get(person.name) || 0) + 1);
  const byAttendance = new Map(attendance.map(row => [row.employeeId || `name:${row.employeeName}`, row]));
  const byLeave = new Map(leave.map(row => [row.employeeId, row]));
  const byAssignment = new Map();
  for (const row of assignments) if (!byAssignment.has(row.employeeId)) byAssignment.set(row.employeeId, row);
  const byLocation = new Map(locations.map(row => [row.employeeId, row]));
  const people = employees.map(person => {
    const day = byAttendance.get(person.id) || (nameCounts.get(person.name) === 1 ? byAttendance.get(`name:${person.name}`) : null);
    const away = byLeave.get(person.id);
    const plan = byAssignment.get(person.id);
    const datedLocation = byLocation.get(person.id);
    let status = 'Free', group = 'free', location = 'Not assigned', projectId = null, available = true;
    if (person.employmentStatus === 'Suspended') { status = 'Not working'; group = 'not-working'; location = 'Suspended'; available = false; }
    else if (away) { status = 'On leave'; group = 'leave'; location = away.leaveType; available = false; }
    else if (day?.state === 'Absent') { status = 'Not working'; group = 'not-working'; location = 'Absent'; available = false; }
    else if (day?.state === 'On leave') { status = 'On leave'; group = 'leave'; location = 'On leave'; available = false; }
    else if (day?.workLocation === 'Not working') { status = 'Not working'; group = 'not-working'; location = day.state || 'Not working'; available = false; }
    else if (day?.state === 'Business trip') { status = 'Business trip'; group = 'business-trip'; location = day.project || 'Away'; projectId = day.projectId; available = false; }
    else if (day?.workLocation === 'Office') { status = 'At office'; group = 'office'; location = 'Head office'; available = false; }
    else if (day) { status = 'At site'; group = 'site'; location = day.project || 'Site'; projectId = day.projectId; available = false; }
    else if (datedLocation?.workLocation === 'Office') { status = 'Scheduled at office'; group = 'office'; location = 'Head office'; available = false; }
    else if (datedLocation) { status = 'Scheduled at site'; group = 'site'; location = datedLocation.project || 'Site'; projectId = datedLocation.projectId; available = false; }
    else if (plan) { status = 'Scheduled at site'; group = 'site'; location = plan.project; projectId = plan.projectId; available = false; }
    else if (person.workerType === 'Office') { status = 'Expected at office'; group = 'office'; location = 'Head office'; available = false; }
    return { ...person, status, group, location, projectId, available,
      source: day ? 'Attendance' : datedLocation ? 'Dated work plan' : plan ? 'Project team' : null,
      attendanceRecorded: Boolean(day), attendanceState: day?.state || null, projectRole: Number(plan?.projectId) === Number(projectId) ? plan?.projectRole || null : null };
  });
  const count = key => people.filter(person => person.group === key).length;
  const sites = [...people.filter(person => person.group === 'site').reduce((map, person) => {
    const current = map.get(person.location) || { name: person.location, people: 0 };
    current.people += 1; map.set(person.location, current); return map;
  }, new Map()).values()].sort((a, b) => b.people - a.people);
  return { date, summary: { total: people.length, site: count('site'), office: count('office'), free: count('free'), leave: count('leave'), notWorking: count('not-working') }, sites, people };
}

export async function loadWorkforcePicture(date = today()) {
  const [employees, attendance, leave, assignments, locations] = await Promise.all([
    query(`SELECT e.id,e.code,e.name,e.designation,e.worker_type workerType,e.photo_url photoUrl,e.status employmentStatus,
      d.name department FROM visible_employees e LEFT JOIN departments d ON d.id=e.department_id
      WHERE e.status <> 'Left' AND e.join_date<=? ORDER BY e.name`, [date]),
    query(`SELECT a.employee_id employeeId,a.employee_name employeeName,a.state,a.work_location workLocation,
      p.id projectId,p.name project FROM visible_attendance a LEFT JOIN projects p ON p.id=a.project_id WHERE a.work_date=?`, [date]),
    query(`SELECT l.employee_id employeeId,l.leave_type leaveType FROM visible_leave_requests l
      WHERE l.status='Approved' AND ? BETWEEN l.from_date AND l.to_date`, [date]),
    query(`SELECT pt.employee_id employeeId,p.id projectId,p.name project,pt.project_role projectRole
      FROM visible_project_team pt JOIN projects p ON p.id=pt.project_id
      WHERE p.active=1 AND DATE(pt.assigned_at)<=? AND (pt.released_at IS NULL OR DATE(pt.released_at)>=?)
      ORDER BY pt.assigned_at DESC,pt.id DESC`, [date, date]),
    query(`SELECT w.employee_id employeeId,w.work_location workLocation,w.project_id projectId,p.name project
      FROM visible_employee_work_locations w LEFT JOIN projects p ON p.id=w.project_id WHERE w.work_date=?`, [date])
  ]);
  return workforcePicture({ employees, attendance, leave, assignments, locations }, date);
}
