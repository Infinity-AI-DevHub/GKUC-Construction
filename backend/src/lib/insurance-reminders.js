export function insuranceReminderDate(expiry, reminder) {
  if (reminder.unit === 'Date') return reminder.date;
  const date = new Date(`${expiry}T00:00:00Z`);
  if (reminder.unit === 'Months') {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() - reminder.value);
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(day, last));
  } else date.setUTCDate(date.getUTCDate() - reminder.value * (reminder.unit === 'Weeks' ? 7 : 1));
  return date.toISOString().slice(0,10);
}
