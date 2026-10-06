import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { boqDocument, quotationDocument, invoiceDocument, receiptDocument } from '../src/lib/documents.js';
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

test('saved small letterhead sizes cannot flatten company and document headings', () => {
  const html = quotationDocument({ company: { ...company, name: 'GKUC Readymix' }, quotation: {
    reference: 'QUO-READYMIX-TEST', quoteDate: '2026-09-28', clientName: 'Test Client',
    subtotal: 2000, total: 2000, title: 'Readymix quotation' }, items: items.slice(0, 1),
  });
  assert.match(html, /data-piece="companyName"/);
  assert.match(html, /data-piece="docTitle"/);
  assert.match(html, /data-piece=companyName\]\{[^}]*font-size:18px!important/);
  assert.match(html, /data-piece=docTitle\]\{[^}]*font-size:19px!important/);
});

test('quotation HTML reflects separate totals, optional notes, bank snapshot, item value and prepared-by snapshot', () => {
  const html = quotationDocument({ company, quotation: {
    reference: 'QUO-FIELDS-TEST-R1', revisionNumber: 1, quoteDate: '2026-10-06', clientName: 'Test Client',
    subtotal: 300, total: 354, title: 'Category quotation', calculationMode: 'Separate Category Totals',
    vatPercent: 18, notes: 'Bring delivery evidence', preparedBy: 'Kasun Perera',
    preparedByDesignation: 'Quantity Surveyor', presentation: { company, client: { name: 'Test Client' },
      show: { company: { bankDetails: true }, client: {} }, bank: { label: 'Construction', bankName: 'Test Bank',
        accountName: 'GKUC', accountNumber: '123', branch: 'Colombo' } }
  }, items: [{ category: 'Tar', area: 'T-01', description: 'Tar work', unit: 'm2', quantity: 1, rate: 100, amount: 100 },
    { category: 'Concrete', area: 'C-02', description: 'Concrete work', unit: 'm3', quantity: 1, rate: 200, amount: 200 }] });
  assert.match(html, /Tar subtotal/);
  assert.match(html, /Concrete total/);
  assert.match(html, /T-01/);
  assert.match(html, /Bring delivery evidence/);
  assert.match(html, /Kasun Perera/);
  assert.match(html, /Quantity Surveyor/);
  assert.match(html, /Test Bank/);
  assert.match(html, /Revision:<\/strong> 1/);

  const withoutOptional = quotationDocument({ company, quotation: { reference: 'QUO-NONE', quoteDate: '2026-10-06',
    clientName: 'Test Client', subtotal: 100, total: 100, title: 'No optional blocks', presentation: {
      company, client: { name: 'Test Client' }, show: { company: { bankDetails: false }, client: {} }, bank: null
    } }, items: [{ category: 'Work', area: '1', description: 'Work', unit: 'sum', quantity: 1, rate: 100, amount: 100 }] });
  assert.doesNotMatch(withoutOptional, /<h4>Notes<\/h4>/);
  assert.doesNotMatch(withoutOptional, /<h4>Bank details<\/h4>/);
});

test('BOQ document prints each category once as a section with its own lines and subtotal', () => {
  const html = boqDocument({ company, boq: { reference: 'BOQ-SECTIONS', createdAt: '2026-10-07',
    project: 'Sectioned project', title: 'Measured works', status: 'Draft', preparedBy: 'QS' }, items: [
    { category: 'Preliminaries', description: 'Road name board', unit: 'PS', quantity: 1, rate: 100, amount: 100 },
    { category: 'Civil Works', description: 'Clear site', unit: 'Days', quantity: 2, rate: 50, amount: 100 },
    { category: 'Preliminaries', description: 'Laboratory testing', unit: 'PS', quantity: 1, rate: 75, amount: 75 }
  ] });
  assert.equal((html.match(/<tr class="section"><td colspan="6">Preliminaries<\/td><\/tr>/g) || []).length, 1);
  assert.equal((html.match(/<tr class="section"><td colspan="6">Civil Works<\/td><\/tr>/g) || []).length, 1);
  assert.ok(html.indexOf('Road name board') < html.indexOf('Laboratory testing'));
  assert.match(html, /Sub-total — Preliminaries[\s\S]*175\.00/);
  assert.match(html, /Sub-total — Civil Works[\s\S]*100\.00/);
});

