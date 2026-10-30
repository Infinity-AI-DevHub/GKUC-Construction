import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyStorageEnvironment } from '../src/lib/storage-env.js';

test('explicit backend storage settings replace stale PM2 provider and credentials together', () => {
  const environment = { STORAGE_DRIVER: 'r2', R2_ACCESS_KEY_ID: 'stale', S3_SECRET_ACCESS_KEY: 'stale-s3', PORT: '4400', DB_PASSWORD: 'unchanged' };
  const configured = { STORAGE_DRIVER: 's3', S3_ENDPOINT: 'https://sin1.contabostorage.com', S3_ACCESS_KEY_ID: 'new', DB_PASSWORD: 'not applied' };
  assert.equal(applyStorageEnvironment(environment, configured), 'backend/.env');
  assert.deepEqual(environment, { PORT: '4400', DB_PASSWORD: 'unchanged', STORAGE_DRIVER: 's3', S3_ENDPOINT: configured.S3_ENDPOINT, S3_ACCESS_KEY_ID: 'new' });
});

test('process-only configuration remains supported without an explicit file driver', () => {
  const environment = { STORAGE_DRIVER: 's3', S3_SECRET_ACCESS_KEY: 'process-secret' };
  applyStorageEnvironment(environment, { DB_PASSWORD: 'unrelated' });
  assert.equal(environment.S3_SECRET_ACCESS_KEY, 'process-secret');
});
