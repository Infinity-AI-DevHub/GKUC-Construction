import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invoiceOptions, previousInvoiceCredits, cumulativeInvoice } from '../src/lib/invoice-options.js';
import { certificate } from '../src/lib/invoice-maths.js';
import { invoiceDocument } from '../src/lib/documents.js';

const scope = { companyId: 1, clientId: 4, projectId: 2, invoiceDate: '2026-10-30', taxTreatment: 'Standard', vatRate: 18 };
const original = { id: 1, reference: 'INV-001', company_id: 1, client_id: 4, project_id: 2, invoice_date: '2026-10-01', status: 'Paid', gross: 1000, vat_amount: 180, net_payable: 1180, paid_amount: 1180, retention_amount: 0, advance_recovery: 0, other_deductions: 0, tax_treatment: 'Standard', vat_rate: 18 };
const current = gross => certificate({ gross, vatRate: 18 });

test('cumulative bills deduct paid invoices without repeating their revenue or VAT', async () => {
  const credits = await previousInvoiceCredits(async () => original, [1], scope);
  const sums = cumulativeInvoice(current(2500), credits);
  assert.equal(sums.netPayable, 1770);
  assert.equal(sums.gross, 1500);
  assert.equal(sums.vatAmount, 270);
  assert.equal(sums.cumulativeTotals.gross, 2500);
  assert.equal(sums.cumulativeTotals.vatAmount, 450);
  assert.equal(sums.workings.at(-1).amount, -1180);
});

test('cumulative ancestry and duplicate selections are counted once', async () => {
  const second = { ...original, id: 2, reference: 'INV-002', invoice_options: { previousInvoices: [{ invoiceId: 1 }] } };
  const credits = await previousInvoiceCredits(async id => id === 1 ? original : second, [2, 1, 2], scope);
  assert.deepEqual(credits.map(row => row.invoiceId), [1, 2]);
  assert.equal(cumulativeInvoice(current(3000), credits).netPayable, 1180);
});

test('previous invoices must be fully paid and match the billing account and tax basis', async () => {
  for (const changes of [{ status: 'Draft' }, { paid_amount: 100 }, { company_id: 2 }, { client_id: 7 }, { project_id: null }, { invoice_date: '2026-11-01' }, { tax_treatment: 'Exempt' }, { vat_rate: 15 }]) {
    await assert.rejects(previousInvoiceCredits(async () => ({ ...original, ...changes }), [1], scope), error => error.status === 400);
  }
});

test('cumulative totals cannot reverse amounts already billed or produce a zero bill', async () => {
  const credits = await previousInvoiceCredits(async () => original, [1], scope);
  assert.throws(() => cumulativeInvoice(current(500), credits), /already invoiced/);
  assert.throws(() => cumulativeInvoice(current(1000), credits), /positive new amount/);
  assert.equal(cumulativeInvoice(current(1000), []).netPayable, 1180);
});

test('invoice PDFs support every combination of optional columns and correctly span totals', () => {
  for (let bits = 0; bits < 8; bits++) {
    const columns = { unit: Boolean(bits & 1), quantity: Boolean(bits & 2), rate: Boolean(bits & 4) };
    const html = invoiceDocument({ company: { name: 'GKUC Construction' }, invoice: { reference: 'INV-COLUMNS', invoiceDate: '2026-10-30', client: 'Client', taxTreatment: 'Exempt', gross: 100, netPayable: 100, invoiceOptions: { columns } }, items: [{ description: 'Lump sum work', unit: 'm2', quantity: 2, rate: 50, amount: 100 }] });
    for (const [key, label] of Object.entries({ unit: 'Unit', quantity: 'Quantity', rate: 'Rate (Rs.)' })) {
      assert.equal(html.includes(`>${label}</th>`), columns[key]);
    }
    assert.ok(html.includes(`colspan="${2 + Object.values(columns).filter(Boolean).length}"`));
    assert.match(html, /Lump sum work/);
  }
  assert.deepEqual(invoiceOptions(null).columns, { unit: true, quantity: true, rate: true });
});

test('cumulative invoice document shows full work, named credits and the new payable amount', async () => {
  const previousInvoices = await previousInvoiceCredits(async () => original, [1], scope);
  const sums = cumulativeInvoice(current(2500), previousInvoices);
  const html = invoiceDocument({ company: { name: 'GKUC Construction' }, invoice: { reference: 'INV-002', invoiceDate: '2026-10-30', client: 'Client', taxTreatment: 'Standard', ...sums, invoiceOptions: { previousInvoices, cumulativeTotals: sums.cumulativeTotals } }, items: [{ description: 'Work to date', quantity: 1, rate: 2500, amount: 2500 }] });
  assert.match(html, /Less paid invoice INV-001/);
  assert.match(html, />2,500.00</);
  assert.match(html, />-1,180.00</);
  assert.match(html, />1,770.00</);
});


test('cumulative retention and recoveries contribute only their new portions to the ledger', async () => {
  const paid = { ...original, retention_amount: 100, advance_recovery: 50, other_deductions: 20, net_payable: 1010, paid_amount: 1010 };
  const credits = await previousInvoiceCredits(async () => paid, [1], scope);
  const sums = cumulativeInvoice(certificate({ gross: 2500, vatRate: 18, retentionPercent: 10, advanceRecovery: 80, otherDeductions: 40 }), credits);
  assert.equal(sums.retentionAmount, 150);
  assert.equal(sums.advanceRecovery, 30);
  assert.equal(sums.otherDeductions, 20);
  assert.equal(sums.netPayable, 1570);
  assert.equal(sums.vatCollected, 270);
});

test('quotation-style invoice retains saved identity and optional purchaser TIN', () => {
  const render = buyerTin => invoiceDocument({
    company: { name: 'Saved company', address: 'Saved address line 1\nSaved address line 2', tin: 'SUPPLIER-TIN' },
    invoice: { reference: 'INV-FORMAT', invoiceDate: '2026-11-02', client: 'Purchaser <Company>',
      buyerTin, title: 'Work completed', taxTreatment: 'Standard', vatRate: 18,
      gross: 100, vatAmount: 18, netPayable: 118, paymentMode: 'Cheque',
      invoiceOptions: { columns: { unit: false, quantity: false, rate: false } } },
    items: [{ description: 'Completed work', amount: 100, quantity: 1, rate: 100 }]
  });
  const html = render(null);
  assert.doesNotMatch(html, /Purchaser TIN:/);
  assert.match(html, /data-piece="companyDetails"[^>]*>Saved address line 1, Saved address line 2/);
  assert.match(html, /Invoice for/);
  assert.doesNotMatch(html, /Date of delivery:/);
  assert.match(html, /Date of supply:<\/strong> \<\/p>/);
  assert.match(html, /Place of supply:/);
  assert.match(html, /Additional information if any:<\/strong><\/p>/);
  assert.ok(html.indexOf('Additional information if any:') < html.indexOf('Item / surfacing'));
  assert.ok(html.indexOf('Mode of payment:</strong> Cheque') > html.indexOf('Total amount in words:'));
  assert.match(html, /Mode of payment:<\/strong> Cheque/);
  assert.match(html, /Purchaser &lt;Company&gt;/);
  assert.match(html, /<th class="ref">Item \/ surfacing<\/th>/);
  assert.match(render('BUYER-123'), /Purchaser TIN:<\/strong> BUYER-123/);
  assert.doesNotMatch(render('BUYER-123'), /Purchaser's TIN:<\/strong> <span/);
});
