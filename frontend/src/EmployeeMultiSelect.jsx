import React, { useState } from 'react';

export default function EmployeeMultiSelect({ employees, selected, onChange, label = 'Assigned to' }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const available = employees.filter(employee => ['Active', 'On leave'].includes(employee.status) || selected.includes(Number(employee.id)));
  const matches = available.filter(employee => `${employee.name} ${employee.designation || ''} ${employee.code || ''}`.toLowerCase().includes(search.toLowerCase()));
  const names = selected.map(id => employees.find(employee => Number(employee.id) === id)?.name).filter(Boolean);
  return <div className="project-team-picker">
    <label>{label} <span>*</span></label>
    <button type="button" className="project-team-trigger" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {names.length ? `${names.length} employee${names.length === 1 ? '' : 's'} selected: ${names.join(', ')}` : 'Choose employees…'}
    </button>
    {open && <div className="project-team-options">
      <input aria-label="Search task assignees" placeholder="Search by name or role" value={search} onChange={event => setSearch(event.target.value)} />
      <div className="project-team-option-list">
        {matches.map(employee => <label key={employee.id}>
          <input type="checkbox" checked={selected.includes(Number(employee.id))}
            onChange={event => onChange(event.target.checked
              ? [...selected, Number(employee.id)] : selected.filter(id => id !== Number(employee.id)))} />
          <span><strong>{employee.name}</strong><small>{employee.designation}</small></span>
        </label>)}
        {!matches.length && <p>No employees match this search.</p>}
      </div>
    </div>}
    {!available.length && <p>No active employees are available.</p>}
  </div>;
}
