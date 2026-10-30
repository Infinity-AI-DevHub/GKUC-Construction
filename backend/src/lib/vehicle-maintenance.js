/** Editable business defaults supplied by GKUC, rather than inferred from a vehicle name. */
export const maintenancePresets = profile => [
  { name: 'Engine oil change', intervalKm: profile === 'European' ? 15000 : 5000 },
  { name: 'Brake oil replacement', intervalKm: 20000 }
];

export function maintenanceDue(schedule, odometer) {
  const nextOdometer = Number(schedule.lastOdometer) + Number(schedule.intervalKm);
  const kmRemaining = nextOdometer - Number(odometer);
  return { ...schedule, nextOdometer, kmRemaining, overdue: kmRemaining <= 0,
    dueSoon: kmRemaining <= Number(schedule.remindBeforeKm) };
}

export function maintenanceReminder(schedule, stamp) {
  const due = maintenanceDue(schedule, schedule.odometer);
  if (!schedule.active || schedule.vehicleStatus === 'Inactive' || !due.dueSoon) return null;
  return {
    key: `maintenance:${schedule.id}:${due.nextOdometer}:${stamp}`,
    audience: 'transport.manage', severity: due.overdue ? 'Critical' : 'Warning',
    title: `${schedule.name} ${due.overdue ? 'due' : 'due soon'} — ${schedule.registration}`,
    message: `${schedule.vehicle}: ${schedule.name} at ${due.nextOdometer.toLocaleString('en-LK')} km; `
      + (due.kmRemaining < 0 ? `${Math.abs(due.kmRemaining).toLocaleString('en-LK')} km overdue.` : due.kmRemaining === 0 ? 'due now.' : `${due.kmRemaining.toLocaleString('en-LK')} km remaining.`),
    referenceType: 'fleet', referenceId: schedule.vehicleId
  };
}
