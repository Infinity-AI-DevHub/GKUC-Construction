import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTenderText } from '../src/lib/tender-pdf.js';

test('extracts key tender dates, identity and security for review', () => {
  const parsed = parseTenderText(`Employer: Road Development Authority
Name of Work: Improvement of Kiridigala Road
Contract No: RDA/2026/55
Closing date: 18/09/2026 10:30
Bid validity: 91 days
Bid security amount: LKR 500,000.00
Document fee: LKR 5,000.00`);
  assert.equal(parsed.clientName, 'Road Development Authority');
  assert.equal(parsed.fields.title, 'Improvement of Kiridigala Road');
  assert.equal(parsed.fields.contractNo, 'RDA/2026/55');
  assert.equal(parsed.fields.closingDate, '2026-09-18');
  assert.equal(parsed.fields.closingTime, '10:30');
  assert.equal(parsed.fields.securityAmount, 500000);
  assert.equal(parsed.fields.documentFee, 5000);
  assert.deepEqual(parsed.warnings, []);
});

test('leaves uncertain mandatory details for human entry', () => {
  const parsed = parseTenderText('Invitation to bid\nPlease see the attached schedules.');
  assert.equal(parsed.fields.closingDate, '');
  assert.ok(parsed.warnings.some(warning => warning.includes('Closing date')));
});
