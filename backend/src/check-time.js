/*
 * Reports the time as the application actually sees it.
 *
 * A bare `mysql` CLI session is not a useful check on its own: the application sets its
 * own session timezone on every connection, so the CLI can report the server's default
 * while the application is working in Asia/Colombo perfectly correctly. This connects
 * exactly the way the application does.
 *
 *   node src/check-time.js
 */
import 'dotenv/config';
import { query, today, clock } from './db.js';

const [r] = await query(
  'SELECT NOW() n, CURDATE() d, @@session.time_zone stz, @@global.time_zone gtz, @@system_time_zone systz');

const expected = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Colombo' });
const expectedDay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Colombo' });

console.log(`  process TZ ............... ${process.env.TZ || '(inherited from the host)'}`);
console.log(`  MySQL system_time_zone ... ${r.systz}   (read from the OS when MySQL started)`);
console.log(`  MySQL global time_zone ... ${r.gtz}`);
console.log(`  MySQL session time_zone .. ${r.stz}   (what this application forces)`);
console.log('');
console.log(`  SQL NOW() ................ ${String(r.n).slice(0, 24)}`);
console.log(`  SQL CURDATE() ............ ${r.d}`);
console.log(`  Node today() / clock() ... ${today()} ${clock()}`);
console.log(`  Colombo says ............. ${expected}`);
console.log('');

/*
 * Compare the wall clock, not only the calendar day. Two zones hours apart still share a
 * date for most of the day, so a date-only check passes while the clock is plainly wrong —
 * and it is the clock that decides whether somebody arrived late.
 */
const expectedClock = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Colombo', hour12: false });
const minutesApart = (a, b) => {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  const diff = Math.abs((ah * 60 + am) - (bh * 60 + bm));
  return Math.min(diff, 1440 - diff);
};

const problems = [];
if (String(r.d) !== expectedDay) problems.push(`the database calendar day is ${r.d}, Colombo is on ${expectedDay}`);
if (today() !== expectedDay) problems.push(`Node's calendar day is ${today()}, Colombo is on ${expectedDay} — set TZ=Asia/Colombo`);
if (minutesApart(clock(), expectedClock) > 2) {
  problems.push(`Node's clock reads ${clock()}, Colombo reads ${expectedClock} — set TZ=Asia/Colombo`);
}
/*
 * Check the declared offset too, not just the resulting instant. When the driver and the
 * session agree on a wrong zone the conversion cancels out and every instant looks right —
 * but CURDATE() still returns that zone's calendar day, so attendance and daily reports
 * land on the wrong date for part of every day.
 */
if (r.stz !== '+05:30') {
  problems.push(`the database session is on ${r.stz}, not +05:30 — set DB_TIME_ZONE=+05:30`);
}
const sqlClock = String(r.n).slice(16, 24);
if (minutesApart(sqlClock, expectedClock) > 2) {
  problems.push(`the database clock reads ${sqlClock}, Colombo reads ${expectedClock} — set DB_TIME_ZONE=+05:30`);
}

if (problems.length) {
  for (const problem of problems) console.error(`  WRONG: ${problem}`);
  process.exit(1);
}
console.log('  Correct: the application is working in Sri Lanka time.');
process.exit(0);
