import { test } from 'node:test';
import assert from 'node:assert/strict';
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
