import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveScannerRows } from '../src/lib/biometric-identities.js';

const identity = (code, id, scannerName, extra = {}) => ({ code, id, scannerName, name: `Profile ${id}`, status: 'Active', ...extra });
const row = (code, name) => ({ code, name, date: '2026-10-23' });

test('approved scanner names match new numbers with case/whitespace normalization', () => {
  const [resolved] = resolveScannerRows([row('NEW', '  scanner   NAME  ')], [identity('OLD', 1, 'Scanner Name')]);
  assert.equal(resolved.employeeId, 1);
  assert.equal(resolved.employee, 'Profile 1');
  assert.equal(resolved.name, '  scanner   NAME  ');
});

test('old number-only mappings still work, but profile names are never automatic aliases', () => {
  const matches = resolveScannerRows([row('OLD', 'Different scanner name'), row('NEW', 'Profile 1')], [identity('OLD', 1, null)]);
  assert.deepEqual(matches.map(item => item.employeeId), [1, null]);
});

test('duplicate scanner names remain distinct by code and unmatched on an unknown code', () => {
  const mappings = [identity('A', 1, 'Same name'), identity('B', 2, 'Same name')];
  const matches = resolveScannerRows([row('A', 'Same name'), row('B', 'Same name'), row('C', 'Same name')], mappings);
  assert.deepEqual(matches.map(item => item.employeeId), [1, 2, null]);
});

test('several numbers for the same scanner name in one file require code decisions', () => {
  const matches = resolveScannerRows([row('OLD', 'Scanner'), row('NEW', 'Scanner')], [identity('OLD', 1, 'Scanner')]);
  assert.deepEqual(matches.map(item => item.employeeId), [1, null]);
});

test('a code and saved name pointing to different employees never silently match', () => {
  assert.equal(resolveScannerRows([row('A', 'Name B')], [identity('A', 1, 'Name A'), identity('B', 2, 'Name B')])[0].employeeId, null);
});

test('deactivated/left names do not match and remain part of ambiguity checks', () => {
  const mappings = [identity('A', 1, 'Shared'), identity('B', 2, 'Shared', { deactivatedAt: '2026-11-01' }),
    identity('C', 3, 'Departed', { status: 'Left' })];
  const matches = resolveScannerRows([row('B', 'Shared'), row('NEW', 'Shared'), row('C', 'Departed'), row('NEW-C', 'Departed')], mappings);
  assert.deepEqual(matches.map(item => item.employeeId), [null, null, null]);
  assert.ok(matches.every(item => !item.employee));
});
