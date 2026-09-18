import React, { useState } from 'react';
import { inputDate, patch } from '../api.js';
import { Field, FormModal, SelectField, TextArea } from '../ui.jsx';

/** The same audited correction form is used from the daily view and employment history. */
export default function AttendanceCorrection({ record, projects, close, reload }) {
  const [workLocation, setWorkLocation] = useState(record.workLocation || (record.projectId ? 'Site' : 'Office'));
  return <FormModal title={`Correct attendance — ${record.name || record.employeeName}`} close={close}
    label="Save correction" onSubmit={async values => {
      if (workLocation === 'Site' && !values.projectId) throw new Error('Choose the project site for this attendance day.');
      await patch(`/attendance/${record.id}`, {
        state: values.state,
        checkIn: values.checkIn || null,
        checkOut: values.checkOut || null,
        workDate: values.workDate,
        workLocation,
        projectId: workLocation === 'Site' ? Number(values.projectId) : null,
        reason: values.reason.trim()
      });
      await reload();
    }}>
    <SelectField name="state" label="Status" options={['On site', 'Late', 'Checked out', 'Absent', 'On leave', 'Business trip']}
      defaultValue={record.state} />
    <Field name="workDate" label="Work date" type="date" defaultValue={inputDate(record.workDate)} />
    <label>Work location<select name="workLocation" value={workLocation} onChange={event => setWorkLocation(event.target.value)}>
      <option value="Site">Project site</option><option value="Office">Head office</option><option value="Not working">Not working (absent or leave)</option>
    </select></label>
    {workLocation === 'Site' && <SelectField name="projectId" label="Project / site"
      options={[["", 'Choose a site…'], ...projects.map(project => [project.id, project.name])]}
      defaultValue={record.projectId || ''} />}
    <Field name="checkIn" label="Check in" type="time" step="1" required={false} defaultValue={record.in || ''} />
    <Field name="checkOut" label="Check out" type="time" step="1" required={false} defaultValue={record.out || ''} />
    <TextArea name="reason" label="Reason for the correction" placeholder="Why is this record changing? This is kept in the audit history." />
    <p className="form-note wide">This updates attendance history. If a salary run for this date has already been prepared or approved, ask Payroll to review that run separately.</p>
  </FormModal>;
}
