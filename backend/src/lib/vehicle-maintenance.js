import { today } from '../db.js';

/** Editable business defaults supplied by GKUC, rather than inferred from a vehicle name. */
export const maintenancePresets = profile => [
  { name: 'Engine oil change', intervalKm: profile === 'European' ? 15000 : 5000 },
  { name: 'Brake oil replacement', intervalKm: 20000 }
];

export function maintenanceDue(schedule, odometer, stamp = today()) {
  if (schedule.intervalMonths != null) {
    const [year, month, day] = schedule.lastCompletedDate.split('-').map(Number);
    const next = new Date(Date.UTC(year, month - 1 + Number(schedule.intervalMonths), 1));
    const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
    next.setUTCDate(Math.min(day, lastDay));
    const nextDate = next.toISOString().slice(0, 10);
    const daysRemaining = (next.getTime() - Date.parse(stamp + 'T00:00:00Z')) / 86400000;
    return { ...schedule, nextDate, daysRemaining, overdue: daysRemaining <= 0,
      dueSoon: daysRemaining <= Number(schedule.remindBeforeDays) };
  }
  const nextOdometer = Number(schedule.lastOdometer) + Number(schedule.intervalKm);
  const kmRemaining = nextOdometer - Number(odometer);
  return { ...schedule, nextOdometer, kmRemaining, overdue: kmRemaining <= 0,
    dueSoon: kmRemaining <= Number(schedule.remindBeforeKm) };
}

export function maintenanceReminder(schedule, stamp) {
  const due = maintenanceDue(schedule, schedule.odometer, stamp);
  if (!schedule.active || schedule.vehicleStatus === 'Inactive' || !due.dueSoon) return null;
  const byDate = due.nextDate != null;
  const remaining = byDate ? due.daysRemaining : due.kmRemaining;
  const unit = byDate ? (Math.abs(remaining) === 1 ? 'day' : 'days') : 'km';
  const distance = Math.abs(remaining).toLocaleString('en-LK');
  const target = byDate ? due.nextDate : `${due.nextOdometer.toLocaleString('en-LK')} km`;
  return {
    key: `maintenance:${schedule.id}:${due.nextDate ?? due.nextOdometer}:${stamp}`,
    audience: 'transport.manage', severity: due.overdue ? 'Critical' : 'Warning',
    title: `${schedule.name} ${due.overdue ? 'due' : 'due soon'} — ${schedule.registration}`,
    message: `${schedule.vehicle}: ${schedule.name} ${byDate ? 'on' : 'at'} ${target}; `
      + (remaining < 0 ? `${distance} ${unit} overdue.` : remaining === 0 ? 'due now.' : `${distance} ${unit} remaining.`),
    referenceType: 'fleet', referenceId: schedule.vehicleId
  };
}
