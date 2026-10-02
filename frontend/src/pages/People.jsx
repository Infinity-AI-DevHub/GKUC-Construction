import React, { useEffect, useRef, useState } from 'react';
import { RecordScopeProvider } from '../record-scope.jsx';
import EmployeePersonalFields, { personalDetails } from '../EmployeePersonalFields.jsx';
import Hiring from './Hiring.jsx';
import Insurance from './Insurance.jsx';
import PayrollInputs from './PayrollInputs.jsx';
import { ArrowDownToLine, Check, Clock3, PencilLine, Search, ShieldCheck, UserRoundCheck, XCircle } from 'lucide-react';
import { api, inputDate, localDate, openRecord, patch, post, rupees, shortDate, slug, todayInput } from '../api.js';
import { allowedTabs, Avatar, Badge, Field, FormModal, WorkflowForm, Modal, Page, Row, SelectField, Summary, Table, Tabs, TextArea, useLiveList } from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import BiometricImport from './BiometricImport.jsx';
import { useOptions } from '../options.js';
import { AttendanceRegister, LeaveRegister } from '../Registers.jsx';
import EmployeeProfile from './EmployeeProfile.jsx';
import WorkflowChecklist from '../WorkflowChecklist.jsx';
import { payrollSteps } from '../workflow-paths.js';
import AttendanceCorrection from './AttendanceCorrection.jsx';
import WorkforceMap from './WorkforceMap.jsx';

/* Each tab beside the permissions the server will accept for it — see allowedTabs. */
const TABS = [
  ['Employees', ['hr.view', 'hr.manage']],
  ['Hiring',['hr.hiring']],
  ['Insurance',['hr.insurance']],
  ['Workforce map', ['hr.view', 'hr.manage', 'hr.attendance']],
  ['Attendance', ['hr.manage', 'hr.attendance']],
  ['Attendance register', ['hr.manage', 'hr.attendance']],
  ['Biometric import', ['hr.attendance']],
  ['Leave', ['hr.view', 'hr.leave']],
  ['Leave register', ['hr.view', 'hr.leave']],
  ['Leave settings', ['hr.manage']],
  ['Overtime', ['hr.payroll']],
  ['Payroll', ['hr.payroll']],
  ['Payroll Inputs',['hr.payroll']],
  ['Payroll settings', ['hr.settings']],
  ['Performance', ['hr.payroll', 'hr.manage']],
  ['Departments', ['hr.view', 'hr.manage']]
];
const TAB_GROUPS = [
  { label: 'Team', tabs: ['Employees', 'Hiring', 'Insurance', 'Performance', 'Departments'] },
  { label: 'Time & availability', tabs: ['Workforce map', 'Attendance', 'Attendance register', 'Biometric import', 'Leave', 'Leave register', 'Leave settings'] },
  { label: 'Pay', tabs: ['Overtime', 'Payroll', 'Payroll Inputs', 'Payroll settings'] }
];

