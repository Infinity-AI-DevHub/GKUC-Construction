import React, { useState } from 'react';
import { ArrowDownToLine, Check, Clock3, PencilLine, ShieldCheck, UserRoundCheck, XCircle } from 'lucide-react';
import { api, localDate, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { Avatar, Badge, Field, FormModal, Modal, Page, Row, SelectField, Summary, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import BiometricImport from './BiometricImport.jsx';

const TABS = ['Employees', 'Attendance', 'Biometric import', 'Leave', 'Overtime', 'Payroll', 'Performance', 'Departments'];

/** PID 2.2 — one record per employee covering profile, attendance, leave and overtime. */
export default function People({ data, reload, can }) {
  /* Payroll is a tab of its own permission: offering it to someone the server will refuse
     only sends them into an error they can do nothing about. */
  const tabs = TABS.filter(name => name !== 'Payroll' || can.payroll);
  const [tab, setTab] = useState(tabs[0]);
  const [open, setOpen] = useState('');

  const actions = {
    Employees: can.hr && 'Add employee',
    Attendance: can.attendance && 'Record attendance',
    'Biometric import': null,
    Leave: can.hr && 'Record leave',
    Overtime: can.site && 'Record overtime',
    Payroll: can.payroll && 'Run payroll',
    Performance: can.hr && 'Add review',
    Departments: can.hr && 'Add department'
  };

  return <Page title="People" subtitle="Employee records, live workforce presence, leave and overtime."
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={tabs} active={tab} onChange={setTab} />

    {tab === 'Employees' && <Employees data={data} can={can} />}
    {tab === 'Attendance' && <Attendance data={data} reload={reload} can={can} />}
    {tab === 'Biometric import' && <BiometricImport data={data} reload={reload} can={can} />}
    {tab === 'Leave' && <Leave can={can} />}
    {tab === 'Overtime' && <Overtime can={can} />}
    {tab === 'Payroll' && <Payroll can={can} />}
    {tab === 'Performance' && <Performance />}
    {tab === 'Departments' && <Departments data={data} />}

    {open === 'Employees' && <EmployeeForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Attendance' && <AttendanceForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Leave' && <LeaveForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Overtime' && <OvertimeForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Payroll' && <PayrollForm close={() => setOpen('')} reload={reload} />}
    {open === 'Performance' && <ReviewForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Departments' && <DepartmentForm close={() => setOpen('')} reload={reload} />}
  </Page>;
}

const EMPLOYEE_COLUMNS = ['Employee', 'Department', 'Designation', 'Basic salary', 'Daily rate', 'Status'];
const EMPLOYEE_TEMPLATE = 'minmax(190px,1.4fr) minmax(140px,1fr) minmax(140px,1fr) 130px 110px 100px';

/* The server withholds pay from anyone who does not maintain it, so the columns come and
   go with the data. Showing them as "LKR 0" would read as a wage of nothing. */
const PAY_COLUMNS = ['Basic salary', 'Daily rate'];
const NO_PAY_COLUMNS = EMPLOYEE_COLUMNS.filter(column => !PAY_COLUMNS.includes(column));
const NO_PAY_TEMPLATE = 'minmax(190px,1.4fr) minmax(140px,1fr) minmax(140px,1fr) 100px';

function Employees({ data, can }) {
  const [detail, setDetail] = useState(null);
  const showsPay = data.employees.some(employee => employee.basicSalary !== undefined);
  const columns = showsPay ? EMPLOYEE_COLUMNS : NO_PAY_COLUMNS;
  const template = showsPay ? EMPLOYEE_TEMPLATE : NO_PAY_TEMPLATE;
  return <>
    <div className="attendance-summary">
      <Summary label="Employees" value={data.employees.length} icon={UserRoundCheck} />
      <Summary label="Active" value={data.employees.filter(row => row.status === 'Active').length} icon={ShieldCheck} />
      <Summary label="On leave" value={data.employees.filter(row => row.status === 'On leave').length} icon={Clock3} />
      <Summary label="Departments" value={data.departments.length} icon={ShieldCheck} />
    </div>
    <Table columns={columns} template={template} title="Employee register">
      {data.employees.map(employee => <Row template={template} key={employee.id}
        onClick={async () => setDetail(await api(`/employees/${employee.id}`))}>
        <div className="person"><Avatar name={employee.name} /><div><strong>{employee.name}</strong><small>{employee.code}</small></div></div>
        <span>{employee.department || '—'}</span>
        <span>{employee.designation}</span>
        {showsPay && <span>{rupees(employee.basicSalary)}</span>}
        {showsPay && <span>{rupees(employee.dailyRate)}</span>}
        <Badge tone={slug(employee.status)}>{employee.status}</Badge>
      </Row>)}
    </Table>
    {detail && <EmployeeDetail employee={detail} close={() => setDetail(null)} canManage={can.hr} />}
  </>;
}

function EmployeeDetail({ employee, close, canManage }) {
  return <Modal title={`${employee.name} — ${employee.code}`} close={close}>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Department</span><strong>{employee.department || '—'}</strong></div>
        <div><span>Designation</span><strong>{employee.designation}</strong></div>
      </div>
      <div className="project-stats wide">
        <div><span>Joined</span><strong>{shortDate(employee.joinDate)}</strong></div>
        <div><span>Overtime rate</span><strong>{rupees(employee.overtimeRate)}/h</strong></div>
      </div>
      <div className="wide">
        <Table columns={['Date', 'Site', 'In', 'Out', 'Status']} template="120px minmax(150px,1fr) 80px 80px 110px"
          title="Recent attendance" empty="No attendance recorded.">
          {employee.attendance.slice(0, 10).map(row => <Row template="120px minmax(150px,1fr) 80px 80px 110px" key={row.id}>
            <span>{shortDate(row.workDate)}</span><span>{row.site}</span>
            <span>{row.in || '—'}</span><span>{row.out || '—'}</span>
            <Badge tone={slug(row.state)}>{row.state}</Badge>
          </Row>)}
        </Table>
      </div>
      <div className="wide">
        <Table columns={['Leave type', 'From', 'To', 'Days', 'Status']} template="130px 120px 120px 80px 110px"
          title="Leave history" empty="No leave recorded.">
          {employee.leave.map(row => <Row template="130px 120px 120px 80px 110px" key={row.id}>
            <span>{row.leaveType}</span><span>{shortDate(row.fromDate)}</span><span>{shortDate(row.toDate)}</span>
            <span>{row.days}</span><Badge tone={slug(row.status)}>{row.status}</Badge>
          </Row>)}
        </Table>
      </div>
      <div className="wide">
        <Table columns={['Date', 'Project', 'Hours', 'Rate', 'Status']} template="120px minmax(150px,1fr) 80px 110px 110px"
          title="Overtime" empty="No overtime recorded.">
          {employee.overtime.map(row => <Row template="120px minmax(150px,1fr) 80px 110px 110px" key={row.id}>
            <span>{shortDate(row.workDate)}</span><span>{row.project || '—'}</span>
            <span>{row.hours}</span><span>{rupees(row.rate)}</span>
            <Badge tone={slug(row.status)}>{row.status}</Badge>
          </Row>)}
        </Table>
      </div>
      {employee.projects.length > 0 && <div className="wide">
        <Table columns={['Project', 'Role on project']} template="minmax(200px,1fr) minmax(150px,1fr)" title="Current assignments">
          {employee.projects.map((row, index) => <Row template="minmax(200px,1fr) minmax(150px,1fr)" key={index}>
            <strong>{row.project}</strong><span>{row.projectRole}</span>
          </Row>)}
        </Table>
      </div>}
      <div className="wide">
        <Attachments ownerType="employee" ownerId={employee.id} title="Employee documents"
          canUpload={canManage} canDelete={canManage} withCategory withExpiry />
      </div>
      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>
  </Modal>;
}

const PAYROLL_TEMPLATE = 'minmax(130px,.9fr) 130px 130px 100px 140px 110px 130px';

/** PID 2.2 "Salary Information" — pay computed from recorded attendance and overtime. */
function Payroll({ can }) {
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const load = () => api('/payroll').then(setRows).catch(() => setRows([]));
  useLiveList(load);
  const setStatus = async (id, status) => { await patch(`/payroll/${id}`, { status }); await load(); };

  return <>
    <Table columns={['Reference', 'From', 'To', 'Employees', 'Total', 'Status', '']} template={PAYROLL_TEMPLATE}
      title="Payroll runs" empty="No payroll run yet.">
      {rows.map(row => <Row template={PAYROLL_TEMPLATE} key={row.id}>
        <strong>{row.reference}</strong>
        <span>{shortDate(row.periodStart)}</span>
        <span>{shortDate(row.periodEnd)}</span>
        <span>{row.employees}</span>
        <strong>{rupees(row.total)}</strong>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        <span className="row-actions">
          <button className="status-button" onClick={async () => setDetail(await api(`/payroll/${row.id}`))}>Open</button>
          {can.hr && row.status === 'Draft' && <button className="status-button" onClick={() => setStatus(row.id, 'Approved')}>Approve</button>}
          {can.hr && row.status === 'Approved' && <button className="status-button" onClick={() => setStatus(row.id, 'Paid')}>Mark paid</button>}
        </span>
      </Row>)}
    </Table>
    {detail && <PayrollDetail run={detail} close={() => setDetail(null)} />}
  </>;
}

function PayrollDetail({ run, close }) {
  const template = 'minmax(160px,1.3fr) 90px 90px 110px 120px 120px 120px';
  return <Modal title={`${run.reference} — ${shortDate(run.periodStart)} to ${shortDate(run.periodEnd)}`} close={close}>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Employees</span><strong>{run.payslips.length}</strong></div>
        <div><span>Total net pay</span><strong>{rupees(run.total)}</strong></div>
      </div>
      <div className="wide">
        <Table columns={['Employee', 'Present', 'Absent', 'Overtime', 'Basic', 'Overtime pay', 'Net pay']} template={template}>
          {run.payslips.map(slip => <Row template={template} key={slip.id}>
            <div><strong>{slip.employee}</strong><small>{slip.employeeCode}</small></div>
            <span>{slip.daysPresent}</span>
            <span>{slip.daysAbsent}</span>
            <span>{slip.overtimeHours} h</span>
            <span>{rupees(slip.basic)}</span>
            <span>{rupees(slip.overtimePay)}</span>
            <strong>{rupees(slip.netPay)}</strong>
          </Row>)}
        </Table>
      </div>
      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Close</button></div>
    </div>
  </Modal>;
}

const REVIEW_TEMPLATE = 'minmax(170px,1.2fr) 130px 120px 90px 90px 90px 90px 90px';

/** PID 2.2 "Performance Reports". */
function Performance() {
  const [rows, setRows] = useState([]);
  useLiveList(() => api('/payroll/reviews/all').then(setRows).catch(() => setRows([])));
  return <Table columns={['Employee', 'Period', 'Reviewed', 'Quality', 'Output', 'Safety', 'Reliability', 'Overall']}
    template={REVIEW_TEMPLATE} title="Performance reviews" empty="No reviews recorded.">
    {rows.map(row => <Row template={REVIEW_TEMPLATE} key={row.id}>
      <div><strong>{row.employee}</strong><small>{row.reviewer}</small></div>
      <span>{row.period}</span>
      <span>{shortDate(row.reviewDate)}</span>
      <span>{row.quality}/5</span>
      <span>{row.productivity}/5</span>
      <span>{row.safety}/5</span>
      <span>{row.reliability}/5</span>
      <Badge tone={row.overall >= 4 ? 'on-track' : row.overall >= 3 ? 'watch' : 'at-risk'}>{row.overall}/5</Badge>
    </Row>)}
  </Table>;
}

function PayrollForm({ close, reload }) {
  const first = new Date();
  first.setDate(1);
  return <FormModal title="Run payroll" close={close} label="Build draft run" onSubmit={async values => {
    await post('/payroll', { periodStart: values.periodStart, periodEnd: values.periodEnd });
    await reload();
  }}>
    <Field name="periodStart" label="Period from" type="date" defaultValue={localDate(first)} />
    <Field name="periodEnd" label="Period to" type="date" defaultValue={todayInput()} />
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      Days present come from recorded attendance, overtime from approved overtime records, and
      approved unpaid leave is deducted at the daily rate.
    </p>
  </FormModal>;
}

function ReviewForm({ data, close, reload }) {
  const scores = [1, 2, 3, 4, 5];
  return <FormModal title="Add performance review" close={close} label="Save review" onSubmit={async values => {
    await post(`/payroll/reviews/${values.employeeId}`, {
      reviewDate: values.reviewDate,
      period: values.period,
      quality: Number(values.quality),
      productivity: Number(values.productivity),
      safety: Number(values.safety),
      reliability: Number(values.reliability),
      strengths: values.strengths || undefined,
      improvements: values.improvements || undefined
    });
    await reload();
  }}>
    <SelectField name="employeeId" label="Employee" options={data.employees.map(employee => [employee.id, employee.name])} />
    <Field name="period" label="Review period" placeholder="Q3 2026" />
    <Field name="reviewDate" label="Review date" type="date" defaultValue={todayInput()} />
    <SelectField name="quality" label="Work quality" options={scores} defaultValue="3" />
    <SelectField name="productivity" label="Productivity" options={scores} defaultValue="3" />
    <SelectField name="safety" label="Safety" options={scores} defaultValue="3" />
    <SelectField name="reliability" label="Reliability" options={scores} defaultValue="3" />
    <TextArea name="strengths" label="Strengths" required={false} placeholder="Optional" />
    <TextArea name="improvements" label="Areas to improve" required={false} placeholder="Optional" />
  </FormModal>;
}

const ATTENDANCE_COLUMNS = ['Employee', 'Site', 'Check in', 'Check out', 'Status', ''];
const ATTENDANCE_TEMPLATE = 'minmax(170px,1.3fr) minmax(160px,1fr) 90px 90px 110px 90px';

function Attendance({ data, reload, can }) {
  const [correcting, setCorrecting] = useState(null);
  const present = data.attendance.filter(row => row.state === 'On site' || row.state === 'Late').length;
  const toggle = async id => { await post(`/attendance/${id}/toggle`); await reload(); };

  return <>
    <div className="attendance-summary">
      <Summary label="Present" value={present} icon={UserRoundCheck} />
      <Summary label="Late" value={data.attendance.filter(row => row.state === 'Late').length} icon={Clock3} />
      <Summary label="Absent" value={data.attendance.filter(row => row.state === 'Absent').length} icon={XCircle} />
      <Summary label="Records today" value={data.attendance.length} icon={ShieldCheck} />
    </div>
    <Table columns={ATTENDANCE_COLUMNS} template={ATTENDANCE_TEMPLATE} title="Today’s attendance"
      empty="No attendance recorded for today yet.">
      {data.attendance.map(row => <Row template={ATTENDANCE_TEMPLATE} key={row.id}>
        <div className="person"><Avatar name={row.name} /><div><strong>{row.name}</strong><small>{row.role}</small></div></div>
        <span>{row.site}</span>
        <span>{row.in || '—'}</span>
        <span>{row.out || '—'}</span>
        <Badge tone={slug(row.state)}>{row.state}</Badge>
        {can.site
          ? <span className="row-actions">
            <button className="icon-btn" onClick={() => toggle(row.id)} title={row.in && !row.out ? 'Check out' : 'Check in'}>
              {row.in && !row.out ? <ArrowDownToLine size={17} /> : <Check size={17} />}
            </button>
            <button className="icon-btn" onClick={() => setCorrecting(row)} title="Correct this record"><PencilLine size={15} /></button>
          </span>
          : <span />}
      </Row>)}
    </Table>
    {correcting && <CorrectionForm record={correcting} close={() => setCorrecting(null)} reload={reload} />}
  </>;
}

/** Corrections are allowed but always carry a reason, and land in the audit log. */
function CorrectionForm({ record, close, reload }) {
  return <FormModal title={`Correct attendance — ${record.name}`} close={close} label="Save correction" onSubmit={async values => {
    await patch(`/attendance/${record.id}`, {
      state: values.state || undefined,
      checkIn: values.checkIn || undefined,
      checkOut: values.checkOut || undefined,
      reason: values.reason
    });
    await reload();
  }}>
    <SelectField name="state" label="Status" options={['On site', 'Late', 'Checked out', 'Absent', 'On leave']} defaultValue={record.state} />
    <Field name="checkIn" label="Check in (HH:MM)" required={false} defaultValue={record.in || ''} placeholder="07:30" />
    <Field name="checkOut" label="Check out (HH:MM)" required={false} defaultValue={record.out || ''} placeholder="16:30" />
    <TextArea name="reason" label="Reason for the correction" placeholder="Required — recorded in the audit log" />
  </FormModal>;
}

const LEAVE_COLUMNS = ['Employee', 'Type', 'From', 'To', 'Days', 'Status', ''];
const LEAVE_TEMPLATE = 'minmax(170px,1.2fr) 110px 120px 120px 70px 110px 150px';

function Leave({ can }) {
  const [rows, setRows] = useState([]);
  const load = () => api('/employees/leave/all').then(setRows).catch(() => setRows([]));
  useLiveList(load);
  const decide = async (id, status) => { await patch(`/employees/leave/${id}`, { status }); await load(); };

  return <Table columns={LEAVE_COLUMNS} template={LEAVE_TEMPLATE} title="Leave requests" empty="No leave requested.">
    {rows.map(row => <Row template={LEAVE_TEMPLATE} key={row.id}>
      <div><strong>{row.employee}</strong><small>{row.employeeCode}</small></div>
      <span>{row.leaveType}</span>
      <span>{shortDate(row.fromDate)}</span>
      <span>{shortDate(row.toDate)}</span>
      <span>{row.days}</span>
      <Badge tone={slug(row.status)}>{row.status}</Badge>
      {can.hr && row.status === 'Pending'
        ? <span className="row-actions">
          <button className="status-button" onClick={() => decide(row.id, 'Approved')}>Approve</button>
          <button className="status-button" onClick={() => decide(row.id, 'Rejected')}>Reject</button>
        </span>
        : <span>—</span>}
    </Row>)}
  </Table>;
}

const OVERTIME_COLUMNS = ['Employee', 'Project', 'Date', 'Hours', 'Rate', 'Status', ''];
const OVERTIME_TEMPLATE = 'minmax(170px,1.2fr) minmax(150px,1fr) 120px 80px 100px 110px 120px';

function Overtime({ can }) {
  const [rows, setRows] = useState([]);
  const load = () => api('/employees/overtime/all').then(setRows).catch(() => setRows([]));
  useLiveList(load);
  const decide = async (id, status) => { await patch(`/employees/overtime/${id}`, { status }); await load(); };

  return <Table columns={OVERTIME_COLUMNS} template={OVERTIME_TEMPLATE} title="Overtime records" empty="No overtime recorded.">
    {rows.map(row => <Row template={OVERTIME_TEMPLATE} key={row.id}>
      <div><strong>{row.employee}</strong><small>{row.employeeCode}</small></div>
      <span>{row.project || '—'}</span>
      <span>{shortDate(row.workDate)}</span>
      <span>{row.hours}</span>
      <span>{rupees(row.rate)}</span>
      <Badge tone={slug(row.status)}>{row.status}</Badge>
      {can.hr && row.status === 'Pending'
        ? <button className="status-button" onClick={() => decide(row.id, 'Approved')}>Approve</button>
        : <span>—</span>}
    </Row>)}
  </Table>;
}

function Departments({ data }) {
  const template = 'minmax(180px,1fr) minmax(240px,2fr) 120px';
  const counts = data.employees.reduce((total, employee) => {
    total[employee.departmentId] = (total[employee.departmentId] || 0) + 1;
    return total;
  }, {});
  return <Table columns={['Department', 'Description', 'Headcount']} template={template} title="Departments">
    {data.departments.map(department => <Row template={template} key={department.id}>
      <strong>{department.name}</strong>
      <span>{department.description || '—'}</span>
      <span>{counts[department.id] || 0}</span>
    </Row>)}
  </Table>;
}

function EmployeeForm({ data, close, reload }) {
  return <FormModal title="Add employee" close={close} label="Add employee" onSubmit={async values => {
    await post('/employees', {
      code: values.code,
      name: values.name,
      departmentId: values.departmentId ? Number(values.departmentId) : undefined,
      designation: values.designation,
      phone: values.phone || undefined,
      email: values.email || undefined,
      joinDate: values.joinDate,
      basicSalary: Number(values.basicSalary || 0),
      dailyRate: Number(values.dailyRate || 0),
      overtimeRate: Number(values.overtimeRate || 0)
    });
    await reload();
  }}>
    <Field name="code" label="Employee code" defaultValue={`EMP-${String(data.employees.length + 1).padStart(4, '0')}`} />
    <Field name="name" label="Full name" />
    <SelectField name="departmentId" label="Department" options={data.departments.map(department => [department.id, department.name])} />
    <Field name="designation" label="Designation / trade" />
    <Field name="phone" label="Phone" required={false} />
    <Field name="email" label="Email" type="email" required={false} />
    <Field name="joinDate" label="Join date" type="date" defaultValue={todayInput()} />
    <Field name="basicSalary" label="Basic salary (LKR)" type="number" min="0" defaultValue="0" />
    <Field name="dailyRate" label="Daily rate (LKR)" type="number" min="0" defaultValue="0" />
    <Field name="overtimeRate" label="Overtime rate (LKR/h)" type="number" min="0" defaultValue="0" />
  </FormModal>;
}

function AttendanceForm({ data, close, reload }) {
  return <FormModal title="Record attendance" close={close} label="Record attendance" onSubmit={async values => {
    const employee = data.employees.find(row => String(row.id) === values.employeeId);
    await post('/attendance', {
      name: employee.name,
      role: employee.designation,
      employeeId: employee.id,
      projectId: Number(values.projectId),
      date: values.date,
      state: values.state
    });
    await reload();
  }}>
    <SelectField name="employeeId" label="Employee" options={data.employees.map(employee => [employee.id, `${employee.name} — ${employee.designation}`])} />
    <SelectField name="projectId" label="Project / site" options={data.projects.map(project => [project.id, project.name])} />
    <Field name="date" label="Work date" type="date" defaultValue={todayInput()} />
    <SelectField name="state" label="Status" options={['On site', 'Late', 'Absent', 'On leave']} />
  </FormModal>;
}

function LeaveForm({ data, close, reload }) {
  return <FormModal title="Record leave" close={close} label="Save leave request" onSubmit={async values => {
    await post(`/employees/${values.employeeId}/leave`, {
      leaveType: values.leaveType,
      fromDate: values.fromDate,
      toDate: values.toDate,
      reason: values.reason
    });
    await reload();
  }}>
    <SelectField name="employeeId" label="Employee" options={data.employees.map(employee => [employee.id, employee.name])} />
    <SelectField name="leaveType" label="Leave type" options={['Annual', 'Casual', 'Medical', 'Unpaid', 'Other']} />
    <Field name="fromDate" label="From" type="date" defaultValue={todayInput()} />
    <Field name="toDate" label="To" type="date" defaultValue={todayInput()} />
    <TextArea name="reason" label="Reason" />
  </FormModal>;
}

function OvertimeForm({ data, close, reload }) {
  return <FormModal title="Record overtime" close={close} label="Save overtime" onSubmit={async values => {
    await post(`/employees/${values.employeeId}/overtime`, {
      projectId: Number(values.projectId),
      workDate: values.workDate,
      hours: Number(values.hours)
    });
    await reload();
  }}>
    <SelectField name="employeeId" label="Employee" options={data.employees.map(employee => [employee.id, employee.name])} />
    <SelectField name="projectId" label="Project" options={data.projects.map(project => [project.id, project.name])} />
    <Field name="workDate" label="Work date" type="date" defaultValue={todayInput()} />
    <Field name="hours" label="Overtime hours" type="number" step="0.5" min="0.5" defaultValue="2" />
  </FormModal>;
}

function DepartmentForm({ close, reload }) {
  return <FormModal title="Add department" close={close} label="Add department" onSubmit={async values => {
    await post('/employees/departments', { name: values.name, description: values.description || undefined });
    await reload();
  }}>
    <Field name="name" label="Department name" />
    <TextArea name="description" label="Description" required={false} placeholder="Optional" />
  </FormModal>;
}
