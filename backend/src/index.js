import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { query } from './db.js';
import { migrate } from './schema.js';
import { seedIfEmpty } from './seed.js';
import { startAlertScheduler } from './alerts.js';
import { UPLOAD_ROOT } from './lib/storage.js';

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
import inquiryRoutes from './routes/inquiries.js';
import payrollRoutes from './routes/payroll.js';

const app = express();
const workspaceRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const frontendDist = path.join(workspaceRoot, 'frontend', 'dist');
const port = Number(process.env.PORT || 4173);

app.use(helmet({ contentSecurityPolicy: false }));
app.use((req, res, next) => (
  req.headers['content-type']?.startsWith('multipart/form-data') ? next() : express.json({ limit: '2mb' })(req, res, next)
));
app.set('trust proxy', true);

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
app.use('/api/inquiries', inquiryRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api', adminRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));
/* Stored objects. This mount answers for itself so a missing file 404s rather than
   falling through to the single-page app and returning index.html with a 200. */
app.use('/uploads', express.static(UPLOAD_ROOT, { maxAge: '1y', index: false, dotfiles: 'deny', fallthrough: false }));
app.use(express.static(frontendDist));
app.get('*', (_req, res) => res.sendFile(path.join(frontendDist, 'index.html')));

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (error.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'This record already exists' });
  if (error.code === 'ER_NO_REFERENCED_ROW_2') return res.status(400).json({ error: 'A referenced record does not exist' });
  res.status(500).json({ error: 'Unexpected server error' });
});

await migrate();
await seedIfEmpty();
startAlertScheduler();
app.listen(port, () => console.log(`GKUC SiteOps running with MySQL at http://127.0.0.1:${port}`));
