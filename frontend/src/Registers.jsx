import React, { useEffect, useState } from 'react';
import { api } from './api.js';
import { EmptyState, Row, Table } from './ui.jsx';

/*
 * The two registers an HR office is asked for by name: the muster roll for a month, and a
 * year's leave per person against entitlement. Neither holds anything the attendance and
 * leave tables did not already hold — what was missing was the shape.
 */

const monthValue = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

const MARK_TITLES = { P: 'On site', L: 'Late', V: 'On leave', A: 'Absent' };

/**
 * The muster roll.
 *
 * A month is up to 31 columns wide, which no phone will ever show at once, so the grid
 * scrolls sideways inside the panel with the name column pinned. That is the same shape a
 * paper roll has, and the reason it works.
 */
export function AttendanceRegister() {
  const [month, setMonth] = useState(monthValue());
  const [register, setRegister] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    api(`/hr/attendance-register?month=${month}`).then(setRegister)
      .catch(failure => { setRegister(null); setError(failure.message); });
  }, [month]);

  const days = register ? Array.from({ length: register.period.days }, (_, index) => index + 1) : [];

  return <>
    <div className="toolbar">
      <label className="inline-field">Month
        <input type="month" value={month} onChange={event => setMonth(event.target.value)} />
      </label>
      <div className="register-legend">
        {Object.entries(MARK_TITLES).map(([mark, label]) =>
          <span key={mark}><b className={`mark mark-${mark}`}>{mark}</b>{label}</span>)}
      </div>
    </div>

    {error && <p className="form-error">{error}</p>}

    {register && (register.rows.length
      ? <section className="table-panel">
        <div className="table-tools"><h2>Attendance register</h2></div>
        <div className="register-scroll">
          <table className="register">
            <thead>
              <tr>
                <th className="register-name">Employee</th>
                {days.map(day => <th key={day}>{day}</th>)}
                <th>Present</th><th>Late</th><th>Leave</th><th>Absent</th>
              </tr>
            </thead>
            <tbody>
              {register.rows.map(person => <tr key={person.name}>
                <th className="register-name">{person.name}</th>
                {days.map(day => {
                  const entry = person.days[day];
                  return <td key={day}>
                    {entry
                      ? <b className={`mark mark-${entry.mark}`}
                        title={`${MARK_TITLES[entry.mark]}${entry.project ? ` — ${entry.project}` : ''}`}>
                        {entry.mark}
                      </b>
                      : <span className="mark mark-none" title="Nothing recorded">·</span>}
                  </td>;
                })}
                <td><b>{person.present}</b></td>
                <td>{person.late || '—'}</td>
                <td>{person.onLeave || '—'}</td>
                <td className={person.absent ? 'overdue' : ''}>{person.absent || '—'}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </section>
      : <EmptyState>No attendance was recorded in that month.</EmptyState>)}
  </>;
}

const LEAVE_COLUMNS = ['Employee', 'Department', 'Annual taken', 'Annual left',
  'Casual taken', 'Casual left', 'Awaiting approval', 'Total taken'];
const LEAVE_TEMPLATE = 'minmax(170px,1.3fr) minmax(140px,1fr) 120px 120px 120px 120px 150px 120px';

/**
 * The leave register.
 *
 * Days awaiting approval are counted apart from days taken. Somebody with two days left and
 * three still pending is a conversation to have before the approval rather than after it,
 * and folding the two together hides exactly that case.
 */
export function LeaveRegister() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [register, setRegister] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    api(`/hr/leave-register?year=${year}`).then(setRegister)
      .catch(failure => { setRegister(null); setError(failure.message); });
  }, [year]);

  const years = [0, 1, 2].map(back => new Date().getFullYear() - back);

  return <>
    <div className="toolbar">
      <label className="inline-field">Year
        <select value={year} onChange={event => setYear(Number(event.target.value))}>
          {years.map(one => <option key={one} value={one}>{one}</option>)}
        </select>
      </label>
    </div>

    {error && <p className="form-error">{error}</p>}

    <Table columns={LEAVE_COLUMNS} template={LEAVE_TEMPLATE} title={`Leave register ${year}`}
      empty="No employees on the register.">
      {(register?.rows || []).map(person => <Row template={LEAVE_TEMPLATE} key={person.id}>
        <div><strong>{person.name}</strong><small>{person.designation || person.code}</small></div>
        <span>{person.department || '—'}</span>
        <span>{person.annualTaken}</span>
        <strong className={person.annualLeft <= 0 ? 'overdue' : ''}>{person.annualLeft}</strong>
        <span>{person.casualTaken}</span>
        <strong className={person.casualLeft <= 0 ? 'overdue' : ''}>{person.casualLeft}</strong>
        <span className={person.pending > 0 ? 'watch-text' : ''}>{person.pending || '—'}</span>
        <span>{person.totalTaken}</span>
      </Row>)}
    </Table>
  </>;
}
