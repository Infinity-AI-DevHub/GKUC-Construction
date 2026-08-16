import React from 'react';
import { AlertTriangle, Boxes, CheckCircle2, ChevronRight, FileText, Truck } from 'lucide-react';
import { Avatar, Badge, PanelTitle } from '../ui.jsx';
import { daysUntil, money } from '../api.js';

/**
 * PID 2.1 — the state of the business at a glance, so managers stop chasing
 * status updates across departments.
 */
export default function Dashboard({ data, go, user, can }) {
  const openTasks = data.tasks.filter(task => task.status !== 'Completed' && task.status !== 'Approved');
  const present = data.attendance.filter(row => row.state === 'On site' || row.state === 'Late').length;
  const lowStock = data.materials.filter(material => material.state !== 'Available').length;
  const renewals = data.fleet.filter(vehicle => daysUntil(vehicle.due_date) <= 30).length;
  const spotlight = data.projects[0];
  const supervisor = data.reports[0]?.supervisor || spotlight?.manager || user.name;
  const portfolio = data.projects.length
    ? Math.round(data.projects.reduce((sum, project) => sum + project.progress, 0) / data.projects.length)
    : 0;
  const board = data.dashboard;
  /* The chart shows real workforce attendance for the last seven days. */
  const peak = Math.max(1, ...board.weekly.map(day => day.workforce));
  const alerts = data.notifications.filter(item => item.status !== 'Read').slice(0, 3);

  return <div className="reference-dashboard">
    <div className="reference-welcome">
      <div>
        <p>{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <h1>Welcome in, {user.name.split(' ')[0]}</h1>
      </div>
      <div className="welcome-counters">
        <span><b>{present}</b>On site</span>
        <span><b>{openTasks.length}</b>Open tasks</span>
        <span><b>{board.delayed.length}</b>Delayed</span>
        <span><b>{data.projects.length}</b>Projects</span>
      </div>
    </div>

    <div className="project-pulse">
      {data.projects.slice(0, 3).map(project => (
        <span key={project.id}><small>{project.name.split(' ')[0]}</small><b>{project.progress}%</b></span>
      ))}
      <span className="pulse-output"><small>Portfolio output</small><b>{portfolio}%</b></span>
      {/* Money is only shown to those allowed it — the figures arrive empty otherwise, and
          a zero here reads as "nothing came in" rather than "you cannot see this". */}
      {can.money && <>
        <span className="pulse-output"><small>Income received</small><b>{money(board.revenue)}</b></span>
        <span className="pulse-output"><small>Cost recorded</small><b>{money(board.spend)}</b></span>
      </>}
    </div>

    <div className="reference-grid">
      <section className="site-spotlight">
        <div>
          <Badge tone={spotlight?.health === 'On track' ? 'on-track' : spotlight?.health === 'At risk' ? 'at-risk' : 'watch'}>Live site</Badge>
          <h2>{spotlight?.name}</h2>
          <p>{spotlight?.stage} · {spotlight?.site}</p>
        </div>
        <span><Avatar name={supervisor} /><b>{supervisor}</b><small>Site supervisor</small></span>
      </section>

      <section className="reference-card progress-card">
        <PanelTitle title="Weekly progress" action="Projects" onClick={() => go('Projects')} />
        <div className="progress-number">
          <strong>{spotlight?.progress || 0}%</strong>
          <span>{board.weekly.at(-1)?.workforce || 0}<small>on site today</small></span>
        </div>
        <div className="bar-chart">
          {board.weekly.map(day => (
            <span key={day.day} title={`${day.workforce} on site · ${day.reports} report(s)`}>
              <i style={{ height: `${Math.max(4, (day.workforce / peak) * 100)}%` }} />
              <small>{day.label[0]}</small>
            </span>
          ))}
        </div>
      </section>

      <section className="reference-card attendance-card">
        <PanelTitle title="Site attendance" action="People" onClick={() => go('People')} />
        <div className="attendance-ring" style={{ '--ring': `${Math.min(100, (present / Math.max(1, data.attendance.length)) * 100)}%` }}>
          <div><strong>{present}</strong><span>on site</span></div>
        </div>
        <div className="attendance-legend"><span><i />Present</span><span><i />Late</span></div>
      </section>

      <section className="priority-board">
        <div className="priority-title">
          <div><span>Priority work</span><strong>{openTasks.length}/{data.tasks.length}</strong></div>
          <button onClick={() => go('Tasks')}><ChevronRight size={17} /></button>
        </div>
        {data.tasks.slice(0, 5).map((task, index) => (
          <button className="priority-item" key={task.id} onClick={() => go('Tasks')}>
            <span>{index + 1}</span>
            <div><strong>{task.title}</strong><small>{task.assignee} · {task.due}</small></div>
            <CheckCircle2 size={16} />
          </button>
        ))}
      </section>

      <section className="reference-card quick-control">
        <h2>Operations</h2>
        {/* The card sits in a fixed-height grid row, so the list scrolls rather than clipping. */}
        <div className="quick-control-list">
          <button onClick={() => go('Materials')}><Boxes size={17} /><span>Low-stock materials</span><b>{lowStock}</b><ChevronRight size={15} /></button>
          <button onClick={() => go('Fleet')}><Truck size={17} /><span>Fleet renewals</span><b>{renewals}</b><ChevronRight size={15} /></button>
          <button onClick={() => go('Daily reports')}><FileText size={17} /><span>Daily reports</span><b>{data.reports.length}</b><ChevronRight size={15} /></button>
          <button onClick={() => go('Projects')}><AlertTriangle size={17} /><span>Delayed projects</span><b>{board.delayed.length}</b><ChevronRight size={15} /></button>
        </div>
      </section>

      <section className="reference-card activity-timeline">
        <div className="timeline-title">
          <span>{new Date().toLocaleDateString('en-GB', { weekday: 'long' })}</span>
          <h2>Needs attention</h2>
          <span>{new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}</span>
        </div>
        <div className="timeline-grid">
          <div className="time-labels">{alerts.map(alert => <span key={alert.id}>{alert.severity}</span>)}</div>
          <div className="timeline-events">
            {alerts.map((alert, index) => (
              <i className={`event ${['concrete', 'inspection', 'delivery'][index]}`} key={alert.id}
                style={{ top: `${8 + index * 52}px`, left: '4%', width: '92%' }}>
                <b>{alert.title}</b><small>{alert.message}</small>
              </i>
            ))}
            {!alerts.length && <i className="event concrete" style={{ top: '8px', left: '4%', width: '92%' }}>
              <b>Nothing needs attention</b><small>No open alerts across projects, stores or fleet</small>
            </i>}
          </div>
        </div>
      </section>
    </div>
  </div>;
}
