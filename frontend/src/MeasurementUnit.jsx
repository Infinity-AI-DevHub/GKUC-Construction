import React, { useId } from 'react';

// Suggestions, not an enum: retain existing BOQ units and custom measurements.
const UNITS = ['Litres', 'Barrels', 'kg', 'Tonnes', 'm', 'm²', 'm³', 'Nos', 'sum'];

export default function MeasurementUnit({ value, onChange, ...props }) {
  const id = useId();
  return <>
    <input {...props} value={value} onChange={onChange} list={id} maxLength={30} placeholder="Unit" />
    <datalist id={id}>{UNITS.map(unit => <option key={unit} value={unit} />)}</datalist>
  </>;
}
