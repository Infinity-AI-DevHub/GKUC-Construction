import 'dotenv/config';
import { pool, query } from '../db.js';
import { DEFAULT_PAYMENT_MESSAGE } from '../lib/service-access.js';

const action = process.argv[2];
if (!['suspend', 'restore'].includes(action)) {
  console.error('Use: npm run access:suspend or npm run access:restore');
  process.exitCode = 1;
} else {
  try {
    await query(`CREATE TABLE IF NOT EXISTS system_access_state (
      id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
      status ENUM('active','payment_overdue') NOT NULL DEFAULT 'active',
      message TEXT NULL,
      changed_by VARCHAR(120) NOT NULL DEFAULT 'Server command',
      changed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);
    await query(`INSERT IGNORE INTO system_access_state(id,status,message)
      VALUES(1,'active',?)`, [DEFAULT_PAYMENT_MESSAGE]);
    const status = action === 'suspend' ? 'payment_overdue' : 'active';
    const message = process.env.SERVICE_SUSPENSION_MESSAGE || DEFAULT_PAYMENT_MESSAGE;
    await query(`UPDATE system_access_state SET status=?,message=?,changed_by='Server command' WHERE id=1`,
      [status, message]);
    console.log(action === 'suspend'
      ? 'SiteOps access is now suspended for overdue payment. Records and accounts were not changed.'
      : 'SiteOps access is restored. Existing users can continue normally.');
  } catch (error) {
    console.error(`Could not ${action} SiteOps access:`, error.message);
    process.exitCode = 1;
  }
}

await pool.end();
