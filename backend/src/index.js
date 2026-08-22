import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { query } from './db.js';
import { migrate } from './schema.js';
import { seedIfEmpty } from './seed.js';
import { startAlertScheduler } from './alerts.js';

import authRoutes from './routes/auth.js';
import bootstrapRoutes from './routes/bootstrap.js';
import projectRoutes from './routes/projects.js';
import taskRoutes from './routes/tasks.js';
import employeeRoutes from './routes/employees.js';
import attendanceRoutes from './routes/attendance.js';
import materialRoutes from './routes/materials.js';
import purchasingRoutes from './routes/purchasing.js';
import fleetRoutes from './routes/fleet.js';
import equipmentRoutes from './routes/equipment.js';
import boqRoutes from './routes/boq.js';
import financeRoutes from './routes/finance.js';
import dailyReportRoutes from './routes/dailyReports.js';
import analyticsRoutes from './routes/analytics.js';
import adminRoutes from './routes/admin.js';
import uploadRoutes from './routes/uploads.js';
import accessRoutes from './routes/access.js';
import siteRoutes from './routes/sites.js';
import qsRoutes from './routes/qs.js';
import biometricRoutes from './routes/biometric.js';
import inquiryRoutes from './routes/inquiries.js';
import payrollRoutes from './routes/payroll.js';
import galleryRoutes from './routes/gallery.js';

const app = express();
const workspaceRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const frontendDist = path.join(workspaceRoot, 'frontend', 'dist');
const port = Number(process.env.PORT || 4173);

/*
 * Content-Security-Policy was switched off wholesale, which gave up the main defence
 * against an injected script running in this origin.
 *
 * The policy below fits what the product actually does: its own bundle and no other
 * script source; inline styles, because the interface sets them from React and the
 * generated documents carry their own <style>; blob: images and frames, because
 * attachments and the document preview are fetched with the session and handed to the
 * page as object URLs; and no plugins, no framing by anyone else.
 */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'", 'blob:'],
      frameSrc: ["'self'", 'blob:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  referrerPolicy: { policy: 'no-referrer' }
}));

/*
 * A request refused before its body was read — the wrong file type, a record that does not
 * exist, no permission — leaves the client still sending into a socket nobody is reading.
 * The refusal itself gets through, but the connection is left mid-request, and the next
 * request to reuse it fails with a reset. Draining whatever is left once the reply has gone
 * out keeps the connection usable, which matters most for uploads: those are the requests
 * large enough for the client to still be writing when the answer comes back.
 */
app.use((req, res, next) => {
  res.on('finish', () => { if (!req.complete) req.resume(); });
  next();
});

app.use((req, res, next) => (
  req.headers['content-type']?.startsWith('multipart/form-data') ? next() : express.json({ limit: '2mb' })(req, res, next)
));
/*
 * Only trust forwarding headers from a proxy we actually run.
 *
 * With this set to true, any client could send X-Forwarded-For and choose the address that
 * went into the audit trail — the one record meant to say who did what, from where. Set
 * TRUST_PROXY to the hop count or the proxy address in front of the app.
 */
app.set('trust proxy', process.env.TRUST_PROXY
  ? (/^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY)
  : false);

app.get('/api/health', async (_req, res, next) => {
  try {
    await query('SELECT 1');
    res.json({ ok: true, database: 'mysql', time: new Date().toISOString() });
  } catch (error) { next(error); }
});

app.use('/api/auth', authRoutes);
app.use('/api/bootstrap', bootstrapRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/materials', materialRoutes);
app.use('/api/purchasing', purchasingRoutes);
app.use('/api/fleet', fleetRoutes);
app.use('/api/equipment', equipmentRoutes);
app.use('/api/boq', boqRoutes);
app.use('/api/finance', financeRoutes);
app.use('/api/reports', dailyReportRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/uploads', uploadRoutes);
app.use('/api/access', accessRoutes);
app.use('/api', siteRoutes);
app.use('/api/qs', qsRoutes);
app.use('/api/biometric', biometricRoutes);
app.use('/api/inquiries', inquiryRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api', galleryRoutes);
app.use('/api', adminRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));

/*
 * Stored objects are NOT mounted statically.
 *
 * They were, and that put every uploaded file — employment contracts, identity documents,
 * signed tenders, payslips — one guessed or shared URL away from anyone at all, with no
 * session and no permission. Files are served by /api/uploads/file/:id instead, which
 * applies the same permission as seeing the file listed. Anything still pointing at
 * /uploads is answered with 404 rather than silently falling through to the single-page
 * app and returning index.html with a 200.
 */
app.use('/uploads', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(frontendDist));
app.get('*', (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));

app.use((error, req, res, _next) => {
  console.error(error);
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This record already exists' });
  if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'A referenced record does not exist' });
  res.status(500).json({ error: 'Unexpected server error' });
});

await migrate();
/*
 * Demo data is a development convenience, not a production behaviour: an empty users table
 * in production is a disaster to investigate, not an invitation to create seven accounts
 * that share one published password. Set SEED_DEMO_DATA=true to allow it.
 */
if (process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO_DATA === 'true') {
  await seedIfEmpty();
} else {
  const [{ count }] = await query('SELECT COUNT(*) count FROM users');
  if (!count) console.warn('No users exist and demo seeding is off. Create the first account before use.');
}
startAlertScheduler();
app.listen(port, () => console.log(`GKUC SiteOps running with MySQL at http://127.0.0.1:${port}`));
