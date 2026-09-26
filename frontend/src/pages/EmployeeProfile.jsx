import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BriefcaseBusiness, CalendarDays, CheckCircle2, ClipboardCheck,
  Clock3, Mail, MapPin, PencilLine, Phone, ShieldCheck, Star, TrendingUp, UserRound } from 'lucide-react';
import { api, inputDate, patch, rupees, shortDate, slug } from '../api.js';
import { Avatar, Badge, Field, FormModal, Row, SelectField, Table, TextArea } from '../ui.jsx';
import Attachments from '../Attachments.jsx';
import EmployeePersonalFields, { personalDetails } from '../EmployeePersonalFields.jsx';
import AttendanceCorrection from './AttendanceCorrection.jsx';

function RateRing({ value, label }) {
  return <div className="people-rate-ring" style={{ '--people-rate': `${Math.max(0, Math.min(100, value || 0))}%` }}>
    <div><strong>{value || 0}%</strong><span>{label}</span></div>
  </div>;
}

function TrendBars({ points }) {
  const shown = points.slice(-12);
  return <div className="people-trend" aria-label="Monthly attendance trend">
    {shown.map(point => <div className="people-trend-column" key={point.month} title={`${point.month}: ${point.rate}%`}>
      <div><i style={{ height: `${Math.max(4, point.rate)}%` }} /></div>
      <span>{new Date(`${point.month}-01T12:00:00`).toLocaleDateString('en-GB', { month: 'short' })}</span>
    </div>)}
    {!shown.length && <p className="empty-state">Attendance history will appear after the first records are added.</p>}
  </div>;
}

function ReviewRadar({ review }) {
  if (!review) return <p className="empty-state">No performance review has been recorded yet.</p>;
  const scores = [review.quality, review.productivity, review.safety, review.reliability].map(Number);
  const axes = [[100, 18], [182, 100], [100, 182], [18, 100]];
  const points = axes.map(([x, y], index) => {
    const ratio = scores[index] / 5;
    return `${100 + (x - 100) * ratio},${100 + (y - 100) * ratio}`;
  }).join(' ');
  return <div className="performance-visual">
    <svg viewBox="0 0 200 200" role="img" aria-label={`Latest overall performance ${review.overall} out of 5`}>
      <polygon className="radar-grid" points="100,18 182,100 100,182 18,100" />
      <polygon className="radar-grid radar-mid" points="100,58 142,100 100,142 58,100" />
      <line x1="100" y1="18" x2="100" y2="182" /><line x1="18" y1="100" x2="182" y2="100" />
      <polygon className="radar-score" points={points} />
    </svg>
    <div className="performance-legend">
      {[['Quality', scores[0]], ['Output', scores[1]], ['Safety', scores[2]], ['Reliability', scores[3]]]
        .map(([label, score]) => <span key={label}><b>{score}/5</b>{label}</span>)}
    </div>
  </div>;
}