test('quotation, invoice and receipt PDF layouts retain company, type and reference', async t => {
  try {
    await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    await exec('pdftotext', ['-v']);
  } catch { t.skip('Local Chromium and Poppler are needed for document verification'); return; }
  const readymix = { ...company, name: 'GKUC Readymix', address: 'Plant Road\nGaligamuwa' };
  const samples = [
    [quotationDocument({ company: readymix, quotation: { reference: 'QUO-PREVIEW-TEST', quoteDate: '2026-09-28',
      clientName: 'Test Client', subtotal: 2000, total: 2000, title: 'Sample quote' }, items: items.slice(0, 1) }),
    /Quotation/, /QUO-PREVIEW-TEST/],
    [invoiceDocument({ company: readymix, invoice: { reference: 'INV-PREVIEW-TEST', invoiceDate: '2026-09-28',
      client: 'Test Client', title: 'Sample invoice', gross: 2000, netPayable: 2000, taxTreatment: 'Exempt' },
    items: items.slice(0, 1) }), /Invoice/, /INV-PREVIEW-TEST/],
    [receiptDocument({ company: readymix, receipt: { id: 9, receivedDate: '2026-09-28', client: 'Test Client',
      invoiceReference: 'INV-PREVIEW-TEST', amount: 1000, netPayable: 2000, paidAmount: 1000,
      method: 'Bank transfer' } }), /Payment Receipt/, /RCPT-2026-00009/]
  ];
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gkuc-document-types-'));
  try {
    for (const [index, [html, heading, reference]] of samples.entries()) {
      const pdf = await renderDocumentPdf(html);
      const file = path.join(temporary, `type-${index}.pdf`);
      await writeFile(file, pdf);
      if (process.env.GKUC_LAYOUT_ARTIFACT_DIR) {
        await mkdir(process.env.GKUC_LAYOUT_ARTIFACT_DIR, { recursive: true });
        await writeFile(path.join(process.env.GKUC_LAYOUT_ARTIFACT_DIR, `type-${index}.pdf`), pdf);
      }
      const { stdout: content } = await exec('pdftotext', ['-layout', file, '-']);
      assert.match(content, /GKUC Readymix/);
      assert.ok(content.toUpperCase().replace(/\s+/g, '').includes(heading.source.toUpperCase().replace(/\s+/g, '')),
        'printed heading remains readable even with tracked uppercase letters');
      assert.match(content, reference);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('long quotations print the full letterhead only on page one while invoices keep their existing behavior', async t => {
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
      for (const [pageIndex, page] of text.split('\f').filter(page => page.trim()).entries()) {
        if (index === 0 && pageIndex > 0) {
          assert.doesNotMatch(page, /Address line 1 with additional company information/, 'quotation continuation pages omit the full letterhead');
          continue;
        }
        assert.match(page, /GKUC Construction/, 'the first page retains the company letterhead');
        const compact = page.toUpperCase().replace(/\s+/g, '');
        assert.ok(compact.includes(index === 0 ? 'QUOTATION' : 'INVOICE'),
          'the applicable page retains the document title');
        assert.ok(page.includes(index === 0 ? 'QUO-LAYOUT-TEST' : 'INV-LAYOUT-TEST'),
          'the applicable page retains the document reference');
        assert.ok(page.includes('Address line 1 with additional company information'),
          'the applicable page retains the company details');
      }
      assert.equal((text.match(index === 0 ? /Subtotal/g : /Net payable/g) || []).length, 1,
        'document totals must not repeat on every page');
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});

test('quotation pagination is verified at one, two and three A4 pages with one full letterhead', async t => {
  try { await access('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'); await exec('pdfinfo', ['-v']); await exec('pdftotext', ['-v']); }
  catch { t.skip('Local Chromium and Poppler are needed for pagination verification'); return; }
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gkuc-quotation-pages-'));
  try {
    for (const [count, expectedPages] of [[1, 1], [15, 2], [35, 3]]) {
      const sampleItems = items.slice(0, count);
      const html = quotationDocument({ company: { ...company, address: 'Head office road' }, quotation: {
        reference: `QUO-${expectedPages}-PAGE`, quoteDate: '2026-10-06', clientName: 'Pagination client',
        subtotal: count * 2000, total: count * 2000, title: `${expectedPages}-page quotation`
      }, items: sampleItems });
      const file = path.join(temporary, `${expectedPages}-page.pdf`);
      await writeFile(file, await renderDocumentPdf(html));
      const { stdout: info } = await exec('pdfinfo', [file]);
      assert.equal(Number(info.match(/^Pages:\s+(\d+)/m)?.[1]), expectedPages);
      const { stdout: text } = await exec('pdftotext', ['-layout', file, '-']);
      const pages = text.split('\f').filter(page => page.trim());
      assert.match(pages[0], /Head office road/);
      for (const continuation of pages.slice(1)) assert.doesNotMatch(continuation, /Head office road/);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
