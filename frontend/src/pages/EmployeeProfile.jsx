import React, { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BriefcaseBusiness, CalendarDays, CheckCircle2, ClipboardCheck,
  Clock3, Mail, MapPin, Phone, ShieldCheck, Star, TrendingUp, UserRound } from 'lucide-react';
import { api, rupees, shortDate, slug } from '../api.js';
import { Avatar, Badge, Row, Table } from '../ui.jsx';
import Attachments from '../Attachments.jsx';

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

export default function EmployeeProfile({ employeeId, close, canManage }) {
  const [employee, setEmployee] = useState(null);
  const [error, setError] = useState('');
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
            {employee.biometricId && <span><ShieldCheck size={13} />Biometric #{employee.biometricId}</span>}
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
        <div className="employee-section-title"><div><span>Employee record</span><h2>Personal details</h2></div><UserRound size={20} /></div>
        <dl className="employee-details">
          <div><dt><CalendarDays size={14} />Joined</dt><dd>{shortDate(employee.joinDate)}</dd></div>
          <div><dt><Phone size={14} />Phone</dt><dd>{employee.phone || 'Not recorded'}</dd></div>
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
      <Table columns={['Project', 'Role', 'Assigned', 'Released']} template="minmax(180px,1.3fr) minmax(160px,1fr) 130px 130px" empty="No project assignment recorded.">
        {employee.projects.map((row, index) => <Row template="minmax(180px,1.3fr) minmax(160px,1fr) 130px 130px" key={index}>
          <strong>{row.project}</strong><span>{row.projectRole}</span><span>{shortDate(row.assignedAt)}</span><span>{row.releasedAt ? shortDate(row.releasedAt) : 'Current'}</span>
        </Row>)}
      </Table>
    </section>

    <section className="employee-panel employee-wide-panel">
      <div className="employee-section-title"><div><span>Daily record</span><h2>Attendance history</h2></div><CalendarDays size={20} /></div>
      <Table columns={['Date', 'Site', 'In', 'Out', 'Status', 'Source']} template="120px minmax(170px,1fr) 90px 90px 110px 100px" empty="No attendance recorded.">
        {employee.attendance.map(row => <Row template="120px minmax(170px,1fr) 90px 90px 110px 100px" key={row.id}>
          <span>{shortDate(row.workDate)}</span><span>{row.site}</span><span>{row.in || '—'}</span><span>{row.out || '—'}</span>
          <Badge tone={slug(row.state)}>{row.state}</Badge><span>{row.source}</span>
        </Row>)}
      </Table>
    </section>

    <section className="employee-panel employee-wide-panel employee-documents">
      <Attachments ownerType="employee" ownerId={employee.id} title="Employee documents"
        canUpload={canManage} canDelete={canManage} withCategory withExpiry />
    </section>
  </div>;
}
