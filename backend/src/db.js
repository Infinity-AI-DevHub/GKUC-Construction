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
export const getOne = async (sql, params = []) => (await query(sql, params))[0];
export const today = () => new Date().toISOString().slice(0, 10);
export const clock = () => new Date().toISOString().slice(11, 19);

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

/** Reserves the next document number for a series, e.g. PR-2026-0007. */
export async function nextReference(prefix, table) {
  const row = await getOne(`SELECT reference FROM ${table} ORDER BY id DESC LIMIT 1`);
  const year = new Date().getFullYear();
  const sequence = row?.reference?.startsWith(`${prefix}-${year}-`) ? Number(row.reference.split('-')[2]) + 1 : 1;
  return `${prefix}-${year}-${String(sequence).padStart(4, '0')}`;
}
