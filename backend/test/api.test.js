import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import 'dotenv/config';
import mysql from 'mysql2/promise';

const port = 43971;
const base = `http://127.0.0.1:${port}/api`;
const testDatabase = 'gkuc_siteops_test';
let server;
let admin;

before(async () => {
  admin = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD });
  await admin.query(`DROP DATABASE IF EXISTS \`${testDatabase}\``);
  await admin.query(`CREATE DATABASE \`${testDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  server = spawn(process.execPath, ['src/index.js'], { cwd: new URL('..', import.meta.url), env: { ...process.env, PORT: String(port), DB_NAME: testDatabase }, stdio: 'ignore' });
  for (let attempt = 0; attempt < 40; attempt++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not start');
});

after(async () => {
  server?.kill('SIGTERM');
  await admin.query(`DROP DATABASE IF EXISTS \`${testDatabase}\``);
  await admin.end();
});

async function login(email = 'owner@gkuc.lk') {
  const response = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'GKUC@2026' }) });
  assert.equal(response.status, 200);
  return response.json();
}

test('requires authentication for operational data', async () => {
  assert.equal((await fetch(`${base}/bootstrap`)).status, 401);
});

test('authenticates and returns database-backed operational data', async () => {
  const session = await login();
  const response = await fetch(`${base}/bootstrap`, { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.projects.length, 3);
  assert.equal(body.data.tasks.length, 5);
  assert.equal(body.user.role, 'Owner / Director');
});

test('enforces role permissions and records authorized changes', async () => {
  const store = await login('store@gkuc.lk');
  const denied = await fetch(`${base}/tasks/1`, { method: 'PATCH', headers: { authorization: `Bearer ${store.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'Completed' }) });
  assert.equal(denied.status, 403);

  const owner = await login();
  const allowed = await fetch(`${base}/tasks/1`, { method: 'PATCH', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ status: 'Completed' }) });
  assert.equal(allowed.status, 200);
  const audit = await fetch(`${base}/audit`, { headers: { authorization: `Bearer ${owner.token}` } });
  assert.equal(audit.status, 200);
  assert.ok((await audit.json()).some(entry => entry.entity === 'task' && entry.action === 'UPDATE'));
});
