export const BIRTHDAY_REMINDER_DAYS = [7, 5, 3, 1, 0];

// Date-only arithmetic avoids server timezone and daylight-saving differences.
// February 29 birthdays are observed on February 28 in non-leap years.
export function upcomingBirthday(birthDate, stamp) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(birthDate))) return null;
  const current = new Date(`${stamp}T00:00:00Z`);
  const [, month, day] = birthDate.split('-').map(Number);
  const occurrence = year => {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return new Date(Date.UTC(year, month - 1, Math.min(day, lastDay)));
  };
  let next = occurrence(current.getUTCFullYear());
  if (next < current) next = occurrence(current.getUTCFullYear() + 1);
  return {date: next.toISOString().slice(0, 10), remaining: Math.round((next - current) / 86400000)};
}
