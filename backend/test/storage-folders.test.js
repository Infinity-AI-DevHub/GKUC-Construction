import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FOLDERS } from '../src/lib/storage.js';

test('every generic attachment owner has an allowed storage folder', () => {
  const attachmentOwners = [
    'attendance', 'claim', 'handover', 'candidate', 'task', 'project', 'employee',
    'report', 'vehicle', 'equipment', 'incoming_letter', 'risk_finding'
  ];
  for (const owner of attachmentOwners) {
    assert.ok(FOLDERS.includes(owner), `${owner} must be accepted by the storage layer`);
  }
});

test('every R2 redirect awaits its signed URL', async () => {
  const routes = ['uploads.js', 'gallery.js', 'drive.js', 'boq-import.js', 'qs.js', 'public-share.js'];
  for (const route of routes) {
    const source = await readFile(new URL(`../src/routes/${route}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /res\.redirect\((?:302,\s*)?signedDownloadUrl\(/,
      `${route} must await the signed URL before redirecting`);
  }
});
