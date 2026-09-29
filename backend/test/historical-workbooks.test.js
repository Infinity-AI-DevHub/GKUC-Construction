import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readWorkbook } from '../src/lib/xlsx.js';

const files = [
  ['01_GKUC_Clients_Import_Template.xlsx', 'Clients', 'CLIENT_CODE'],
  ['02_GKUC_Projects_Import_Template.xlsx', 'Projects', 'PROJECT_CODE'],
  ['03_GKUC_BOQs_Import_Template.xlsx', 'BOQ Headers', 'BOQ_CODE'],
  ['04_GKUC_Quotations_Import_Template.xlsx', 'Quotation Headers', 'QUOTATION_CODE'],
  ['05_GKUC_Cost_Controls_Import_Template.xlsx', 'Expenses', 'EXPENSE_CODE'],
  ['06_GKUC_Retentions_Import_Template.xlsx', 'Retentions', 'RETENTION_CODE'],
  ['07_GKUC_Subcontractors_Import_Template.xlsx', 'Subcontractors', 'SUBCONTRACTOR_CODE']
];

test('historical migration templates retain readable sheet names and keys', t => {
  const downloads = process.env.GKUC_TEMPLATE_DIR;
  if (!downloads) { t.skip('Set GKUC_TEMPLATE_DIR to validate the prepared workbooks.'); return; }
  if (!files.every(([filename]) => fs.existsSync(path.join(downloads, filename)))) {
    t.skip('The separately prepared migration templates are not installed on this machine.');
    return;
  }
  for (const [filename, sheet, key] of files) {
    const workbook = readWorkbook(fs.readFileSync(path.join(downloads, filename)));
    assert.ok(workbook.names.includes(sheet), `${filename}: ${sheet}`);
    assert.ok(workbook.sheet(sheet).rows.some(row => row?.some(cell => String(cell).includes(key))), `${filename}: ${key}`);
  }
});
