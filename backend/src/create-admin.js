/*
 * Creates the first real account on a production install.
 *
 * Demo seeding is deliberately off in production, so a fresh database has roles and
 * permissions but no users. Rather than turn the demo data on and then try to undo it —
 * nine accounts sharing one published password — this creates exactly one account, with a
 * password that has to clear the same policy the application enforces everywhere else.
 *
 *   node src/create-admin.js "Full Name" name@company.lk 'the password'
 *
 * Safe to re-run: an address that already exists is reported, not overwritten.
 */
import 'dotenv/config';
import { hashPassword, query } from './db.js';
import { migrate } from './schema.js';
import { passwordProblems } from './lib/passwords.js';

const [name, email, password] = process.argv.slice(2);

if (!name || !email || !password) {
  console.error('Usage: node src/create-admin.js "Full Name" email@company.lk \'password\'');
  process.exit(1);
}

await migrate();

const problems = passwordProblems(password, { email, name });
if (problems.length) {
  console.error('That password does not meet the policy:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const [existing] = await query('SELECT id FROM users WHERE email=?', [email]);
if (existing) {
  console.error(`An account already exists for ${email} (id ${existing.id}). Nothing changed.`);
  process.exit(1);
}

const [role] = await query('SELECT id FROM roles WHERE name=?', ['Managing Director']);
if (!role) {
  console.error('The Managing Director role is missing — the migration did not complete.');
  process.exit(1);
}

await query('INSERT INTO users (name,email,password_hash,role,role_id) VALUES (?,?,?,?,?)',
  [name, email, hashPassword(password), 'Managing Director', role.id]);

console.log(`Created Managing Director account for ${email}.`);
process.exit(0);
