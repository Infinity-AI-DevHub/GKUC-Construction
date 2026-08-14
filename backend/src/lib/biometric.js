/**
 * PID v3 §1.2 — "The existing biometric attendance system continues to be used exactly as
 * it is today. Attendance data already exported to a pendrive is simply uploaded into the
 * system periodically."
 *
 * Biometric devices export in whatever shape their vendor chose: some write one row per
 * punch, some write a row per day with separate in and out columns, and the delimiter,
 * date format and column names all vary. Rather than demanding one format, this reads the
 * header, works out which columns mean what, and groups punches per person per day. If a
 * row cannot be understood it is reported rather than silently dropped — an attendance
 * record that quietly vanishes is worse than one that is flagged.
 */

const DELIMITERS = ['\t', ',', ';', '|'];

/** Column aliases seen across common device exports (ZKTeco, eSSL, Hikvision, Suprema). */
const FIELDS = {
  code: ['employeeid', 'empid', 'employeecode', 'userid', 'usrid', 'acno', 'ac-no', 'enrollno', 'enrollmentno', 'badgenumber', 'id', 'pin'],
  name: ['name', 'employeename', 'username', 'empname', 'person'],
  date: ['date', 'attdate', 'punchdate', 'workdate', 'day'],
  time: ['time', 'punchtime', 'atttime', 'clock'],
  datetime: ['datetime', 'punch', 'timestamp', 'attendancedatetime', 'logdate', 'recordtime', 'checktime', 'date/time'],
  checkIn: ['in', 'checkin', 'timein', 'intime', 'firstin', 'clockin'],
  checkOut: ['out', 'checkout', 'timeout', 'outtime', 'lastout', 'clockout'],
  status: ['status', 'state', 'inout', 'punchstate', 'type']
};

const normalise = value => String(value || '').toLowerCase().replace(/[^a-z0-9/]/g, '');

const detectDelimiter = line => {
  let best = ',';
  let bestCount = 0;
  for (const delimiter of DELIMITERS) {
    const count = line.split(delimiter).length;
    if (count > bestCount) { bestCount = count; best = delimiter; }
  }
  return bestCount > 1 ? best : null;
};

const splitRow = (line, delimiter) => line.split(delimiter)
  .map(cell => cell.trim().replace(/^"(.*)"$/, '$1').trim());

/** Maps each column index to the meaning we recognise, if any. */
function mapColumns(header) {
  const mapping = {};
  header.forEach((cell, index) => {
    const key = normalise(cell);
    for (const [field, aliases] of Object.entries(FIELDS)) {
      if (aliases.includes(key) && mapping[field] === undefined) mapping[field] = index;
    }
  });
  return mapping;
}

/** Accepts the date shapes devices actually emit, without guessing between them wrongly. */
export function parseDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  let match = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) return `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  /* Day-first is the convention in Sri Lanka; a value above 12 in the first position
     confirms it, and below that the two are indistinguishable so day-first is assumed. */
  match = text.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (match) {
    const [, first, second, yearPart] = match;
    const year = yearPart.length === 2 ? `20${yearPart}` : yearPart;
    return `${year}-${second.padStart(2, '0')}-${first.padStart(2, '0')}`;
  }
  return null;
}

export function parseTime(value) {
  const text = String(value || '').trim();
  const match = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const meridiem = match[4]?.toLowerCase();
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${match[2]}:${match[3] || '00'}`;
}

/**
 * Reads an export into one record per person per day. Multiple punches collapse to the
 * earliest as the arrival and the latest as the departure, which is how a day is actually
 * read off a device that logs every swipe.
 */
export function parseBiometricExport(text) {
  const lines = String(text).split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], problems: ['The file is empty'], columns: {} };

  const delimiter = detectDelimiter(lines[0]);
  if (!delimiter) return { rows: [], problems: ['Could not detect the column separator — expected tab, comma, semicolon or pipe'], columns: {} };

  const header = splitRow(lines[0], delimiter);
  const columns = mapColumns(header);
  const problems = [];

  const hasDay = columns.date !== undefined || columns.datetime !== undefined;
  if (!hasDay) problems.push('No date column found. Expected one of: Date, DateTime, Punch, LogDate, CheckTime');
  if (columns.code === undefined && columns.name === undefined) {
    problems.push('No employee column found. Expected one of: EmployeeID, UserID, AC-No, Name');
  }
  if (problems.length) return { rows: [], problems, columns: header };

  const days = new Map();
  lines.slice(1).forEach((line, index) => {
    const cells = splitRow(line, delimiter);
    const pick = field => (columns[field] === undefined ? '' : cells[columns[field]] || '');

    const rawDateTime = pick('datetime');
    const date = parseDate(columns.date !== undefined ? pick('date') : rawDateTime);
    if (!date) { problems.push(`Row ${index + 2}: could not read the date`); return; }

    const code = pick('code').trim();
    const name = pick('name').trim();
    if (!code && !name) { problems.push(`Row ${index + 2}: no employee identifier`); return; }

    const key = `${code || name}|${date}`;
    if (!days.has(key)) days.set(key, { code, name, date, punches: [], checkIn: null, checkOut: null });
    const day = days.get(key);
    if (code && !day.code) day.code = code;
    if (name && !day.name) day.name = name;

    /* A row with explicit in/out columns is already a day; anything else is one punch. */
    const explicitIn = parseTime(pick('checkIn'));
    const explicitOut = parseTime(pick('checkOut'));
    if (explicitIn || explicitOut) {
      if (explicitIn) day.checkIn = day.checkIn ? (explicitIn < day.checkIn ? explicitIn : day.checkIn) : explicitIn;
      if (explicitOut) day.checkOut = day.checkOut ? (explicitOut > day.checkOut ? explicitOut : day.checkOut) : explicitOut;
      return;
    }
    const time = parseTime(columns.time !== undefined ? pick('time') : rawDateTime);
    if (time) day.punches.push(time);
  });

  const rows = [...days.values()].map(day => {
    const punches = day.punches.sort();
    const checkIn = day.checkIn || punches[0] || null;
    const checkOut = day.checkOut || (punches.length > 1 ? punches[punches.length - 1] : null);
    return {
      code: day.code || null,
      name: day.name || null,
      date: day.date,
      checkIn,
      checkOut: checkOut && checkOut !== checkIn ? checkOut : null,
      punches: punches.length || (day.checkIn ? 1 : 0) + (day.checkOut ? 1 : 0)
    };
  }).sort((a, b) => (a.date === b.date ? String(a.code).localeCompare(String(b.code)) : a.date.localeCompare(b.date)));

  return { rows, problems, columns: header };
}