export default function EmployeeProfile({ employeeId, close, canManage, canCorrect, projects = [], departments = [], companies = [], reloadPeople }) {
  const [employee, setEmployee] = useState(null);
  const [error, setError] = useState('');
  const [correcting, setCorrecting] = useState(null);
  const [editing, setEditing] = useState(false);
  const reloadEmployee = async () => setEmployee(await api(`/employees/${employeeId}`));
  useEffect(() => {
    setEmployee(null); setError('');
    api(`/employees/${employeeId}`).then(setEmployee).catch(failure => setError(failure.message));
  }, [employeeId]);

  const latestReview = employee?.reviews?.[employee.reviews.length - 1] || null;
  const activity = useMemo(() => {
    if (!employee) return [];
    return [
      ...employee.tasks.slice(0, 8).map(item => ({ date: item.updatedAt, title: item.title, meta: `${item.project} · ${item.status}`, kind: 'Task' })),
      ...employee.reports.slice(0, 8).map(item => ({ date: item.reportDate, title: item.work || 'Daily report', meta: item.project, kind: 'Report' }))
    ].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 10);
  }, [employee]);

  if (error) return <div className="employee-profile-error"><button className="secondary" onClick={close}><ArrowLeft size={16} />People</button><p className="form-error">{error}</p></div>;
  if (!employee) return <div className="employee-profile-loading">Loading employee profile…</div>;

  const stats = employee.attendanceStats;
  return <div className="employee-profile">
    <button className="employee-back" onClick={close}><ArrowLeft size={16} />All people</button>

    <section className="employee-hero">
      <div className="employee-hero-copy">
        <Avatar name={employee.name} />
        <div><span className="employee-kicker">EMPLOYEE PROFILE · {employee.code}</span><h1>{employee.name}</h1>
          <p>{employee.designation} · {employee.department || 'No department assigned'}</p>
          <div className="employee-hero-tags"><Badge tone={slug(employee.status)}>{employee.status}</Badge>
            <span><BriefcaseBusiness size={13} />{employee.workerType} employee</span>
            {employee.currentProject && <span><MapPin size={13} />{employee.currentProject}</span>}
            {(employee.biometricIds?.length ? employee.biometricIds : employee.biometricId ? [employee.biometricId] : [])
              .map(code => <span key={code}><ShieldCheck size={13} />Biometric #{code}</span>)}
          </div>
        </div>
      </div>
      <RateRing value={stats.rate} label="career attendance" />
    </section>

    <section className="employee-metrics">
      <article><CheckCircle2 /><div><span>Days present</span><strong>{stats.present}</strong><small>{stats.late} late arrivals</small></div></article>
      <article><ClipboardCheck /><div><span>Task delivery</span><strong>{employee.workStats.completedTasks}/{employee.workStats.tasks}</strong><small>completed assignments</small></div></article>
      <article><Star /><div><span>Performance</span><strong>{employee.workStats.averagePerformance ?? '—'}</strong><small>{employee.reviews.length} formal reviews</small></div></article>
      <article><BriefcaseBusiness /><div><span>Site reporting</span><strong>{employee.workStats.reports}</strong><small>daily reports submitted</small></div></article>
    </section>

    <div className="employee-profile-grid">
      <section className="employee-panel attendance-history-panel">
        <div className="employee-section-title"><div><span>Attendance performance</span><h2>Employment trend</h2></div><TrendingUp size={20} /></div>
        <TrendBars points={employee.monthlyTrend} />
        <div className="employee-stat-strip">
          <span><b>{stats.rate}%</b>Attendance</span><span><b>{stats.absent}</b>Absent</span>
          <span><b>{stats.late}</b>Late</span><span><b>{stats.needsReview}</b>Need review</span>
        </div>
      </section>

      <section className="employee-panel personal-panel">
        <div className="employee-section-title"><div><span>Employee record</span><h2>Personal details</h2></div>
          {canManage ? <button className="icon-btn" type="button" title="Edit personal details" aria-label="Edit personal details"
            onClick={() => setEditing(true)}><PencilLine size={16} /></button> : <UserRound size={20} />}
        </div>
        <dl className="employee-details">
          <div><dt><CalendarDays size={14} />Joined</dt><dd>{employee.joinDate ? shortDate(employee.joinDate) : 'Not recorded'}</dd></div>
          <div><dt><Phone size={14} />Phone</dt><dd>{employee.phone || 'Not recorded'}</dd></div>
          <div><dt>Birth date</dt><dd>{employee.birthDate ? shortDate(employee.birthDate) : 'Not recorded'}</dd></div>
          <div><dt>NIC number</dt><dd>{employee.nicNumber || 'Not recorded'}</dd></div>
          <div><dt>Additional phone 1</dt><dd>{employee.additionalPhone1 || 'Not recorded'}</dd></div>
          <div><dt>Additional phone 2</dt><dd>{employee.additionalPhone2 || 'Not recorded'}</dd></div>
          <div><dt>Residential address</dt><dd>{employee.residentialAddress || 'Not recorded'}</dd></div>
          <div><dt>Permanent address</dt><dd>{employee.permanentAddress || 'Not recorded'}</dd></div>
          <div><dt><Mail size={14} />Email</dt><dd>{employee.email || 'Not recorded'}</dd></div>
          <div><dt><BriefcaseBusiness size={14} />Department</dt><dd>{employee.department || 'Not assigned'}</dd></div>
          <div><dt><UserRound size={14} />Employee type</dt><dd>{employee.workerType} employee</dd></div>
          {employee.payBasis !== undefined && <div><dt>Pay arrangement</dt><dd>{employee.payBasis} · {employee.payFrequency}</dd></div>}
          {employee.payrollCategory !== undefined && <div><dt>Overtime policy</dt><dd>{employee.payrollCategory}</dd></div>}
          {employee.basicSalary !== undefined && <div><dt>Monthly basic</dt><dd>{rupees(employee.basicSalary)}</dd></div>}
          {employee.weeklyRate !== undefined && Number(employee.weeklyRate) > 0 && <div><dt>Weekly rate</dt><dd>{rupees(employee.weeklyRate)}</dd></div>}
          {employee.dailyRate !== undefined && <div><dt>Daily rate</dt><dd>{rupees(employee.dailyRate)}</dd></div>}
          {employee.epfEligible !== undefined && <div><dt>Statutory eligibility</dt><dd>EPF {employee.epfEligible ? 'eligible' : 'not eligible'} · ETF {employee.etfEligible ? 'eligible' : 'not eligible'}</dd></div>}
        </dl>
        {employee.notes && <p className="employee-notes">{employee.notes}</p>}
        {editing && <PersonalDetailsForm employee={employee} departments={departments} companies={companies}
          close={() => setEditing(false)} reload={async () => { await reloadEmployee(); await reloadPeople?.(); }} />}
      </section>

      <section className="employee-panel performance-panel">
        <div className="employee-section-title"><div><span>Latest formal review</span><h2>{latestReview?.period || 'Performance'}</h2></div><Star size={20} /></div>
        <ReviewRadar review={latestReview} />
        {latestReview && <div className="review-copy"><p><b>Strengths</b>{latestReview.strengths || 'Not recorded'}</p><p><b>Development focus</b>{latestReview.improvements || 'Not recorded'}</p></div>}
      </section>

      <section className="employee-panel activity-panel">
        <div className="employee-section-title"><div><span>Work record</span><h2>Recent contribution</h2></div><Clock3 size={20} /></div>
        <div className="employee-activity">{activity.map((item, index) => <article key={`${item.kind}-${index}`}>
          <i className={item.kind.toLowerCase()} /><div><strong>{item.title}</strong><span>{item.meta}</span></div><time>{shortDate(item.date)}</time>
        </article>)}{!activity.length && <p className="empty-state">No tasks or reports are linked to this person yet.</p>}</div>
      </section>
    </div>

    <section className="employee-panel employee-wide-panel">
      <div className="employee-section-title"><div><span>Project history</span><h2>Assignments</h2></div><BriefcaseBusiness size={20} /></div>
      <Table columns={['Project', 'Role', 'Assigned', 'Tasks completed', 'Reports', 'Days on site']} template="minmax(180px,1.3fr) minmax(160px,1fr) 130px 130px 100px 110px" empty="No project work recorded.">
        {employee.projects.map((row, index) => <Row template="minmax(180px,1.3fr) minmax(160px,1fr) 130px 130px 100px 110px" key={index}>
          <strong>{row.project}</strong><span>{row.projectRole}{row.releasedAt ? <small>Released {shortDate(row.releasedAt)}</small> : null}</span>
          <span>{shortDate(row.assignedAt)}</span><span>{row.completedTasks}/{row.tasks}</span><span>{row.reports}</span><span>{row.attendanceDays}</span>
        </Row>)}
      </Table>
    </section>

    <section className="employee-panel employee-wide-panel">
      <div className="employee-section-title"><div><span>Delivery contribution</span><h2>Tasks and work completed</h2></div><ClipboardCheck size={20} /></div>
      <Table columns={['Task', 'Project', 'Status', 'Updated']} template="minmax(220px,1.5fr) minmax(180px,1fr) 130px 130px" empty="No tasks assigned to this employee.">
        {employee.tasks.map(task => <Row template="minmax(220px,1.5fr) minmax(180px,1fr) 130px 130px" key={task.id}>
          <strong>{task.title}</strong><span>{task.project}</span><Badge tone={slug(task.status)}>{task.status}</Badge><span>{shortDate(task.updatedAt)}</span>
        </Row>)}
      </Table>
      <Table title="Daily work reported" columns={['Date', 'Project', 'Work completed', 'Issues']} template="130px minmax(180px,1fr) minmax(240px,1.6fr) minmax(180px,1fr)" empty="No daily reports linked to this employee.">
        {employee.reports.map(report => <Row template="130px minmax(180px,1fr) minmax(240px,1.6fr) minmax(180px,1fr)" key={report.id}>
          <span>{shortDate(report.reportDate)}</span><span>{report.project}</span><span>{report.work || '—'}</span><span>{report.issue || '—'}</span>
        </Row>)}
      </Table>
    </section>

    <section className="employee-panel employee-wide-panel">
      <div className="employee-section-title"><div><span>Daily record</span><h2>Attendance history</h2></div><CalendarDays size={20} /></div>
      <Table columns={canCorrect ? ['Date', 'Site', 'In', 'Out', 'Status', 'Source', ''] : ['Date', 'Site', 'In', 'Out', 'Status', 'Source']}
        template={canCorrect ? '120px minmax(170px,1fr) 90px 90px 110px 100px 48px' : '120px minmax(170px,1fr) 90px 90px 110px 100px'} empty="No attendance recorded.">
        {employee.attendance.map(row => <Row template={canCorrect ? '120px minmax(170px,1fr) 90px 90px 110px 100px 48px' : '120px minmax(170px,1fr) 90px 90px 110px 100px'} key={row.id}>
          <span>{shortDate(row.workDate)}</span><span>{row.site}</span><span>{row.in || '—'}</span><span>{row.out || '—'}</span>
          <Badge tone={slug(row.state)}>{row.state}</Badge><span>{row.source}{row.correctionReason ? <small>Corrected: {row.correctionReason}</small> : null}</span>
          {canCorrect && <button className="icon-btn" type="button" title={`Edit attendance for ${shortDate(row.workDate)}`}
            aria-label={`Edit attendance for ${shortDate(row.workDate)}`} onClick={() => setCorrecting({ ...row, name: employee.name })}>
            <PencilLine size={15} />
          </button>}
        </Row>)}
      </Table>
      {correcting && <AttendanceCorrection record={correcting} projects={projects}
        close={() => setCorrecting(null)} reload={reloadEmployee} />}
    </section>

    <section className="employee-panel employee-wide-panel employee-documents">
      <Attachments ownerType="employee" ownerId={employee.id} title="Employee documents"
        canUpload={canManage} canDelete={canManage} withCategory withExpiry />
    </section>
  </div>;
}

function PersonalDetailsForm({ employee, departments, companies, close, reload }) {
  const number = value => Number(value || 0);
  const optionalNumber = value => value === '' ? null : Number(value);
  return <FormModal title={`Edit ${employee.name}`} close={close} label="Save employee details" wide onSubmit={async values => {
    await patch(`/employees/${employee.id}`, {
      ...personalDetails(values),
      code: values.code.trim(),
      name: values.name.trim(),
      departmentId: values.departmentId ? Number(values.departmentId) : undefined,
      designation: values.designation.trim(),
      workerType: values.workerType,
      phone: values.phone.trim(),
      email: values.email.trim(),
      joinDate: values.joinDate || null,
      status: values.status,
      notes: values.notes.trim(),
      payrollCompanyId: Number(values.payrollCompanyId),
      payBasis: values.payBasis,
      payFrequency: values.payFrequency,
      payrollCategory: values.payrollCategory,
      compensationEffectiveFrom: values.compensationEffectiveFrom || values.joinDate || undefined,
      basicSalary: number(values.basicSalary),
      weeklyRate: number(values.weeklyRate),
      dailyRate: number(values.dailyRate),
      overtimeRate: number(values.overtimeRate),
      customOfficeOtRate: optionalNumber(values.customOfficeOtRate),
      customSiteOtRate: optionalNumber(values.customSiteOtRate),
      customTravelOtRate: optionalNumber(values.customTravelOtRate),
      epfEligible: values.epfEligible === 'true',
      etfEligible: values.etfEligible === 'true'
    });
    await reload();
  }}>
    <Field name="code" label="Employee code" defaultValue={employee.code} />
    <Field name="name" label="Full name" defaultValue={employee.name} />
    <EmployeePersonalFields employee={employee} />
    <SelectField required={false} name="departmentId" label="Department" defaultValue={employee.departmentId}
      options={[["", "Not recorded"], ...departments.map(department => [department.id, department.name])]} />
    <Field required={false} name="designation" label="Designation / trade" defaultValue={employee.designation} />
    <SelectField required={false} name="workerType" label="Employee type" defaultValue={employee.workerType}
      options={[["Office", "Office employee"], ["Site", "Site worker"]]} />
    <SelectField required={false} name="status" label="Employment status" defaultValue={employee.status}
      options={['Active', 'On leave', 'Suspended', 'Left']} />
    <Field name="phone" label="Phone" defaultValue={employee.phone || ''} required={false} />
    <Field name="email" label="Email" type="email" defaultValue={employee.email || ''} required={false} />
    <Field required={false} name="joinDate" label="Join date" type="date" defaultValue={inputDate(employee.joinDate)} />
    <SelectField required={false} name="payrollCompanyId" label="Salary paid by" defaultValue={employee.payrollCompanyId || 1}
      options={companies.map(company => [company.id, company.name])} />
    <SelectField required={false} name="payBasis" label="Pay basis" defaultValue={employee.payBasis}
      options={['Monthly salary', 'Weekly rate', 'Daily rate']} />
    <SelectField required={false} name="payFrequency" label="Payment frequency" defaultValue={employee.payFrequency}
      options={['Daily', 'Weekly', 'Monthly']} />
    <SelectField required={false} name="payrollCategory" label="Payroll category" defaultValue={employee.payrollCategory}
      options={['Office employee', 'Site labourer', 'Driver', 'Supervisor', 'Custom']} />
    <Field required={false} name="compensationEffectiveFrom" label="Compensation effective from" type="date"
      defaultValue={inputDate(employee.compensationEffectiveFrom || employee.joinDate)} />
    <Field required={false} name="basicSalary" label="Basic salary (LKR)" type="number" min="0" defaultValue={employee.basicSalary || 0} />
    <Field required={false} name="weeklyRate" label="Weekly rate (LKR)" type="number" min="0" defaultValue={employee.weeklyRate || 0} />
    <Field required={false} name="dailyRate" label="Daily rate (LKR)" type="number" min="0" defaultValue={employee.dailyRate || 0} />
    <Field name="overtimeRate" label="Legacy/custom OT rate (LKR/h)" type="number" min="0" defaultValue={employee.overtimeRate || 0} required={false} />
    <Field name="customOfficeOtRate" label="Office OT override (LKR/h)" type="number" min="0"
      defaultValue={employee.customOfficeOtRate ?? ''} required={false} />
    <Field name="customSiteOtRate" label="Site OT override (LKR/h)" type="number" min="0"
      defaultValue={employee.customSiteOtRate ?? ''} required={false} />
    <Field name="customTravelOtRate" label="Travel OT override (LKR/h)" type="number" min="0"
      defaultValue={employee.customTravelOtRate ?? ''} required={false} />
    <SelectField required={false} name="epfEligible" label="EPF eligible" defaultValue={String(Boolean(employee.epfEligible))}
      options={[[false, 'No'], [true, 'Yes']]} />
    <SelectField required={false} name="etfEligible" label="ETF eligible" defaultValue={String(Boolean(employee.etfEligible))}
      options={[[false, 'No'], [true, 'Yes']]} />
    <TextArea name="notes" label="HR notes" defaultValue={employee.notes || ''} required={false} rows={3} />
  </FormModal>;
}