/** PID 2.2 — one record per employee covering profile, attendance, leave and overtime. */
export default function People({ data, allData, reload, can, companies, companyId, company, employeeSearchRequest }) {
  /* Offering a tab the server will refuse only sends somebody into an error they can do
     nothing about, so each is shown against the permissions it actually needs. */
  const tabs = allowedTabs(TABS, can);
  const [tab, setTab] = useState(() => tabs.find(section => slug(section) === window.location.pathname.split('/')[2]) || tabs[0]);
  const [open, setOpen] = useState('');
  const allProjects = allData?.projects || data.projects;
  const employeeFromPath = () => Number(window.location.pathname.match(/^\/people\/(\d+)\/?$/)?.[1]) || null;
  const [employeeId, setEmployeeId] = useState(employeeFromPath);
  useEffect(() => {
    const sync = () => setEmployeeId(employeeFromPath());
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const openEmployee = id => { window.history.pushState({}, '', `/people/${id}`); setEmployeeId(id); };
  const closeEmployee = () => { window.history.pushState({}, '', '/people'); setEmployeeId(null); };
  useEffect(() => {
    if (!employeeSearchRequest) return;
    setTab('Employees');
    if (employeeId) closeEmployee();
  }, [employeeSearchRequest]);

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

  if (employeeId) return <RecordScopeProvider scope={{ kind: 'shared' }}><EmployeeProfile employeeId={employeeId} close={closeEmployee} canManage={can.hr} canPayroll={can.payroll} canAccess={can.manage} canConduct={can.conduct} canAssets={can.assets}
    canCorrect={can.attendance || can.hrImport} projects={allProjects} departments={data.departments}
    companies={companies} reloadPeople={reload} /></RecordScopeProvider>;

  return <RecordScopeProvider scope={['Payroll', 'Payroll settings', 'Payroll Inputs'].includes(tab) ? { kind: 'company', name: company?.name || 'the selected company', id: companyId } : { kind: 'shared' }}><Page title="People" subtitle="Employee records, live workforce presence, leave and overtime."
    action={actions[tab] || null} onAction={() => setOpen(tab)}>
    <Tabs tabs={tabs} active={tab} onChange={setTab} groups={TAB_GROUPS} />

    {tab === 'Employees' && <Employees data={data} can={can} onOpen={openEmployee} focusRequest={employeeSearchRequest} />}
    {tab === 'Hiring' && <Hiring companies={companies} companyId={companyId} reload={reload} />}
    {tab === 'Insurance' && <Insurance />}
    {tab === 'Payroll Inputs' && <PayrollInputs data={data}/>}
    {tab === 'Workforce map' && <WorkforceMap canManage={can.hr} canPlan={can.hr || can.hrImport} projects={allProjects} />}
    {tab === 'Attendance' && <Attendance data={data} projects={allProjects} reload={reload} can={can} />}
    {tab === 'Attendance register' && <AttendanceRegister projects={allProjects} canCorrect={can.attendance || can.hrImport || can.hr} />}
    {tab === 'Leave register' && <LeaveRegister />}
    {tab === 'Biometric import' && <BiometricImport data={data} projects={allProjects} reload={reload} can={can} />}
    {tab === 'Leave' && <Leave can={can} />}
    {tab === 'Leave settings' && <LeaveSettings />}
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
  </Page></RecordScopeProvider>;
}

const EMPLOYEE_COLUMNS = ['Employee', 'Type', 'Department', 'Designation', 'Basic salary', 'Daily rate', 'Status'];
const EMPLOYEE_TEMPLATE = 'minmax(190px,1.4fr) 100px minmax(140px,1fr) minmax(140px,1fr) 130px 110px 100px';

/* The server withholds pay from anyone who does not maintain it, so the columns come and
   go with the data. Showing them as "LKR 0" would read as a wage of nothing. */
const PAY_COLUMNS = ['Basic salary', 'Daily rate'];
const NO_PAY_COLUMNS = EMPLOYEE_COLUMNS.filter(column => !PAY_COLUMNS.includes(column));
const NO_PAY_TEMPLATE = 'minmax(190px,1.4fr) 100px minmax(140px,1fr) minmax(140px,1fr) 100px';

function Employees({ data, onOpen, focusRequest }) {
  const [search, setSearch] = useState('');
  const searchInput = useRef(null);
  useEffect(() => { if (focusRequest) searchInput.current?.focus(); }, [focusRequest]);
  const showsPay = data.employees.some(employee => employee.basicSalary !== undefined);
  const columns = showsPay ? EMPLOYEE_COLUMNS : NO_PAY_COLUMNS;
  const template = showsPay ? EMPLOYEE_TEMPLATE : NO_PAY_TEMPLATE;
  const term = search.trim().toLocaleLowerCase();
  const employees = term ? data.employees.filter(employee => [employee.name, employee.code, employee.department]
    .some(value => String(value || '').toLocaleLowerCase().includes(term))) : data.employees;
  return <>
    <div className="attendance-summary">
      <Summary label="Employees" value={data.employees.length} icon={UserRoundCheck} />
      <Summary label="Active" value={data.employees.filter(row => row.status === 'Active').length} icon={ShieldCheck} />
      <Summary label="On leave" value={data.employees.filter(row => row.status === 'On leave').length} icon={Clock3} />
      <Summary label="Departments" value={data.departments.length} icon={ShieldCheck} />
    </div>
    <Table columns={columns} template={template} title="Employee register"
      empty={term ? `No employees match “${search.trim()}”.` : 'No employees have been added yet.'}
      tools={<label className="employee-search"><Search size={16} aria-hidden="true" />
        <input ref={searchInput} type="search" value={search} onChange={event => setSearch(event.target.value)}
          placeholder="Search name, code or department" aria-label="Search employees by name, code or department" />
        <span aria-live="polite">{employees.length} of {data.employees.length}</span>
      </label>}>
      {employees.map(employee => <Row template={template} key={employee.id}
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
      title="Payroll runs" empty="No payroll run for this company yet. Check attendance and payroll inputs, then prepare the first run for the correct pay period."
      emptyAction={can.payroll ? () => window.location.assign('/people/payroll-inputs') : undefined} emptyActionLabel="Review payroll inputs">
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
    <PayrollSchedule companyId={companyId} />
    <section className="panel">
      <div className="panel-title"><h2>EPF & ETF rates</h2><button type="button" onClick={()=>setPolicyOpen(true)}>Set / change rates</button></div>
      <div className="report-form">
        <div><strong>Employee EPF</strong><p>{settings.activePolicy?.epfEmployeeRate ?? 'Not set'}%</p></div>
        <div><strong>Employer EPF</strong><p>{settings.activePolicy?.epfEmployerRate ?? 'Not set'}%</p></div>
        <div><strong>Employer ETF</strong><p>{settings.activePolicy?.etfEmployerRate ?? 'Not set'}%</p></div>
        <p className="form-note wide">Calculated only on earned basic salary, after unpaid leave deductions. Overtime, allowances and reimbursements are excluded. EPF and ETF eligibility remain configurable separately for each employee. Rate changes use an effective date; existing salary sheets are not recalculated automatically.</p>
      </div>
    </section>
    <div className="project-stats">
      <div><span>Effective policy</span><strong>{settings.activePolicy ? shortDate(settings.activePolicy.effectiveFrom) : 'Not set'}</strong></div>
      <div><span>Payroll company</span><strong>{company?.name}</strong></div>
      <div><span>Monthly payroll</span><strong>{payrollEmployees.filter(row => row.payFrequency === 'Monthly').length}</strong></div>
      <div><span>Weekly / daily</span><strong>{payrollEmployees.filter(row => row.payFrequency !== 'Monthly').length}</strong></div>
      <div><span>EPF / ETF eligible</span><strong>{payrollEmployees.filter(row => row.epfEligible || row.etfEligible).length}</strong></div>
    </div>

    <Table columns={['Effective', 'Office OT', 'Labour site', 'Labour travel', 'Driver OT', 'Supervisor site', 'Supervisor travel', 'EPF employee', 'EPF employer', 'ETF employer']}
      template={POLICY_TEMPLATE} title="Effective-dated payroll policies"
      tools={<button className="status-button" onClick={() => setPolicyOpen(true)}>Set payroll rates</button>}>
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

function PayrollSchedule({companyId}) {
  const [rows,setRows]=useState([]);
  const [open,setOpen]=useState(false);
  const load=()=>api(`/payroll/schedules?companyId=${companyId}`).then(setRows).catch(()=>setRows([]));
  useEffect(()=>{load();const timer=setInterval(load,60000);return()=>clearInterval(timer);},[companyId]);
  return <>
    <Table title="Automatic payroll" columns={['Period','Pay frequency','Run date / time','Status','Result']} rows={rows.map(row=>[`${shortDate(row.periodStart)} – ${shortDate(row.periodEnd)}`,row.payFrequency,String(row.runAt).replace('T',' ').slice(0,16),row.status,row.message || 'Awaiting scheduled date'])} />
    <button className="secondary" onClick={()=>setOpen(true)}>Schedule automatic payroll</button>
    {open && <FormModal title="Schedule automatic payroll" close={()=>setOpen(false)} label="Save schedule" onSubmit={async values=>{await post('/payroll/schedules',{companyId:Number(companyId),periodStart:values.periodStart,periodEnd:values.periodEnd,payFrequency:values.payFrequency,runAt:values.runAt});await load();}}>
      <p className="form-note wide">At this Sri Lanka date and time, the server creates a draft salary run automatically. HR still reviews and approves it; no salary payment is made automatically. Schedule each required daily, weekly or monthly pay period.</p>
      <Field name="periodStart" label="Payroll period start" type="date" />
      <Field name="periodEnd" label="Payroll period end" type="date" />
      <SelectField name="payFrequency" label="Pay frequency" options={['Daily','Weekly','Monthly']} />
      <Field name="runAt" label="Run automatically at (Sri Lanka time)" type="datetime-local" />
    </FormModal>}
  </>;
}

function PolicyForm({ companyId, policy, close, reload }) {
  return <FormModal title="Set payroll rates and effective date" close={close} label="Save payroll policy" wide onSubmit={async values => {
    await post('/payroll/settings/policies', {
      companyId,
      effectiveFrom: values.effectiveFrom,
      officeOtRate: Number(values.officeOtRate), siteLabourSiteOtRate: Number(values.siteLabourSiteOtRate),
      siteLabourTravelOtRate: Number(values.siteLabourTravelOtRate), driverOtRate: Number(values.driverOtRate),
      supervisorSiteOtRate: Number(values.supervisorSiteOtRate), supervisorTravelOtRate: Number(values.supervisorTravelOtRate),
      epfEmployeeRate: Number(values.epfEmployeeRate), epfEmployerRate: Number(values.epfEmployerRate),
      etfEmployerRate: Number(values.etfEmployerRate), epfBasis: 'Basic earnings', etfBasis: 'Basic earnings',
      hrRules:{normalStart:values.normalStart,normalEnd:values.normalEnd,otInterval:Number(values.otInterval),minimumOt:Number(values.minimumOt),maxDailyOt:Number(values.maxDailyOt),transportDivisor:Number(values.transportDivisor),fullTransportDays:values.fullTransportDays===''?null:Number(values.fullTransportDays),fullTransportComparison:values.fullTransportComparison,longDistanceKm:Number(values.longDistanceKm),longDistancePayment:Number(values.longDistancePayment),supervisorSiteCharge:Number(values.supervisorSiteCharge),mileageRate:Number(values.mileageRate),fixedTravelPayment:Number(values.fixedTravelPayment),allowMileageAndFixed:values.allowMileageAndFixed==='true',countLeaveForTransport:values.countLeaveForTransport==='true',countAbsenceForTransport:values.countAbsenceForTransport==='true'},
      statutoryRules:{permanentOnly:values.permanentOnly==='true',minimumMonthlySalary:Number(values.minimumMonthlySalary),weeklyWeeksPerMonth:Number(values.weeklyWeeksPerMonth),dailyDaysPerMonth:Number(values.dailyDaysPerMonth)}
    });
    await reload();
  }}>
    <Field name="effectiveFrom" label="Effective from" type="date" defaultValue={todayInput()} />
    <SelectField name="permanentOnly" label="GKUC EPF / ETF policy — permanent employees only" options={[[true,'Yes'],[false,'No']]} defaultValue={String((typeof policy?.statutoryRules==='string'?JSON.parse(policy.statutoryRules):policy?.statutoryRules)?.permanentOnly ?? true)} />
    <Field name="minimumMonthlySalary" label="Minimum monthly-equivalent basic salary (LKR)" type="number" min="0" step="0.01" defaultValue={(typeof policy?.statutoryRules==='string'?JSON.parse(policy.statutoryRules):policy?.statutoryRules)?.minimumMonthlySalary ?? 30000} />
    <Field name="weeklyWeeksPerMonth" label="Weeks per month for weekly-rate comparison" type="number" min="0.01" step="0.000001" defaultValue={(typeof policy?.statutoryRules==='string'?JSON.parse(policy.statutoryRules):policy?.statutoryRules)?.weeklyWeeksPerMonth ?? 52/12} />
    <Field name="dailyDaysPerMonth" label="Days per month for daily-rate comparison" type="number" min="0.01" step="0.01" defaultValue={(typeof policy?.statutoryRules==='string'?JSON.parse(policy.statutoryRules):policy?.statutoryRules)?.dailyDaysPerMonth ?? 25} />
    {Object.entries({normalStart:['Normal work starts','07:30','time'],normalEnd:['Normal work ends','16:30','time'],otInterval:['OT rounding interval (hours, rounded down)',0.5,'number'],minimumOt:['Minimum payable OT (hours)',0.5,'number'],maxDailyOt:['Daily OT warning threshold (hours)',6,'number'],transportDivisor:['Monthly transport proration divisor (days)',25,'number'],fullTransportDays:['Full transport threshold — confirm with HR','', 'number'],longDistanceKm:['Long-distance threshold (km, greater than)',50,'number'],longDistancePayment:['Long-distance allowance per qualifying claim (LKR)',500,'number'],mileageRate:['Motorcycle mileage rate (LKR/km)',17,'number'],fixedTravelPayment:['Fixed office-travel payment (LKR)',300,'number']}).map(([name,[label,fallback,type]])=><Field key={name} name={name} label={label} type={type} step={type==='number'?'0.01':undefined} min={type==='number'?'0':undefined} required={name!=='fullTransportDays'} defaultValue={(typeof policy?.hrRules==='string'?JSON.parse(policy.hrRules):policy?.hrRules)?.[name]??fallback}/>)}
    <Field name="supervisorSiteCharge" label="HR-approved supervisor site charge (LKR per day)" type="number" min="0" step="0.01" defaultValue={(typeof policy?.hrRules==='string'?JSON.parse(policy.hrRules):policy?.hrRules)?.supervisorSiteCharge ?? 500} />
    <SelectField name="fullTransportComparison" label="Full transport threshold comparison" options={['At least','More than']} defaultValue={(typeof policy?.hrRules==='string'?JSON.parse(policy.hrRules):policy?.hrRules)?.fullTransportComparison||'At least'}/>
    {['allowMileageAndFixed','countLeaveForTransport','countAbsenceForTransport'].map(name=><SelectField key={name} name={name} label={{allowMileageAndFixed:'Allow mileage and fixed travel together',countLeaveForTransport:'Count leave days for transport',countAbsenceForTransport:'Count absent days for transport'}[name]} options={[[false,'No'],[true,'Yes']]} defaultValue={String((typeof policy?.hrRules==='string'?JSON.parse(policy.hrRules):policy?.hrRules)?.[name]||false)}/>)}
    <Field name="officeOtRate" label="Office OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.officeOtRate ?? 225} />
    <Field name="siteLabourSiteOtRate" label="Labour site OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.siteLabourSiteOtRate ?? 200} />
    <Field name="siteLabourTravelOtRate" label="Labour travel OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.siteLabourTravelOtRate ?? 100} />
    <Field name="driverOtRate" label="Driver OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.driverOtRate ?? 225} />
    <Field name="supervisorSiteOtRate" label="Supervisor site OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.supervisorSiteOtRate ?? 225} />
    <Field name="supervisorTravelOtRate" label="Supervisor travel OT (LKR/h)" type="number" min="0.01" step="0.01" defaultValue={policy?.supervisorTravelOtRate ?? 100} />
    <Field name="epfEmployeeRate" label="EPF employee rate (%)" type="number" min="0" max="100" step="0.001" defaultValue={policy?.epfEmployeeRate ?? 0} />
    <Field name="epfEmployerRate" label="EPF employer rate (%)" type="number" min="0" max="100" step="0.001" defaultValue={policy?.epfEmployerRate ?? 0} />
    <Field name="etfEmployerRate" label="ETF employer rate (%)" type="number" min="0" max="100" step="0.001" defaultValue={policy?.etfEmployerRate ?? 0} />
    <p className="form-note wide">These are GKUC's configurable payroll rules. Eligibility requires the selected employment classification, monthly-equivalent basic salary threshold, contribution start date and the employee's EPF/ETF switches. Changing rules creates a new effective-dated policy; approved salary sheets stay unchanged.</p>
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
      contributionStartDate: values.contributionStartDate || null,
      customOfficeOtRate: values.customOfficeOtRate === '' ? null : Number(values.customOfficeOtRate),
      customSiteOtRate: values.customSiteOtRate === '' ? null : Number(values.customSiteOtRate),
      customTravelOtRate: values.customTravelOtRate === '' ? null : Number(values.customTravelOtRate),
      allowanceEligibility:Object.fromEntries(['transport','longDistance','motorcycle','machine','specialDuty'].map(key=>[key,values[`eligible_${key}`]==='true']))
    });
    await reload();
  }}>
    <SelectField name="payrollCompanyId" label="Salary paid by" options={companies.map(row => [row.id, row.name])} defaultValue={employee.payrollCompanyId || 1} />
    {['transport','longDistance','motorcycle','machine','specialDuty'].map(key=><SelectField key={key} name={`eligible_${key}`} label={`${{transport:'Monthly transport',longDistance:'Long-distance site',motorcycle:'Personal motorcycle mileage',machine:'Machine/operator',specialDuty:'Special daily-duty'}[key]} eligibility`} options={[[false,'Not eligible'],[true,'Eligible']]} defaultValue={String((typeof employee.allowanceEligibility==='string'?JSON.parse(employee.allowanceEligibility):employee.allowanceEligibility)?.[key]||false)}/>)}
    <SelectField name="payBasis" label="Pay basis" options={['Monthly salary', 'Weekly rate', 'Daily rate']} defaultValue={employee.payBasis} />
    <SelectField name="payFrequency" label="Payment frequency" options={['Daily', 'Weekly', 'Monthly']} defaultValue={employee.payFrequency} />
    <SelectField name="payrollCategory" label="Payroll category" options={['Office employee', 'Site labourer', 'Driver', 'Supervisor', 'Custom']} defaultValue={employee.payrollCategory} />
    <Field name="compensationEffectiveFrom" label="Compensation effective from" type="date" defaultValue={inputDate(employee.compensationEffectiveFrom || employee.joinDate)} />
    <Field name="basicSalary" label="Monthly basic salary (LKR)" type="number" min="0" step="0.01" defaultValue={employee.basicSalary || 0} />
    <Field name="weeklyRate" label="Weekly rate (LKR)" type="number" min="0" step="0.01" defaultValue={employee.weeklyRate || 0} />
    <Field name="dailyRate" label="Daily rate (LKR)" type="number" min="0" step="0.01" defaultValue={employee.dailyRate || 0} />
    <SelectField name="epfEligible" label="EPF eligible" options={[[true, 'Yes'], [false, 'No']]} defaultValue={String(Boolean(employee.epfEligible))} />
    <SelectField name="etfEligible" label="ETF eligible" options={[[true, 'Yes'], [false, 'No']]} defaultValue={String(Boolean(employee.etfEligible))} />
    <Field name="contributionStartDate" label="EPF / ETF contributions start on" type="date" required={false} defaultValue={inputDate(employee.contributionStartDate || employee.joinDate)} />
    <p className="form-note wide">GKUC's active policy also checks permanent status, the monthly-equivalent salary threshold and this contribution start date. Change those rules in Payroll settings when the company policy changes.</p>
    <Field name="customOfficeOtRate" label="Custom office OT (optional)" type="number" min="0" step="0.01" required={false} defaultValue={employee.customOfficeOtRate ?? ''} />
    <Field name="customSiteOtRate" label="Custom site OT (optional)" type="number" min="0" step="0.01" required={false} defaultValue={employee.customSiteOtRate ?? ''} />
    <Field name="customTravelOtRate" label="Custom travel OT (optional)" type="number" min="0" step="0.01" required={false} defaultValue={employee.customTravelOtRate ?? ''} />
  </FormModal>;
}

function PayComponentForm({ employee, close, reload }) {
  return <FormModal title={`Add pay component for ${employee.name}`} close={close} label="Add recurring component" onSubmit={async values => {
    await post('/payroll/settings/components', {
      employeeId: employee.id, name: values.name, kind: values.kind, amount: Number(values.amount),
      payFrequency: values.payFrequency, effectiveFrom: values.effectiveFrom, effectiveTo: values.effectiveTo || null,
      calculationMethod:values.calculationMethod,allowanceType:values.allowanceType
    });
    await reload();
  }}>
    <Field name="name" label="Component name" placeholder="Transport allowance" />
    <SelectField name="allowanceType" label="Allowance purpose" options={['Other','Transport','Machine/operator','Special duty']}/>
    <SelectField name="calculationMethod" label="Calculation method" options={['Fixed full amount','Attendance-prorated amount','Per-day amount']}/>
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
      <WorkflowChecklist title="Monthly payroll path" steps={payrollSteps(run)} />
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
            <span>{component.kind}</span><span>{component.name}<small>{component.calculationDetail}</small></span><strong>{rupees(component.amount)}</strong>
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
  return <WorkflowForm title="Prepare payroll run" close={close} label="Build draft run" summary={[["Company", company?.name || 'Selected company'], ['Run stage', 'Draft only — review before approval']]} onSubmit={async values => {
    await post('/payroll', { companyId, periodStart: values.periodStart, periodEnd: values.periodEnd, payFrequency: values.payFrequency });
    await reload();
  }}>
    <div className="qs-form-section wide"><span>01</span><div><h3>Pay period</h3><p>Choose the date range and employees to include.</p></div></div>
    <p className="form-note wide">This salary run belongs to <strong>{company?.name}</strong>.</p>
    <Field name="periodStart" label="Period from" type="date" defaultValue={localDate(first)} />
    <Field name="periodEnd" label="Period to" type="date" defaultValue={todayInput()} />
    <SelectField name="payFrequency" label="Employees to pay" options={[["Daily", "Daily-paid employees"], ["Weekly", "Weekly-paid employees"], ["Monthly", "Monthly-paid employees"]]} defaultValue="Monthly" />
    <div className="qs-form-section wide"><span>02</span><div><h3>Calculation sources</h3><p>Review the inputs used in this draft.</p></div></div>
    <p className="wide" style={{ margin: 0, fontSize: '10px', color: 'var(--muted)' }}>
      Only employees assigned to this payment frequency are included. Attendance, approved typed overtime,
      recurring components, statutory eligibility and outstanding salary advances are calculated automatically.
    </p>
  </WorkflowForm>;
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

function Attendance({ data, projects, reload, can }) {
  const [correcting, setCorrecting] = useState(null);
  const [date, setDate] = useState(todayInput());
  const [rows, setRows] = useState(data.attendance);
  const [analytics, setAnalytics] = useState(null);
  const [siteSubmissions,setSiteSubmissions]=useState([]);
  const [reviewError,setReviewError]=useState('');
  const loadSubmissions=()=>api('/attendance/site-submissions').then(setSiteSubmissions).catch(()=>setSiteSubmissions([]));
  const loadRows = () => api(`/attendance?date=${date}`).then(setRows).catch(() => setRows([]));
  const loadAnalytics = () => api('/attendance/analytics').then(setAnalytics).catch(() => setAnalytics(null));
  useEffect(() => { loadRows(); loadSubmissions(); }, [date]);
  useLiveList(loadAnalytics);
  const present = rows.filter(row => ['On site', 'Late', 'Checked out', 'Business trip'].includes(row.state)).length;
  const refresh = async () => { await Promise.all([loadRows(), loadAnalytics(), reload()]); };
  const toggle = async id => { await post(`/attendance/${id}/toggle`); await refresh(); };
  const reviewSubmission=async(id,decision)=>{try{await post(`/attendance/site-submissions/${id}/review`,{decision});setReviewError('');await Promise.all([loadSubmissions(),refresh()]);}catch(error){setReviewError(error.message);}};
  const canCorrect = can.attendance || can.hrImport;

  return <>
    {siteSubmissions.length>0&&<section className="site-attendance-review"><h3>Site attendance awaiting HR review</h3><p>These field submissions do not affect payroll until HR approves them.</p>{reviewError&&<p className="form-error" role="alert">{reviewError}</p>}{siteSubmissions.map(row=><div key={row.id}><strong>{row.employee}</strong><span>{row.project} · {row.workDate} · {row.state} · submitted by {row.submittedBy}</span><button type="button" onClick={()=>reviewSubmission(row.id,'Approved')}>Approve</button><button type="button" onClick={()=>reviewSubmission(row.id,'Rejected')}>Reject</button></div>)}</section>}
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
    {correcting && <AttendanceCorrection record={correcting} projects={projects} close={() => setCorrecting(null)} reload={refresh} />}
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

const LEAVE_COLUMNS = ['Employee', 'Type', 'From', 'To', 'Days', 'Status', ''];
const LEAVE_TEMPLATE = 'minmax(170px,1.2fr) 110px 120px 120px 70px 110px 150px';

function Leave({ can }) {
  const [rows, setRows] = useState([]);
  const load = () => api('/employees/leave/all').then(setRows).catch(() => setRows([]));
  useLiveList(load);
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get('record')); if (id && rows.some(row => Number(row.id) === id)) document.getElementById(`leave-${id}`)?.scrollIntoView({ block: 'center' }); }, [rows]);
  const decide = async (id, status) => { await patch(`/employees/leave/${id}`, { status }); await load(); };

  return <Table columns={LEAVE_COLUMNS} template={LEAVE_TEMPLATE} title="Leave requests" empty="No leave requested.">
    {rows.map(row => <Row template={LEAVE_TEMPLATE} key={row.id} id={`leave-${row.id}`} className={Number(new URLSearchParams(window.location.search).get('record')) === Number(row.id) ? 'linked-record' : ''}>
      <div><strong>{row.employee}</strong><small>{row.employeeCode}</small></div>
      <span>{row.leaveType}<small>{row.paymentType || (row.leaveType === 'Unpaid' ? 'Unpaid' : 'Paid')}</small></span>
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
  useEffect(() => { const id = Number(new URLSearchParams(window.location.search).get('record')); if (id && rows.some(row => Number(row.id) === id)) document.getElementById(`overtime-${id}`)?.scrollIntoView({ block: 'center' }); }, [rows]);
  const decide = async (id, status) => { await patch(`/employees/overtime/${id}`, { status }); await load(); };

  return <Table columns={OVERTIME_COLUMNS} template={OVERTIME_TEMPLATE} title="Overtime records" empty="No overtime recorded.">
    {rows.map(row => <Row template={OVERTIME_TEMPLATE} key={row.id} id={`overtime-${row.id}`} className={Number(new URLSearchParams(window.location.search).get('record')) === Number(row.id) ? 'linked-record' : ''}>
      <div><strong>{row.employee}</strong><small>{row.employeeCode}</small></div>
      <Badge tone="pending">{row.overtimeType}</Badge>
      <span>{row.project || '—'}</span>
      <span>{shortDate(row.workDate)}</span>
      <span>{row.hours}</span>
      <span>{rupees(row.rate)}</span>
      <Badge tone={slug(row.status)}>{row.status}</Badge>
      {can.payroll && row.status === 'Pending'
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
      ...personalDetails(values),
      code: values.code,
      name: values.name,
      departmentId: values.departmentId ? Number(values.departmentId) : undefined,
      designation: values.designation,
      workerType: values.workerType,
      phone: values.phone || undefined,
      email: values.email || undefined,
      joinDate: values.joinDate || null,
      basicSalary: Number(values.basicSalary || 0),
      dailyRate: Number(values.dailyRate || 0),
      weeklyRate: Number(values.weeklyRate || 0),
      overtimeRate: Number(values.overtimeRate || 0),
      payBasis: values.payBasis,
      payFrequency: values.payFrequency,
      payrollCategory: values.payrollCategory,
      payrollCompanyId: Number(values.payrollCompanyId),
      compensationEffectiveFrom: values.compensationEffectiveFrom || undefined,
      epfEligible: values.epfEligible === 'true',
      etfEligible: values.etfEligible === 'true',
      contributionStartDate: values.contributionStartDate || values.joinDate || null,
      employmentType: values.employmentType
    });
    await reload();
  }}>
    <Field name="code" label="Employee code" defaultValue={`EMP-${String(data.employees.length + 1).padStart(4, '0')}`} />
    <Field name="name" label="Full name" />
    <EmployeePersonalFields />
    <SelectField name="departmentId" label="Department" required={false} options={[["", "Not recorded"], ...data.departments.map(department => [department.id, department.name])]} />
    <Field name="designation" label="Designation / trade" required={false} />
    <SelectField required={false} name="workerType" label="Employee type" options={[["Office", "Office employee"], ["Site", "Site worker"]]} />
    <SelectField required={false} name="employmentType" label="Employment classification" options={['Permanent','Probation','Temporary','Casual','Contract']} defaultValue="Permanent" />
    <Field name="phone" label="Phone" required={false} />
    <Field name="email" label="Email" type="email" required={false} />
    <Field required={false} name="joinDate" label="Employment start date" type="date" />
    <p className="form-note wide">Enter the date this employee actually started working for the company, including existing employees. This is not their registration date. Paid leave becomes available after six months.</p>
    <SelectField required={false} name="payrollCompanyId" label="Salary paid by" options={companies.map(row => [row.id, row.name])} defaultValue={companyId} />
    <SelectField required={false} name="payBasis" label="Pay basis" options={['Monthly salary', 'Weekly rate', 'Daily rate']} defaultValue="Monthly salary" />
    <SelectField required={false} name="payFrequency" label="Payment frequency" options={['Daily', 'Weekly', 'Monthly']} defaultValue="Monthly" />
    <SelectField required={false} name="payrollCategory" label="Payroll category" options={['Office employee', 'Site labourer', 'Driver', 'Supervisor', 'Custom']} defaultValue="Site labourer" />
    <Field required={false} name="compensationEffectiveFrom" label="Compensation effective from" type="date" defaultValue={todayInput()} />
    <Field required={false} name="basicSalary" label="Basic salary (LKR)" type="number" min="0" defaultValue="0" />
    <Field name="weeklyRate" label="Weekly rate (LKR)" type="number" min="0" required={false} />
    <Field name="dailyRate" label="Daily rate (LKR)" type="number" min="0" required={false} />
    <SelectField required={false} name="epfEligible" label="EPF eligible" options={[[true, 'Yes'], [false, 'No']]} defaultValue="true" />
    <SelectField required={false} name="etfEligible" label="ETF eligible" options={[[true, 'Yes'], [false, 'No']]} defaultValue="true" />
    <Field required={false} name="contributionStartDate" label="EPF / ETF contributions start on" type="date" />
    <Field name="overtimeRate" label="Legacy/custom OT rate (LKR/h)" type="number" min="0" defaultValue="0" required={false} />
  </FormModal>;
}

function AttendanceForm({ data, close, reload }) {
  const [workLocation, setWorkLocation] = useState('Site');
  const [projectId,setProjectId]=useState(''),[date,setDate]=useState(todayInput()),[source,setSource]=useState('Attendance sheet'),[notes,setNotes]=useState('');
  const [search,setSearch]=useState(''),[selected,setSelected]=useState({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const employees=data.employees.filter(row=>row.status!=='Archived');
  const visible=employees.filter(row=>`${row.name} ${row.code||''} ${row.designation||''}`.toLowerCase().includes(search.toLowerCase()));
  const chosen=employees.filter(row=>selected[row.id]);
  const update=(id,patch)=>setSelected(rows=>({...rows,[id]:{...rows[id],...patch}}));
  const toggle=id=>setSelected(rows=>{const next={...rows};if(next[id])delete next[id];else next[id]={state:'On site',checkIn:'',checkOut:''};return next;});
  const selectVisible=()=>setSelected(rows=>{const next={...rows};for(const employee of visible)next[employee.id]??={state:'On site',checkIn:'',checkOut:''};return next;});
  const submit=async event=>{
    event.preventDefault();setError('');setBusy(true);
    try{
      if(!chosen.length)throw new Error('Select at least one employee.');
      await post('/attendance/bulk',{workLocation,projectId:workLocation==='Site'?Number(projectId):null,date,informationSource:source,sourceNotes:notes,
        entries:chosen.map(employee=>({employeeId:Number(employee.id),state:selected[employee.id].state,checkIn:selected[employee.id].checkIn||null,checkOut:selected[employee.id].checkOut||null}))});
      await reload();close();
    }catch(failure){setError(failure.message);}finally{setBusy(false);}
  };
  return <Modal title="Record attendance for the team" close={close} wide>
    <form className="attendance-batch" onSubmit={submit}>
      <p className="form-note">Set the date and source once, then select everyone to record. You can adjust each person’s status and times before saving.</p>
      <div className="attendance-batch-common">
        <label>Work location<select value={workLocation} onChange={event=>setWorkLocation(event.target.value)}><option value="Site">Project site</option><option value="Office">Head office</option></select></label>
        {workLocation==='Site'&&<label>Project / site *<select required value={projectId} onChange={event=>setProjectId(event.target.value)}><option value="">Choose a project…</option>{data.projects.map(project=><option value={project.id} key={project.id}>{project.name}</option>)}</select></label>}
        <label>Work date *<input required type="date" value={date} onChange={event=>setDate(event.target.value)}/></label>
        <label>Information source *<select value={source} onChange={event=>setSource(event.target.value)}>{['Biometric','Attendance sheet','WhatsApp','Signed timesheet','Management instruction','Other'].map(value=><option key={value}>{value}</option>)}</select></label>
        <label className="wide">Source reference / notes<textarea rows={2} value={notes} onChange={event=>setNotes(event.target.value)}/></label>
      </div>
      <div className="attendance-batch-picker"><div><strong>Employees</strong><span>{chosen.length} selected</span></div><input type="search" value={search} onChange={event=>setSearch(event.target.value)} placeholder="Search name, ID or role" aria-label="Search employees"/>
        <div className="attendance-batch-picker-actions"><button type="button" className="status-button" onClick={selectVisible} disabled={!visible.length}>Select all shown</button><button type="button" className="status-button" onClick={()=>setSelected({})} disabled={!chosen.length}>Clear selection</button></div>
        <div className="attendance-batch-options">{visible.map(employee=><label key={employee.id}><input type="checkbox" checked={!!selected[employee.id]} onChange={()=>toggle(employee.id)}/><span>{employee.name}<small>{employee.code||employee.designation||'Employee'}</small></span></label>)}</div>
      </div>
      {chosen.length>0&&<section className="attendance-batch-selected"><h3>Review {chosen.length} attendance record{chosen.length===1?'':'s'}</h3>{chosen.map(employee=>{const entry=selected[employee.id];return <div className="attendance-batch-row" key={employee.id}><strong>{employee.name}</strong><label>Status<select value={entry.state} onChange={event=>update(employee.id,{state:event.target.value})}>{['On site','Late','Checked out','Absent','On leave','Business trip'].map(value=><option key={value}>{value}</option>)}</select></label><label>Check in<input type="time" disabled={['Absent','On leave'].includes(entry.state)} value={entry.checkIn} onChange={event=>update(employee.id,{checkIn:event.target.value})}/></label><label>Check out<input type="time" disabled={['Absent','On leave'].includes(entry.state)} value={entry.checkOut} onChange={event=>update(employee.id,{checkOut:event.target.value})}/></label></div>})}</section>}
      {error&&<p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="secondary" onClick={close}>Cancel</button><button className="primary" disabled={busy||!chosen.length}>{busy?'Recording…':`Record ${chosen.length} employee${chosen.length===1?'':'s'}`}</button></div>
    </form>
  </Modal>;
}

function LeaveSettings(){
  const [settings,setSettings]=useState(null),[editing,setEditing]=useState(false),[error,setError]=useState('');
  const load=()=>api('/employees/leave/settings').then(setSettings).catch(e=>setError(e.message));
  useEffect(()=>{load();},[]);
  const p=settings?.active;
  return <section className="panel"><div className="panel-title"><h2>Leave policy</h2><button className="primary" onClick={()=>setEditing(true)}>Create dated policy</button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
    <p className="form-note">The active policy applies by leave start date. Employee-specific annual and casual entitlements can be edited in each employee profile.</p>
    {p&&<div className="attendance-summary"><div className="summary"><div><strong>{p.annual_default}</strong><span>Annual default for new employees</span></div></div><div className="summary"><div><strong>{p.casual_default}</strong><span>Casual default for new employees</span></div></div><div className="summary"><div><strong>{p.monthly_limit}</strong><span>Maximum days in one month</span></div></div><div className="summary"><div><strong>{p.waiting_months} months</strong><span>Leave waiting period</span></div></div></div>}
    {p&&<p className="form-note">Unpaid leave during waiting period: {p.allow_unpaid_during_wait?'Allowed':'Blocked'} · Effective from {shortDate(p.effective_from)}</p>}
    {editing&&<FormModal title="Create leave policy" close={()=>setEditing(false)} label="Save dated policy" onSubmit={async v=>{await post('/employees/leave/settings',{effectiveFrom:v.effectiveFrom,annualDefault:Number(v.annualDefault),casualDefault:Number(v.casualDefault),monthlyLimit:Number(v.monthlyLimit),waitingMonths:Number(v.waitingMonths),allowUnpaidDuringWait:v.allowUnpaidDuringWait==='true'});await load();}}>
      <Field name="effectiveFrom" label="Effective from" type="date" defaultValue={todayInput()}/><Field name="annualDefault" label="Annual default (days)" type="number" min="0" max="365" step="0.5" defaultValue={p?.annual_default??14}/><Field name="casualDefault" label="Casual default (days)" type="number" min="0" max="365" step="0.5" defaultValue={p?.casual_default??7}/><Field name="monthlyLimit" label="Maximum leave days per month" type="number" min="1" max="31" step="0.5" defaultValue={p?.monthly_limit??5}/><Field name="waitingMonths" label="Waiting period after start (months)" type="number" min="0" max="60" defaultValue={p?.waiting_months??6}/><SelectField name="allowUnpaidDuringWait" label="Allow unpaid leave during waiting period" options={[[false,'No'],[true,'Yes']]} defaultValue={String(Boolean(p?.allow_unpaid_during_wait))}/>
      <p className="form-note wide">The monthly cap counts paid and unpaid leave. Annual/other and casual leave have separate annual entitlements. Save a future effective date to change policy later.</p>
    </FormModal>}
  </section>;
}

function LeaveForm({ data, close, reload }) {
  const [employeeId,setEmployeeId]=useState(String(data.employees[0]?.id || ''));
  const [fromDate,setFromDate]=useState(todayInput());
  const employee=data.employees.find(row=>String(row.id)===employeeId);
  const start=employee?.joinDate ? inputDate(employee.joinDate) : '';
  let eligibleFrom='';
  if(start){
    const [year,month,day]=start.split('-').map(Number);
    const target=new Date(Date.UTC(year,month-1+6,1));
    const lastDay=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
    target.setUTCDate(Math.min(day,lastDay));eligibleFrom=target.toISOString().slice(0,10);
  }
  const eligible=eligibleFrom && fromDate>=eligibleFrom;
  const leaveTypes = useOptions('leave.type');
  const [policy,setPolicy]=useState(null);
  useEffect(()=>{api('/employees/leave/settings').then(value=>setPolicy(value.active)).catch(()=>{});},[]);
  return <FormModal title="Record leave" close={close} label="Save leave request" onSubmit={async values => {
    await post(`/employees/${values.employeeId}/leave`, {
      leaveType: values.leaveType,
      paymentType: values.paymentType,
      fromDate: values.fromDate,
      toDate: values.toDate,
      reason: values.reason
    });
    await reload();
  }}>
    <label>Employee<select name="employeeId" required value={employeeId} onChange={event=>setEmployeeId(event.target.value)}>{data.employees.map(employee=><option key={employee.id} value={employee.id}>{employee.name}</option>)}</select></label>
    <SelectField name="leaveType" label="Leave type" options={leaveTypes} />
    {!eligible && <p className="form-note wide" role="alert">{start ? `This employee is still in the leave waiting period. Paid leave is available from ${shortDate(eligibleFrom)}. ${policy?.allow_unpaid_during_wait?'Unpaid leave may be requested.':'Unpaid leave is also blocked by the active policy.'}` : 'Employment start date is not recorded. Update the employee profile before requesting leave.'}</p>}
    <SelectField name="paymentType" label="Leave payment" options={['Paid','Unpaid']} />
    <p className="form-note wide">Annual/other entitlement: {employee?.annualLeaveEntitlement??policy?.annual_default??14} days · Casual entitlement: {employee?.casualLeaveEntitlement??policy?.casual_default??7} days · Monthly maximum: {policy?.monthly_limit??5} days. Paid and unpaid requests count. Approved unpaid leave is deducted in payroll.</p>
    <label>From<input name="fromDate" type="date" required value={fromDate} onChange={event=>setFromDate(event.target.value)} /></label>
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
      overtimeType: values.overtimeType,startTime:values.startTime||undefined,endTime:values.endTime||undefined,reason:values.reason||undefined
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
    <Field name="startTime" label="OT interval starts (manual correction)" type="time" required={false}/>
    <Field name="endTime" label="OT interval ends (manual correction)" type="time" required={false}/>
    <TextArea name="reason" label="Correction / exceptional attendance reason" required={false}/>
    <p className="form-note wide">Travel OT must be entered through Payroll Inputs → Travel claim, not this form.</p>
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
