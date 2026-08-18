import { readWorkbook } from './xlsx.js';

/**
 * Reads the "All Report" workbook that GKUC's fingerprint terminal exports.
 *
 * The terminal does not write a punch list. It writes a calendar: one block per employee,
 * with the days of the month across the columns and that day's punch times inside a single
 * cell, separated by a line break. So the file is read as a grid rather than as rows.
 *
 * The raw punches are taken as the truth rather than the device's own "Abnormal" sheet.
 * That sheet reports what the terminal's configured shift matched, and on this export it
 * calls almost every departure "Missed" even where an evening punch plainly exists — a
 * shift setting on the device, not missing data. Reading the grid recovers those times.
 */

const HEADER_LABELS = { id: 'id', name: 'name', date: 'date' };
const SHEET_LOGS = ['attendance logs', 'attendance log', 'logs'];
const SHEET_SUMMARY = ['attendance summary', 'summary'];

const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const lower = value => clean(value).toLowerCase();

/** The first value to the right of a label cell, e.g. `ID | | 101` → 101. */
function valueAfter(row, from, limit) {
  for (let column = from + 1; column <= limit; column += 1) {
    if (row?.[column] !== undefined && row[column] !== null && clean(row[column]) !== '') return row[column];
  }
  return null;
}

function findSheet(workbook, candidates) {
  const name = workbook.names.find(sheet => candidates.includes(lower(sheet)));
  return name ? { name, sheet: workbook.sheet(name) } : null;
}

/** "2026-08-01 ~ 2026-08-18" → the two ends of the period the export covers. */
function periodFrom(sheet) {
  for (let row = 1; row <= Math.min(sheet.rowCount, 8); row += 1) {
    for (let column = 1; column <= sheet.columnCount; column += 1) {
      const match = /(\d{4})-(\d{2})-(\d{2})\s*[~–-]\s*(\d{4})-(\d{2})-(\d{2})/.exec(clean(sheet.rows[row]?.[column]));
      if (match) return { from: match.slice(1, 4).join('-'), to: match.slice(4, 7).join('-') };
    }
  }
  return null;
}

/**
 * The grid carries a day of the month, not a full date. Where a period runs across a month
 * boundary, the day alone is ambiguous — so the candidate months are tried and the one that
 * lands inside the period wins.
 */
function dateForDay(period, day) {
  if (!period) return null;
  const [fromYear, fromMonth] = period.from.split('-').map(Number);
  const [toYear, toMonth] = period.to.split('-').map(Number);
  const candidates = [[fromYear, fromMonth]];
  if (fromYear !== toYear || fromMonth !== toMonth) candidates.push([toYear, toMonth]);

  for (const [year, month] of candidates) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (iso >= period.from && iso <= period.to) return iso;
  }
  return null;
}

const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/** Every time written into one day's cell, in order, as HH:MM:SS. */
function punchesIn(cell) {
  return String(cell ?? '')
    .split(/[\r\n,;]+/)
    .map(part => clean(part))
    .filter(Boolean)
    .map(part => {
      const match = TIME.exec(part);
      if (!match) return null;
      const [hours, minutes, seconds = '00'] = [match[1].padStart(2, '0'), match[2], match[3] || '00'];
      return Number(hours) > 23 || Number(minutes) > 59 ? null : `${hours}:${minutes}:${seconds}`;
    })
    .filter(Boolean)
    .sort();
}

/** ID → department, from the summary sheet, so an unmatched person can still be placed. */
function departments(workbook) {
  const found = findSheet(workbook, SHEET_SUMMARY);
  if (!found) return new Map();
  const { sheet } = found;
  const map = new Map();
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    const id = sheet.rows[row]?.[1];
    if (typeof id !== 'number') continue;
    map.set(String(id), { name: clean(sheet.rows[row][2]), department: clean(sheet.rows[row][3]) });
  }
  return map;
}

export function isWorkbook(buffer, filename = '') {
  if (/\.xlsx$/i.test(filename)) return true;
  /* A .xlsx is a ZIP, which always starts "PK\x03\x04". */
  return buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

export function parseAttendanceWorkbook(buffer) {
  const workbook = readWorkbook(buffer);
  const found = findSheet(workbook, SHEET_LOGS);
  if (!found) {
    return {
      rows: [],
      problems: [`This workbook has no "Attendance Logs" sheet. It contains: ${workbook.names.join(', ')}`],
      columns: workbook.names
    };
  }

  const { sheet } = found;
  const period = periodFrom(sheet);
  const staff = departments(workbook);
  const problems = [];
  const rows = [];

  if (!period) problems.push('The period this export covers could not be read, so the dates may be wrong.');

  for (let row = 1; row <= sheet.rowCount; row += 1) {
    if (lower(sheet.rows[row]?.[1]) !== HEADER_LABELS.id) continue;

    const width = Math.max(sheet.columnCount, 31);
    const code = clean(valueAfter(sheet.rows[row], 1, width));
    const nameLabel = (sheet.rows[row] || []).findIndex(cell => lower(cell) === HEADER_LABELS.name);
    const name = nameLabel > 0 ? clean(valueAfter(sheet.rows[row], nameLabel, width)) : '';

    /* The block is four rows: the heading, the days, the weekdays, then the punches. */
    const days = sheet.rows[row + 1] || [];
    const times = sheet.rows[row + 3] || [];
    if (!code) { problems.push(`An employee block at row ${row} has no ID and was skipped.`); continue; }

    for (let column = 1; column <= width; column += 1) {
      const day = Number(days[column]);
      const cell = times[column];
      if (!Number.isInteger(day) || day < 1 || day > 31 || !cell) continue;

      const punches = punchesIn(cell);
      if (!punches.length) { problems.push(`${name || code}: could not read "${clean(cell)}" on day ${day}.`); continue; }

      const date = dateForDay(period, day);
      if (!date) { problems.push(`${name || code}: day ${day} falls outside the period of this export.`); continue; }

      /*
       * One punch on its own cannot say whether the person arrived or left. Rather than
       * guess — and quietly credit a 17:00 departure as an arrival — it is recorded on the
       * side it most likely belongs to and marked for a person to confirm.
       */
      const single = punches.length === 1;
      const morning = Number(punches[0].slice(0, 2)) < 12;

      rows.push({
        code,
        name: name || staff.get(code)?.name || '',
        department: staff.get(code)?.department || '',
        date,
        checkIn: single ? (morning ? punches[0] : null) : punches[0],
        checkOut: single ? (morning ? null : punches[0]) : punches[punches.length - 1],
        punches,
        needsReview: single
      });
    }
  }

  const reviews = rows.filter(item => item.needsReview).length;
  if (reviews) {
    problems.push(`${reviews} day(s) have only one punch, so it is unclear whether the person arrived or left. Each is marked for review.`);
  }

  return {
    rows,
    problems,
    columns: ['ID', 'Name', 'Date', 'Punches'],
    period,
    source: found.name
  };
}
