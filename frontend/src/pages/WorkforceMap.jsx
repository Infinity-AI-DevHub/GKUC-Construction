import React, { useEffect, useMemo, useState } from 'react';
import { Building2, CalendarDays, Coffee, MapPin, Search, UsersRound } from 'lucide-react';
import { api, patch, shortDate, slug, todayInput } from '../api.js';
import { Avatar, Badge, Summary } from '../ui.jsx';

const FILTERS = [['all', 'Everyone'], ['free', 'Free'], ['site', 'At sites'], ['office', 'At office'], ['leave', 'On leave'], ['not-working', 'Not working']];

export default function WorkforceMap({ canManage }) {
  const [date, setDate] = useState(todayInput());
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const load = () => { setError(''); api(`/employees/availability?date=${date}`).then(setData).catch(failure => setError(failure.message)); };
  useEffect(load, [date]);

  const rows = useMemo(() => (data?.people || []).filter(person => {
    const inGroup = filter === 'all' || person.group === filter;
    const words = `${person.name} ${person.code} ${person.department || ''} ${person.designation} ${person.location}`.toLowerCase();
    return inGroup && words.includes(search.trim().toLowerCase());
  }), [data, filter, search]);

  const changeType = async (person, workerType) => {
    await patch(`/employees/${person.id}`, { workerType });
    await load();
  };

  if (error) return <p className="form-error">{error}</p>;
  return <div className="workforce-map">
    <section className="workforce-command">
      <div><span>Daily deployment</span><h2>Where is everyone?</h2>
        <p>Attendance, approved leave and active project assignments combined for one reliable workforce picture.</p></div>
      <label><CalendarDays size={16} />View date<input type="date" value={date} onChange={event => setDate(event.target.value)} /></label>
    </section>

    <div className="attendance-summary workforce-summary">
      <Summary label="At sites" value={data?.summary.site || 0} icon={MapPin} />
      <Summary label="At office" value={data?.summary.office || 0} icon={Building2} />
      <Summary label="Free to assign" value={data?.summary.free || 0} icon={Coffee} />
      <Summary label="On leave" value={data?.summary.leave || 0} icon={CalendarDays} />
    </div>

    <div className="workforce-layout">
      <section className="workforce-roster">
        <div className="workforce-tools">
          <div className="segments">{FILTERS.map(([key, label]) => <button className={filter === key ? 'active' : ''} onClick={() => setFilter(key)} key={key}>{label}</button>)}</div>
          <label><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find an employee or site" /></label>
        </div>
        <div className="workforce-list">
          {rows.map(person => <article className={`workforce-person ${person.group}`} key={person.id}>
            <Avatar name={person.name} />
            <div className="workforce-person-name"><strong>{person.name}</strong><span>{person.designation} · {person.department || 'No department'}</span></div>
            <div className="workforce-location"><MapPin size={15} /><div><strong>{person.location}</strong><span>{person.status}</span></div></div>
            <Badge tone={slug(person.status)}>{person.status}</Badge>
            {canManage ? <select aria-label={`Employee type for ${person.name}`} value={person.workerType} onChange={event => changeType(person, event.target.value)}>
              <option value="Office">Office employee</option><option value="Site">Site worker</option>
            </select> : <span className="worker-type">{person.workerType} employee</span>}
          </article>)}
          {!rows.length && <div className="workforce-empty"><UsersRound size={32} /><strong>No employees match this view</strong><span>Try another date or filter.</span></div>}
        </div>
      </section>

      <aside className="workforce-sites">
        <div><span>Site distribution</span><h2>{shortDate(date)}</h2></div>
        {(data?.sites || []).map((site, index) => <article key={site.name}>
          <div><MapPin size={15} /><strong>{site.name}</strong></div><b>{site.people}</b>
          <i><span style={{ width: `${Math.max(10, site.people / Math.max(1, data.summary.site) * 100)}%` }} /></i>
        </article>)}
        {!data?.sites?.length && <p>No site crews are scheduled for this date.</p>}
        <div className="availability-callout"><Coffee size={20} /><div><strong>{data?.summary.free || 0} site workers available</strong><span>Not assigned to a site and not recorded on leave.</span></div></div>
      </aside>
    </div>
  </div>;
}
