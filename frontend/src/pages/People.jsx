import React, { useEffect, useState } from 'react';
import { ArrowDownToLine, Check, Clock3, PencilLine, ShieldCheck, UserRoundCheck, XCircle } from 'lucide-react';
import { api, inputDate, localDate, openRecord, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { allowedTabs, Avatar, Badge, Field, FormModal, Modal, Page, Row, SelectField, Summary, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import BiometricImport from './BiometricImport.jsx';
import { useOptions } from '../options.js';
import { AttendanceRegister, LeaveRegister } from '../Registers.jsx';
import EmployeeProfile from './EmployeeProfile.jsx';
import WorkforceMap from './WorkforceMap.jsx';

/* Each tab beside the permissions the server will accept for it — see allowedTabs. */
const TABS = [
  ['Employees', ['hr.view', 'hr.manage']],
  ['Workforce map', ['hr.view', 'hr.manage', 'hr.attendance', 'site.attendance']],
  ['Attendance', ['hr.view', 'hr.attendance', 'site.attendance']],
  ['Attendance register', ['hr.view', 'hr.attendance', 'site.attendance']],
  ['Biometric import', ['hr.attendance']],
  ['Leave', ['hr.view', 'hr.leave']],
  ['Leave register', ['hr.view', 'hr.leave']],
  ['Overtime', ['hr.view', 'hr.leave']],
  ['Payroll', ['hr.payroll']],
  ['Payroll settings', ['hr.payroll']],
  ['Performance', ['hr.payroll', 'hr.manage']],
  ['Departments', ['hr.view', 'hr.manage']]
];

/** PID 2.2 — one record per employee covering profile, attendance, leave and overtime. */
export default function People({ data, reload, can, companies, companyId, company }) {
  /* Offering a tab the server will refuse only sends somebody into an error they can do
     nothing about, so each is shown against the permissions it actually needs. */
  const tabs = allowedTabs(TABS, can);
  const [tab, setTab] = useState(tabs[0]);
  const [open, setOpen] = useState('');
  const employeeFromPath = () => Number(window.location.pathname.match(/^\/people\/(\d+)\/?$/)?.[1]) || null;
  const [employeeId, setEmployeeId] = useState(employeeFromPath);
  useEffect(() => {
    const sync = () => setEmployeeId(employeeFromPath());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const openEmployee = id => { window.history.pushState({}, '', `/people/${id}`); setEmployeeId(id); };
  const closeEmployee = () => { window.history.pushState({}, '', '/people'); setEmployeeId(null); };

  const actions = {
    Employees: can.hr && 'Add employee',
    'Workforce map': null,
    Attendance: (can.attendance || can.hrImport) && 'Record attendance',
    'Attendance register': null,
    'Biometric import': null,
    'Leave register': null,
    Leave: can.leave && 'Record leave',
    Overtime: can.overtime && 'Record overtime',
    Payroll: can.payroll && 'Run payroll',
    'Payroll settings': null,
    Performance: can.payroll && 'Add review',
    Departments: can.hr && 'Add department'
  };

  if (employeeId) return <EmployeeProfile employeeId={employeeId} close={closeEmployee} canManage={can.hr} />;

  return <Page title="People" subtitle="Employee records, live workforce presence, leave and overtime."
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={tabs} active={tab} onChange={setTab} />

    {tab === 'Employees' && <Employees data={data} can={can} onOpen={openEmployee} />}
    {tab === 'Workforce map' && <WorkforceMap canManage={can.hr} />}
    {tab === 'Attendance' && <Attendance data={data} reload={reload} can={can} />}
    {tab === 'Attendance register' && <AttendanceRegister />}
    {tab === 'Leave register' && <LeaveRegister />}
    {tab === 'Biometric import' && <BiometricImport data={data} reload={reload} can={can} />}
    {tab === 'Leave' && <Leave can={can} />}
    {tab === 'Overtime' && <Overtime can={can} />}
    {tab === 'Payroll' && <Payroll can={can} companyId={companyId} />}
    {tab === 'Payroll settings' && <PayrollSettings data={data} reload={reload} companies={companies} companyId={companyId} company={company} />}
    {tab === 'Performance' && <Performance />}
    {tab === 'Departments' && <Departments data={data} />}

    {open === 'Employees' && <EmployeeForm data={data} companies={companies} companyId={companyId} close={() => setOpen('')} reload={reload} />}
    {open === 'Attendance' && <AttendanceForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Leave' && <LeaveForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Overtime' && <OvertimeForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Payroll' && <PayrollForm companyId={companyId} company={company} close={() => setOpen('')} reload={reload} />}
    {open === 'Performance' && <ReviewForm data={data} close={() => setOpen('')} reload={reload} />}
    {open === 'Departments' && <DepartmentForm close={() => setOpen('')} reload={reload} />}
  </Page>;
}

const EMPLOYEE_COLUMNS = ['Employee', 'Type', 'Department', 'Designation', 'Basic salary', 'Daily rate', 'Status'];
const EMPLOYEE_TEMPLATE = 'minmax(190px,1.4fr) 100px minmax(140px,1fr) minmax(140px,1fr) 130px 110px 100px';

/* The server withholds pay from anyone who does not maintain it, so the columns come and
   go with the data. Showing them as "LKR 0" would read as a wage of nothing. */
const PAY_COLUMNS = ['Basic salary', 'Daily rate'];
const NO_PAY_COLUMNS = EMPLOYEE_COLUMNS.filter(column => !PAY_COLUMNS.includes(column));
const NO_PAY_TEMPLATE = 'minmax(190px,1.4fr) 100px minmax(140px,1fr) minmax(140px,1fr) 100px';

function Employees({ data, onOpen }) {
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
        onClick={() => onOpen(employee.id)}>
        <div className="person"><Avatar name={employee.name} /><div><strong>{employee.name}</strong><small>{employee.code}</small></div></div>
        <Badge tone={employee.workerType === 'Office' ? 'active' : 'pending'}>{employee.workerType}</Badge>
        <span>{employee.department || '—'}</span>
        <span>{employee.designation}</span>
        {showsPay && <span>{rupees(employee.basicSalary)}</span>}
        {showsPay && <span>{rupees(employee.dailyRate)}</span>}
        <Badge tone={slug(employee.status)}>{employee.status}</Badge>
      </Row>)}
    </Table>
  </>;
}

const PAYROLL_TEMPLATE = 'minmax(130px,.9fr) 105px 130px 130px 100px 140px 110px 130px';

/** PID 2.2 "Salary Information" — pay computed from recorded attendance and overtime. */
function Payroll({ can, companyId }) {
  const [rows, setRows] = useState([]);
  const [detail, setDetail] = useState(null);
  const load = () => api(`/payroll?companyId=${companyId}`).then(setRows).catch(() => setRows([]));
  useLiveList(load);
  const setStatus = async (id, status) => { await patch(`/payroll/${id}`, { status }); await load(); };

  return <>
    <Table columns={['Reference', 'Frequency', 'From', 'To', 'Employees', 'Net payroll', 'Status', '']} template={PAYROLL_TEMPLATE}
      title="Payroll runs" empty="No payroll run yet.">
      {rows.map(row => <Row template={PAYROLL_TEMPLATE} key={row.id}>
        <strong>{row.reference}</strong>
        <Badge tone="pending">{row.payFrequency}</Badge>
        <span>{shortDate(row.periodStart)}</span>
        <span>{shortDate(row.periodEnd)}</span>
        <span>{row.employees}</span>
        <strong>{rupees(row.total)}</strong>
        <Badge tone={slug(row.status)}>{row.status}</Badge>
        <span className="row-actions">
          <button className="status-button" onClick={() => openRecord(`/payroll/${row.id}`, setDetail)}>Open</button>
          {can.payroll && row.status === 'Draft' && <button className="status-button" onClick={() => setStatus(row.id, 'Approved')}>Approve</button>}
          {can.payroll && row.status === 'Approved' && <button className="status-button" onClick={() => setStatus(row.id, 'Paid')}>Mark paid</button>}
        </span>
      </Row>)}
    </Table>
    {detail && <PayrollDetail run={detail} close={() => setDetail(null)} />}
  </>;
}

const POLICY_TEMPLATE = '120px repeat(6,110px) repeat(3,105px)';
const PROFILE_TEMPLATE = 'minmax(180px,1.3fr) 135px 105px 140px 80px 80px 100px';

function PayrollSettings({ data, reload, companies, companyId, company }) {
  const [settings, setSettings] = useState({ activePolicy: null, policies: [], components: [] });
  const [policyOpen, setPolicyOpen] = useState(false);
  const [profile, setProfile] = useState(null);
  const [componentEmployee, setComponentEmployee] = useState(null);
  const load = () => api(`/payroll/settings?companyId=${companyId}`).then(setSettings);
  useLiveList(load);
  useEffect(() => { load(); }, [companyId]);
  const payrollEmployees = data.employees.filter(row => Number(row.payrollCompanyId || 1) === Number(companyId));
  const toggleComponent = async row => { await patch(`/payroll/settings/components/${row.id}`, { active: !row.active }); await load(); };

  return <>
    <div className="project-stats">
      <div><span>Effective policy</span><strong>{settings.activePolicy ? shortDate(settings.activePolicy.effectiveFrom) : 'Not set'}</strong></div>
      <div><span>Payroll company</span><strong>{company?.name}</strong></div>
      <div><span>Monthly payroll</span><strong>{payrollEmployees.filter(row => row.payFrequency === 'Monthly').length}</strong></div>
      <div><span>Weekly / daily</span><strong>{payrollEmployees.filter(row => row.payFrequency !== 'Monthly').length}</strong></div>
      <div><span>EPF / ETF eligible</span><strong>{payrollEmployees.filter(row => row.epfEligible || row.etfEligible).length}</strong></div>
    </div>

    <Table columns={['Effective', 'Office OT', 'Labour site', 'Labour travel', 'Driver OT', 'Supervisor site', 'Supervisor travel', 'EPF employee', 'EPF employer', 'ETF employer']}
      template={POLICY_TEMPLATE} title="Effective-dated payroll policies"
      tools={<button className="status-button" onClick={() => setPolicyOpen(true)}>Add future policy</button>}>
      {settings.policies.map(row => <Row template={POLICY_TEMPLATE} key={row.id}>
        <strong>{shortDate(row.effectiveFrom)}</strong><span>{rupees(row.officeOtRate)}</span>
        <span>{rupees(row.siteLabourSiteOtRate)}</span><span>{rupees(row.siteLabourTravelOtRate)}</span>
        <span>{rupees(row.driverOtRate)}</span><span>{rupees(row.supervisorSiteOtRate)}</span>
        <span>{rupees(row.supervisorTravelOtRate)}</span><span>{row.epfEmployeeRate}%</span>
        <span>{row.epfEmployerRate}%</span><span>{row.etfEmployerRate}%</span>
      </Row>)}
    </Table>

    <Table columns={['Employee', 'Pay basis', 'Paid', 'Category', 'EPF', 'ETF', '']}
      template={PROFILE_TEMPLATE} title="Employee compensation profiles">
      {payrollEmployees.map(employee => <Row template={PROFILE_TEMPLATE} key={employee.id}>
        <div><strong>{employee.name}</strong><small>{employee.code}</small></div>
        <span>{employee.payBasis}</span><Badge tone="pending">{employee.payFrequency}</Badge>
        <span>{employee.payrollCategory}</span><Badge tone={employee.epfEligible ? 'active' : 'draft'}>{employee.epfEligible ? 'Yes' : 'No'}</Badge>
        <Badge tone={employee.etfEligible ? 'active' : 'draft'}>{employee.etfEligible ? 'Yes' : 'No'}</Badge>
        <span className="row-actions"><button className="status-button" onClick={() => setProfile(employee)}>Configure</button>
          <button className="status-button" onClick={() => setComponentEmployee(employee)}>Add component</button></span>
      </Row>)}
    </Table>

    <Table columns={['Employee', 'Component', 'Type', 'Frequency', 'Effective', 'Amount', 'Status']}
      template="minmax(170px,1.2fr) minmax(170px,1.2fr) 120px 105px 120px 125px 100px" title="Recurring allowances, deductions and reimbursements"
      empty="No recurring pay components configured.">
      {settings.components.map(row => <Row template="minmax(170px,1.2fr) minmax(170px,1.2fr) 120px 105px 120px 125px 100px" key={row.id}>
        <div><strong>{row.employee}</strong><small>{row.employeeCode}</small></div><span>{row.name}</span><span>{row.kind}</span>
        <span>{row.payFrequency}</span><span>{shortDate(row.effectiveFrom)}</span><strong>{rupees(row.amount)}</strong>
        <button className="status-button" onClick={() => toggleComponent(row)}>{row.active ? 'Active' : 'Inactive'}</button>
      </Row>)}
    </Table>

    {policyOpen && <PolicyForm companyId={companyId} policy={settings.activePolicy} close={() => setPolicyOpen(false)} reload={load} />}
    {profile && <PayProfileForm employee={profile} companies={companies} close={() => setProfile(null)} reload={async () => { await reload(); await load(); }} />}
    {componentEmployee && <PayComponentForm employee={componentEmployee} close={() => setComponentEmployee(null)} reload={load} />}
  </>;
}

function PolicyForm({ companyId, policy, close, reload }) {
  return <FormModal title="Add an effective payroll policy" close={close} label="Save future policy" wide onSubmit={async values => {
    await post('/payroll/settings/policies', {
      companyId,
      effectiveFrom: values.effectiveFrom,
      officeOtRate: Number(values.officeOtRate), siteLabourSiteOtRate: Number(values.siteLabourSiteOtRate),
      siteLabourTravelOtRate: Number(values.siteLabourTravelOtRate), driverOtRate: Number(values.driverOtRate),
      supervisorSiteOtRate: Number(values.supervisorSiteOtRate), supervisorTravelOtRate: Number(values.supervisorTravelOtRate),
      epfEmployeeRate: Number(values.epfEmployeeRate), epfEmployerRate: Number(values.epfEmployerRate),
      etfEmployerRate: Number(values.etfEmployerRate), epfBasis: values.epfBasis, etfBasis: values.etfBasis
    });
    await reload();
  }}>
    <Field name="effectiveFrom" label="Effective from" type="date" defaultValue={todayInput()} />
    <Field name="officeOtRate" label="Office OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.officeOtRate ?? 225} />
    <Field name="siteLabourSiteOtRate" label="Labour site OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.siteLabourSiteOtRate ?? 200} />
    <Field name="siteLabourTravelOtRate" label="Labour travel OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.siteLabourTravelOtRate ?? 100} />
    <Field name="driverOtRate" label="Driver OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.driverOtRate ?? 225} />
    <Field name="supervisorSiteOtRate" label="Supervisor site OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.supervisorSiteOtRate ?? 225} />
    <Field name="supervisorTravelOtRate" label="Supervisor travel OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.supervisorTravelOtRate ?? 100} />
    <Field name="epfEmployeeRate" label="EPF employee rate (%)" type="number" min="0" max="100" step="0.001" defaultValue={policy?.epfEmployeeRate ?? 0} />
    <Field name="epfEmployerRate" label="EPF employer rate (%)" type="number" min="0" max="100" step="0.001" defaultValue={policy?.epfEmployerRate ?? 0} />
    <Field name="etfEmployerRate" label="ETF employer rate (%)" type="number" min="0" max="100" step="0.001" defaultValue={policy?.etfEmployerRate ?? 0} />
    <SelectField name="epfBasis" label="EPF calculation basis" options={['Basic earnings', 'Gross earnings']} defaultValue={policy?.epfBasis || 'Basic earnings'} />
    <SelectField name="etfBasis" label="ETF calculation basis" options={['Basic earnings', 'Gross earnings']} defaultValue={policy?.etfBasis || 'Basic earnings'} />
    <p className="form-note wide">Saving creates a new dated policy. Previously recorded overtime and completed salary sheets keep their original rates.</p>
  </FormModal>;
}

function PayProfileForm({ employee, companies, close, reload }) {
  return <FormModal title={`Configure ${employee.name}`} close={close} label="Save compensation profile" wide onSubmit={async values => {
    await patch(`/payroll/settings/employees/${employee.id}`, {
      payrollCompanyId: Number(values.payrollCompanyId),
      payBasis: values.payBasis, payFrequency: values.payFrequency, payrollCategory: values.payrollCategory,
      basicSalary: Number(values.basicSalary), weeklyRate: Number(values.weeklyRate), dailyRate: Number(values.dailyRate),
      compensationEffectiveFrom: values.compensationEffectiveFrom,
      epfEligible: values.epfEligible === 'true', etfEligible: values.etfEligible === 'true',
      customOfficeOtRate: values.customOfficeOtRate === '' ? null : Number(values.customOfficeOtRate),
      customSiteOtRate: values.customSiteOtRate === '' ? null : Number(values.customSiteOtRate),
      customTravelOtRate: values.customTravelOtRate === '' ? null : Number(values.customTravelOtRate)
    });
    await reload();
  }}>
    <SelectField name="payrollCompanyId" label="Salary paid by" options={companies.map(row => [row.id, row.name])} defaultValue={employee.payrollCompanyId || 1} />
    <SelectField name="payBasis" label="Pay basis" options={['Monthly salary', 'Weekly rate', 'Daily rate']} defaultValue={employee.payBasis} />
    <SelectField name="payFrequency" label="Payment frequency" options={['Daily', 'Weekly', 'Monthly']} defaultValue={employee.payFrequency} />
    <SelectField name="payrollCategory" label="Payroll category" options={['Office employee', 'Site labourer', 'Driver', 'Supervisor', 'Custom']} defaultValue={employee.payrollCategory} />
    <Field name="compensationEffectiveFrom" label="Compensation effective from" type="date" defaultValue={inputDate(employee.compensationEffectiveFrom || employee.joinDate)} />
    <Field name="basicSalary" label="Monthly basic salary (LKR)" type="number" min="0" step="0.01" defaultValue={employee.basicSalary || 0} />
    <Field name="weeklyRate" label="Weekly rate (LKR)" type="number" min="0" step="0.01" defaultValue={employee.weeklyRate || 0} />
    <Field name="dailyRate" label="Daily rate (LKR)" type="number" min="0" step="0.01" defaultValue={employee.dailyRate || 0} />
    <SelectField name="epfEligible" label="EPF eligible" options={[[true, 'Yes'], [false, 'No']]} defaultValue={String(Boolean(employee.epfEligible))} />
    <SelectField name="etfEligible" label="ETF eligible" options={[[true, 'Yes'], [false, 'No']]} defaultValue={String(Boolean(employee.etfEligible))} />
    <Field name="customOfficeOtRate" label="Custom office OT (optional)" type="number" min="0" step="0.01" required={false} defaultValue={employee.customOfficeOtRate ?? ''} />
    <Field name="customSiteOtRate" label="Custom site OT (optional)" type="number" min="0" step="0.01" required={false} defaultValue={employee.customSiteOtRate ?? ''} />
    <Field name="customTravelOtRate" label="Custom travel OT (optional)" type="number" min="0" step="0.01" required={false} defaultValue={employee.customTravelOtRate ?? ''} />
  </FormModal>;
}

function PayComponentForm({ employee, close, reload }) {
  return <FormModal title={`Add pay component for ${employee.name}`} close={close} label="Add recurring component" onSubmit={async values => {
    await post('/payroll/settings/components', {
      employeeId: employee.id, name: values.name, kind: values.kind, amount: Number(values.amount),
      payFrequency: values.payFrequency, effectiveFrom: values.effectiveFrom, effectiveTo: values.effectiveTo || null
    });
    await reload();
  }}>
    <Field name="name" label="Component name" placeholder="Transport allowance" />
    <SelectField name="kind" label="Type" options={['Allowance', 'Deduction', 'Reimbursement']} />
    <Field name="amount" label="Amount per pay cycle (LKR)" type="number" min="0" step="0.01" />
    <SelectField name="payFrequency" label="Pay frequency" options={['Daily', 'Weekly', 'Monthly']} defaultValue={employee.payFrequency} />
    <Field name="effectiveFrom" label="Effective from" type="date" defaultValue={todayInput()} />
    <Field name="effectiveTo" label="Effective to (optional)" type="date" required={false} />
  </FormModal>;
}

function PayrollDetail({ run, close }) {
  const template = 'minmax(160px,1.3fr) 75px 110px 110px 110px 110px 110px 120px 115px 115px 110px 115px 115px 120px 125px';
  const advances = run.payslips.flatMap(slip => slip.advanceRecoveries || []);
  const components = run.payslips.flatMap(slip => (slip.components || []).map(component => ({ ...component, employee: slip.employee, employeeCode: slip.employeeCode })));
  const gross = run.payslips.reduce((sum, slip) => sum + Number(slip.grossEarnings), 0);
  const deductions = run.payslips.reduce((sum, slip) => sum + Number(slip.deductions), 0);
  const employerCost = run.payslips.reduce((sum, slip) => sum + Number(slip.employerCost), 0);
  return <Modal title={`${run.reference} · ${run.payFrequency} · ${shortDate(run.periodStart)} to ${shortDate(run.periodEnd)}`} close={close} wide>
    <div className="report-form">
      <div className="project-stats wide">
        <div><span>Employees</span><strong>{run.payslips.length}</strong></div>
        <div><span>Gross earnings</span><strong>{rupees(gross)}</strong></div>
        <div><span>Total deductions</span><strong>{rupees(deductions)}</strong></div>
        <div><span>Total net pay</span><strong>{rupees(run.total)}</strong></div>
        <div><span>Total employer cost</span><strong>{rupees(employerCost)}</strong></div>
      </div>
      <div className="wide">
        <Table columns={['Employee', 'Present', 'Basic', 'Office OT', 'Site OT', 'Travel OT', 'Allowances', 'Reimbursements', 'Gross', 'Unpaid leave', 'EPF employee', 'Other deductions', 'Salary advance', 'Net pay', 'Employer cost']} template={template} title="Salary sheet breakdown">
          {run.payslips.map(slip => <Row template={template} key={slip.id}>
            <div><strong>{slip.employee}</strong><small>{slip.employeeCode}</small></div>
            <span>{slip.daysPresent}</span>
            <span>{rupees(slip.basic)}</span>
            <div><strong>{rupees(slip.officeOtPay)}</strong><small>{slip.officeOtHours} h</small></div>
            <div><strong>{rupees(slip.siteOtPay)}</strong><small>{slip.siteOtHours} h</small></div>
            <div><strong>{rupees(slip.travelOtPay)}</strong><small>{slip.travelOtHours} h</small></div>
            <span>{rupees(slip.allowanceTotal)}</span><span>{rupees(slip.reimbursementTotal)}</span>
            <strong>{rupees(slip.grossEarnings)}</strong>
            <span>{rupees(slip.unpaidLeaveDeduction)}</span>
            <span>{rupees(slip.epfEmployeeDeduction)}</span><span>{rupees(slip.otherDeduction)}</span>
            <span>{rupees(slip.salaryAdvanceDeduction)}</span>
            <strong>{rupees(slip.netPay)}</strong>
            <strong>{rupees(slip.employerCost)}</strong>
          </Row>)}
        </Table>
      </div>
      {!!components.length && <div className="wide">
        <Table columns={['Employee', 'Type', 'Component', 'Amount']} template="minmax(170px,1.2fr) 130px minmax(220px,1.5fr) 140px" title="Recurring component breakdown">
          {components.map(component => <Row template="minmax(170px,1.2fr) 130px minmax(220px,1.5fr) 140px" key={`${component.employeeCode}-${component.id}`}>
            <div><strong>{component.employee}</strong><small>{component.employeeCode}</small></div>
            <span>{component.kind}</span><span>{component.name}</span><strong>{rupees(component.amount)}</strong>
          </Row>)}
        </Table>
      </div>}
      {!!advances.length && <div className="wide">
        <Table columns={['Employee', 'Advance date', 'Description', 'Recovered in this salary']} template="minmax(170px,1fr) 120px minmax(230px,1.5fr) 170px" title="Salary advance recovery schedule">
          {advances.map(advance => <Row template="minmax(170px,1fr) 120px minmax(230px,1.5fr) 170px" key={advance.id}>
            <div><strong>{advance.employee}</strong><small>{advance.employeeCode}</small></div>
            <span>{shortDate(advance.advanceDate)}</span>
            <span>{advance.description}</span>
            <strong>{rupees(advance.amount)}</strong>
          </Row>)}
        </Table>
      </div>}
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

function PayrollForm({ companyId, company, close, reload }) {
  const first = new Date();
  first.setDate(1);
  return <FormModal title="Run payroll" close={close} label="Build draft run" onSubmit={async values => {
    await post('/payroll', { companyId, periodStart: values.periodStart, periodEnd: values.periodEnd, payFrequency: values.payFrequency });
    await reload();
  }}>
    <p className="form-note wide">This salary run belongs to <strong>{company?.name}</strong>.</p>
    <Field name="periodStart" label="Period from" type="date" defaultValue={localDate(first)} />
    <Field name="periodEnd" label="Period to" type="date" defaultValue={todayInput()} />
    <SelectField name="payFrequency" label="Employees to pay" options={[["Daily", "Daily-paid employees"], ["Weekly", "Weekly-paid employees"], ["Monthly", "Monthly-paid employees"]]} defaultValue="Monthly" />
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      Only employees assigned to this payment frequency are included. Attendance, approved typed overtime,
      recurring components, statutory eligibility and outstanding salary advances are calculated automatically.
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
  const [date, setDate] = useState(todayInput());
  const [rows, setRows] = useState(data.attendance);
  const [analytics, setAnalytics] = useState(null);
  const loadRows = () => api(`/attendance?date=${date}`).then(setRows).catch(() => setRows([]));
  const loadAnalytics = () => api('/attendance/analytics').then(setAnalytics).catch(() => setAnalytics(null));
  useEffect(() => { loadRows(); }, [date]);
  useLiveList(loadAnalytics);
  const present = rows.filter(row => ['On site', 'Late', 'Checked out', 'Business trip'].includes(row.state)).length;
  const refresh = async () => { await Promise.all([loadRows(), loadAnalytics(), reload()]); };
  const toggle = async id => { await post(`/attendance/${id}/toggle`); await refresh(); };
  const canCorrect = can.attendance || can.hrImport;

  return <>
    {analytics && <AttendanceVisuals analytics={analytics} />}
    <div className="attendance-day-toolbar">
      <div><span>Daily record</span><h2>{date === todayInput() ? 'Today’s attendance' : shortDate(date)}</h2></div>
      <label>View date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
    </div>
    <div className="attendance-summary compact-attendance-summary">
      <Summary label="Present" value={present} icon={UserRoundCheck} />
      <Summary label="Late" value={rows.filter(row => row.state === 'Late').length} icon={Clock3} />
      <Summary label="Absent" value={rows.filter(row => row.state === 'Absent').length} icon={XCircle} />
      <Summary label="Records" value={rows.length} icon={ShieldCheck} />
    </div>
    <Table columns={ATTENDANCE_COLUMNS} template={ATTENDANCE_TEMPLATE} title="Today’s attendance"
      empty="No attendance recorded for this date yet.">
      {rows.map(row => <Row template={ATTENDANCE_TEMPLATE} key={row.id}>
        <div className="person"><Avatar name={row.name} /><div><strong>{row.name}</strong><small>{row.role}</small></div></div>
        <span>{row.site}</span>
        <span>{row.in || '—'}</span>
        <span>{row.out || '—'}</span>
        <Badge tone={slug(row.state)}>{row.state}</Badge>
        {canCorrect
          ? <span className="row-actions">
            {date === todayInput() && can.attendance && <button className="icon-btn" onClick={() => toggle(row.id)} title={row.in && !row.out ? 'Check out' : 'Check in'}>
              {row.in && !row.out ? <ArrowDownToLine size={17} /> : <Check size={17} />}
            </button>}
            <button className="icon-btn" onClick={() => setCorrecting(row)} title="Correct this record"><PencilLine size={15} /></button>
          </span>
          : <span />}
      </Row>)}
    </Table>
    {correcting && <CorrectionForm record={correcting} projects={data.projects} close={() => setCorrecting(null)} reload={refresh} />}
  </>;
}

function AttendanceVisuals({ analytics }) {
  const periods = [
    ['Today', analytics.today.rate, `${analytics.today.present} of ${analytics.today.total} people`],
    ['Last 7 days', analytics.weekly.rate, 'Weekly attendance rate'],
    ['Last 30 days', analytics.monthly.rate, 'Monthly attendance rate']
  ];
  return <div className="attendance-visual-dashboard">
    <section className="attendance-rate-cards">{periods.map(([label, rate, detail]) => <article key={label}>
      <div className="attendance-rate-ring" style={{ '--attendance-rate': `${rate}%` }}><strong>{rate}%</strong></div>
      <div><span>{label}</span><h3>{detail}</h3><small>Compared with the active workforce</small></div>
    </article>)}</section>
    <section className="attendance-chart-card">
      <div className="attendance-chart-title"><div><span>30-day attendance</span><h2>Workforce rhythm</h2></div><b>{analytics.monthly.rate}% average</b></div>
      <div className="attendance-bars">{analytics.monthly.series.map(point => <i key={point.day}
        style={{ height: `${Math.max(3, point.rate)}%` }} title={`${shortDate(point.day)} — ${point.rate}%`} />)}</div>
      <div className="attendance-axis"><span>30 days ago</span><span>Today</span></div>
    </section>
    <section className="attendance-watch-card">
      <div className="attendance-chart-title"><div><span>Relative attendance</span><h2>People to check in with</h2></div><b>Cohort median {analytics.cohortMedian}%</b></div>
      <p>Flagged from the lowest-performing quarter of their colleagues—not from an arbitrary pass mark.</p>
      <div className="attendance-watch-list">{analytics.lowAttendance.slice(0, 5).map(person => <article key={person.id}>
        <Avatar name={person.name} /><div><strong>{person.name}</strong><span>{person.designation}</span></div>
        <b>{person.rate}%</b>
      </article>)}{!analytics.lowAttendance.length && <p className="empty-state">No relative attendance concerns in the available history.</p>}</div>
    </section>
  </div>;
}

/** Corrections are allowed but always carry a reason, and land in the audit log. */
function CorrectionForm({ record, projects, close, reload }) {
  return <FormModal title={`Correct attendance — ${record.name}`} close={close} label="Save correction" onSubmit={async values => {
    await patch(`/attendance/${record.id}`, {
      state: values.state || undefined,
      checkIn: values.checkIn || null,
      checkOut: values.checkOut || null,
      workDate: values.workDate,
      projectId: values.projectId ? Number(values.projectId) : undefined,
      reason: values.reason
    });
    await reload();
  }}>
    <SelectField name="state" label="Status" options={['On site', 'Late', 'Checked out', 'Absent', 'On leave', 'Business trip']} defaultValue={record.state} />
    <Field name="workDate" label="Work date" type="date" defaultValue={inputDate(record.workDate)} />
    <SelectField name="projectId" label="Project / site" options={projects.map(project => [project.id, project.name])} defaultValue={record.projectId} />
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
      {can.leave && row.status === 'Pending'
        ? <span className="row-actions">
          <button className="status-button" onClick={() => decide(row.id, 'Approved')}>Approve</button>
          <button className="status-button" onClick={() => decide(row.id, 'Rejected')}>Reject</button>
        </span>
        : <span>—</span>}
    </Row>)}
  </Table>;
}

const OVERTIME_COLUMNS = ['Employee', 'Type', 'Project', 'Date', 'Hours', 'Rate', 'Status', ''];
const OVERTIME_TEMPLATE = 'minmax(170px,1.2fr) 100px minmax(150px,1fr) 120px 80px 100px 110px 120px';

function Overtime({ can }) {
  const [rows, setRows] = useState([]);
  const load = () => api('/employees/overtime/all').then(setRows).catch(() => setRows([]));
  useLiveList(load);
  const decide = async (id, status) => { await patch(`/employees/overtime/${id}`, { status }); await load(); };

  return <Table columns={OVERTIME_COLUMNS} template={OVERTIME_TEMPLATE} title="Overtime records" empty="No overtime recorded.">
    {rows.map(row => <Row template={OVERTIME_TEMPLATE} key={row.id}>
      <div><strong>{row.employee}</strong><small>{row.employeeCode}</small></div>
      <Badge tone="pending">{row.overtimeType}</Badge>
      <span>{row.project || '—'}</span>
      <span>{shortDate(row.workDate)}</span>
      <span>{row.hours}</span>
      <span>{rupees(row.rate)}</span>
      <Badge tone={slug(row.status)}>{row.status}</Badge>
      {can.leave && row.status === 'Pending'
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

function EmployeeForm({ data, companies, companyId, close, reload }) {
  return <FormModal title="Add employee" close={close} label="Add employee" onSubmit={async values => {
    await post('/employees', {
      code: values.code,
      name: values.name,
      departmentId: values.departmentId ? Number(values.departmentId) : undefined,
      designation: values.designation,
      workerType: values.workerType,
      phone: values.phone || undefined,
      email: values.email || undefined,
      joinDate: values.joinDate,
      basicSalary: Number(values.basicSalary || 0),
      dailyRate: Number(values.dailyRate || 0),
      weeklyRate: Number(values.weeklyRate || 0),
      overtimeRate: Number(values.overtimeRate || 0),
      payBasis: values.payBasis,
      payFrequency: values.payFrequency,
      payrollCategory: values.payrollCategory,
      payrollCompanyId: Number(values.payrollCompanyId),
      compensationEffectiveFrom: values.compensationEffectiveFrom,
      epfEligible: values.epfEligible === 'true',
      etfEligible: values.etfEligible === 'true'
    });
    await reload();
  }}>
    <Field name="code" label="Employee code" defaultValue={`EMP-${String(data.employees.length + 1).padStart(4, '0')}`} />
    <Field name="name" label="Full name" />
    <SelectField name="departmentId" label="Department" options={data.departments.map(department => [department.id, department.name])} />
    <Field name="designation" label="Designation / trade" />
    <SelectField name="workerType" label="Employee type" options={[["Office", "Office employee"], ["Site", "Site worker"]]} />
    <Field name="phone" label="Phone" required={false} />
    <Field name="email" label="Email" type="email" required={false} />
    <Field name="joinDate" label="Join date" type="date" defaultValue={todayInput()} />
    <SelectField name="payrollCompanyId" label="Salary paid by" options={companies.map(row => [row.id, row.name])} defaultValue={companyId} />
    <SelectField name="payBasis" label="Pay basis" options={['Monthly salary', 'Weekly rate', 'Daily rate']} defaultValue="Monthly salary" />
    <SelectField name="payFrequency" label="Payment frequency" options={['Daily', 'Weekly', 'Monthly']} defaultValue="Monthly" />
    <SelectField name="payrollCategory" label="Payroll category" options={['Office employee', 'Site labourer', 'Driver', 'Supervisor', 'Custom']} defaultValue="Site labourer" />
    <Field name="compensationEffectiveFrom" label="Compensation effective from" type="date" defaultValue={todayInput()} />
    <Field name="basicSalary" label="Basic salary (LKR)" type="number" min="0" defaultValue="0" />
    <Field name="weeklyRate" label="Weekly rate (LKR)" type="number" min="0" defaultValue="0" />
    <Field name="dailyRate" label="Daily rate (LKR)" type="number" min="0" defaultValue="0" />
    <SelectField name="epfEligible" label="EPF eligible" options={[[false, 'No'], [true, 'Yes']]} defaultValue="false" />
    <SelectField name="etfEligible" label="ETF eligible" options={[[false, 'No'], [true, 'Yes']]} defaultValue="false" />
    <Field name="overtimeRate" label="Legacy/custom OT rate (LKR/h)" type="number" min="0" defaultValue="0" required={false} />
  </FormModal>;
}

function AttendanceForm({ data, close, reload }) {
  const [workLocation, setWorkLocation] = useState('Site');
  return <FormModal title="Record attendance" close={close} label="Record attendance" onSubmit={async values => {
    const employee = data.employees.find(row => String(row.id) === values.employeeId);
    await post('/attendance', {
      name: employee.name,
      role: employee.designation,
      employeeId: employee.id,
      projectId: workLocation === 'Site' ? Number(values.projectId) : null,
      workLocation,
      date: values.date,
      state: values.state,
      checkIn: values.checkIn || null,
      checkOut: values.checkOut || null
    });
    await reload();
  }}>
    <SelectField name="employeeId" label="Employee" options={data.employees.map(employee => [employee.id, `${employee.name} — ${employee.designation}`])} />
    <label>Work location<select name="workLocation" value={workLocation} onChange={event => setWorkLocation(event.target.value)}><option value="Site">Project site</option><option value="Office">Head office</option></select></label>
    {workLocation === 'Site' && <SelectField name="projectId" label="Project / site" options={data.projects.map(project => [project.id, project.name])} />}
    <Field name="date" label="Work date" type="date" defaultValue={todayInput()} />
    <SelectField name="state" label="Status" options={['On site', 'Late', 'Absent', 'On leave', 'Business trip']} />
    <Field name="checkIn" label="Check in (optional)" type="time" required={false} />
    <Field name="checkOut" label="Check out (optional)" type="time" required={false} />
  </FormModal>;
}

function LeaveForm({ data, close, reload }) {
  const leaveTypes = useOptions('leave.type');
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
    <SelectField name="leaveType" label="Leave type" options={leaveTypes} />
    <Field name="fromDate" label="From" type="date" defaultValue={todayInput()} />
    <Field name="toDate" label="To" type="date" defaultValue={todayInput()} />
    <TextArea name="reason" label="Reason" />
  </FormModal>;
}

function OvertimeForm({ data, close, reload }) {
  const [employeeId, setEmployeeId] = useState(String(data.employees[0]?.id || ''));
  const selected = data.employees.find(row => String(row.id) === employeeId);
  const overtimeTypes = selected?.payrollCategory === 'Office employee' ? ['Office']
    : ['Site labourer', 'Supervisor'].includes(selected?.payrollCategory) ? ['Site', 'Travel']
      : ['Office', 'Site', 'Travel'];
  return <FormModal title="Record overtime" close={close} label="Save overtime" onSubmit={async values => {
    await post(`/employees/${values.employeeId}/overtime`, {
      projectId: Number(values.projectId),
      workDate: values.workDate,
      hours: Number(values.hours),
      overtimeType: values.overtimeType
    });
    await reload();
  }}>
    <label>Employee<abbr className="req" title="This field is required" aria-hidden="true">*</abbr><select name="employeeId" value={employeeId} onChange={event => setEmployeeId(event.target.value)} required>
      {data.employees.map(employee => <option value={employee.id} key={employee.id}>{employee.name}</option>)}</select></label>
    <SelectField key={`${employeeId}-${overtimeTypes.join('-')}`} name="overtimeType" label="Overtime type" options={overtimeTypes} />
    <SelectField name="projectId" label="Project (optional)" required={false}
      options={[["", "Head office / no project"], ...data.projects.map(project => [project.id, project.name])]} />
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
