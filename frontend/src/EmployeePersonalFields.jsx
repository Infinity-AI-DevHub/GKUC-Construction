import React from 'react';
import { Field, TextArea } from './ui.jsx';

export const personalDetails = values => ({ birthDate: values.birthDate || null,
  nicNumber: values.nicNumber || '', additionalPhone1: values.additionalPhone1 || '',
  additionalPhone2: values.additionalPhone2 || '', residentialAddress: values.residentialAddress || '',
  permanentAddress: values.permanentAddress || '' });

export default function EmployeePersonalFields({ employee = {} }) {
  return <>
    <Field name="birthDate" label="Birth date" type="date" required={false} defaultValue={employee.birthDate?.slice(0,10) || ''} />
    <Field name="nicNumber" label="NIC number" required={false} defaultValue={employee.nicNumber || ''} />
    <Field name="additionalPhone1" label="Additional phone 1" type="tel" required={false} defaultValue={employee.additionalPhone1 || ''} />
    <Field name="additionalPhone2" label="Additional phone 2" type="tel" required={false} defaultValue={employee.additionalPhone2 || ''} />
    <TextArea name="residentialAddress" label="Residential address" required={false} defaultValue={employee.residentialAddress || ''} />
    <TextArea name="permanentAddress" label="Permanent address" required={false} defaultValue={employee.permanentAddress || ''} />
  </>;
}
