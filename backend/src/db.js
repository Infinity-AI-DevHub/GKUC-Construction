import 'dotenv/config';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

const config = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'gkuc_siteops',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'Z',
  decimalNumbers: true
};

export const pool = mysql.createPool(config);
export const query = async (sql, params = []) => (await pool.execute(sql, params))[0];
/*
 * Statements the prepared protocol will not carry — CREATE TRIGGER and anything else with a
 * BEGIN ... END body. Takes no parameters by design: it is for schema definition, never for
 * anything with a value in it.
 */
export const ddl = async sql => (await pool.query(sql))[0];
export const getOne = async (sql, params = []) => (await query(sql, params))[0];
/**
 * "Today" means the local calendar day on the server, which is what MySQL's CURDATE()
 * returns and what a site means by today. Deriving it from toISOString() would give the
 * UTC day instead, so east of Greenwich the two disagree for the whole local morning and
 * queries filtered on CURDATE() would find nothing.
 */
const pad = value => String(value).padStart(2, '0');
export const today = (date = new Date()) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
export const clock = (date = new Date()) =>
  `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;

/** Formats a DATE read back from MySQL, which arrives as UTC midnight. */
export const isoDate = value => (value ? new Date(value).toISOString().slice(0, 10) : null);

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function transaction(work) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function audit(executor, userId, action, entity, entityId, before, after, ip = '') {
  await executor.execute(`INSERT INTO audit_logs (user_id,action,entity,entity_id,before_json,after_json,ip_address)
    VALUES (?,?,?,?,?,?,?)`, [userId || null, action, entity, String(entityId || ''), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, ip]);
}

/**
 * Total recorded cost for a project: the opening figure carried on the project record
 * plus every expense captured since. Used everywhere budget-vs-actual is reported so
 * the dashboard, the finance module and the alert scanner never disagree.
 */
export const spendSql = alias =>
  `(${alias}.actual + COALESCE((SELECT SUM(x.amount) FROM expenses x WHERE x.project_id=${alias}.id),0))`;

/**
 * Reserves the next document number in a series, e.g. PR-2026-0007.
 *
 * The number is handed out by a counter row updated in one atomic statement, rather than by
 * reading the last reference and adding one. Reading first is a race: two people creating a
 * quotation in the same second both read the same last number, both build the same
 * reference, and the second is refused with a duplicate-key error that says nothing about
 * what went wrong. Two of three simultaneous attempts failed that way.
 *
 * MySQL's LAST_INSERT_ID(expr) is what makes it atomic — it both sets the new value and
 * reports it back, so the reservation and the read are a single statement no other
 * connection can interleave with.
 *
 * A series is scoped to its year, so numbering restarts each January without a reference
 * from December being consulted.
 */
export async function nextReference(prefix, table) {
  const year = new Date().getFullYear();
  const scope = `${prefix}-${year}`;

  /*
   * The first document of a series continues from whatever is already in the table, so
   * numbering does not restart over references that have already been issued. Taking the
   * highest of this year's rather than the newest row: references are not always created in
   * order, and one left over from last year must not reset the count.
   */
  const [existing] = await query(
    `SELECT COALESCE(MAX(CAST(SUBSTRING_INDEX(reference,'-',-1) AS UNSIGNED)),0) high
     FROM ${table} WHERE reference LIKE ?`, [`${scope}-%`]);

  const result = await query(
    `INSERT INTO document_sequences (scope,next_value) VALUES (?, LAST_INSERT_ID(?))
     ON DUPLICATE KEY UPDATE next_value = LAST_INSERT_ID(next_value + 1)`,
    [scope, Number(existing.high) + 1]);

  /* insertId carries whatever LAST_INSERT_ID() was set to, on either branch. */
  const sequence = Number(result.insertId);
  return `${prefix}-${year}-${String(sequence).padStart(4, '0')}`;
}
