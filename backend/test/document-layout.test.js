import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { quotationDocument, invoiceDocument } from '../src/lib/documents.js';
import { renderDocumentPdf } from '../src/lib/document-pdf.js';

const exec = promisify(execFile);
const company = {
  name: 'GKUC Construction',
  address: Array.from({ length: 9 }, (_, index) => `Address line ${index + 1} with additional company information`).join('\n'),
  telephone: '+94 11 234 5678', email: 'office@example.test', tin: 'TIN-123', vatNumber: 'VAT-123'
};
const items = Array.from({ length: 90 }, (_, index) => ({
  area: String(index + 1), description: `Construction work item ${index + 1} with a detailed description that wraps in the priced-items table`,
  unit: 'm²', quantity: 2, rate: 1000, amount: 2000
}));

test('long quotations and invoices print on A4 with a letterhead on every page', async t => {
  try {
    await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    await exec('pdfinfo', ['-v']);
    await exec('pdftotext', ['-v']);
  } catch { t.skip('Local Chromium and Poppler are needed for print-layout verification'); return; }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gkuc-layout-test-'));
  try {
    const samples = [
      quotationDocument({ company, quotation: { reference: 'QUO-LAYOUT-TEST', quoteDate: '2026-09-28', clientName: 'Test Client',
        subtotal: 180000, total: 180000, title: 'Long quotation' }, items }),
      invoiceDocument({ company, invoice: { reference: 'INV-LAYOUT-TEST', invoiceDate: '2026-09-28', client: 'Test Client',
        title: 'Long invoice', gross: 180000, netPayable: 180000, taxTreatment: 'Exempt' }, items })
    ];
    for (const [index, html] of samples.entries()) {
      assert.match(html, /@page\{size:A4;/);
      const pdf = await renderDocumentPdf(html);
      const file = path.join(temporary, `document-${index}.pdf`);
      await writeFile(file, pdf);
      if (process.env.GKUC_LAYOUT_ARTIFACT_DIR) {
        await mkdir(process.env.GKUC_LAYOUT_ARTIFACT_DIR, { recursive: true });
        await writeFile(path.join(process.env.GKUC_LAYOUT_ARTIFACT_DIR, `document-${index}.pdf`), pdf);
      }
      const { stdout: info } = await exec('pdfinfo', [file]);
      const pages = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      assert.ok(pages > 1, 'sample must span multiple printed pages');
      assert.match(info, /Page size:\s+59[45](?:\.\d+)? x 84[12](?:\.\d+)? pts \(A4\)/);
      const { stdout: text } = await exec('pdftotext', ['-layout', file, '-']);
      assert.equal(text.split('\f').filter(page => page.trim()).length, pages);
      for (const page of text.split('\f').filter(page => page.trim())) {
        assert.match(page, /GKUC Construction/, 'each printed page repeats the company letterhead');
      }
      assert.equal((text.match(index === 0 ? /Subtotal/g : /Net payable/g) || []).length, 1,
        'document totals must not repeat on every page');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
