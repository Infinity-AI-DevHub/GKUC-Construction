const WORKED = new Set(['On site','Late','Checked out','Business trip']);
const dateKey = value => value instanceof Date ? value.toISOString().slice(0,10) : String(value).slice(0,10);

export function calculatePayrollLeave(employee,attendance,requests,periodStart,periodEnd) {
  const days = new Map();
  const start = employee.join_date ? [periodStart,dateKey(employee.join_date)].sort().at(-1) : periodStart;
  for(const leave of requests) {
    if(Number(leave.employee_id)!==Number(employee.id)||leave.status!=='Approved')continue;
    const from=[start,dateKey(leave.from_date)].sort().at(-1);
    const to=[periodEnd,dateKey(leave.to_date)].sort()[0];
    if(from>to)continue;
    if(!['Paid','Unpaid'].includes(leave.payment_type))throw new Error(`Review the leave payment type for request #${leave.id}.`);
    for(let date=new Date(`${from}T00:00:00Z`);dateKey(date)<=to;date.setUTCDate(date.getUTCDate()+1)) {
      const key=dateKey(date),prior=days.get(key);
      if(prior&&prior.paymentType!==leave.payment_type)
        throw new Error(`Paid and unpaid leave overlap on ${key}. Correct the leave requests before payroll.`);
      if(prior)prior.requestIds.push(leave.id);
      else days.set(key,{workDate:key,paymentType:leave.payment_type,requestIds:[leave.id],leaveType:leave.leave_type});
    }
  }
  const worked=new Set(),absent=new Set(),transportLeave=new Set(days.keys());
  const relevant=attendance.filter(day=>dateKey(day.work_date)>=periodStart&&dateKey(day.work_date)<=periodEnd);
  for(const day of relevant) {
    const key=dateKey(day.work_date);
    if(WORKED.has(day.state)) {
      if(days.has(key))throw new Error(`Approved ${days.get(key).paymentType.toLowerCase()} leave conflicts with worked attendance on ${key}. Correct attendance or the leave request before payroll.`);
      worked.add(key);
    } else if(day.state==='On leave')transportLeave.add(key);
    else if(day.state==='Absent'&&!days.has(key))absent.add(key);
  }
  for(const key of worked) { absent.delete(key); transportLeave.delete(key); }
  const paid=[...days.values()].filter(day=>day.paymentType==='Paid');
  const unpaid=[...days.values()].filter(day=>day.paymentType==='Unpaid');
  if(paid.length&&Number(employee.daily_rate)<=0)throw new Error('Set a daily salary rate before calculating paid leave.');
  // Virtual leave attendance prevents reviewed OT on a leave day from slipping through.
  const adjustedAttendance=relevant.map(day=>days.has(dateKey(day.work_date))
    ? {...day,state:'On leave',check_in:null,check_out:null}:day);
  const recorded=new Set(relevant.map(day=>dateKey(day.work_date)));
  for(const key of days.keys())if(!recorded.has(key))adjustedAttendance.push({work_date:key,state:'On leave',check_in:null,check_out:null});
  return {days_present:worked.size,days_absent:absent.size,paid_leave_days:paid.length,unpaid_leave_days:unpaid.length,
    leave_days_for_transport:transportLeave.size,absent_days_for_transport:absent.size,
    attendance:adjustedAttendance,
    detail:{workedDays:worked.size,paidLeaveDays:paid.length,unpaidLeaveDays:unpaid.length,
      payableDays:worked.size+paid.length,dailyRate:Number(employee.daily_rate),
      days:[...days.values()].sort((a,b)=>a.workDate.localeCompare(b.workDate))}};
}
