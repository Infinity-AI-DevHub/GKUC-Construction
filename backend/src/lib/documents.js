import { amountInWords } from './amount-in-words.js';
import { DEFAULT_DESIGN, fontStack, normaliseDesign, orderedBlocks, shows } from './document-design.js';

/**
 * Renders a client-facing document as a self-contained printable page.
 *
 * GKUC types its quotations in Word today and retypes the same figures that are already in
 * the system. This produces the document from the record itself, so the quotation, the
 * budget and the project can never quietly disagree.
 *
 * Deliberately HTML rather than a generated PDF: every browser prints to PDF, the page can
 * be checked on screen before it is sent, and it avoids a rendering dependency for what is
 * ultimately a page of text and a table. The print rules below are what make it come out as
 * a clean A4 sheet rather than a screenshot of a web page.
 */

const escape = value => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/* Line breaks typed into a settings box should survive onto the page. */
const lines = value => escape(value).split(/\r?\n/).filter(Boolean);

const money = value => Number(value || 0).toLocaleString('en-LK', {
  minimumFractionDigits: 2, maximumFractionDigits: 2
});

const quantity = value => (value === null || value === undefined || value === ''
  ? ''
  : Number(value).toLocaleString('en-LK', { maximumFractionDigits: 3 }));

const longDate = value => (value
  ? new Date(value).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  : '');

/** What a document looks like when nothing has been customised. */
export const DEFAULT_DOCUMENT_SETTINGS = {
  accentColour: '#16305c',
  paperSize: 'A4',
  showLogo: true,
  showSignatures: true,
  showAmountInWords: true,
  showBankDetails: true,
  footerNote: '',
  quotationNotes: '',
  quotationTerms: '',
  boqTerms: '',
  invoiceTerms: ''
};

const settingsFor = given => ({ ...DEFAULT_DOCUMENT_SETTINGS, ...(given || {}) });

/**
 * Every document says who built the system. Fixed rather than configurable — it is an
 * attribution, not a preference, and it prints as well as showing on screen.
 */
const BUILDER = 'Built by Infinity AI (Pvt) Ltd, Sri Lanka';

/** Turns a design into the stylesheet the document is drawn with. */
function stylesheet(design) {
  const { page, type, table, totals } = design;
  return `
  *{box-sizing:border-box}
  /*
   * Print the colours as designed.
   *
   * A browser drops background colours when printing unless it is told not to — the
   * "Background graphics" tick in the print dialogue. Without this the navy table header and
   * the total bar came out blank, and because their text is white it disappeared with them:
   * the total, the one figure that matters most, printed invisibly. Asking for exact colour
   * makes it independent of a tick box nobody should have to know about.
   */
  *,*::before,*::after{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  body{margin:0;background:#eef1f3;color:${type.colour};
    font:${type.size}px/1.5 ${fontStack(type.font)}}
  .sheet{width:${page.size === 'Letter' ? '216mm' : '210mm'};
    min-height:${page.size === 'Letter' ? '279mm' : '297mm'};
    margin:16px auto;background:${page.background};
    padding:${page.margins.top}mm ${page.margins.right}mm ${page.margins.bottom}mm ${page.margins.left}mm;
    box-shadow:0 6px 26px rgba(0,0,0,.14);position:relative}
  .watermark{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none;
    font-weight:800;letter-spacing:6px;text-transform:uppercase;z-index:0}
  .sheet > *:not(.watermark){position:relative;z-index:1}
  /* A band placed by coordinate. It appears once and never paginates, so nothing in it
     can be pushed out of place by content further down the page. */
  .head{position:relative;margin-bottom:14px}
  .head.ruled{border-bottom:2px solid ${design.accent}}
  .head .piece{position:absolute;margin:0}
  .head .piece img{width:100%;height:100%;object-fit:contain;object-position:left center;display:block}
  /* Never wrapped: a two-line title drops onto the reference number sitting below it, and
     the letterhead is a free canvas, so nothing reflows out of its way. Right-aligned
     overflow runs left into the gap beside the company name. */
  .head .piece[data-piece="docTitle"]{letter-spacing:3px;text-transform:uppercase;white-space:nowrap}
  .parties{display:flex;gap:18px;margin:16px 0 14px}
  .party{flex:1;border:1px solid ${table.border};border-radius:3px;padding:9px 11px}
  .party h3{margin:0 0 5px;font-size:${(type.size * 0.75).toFixed(1)}px;letter-spacing:1.1px;text-transform:uppercase;opacity:.62}
  .party strong{display:block;font-size:${(type.size * 1.04).toFixed(1)}px;margin-bottom:2px}
  .party p{margin:1px 0;font-size:${(type.size * 0.875).toFixed(1)}px;opacity:.85}
  .party p strong{display:inline;font-size:inherit;margin:0}
  .subject{margin:0 0 12px;font-size:${type.size}px}
  .subject strong{color:${type.headingColour}}
  table{width:100%;border-collapse:collapse;font-size:${table.fontSize}px}
  thead th{background:${table.headerBackground};color:${table.headerText};
    font-size:${(table.fontSize * 0.9).toFixed(1)}px;letter-spacing:.6px;text-transform:uppercase;
    padding:${table.padding + 1}px ${table.padding}px;text-align:left;border:1px solid ${table.headerBackground}}
  tbody td{padding:${table.padding}px;border:1px solid ${table.border};vertical-align:top}
  tbody tr:nth-child(even) td{background:${table.stripe}}
  .num{text-align:right;white-space:nowrap}
  .ref{width:52px;white-space:nowrap}
  .unit{width:64px}
  .qty{width:74px}
  .rate,.amount{width:96px}
  tbody tr.section td{background:${table.headerBackground}18;font-weight:700;color:${type.headingColour}}
  tbody tr.subtotal td{background:${table.headerBackground}0e;font-weight:700}
  tfoot td{padding:${table.padding + 1}px ${table.padding}px;border:1px solid ${table.border};font-size:${(table.fontSize * 1.05).toFixed(1)}px}
  tfoot tr.grand td{background:${totals.barBackground};color:${totals.barText};font-weight:700;
    font-size:${(table.fontSize * 1.19).toFixed(1)}px}
  .words{margin:10px 0 0;font-size:${(type.size * 0.92).toFixed(1)}px;border:1px solid ${table.border};padding:8px 10px}
  .terms{margin-top:16px;font-size:${(type.size * 0.875).toFixed(1)}px}
  .terms h4{margin:0 0 5px;font-size:${(type.size * 0.79).toFixed(1)}px;letter-spacing:1.1px;text-transform:uppercase;opacity:.62}
  .terms li{margin-bottom:2px}
  .sign{display:flex;justify-content:space-between;gap:40px;margin-top:34px;font-size:${(type.size * 0.875).toFixed(1)}px}
  .sign div{flex:1;border-top:1px solid #555;padding-top:5px}
  .foot{margin-top:18px;border-top:1px solid ${table.border};padding-top:7px;
    font-size:${(type.size * 0.75).toFixed(1)}px;opacity:.62;display:flex;justify-content:space-between}
  .foot-note{margin:5px 0 0;font-size:${(type.size * 0.75).toFixed(1)}px;opacity:.62;text-align:center}
  .builder{margin:6px 0 0;font-size:${(type.size * 0.71).toFixed(1)}px;opacity:.5;text-align:center;letter-spacing:.3px}
  .bar{position:sticky;top:0;background:${design.accent};color:#fff;padding:9px 14px;display:flex;
    justify-content:space-between;align-items:center;font-size:12px;z-index:5}
  .bar button{font:inherit;font-weight:600;border:0;border-radius:5px;padding:7px 15px;
    background:#b7f334;color:#12200a;cursor:pointer}
  [data-block]{scroll-margin-top:60px}
  /* The positioning wrapper carries the offset only; the block inside keeps its own layout. */
  .placed{display:block}
  .placed > table{width:100%}
  .placed > .parties,.placed > .sign{display:flex}
  @media print{
    html,body{background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .bar{display:none}
    /* The printed page gets its margins from @page, so the sheet itself drops its padding. */
    .sheet{margin:0;box-shadow:none;width:auto;min-height:0;padding:0}
    thead{display:table-header-group}
    tr{page-break-inside:avoid}
    .sign,.words{page-break-inside:avoid}
  }
  @page{size:${page.size};
    margin:${page.margins.top}mm ${page.margins.right}mm ${page.margins.bottom}mm ${page.margins.left}mm}
`;
}


/** The strip at the foot of every document, including the builder's attribution. */
function footer(company, reference, settings) {
  return `<div class="foot" data-block="footer">
    <span>${escape(reference)}</span>
    <span>${escape(company.name)}</span>
  </div>
  ${settings.footerNote ? `<p class="foot-note">${escape(settings.footerNote)}</p>` : ''}
  <p class="builder">${BUILDER}</p>`;
}

/**
 * The letterhead band.
 *
 * Everything in it is placed by coordinate rather than by flow, because the band appears
 * once at the top of the document and never runs onto a second page — so a position set by
 * dragging stays where it was put. Each piece is marked up for the designer to grab.
 */
/*
 * A long document title is shrunk to fit its box rather than allowed to run out of it.
 *
 * The title never wraps — a second line drops onto the reference number below it — so a
 * heading wider than its box overflows sideways instead, and "Contract Commitments" is
 * half again as wide as "Quotation". Rather than let it slide across the company name, the
 * type is stepped down until it fits. The width is estimated from the character count:
 * these are uppercase, letter-spaced and bold, which is regular enough to predict.
 */
const TITLE_TRACKING = 3;
const TITLE_BAND_WIDTH = 680;

function titleSize(element, heading) {
  const text = String(heading || '');
  if (!text) return element.size;
  const available = (element.width / 100) * TITLE_BAND_WIDTH;
  const widthAt = size => text.length * (size * 0.62 + TITLE_TRACKING);
  if (widthAt(element.size) <= available) return element.size;
  const fitted = (available / text.length - TITLE_TRACKING) / 0.62;
  return Math.max(11, Math.floor(fitted * 10) / 10);
}

function letterhead(company, heading, reference, date, design = DEFAULT_DESIGN, visibility = {}) {
  const header = design.header;

  const contents = {
    logo: design.logo.show === false || visibility.logo === false
      ? ''
      : '<img src="/brand/gkuc-mark-256.png" alt="">',
    companyName: visibility.name === false ? '' : escape(company.name),
    companyDetails: [
      ...(visibility.address === false ? [] : lines(company.address)),
      visibility.telephone !== false && company.telephone ? `Telephone: ${escape(company.telephone)}` : '',
      visibility.email !== false && company.email ? escape(company.email) : '',
      visibility.tin !== false && company.tin ? `TIN: ${escape(company.tin)}` : '',
      visibility.vatNumber !== false && company.vatNumber ? `VAT Reg. No: ${escape(company.vatNumber)}` : '',
      visibility.svatNumber !== false && company.svatNumber ? `SVAT No: ${escape(company.svatNumber)}` : ''
    ].filter(Boolean).join('<br>'),
    /* Left in its real case: uppercasing is presentation, and the words themselves
       should stay searchable and copyable as written. */
    docTitle: escape(heading),
    reference: `<strong>No:</strong> ${escape(reference)}`,
    docDate: `<strong>Date:</strong> ${escape(longDate(date))}`
  };

  const pieces = header.elements.filter(element => element.show).map(element => {
    const body = element.custom ? escape(element.text) : contents[element.id];
    if (body === undefined || body === '') return '';
    const align = element.align === 'centre' ? 'center' : element.align;
    /* The logo is sized by its element size; text by its font size. */
    const size = element.id === 'docTitle' ? titleSize(element, heading) : element.size;
    const type = element.id === 'logo'
      ? `height:${element.size}px`
      : `font-size:${size}px;font-weight:${element.weight};line-height:1.35`;
    return `<div class="piece" data-piece="${escape(element.id)}"
      style="left:${element.x}%;top:${element.y}px;width:${element.width}%;
        color:${element.colour};text-align:${align};${type}">${body}</div>`;
  }).join('\n    ');

  return `<div class="head${header.rule ? ' ruled' : ''}" data-block="letterhead"
    style="height:${header.height}px">
    ${pieces}
  </div>`;
}

/** Wraps a document's blocks in the page, in the order the designer put them. */
function page({ design, company, title, heading, reference, date, blocks, settings }) {
  /*
   * Position is applied here rather than baked into each block, so a block does not need to
   * know where in the document it ended up. Space is added above whatever the layout already
   * gives it, which is what makes it useful for nudging one block clear of another.
   */
  const drawn = orderedBlocks(design)
    .map(block => {
      const html = blocks[block.id];
      if (!html) return null;
      const style = [
        block.space ? `margin-top:${block.space}px` : '',
        block.align && block.align !== 'left'
          ? `text-align:${block.align === 'centre' ? 'center' : 'right'}`
          : ''
      ].filter(Boolean).join(';');
      return style ? `<div class="placed" style="${style}">${html}</div>` : html;
    })
    .filter(Boolean)
    .join('\n  ');

  const watermark = design.watermark.text
    ? `<div class="watermark" style="color:${design.watermark.colour};opacity:${design.watermark.opacity};
        font-size:${design.watermark.size}px;transform:rotate(${design.watermark.rotate}deg)">
        ${escape(design.watermark.text)}</div>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>${stylesheet(design)}</style></head>
<body>
<div class="bar">
  <span>Check this over, then print or save it as a PDF.</span>
  <button onclick="window.print()">Print / Save as PDF</button>
</div>
<div class="sheet">
  ${watermark}
  ${drawn}
</div>
</body></html>`;
}

export function quotationDocument({ company, quotation, items, bankAccount, settings: given, design: givenDesign }) {
  const settings = settingsFor(given);
  const design = normaliseDesign(givenDesign);
  const presentation = typeof quotation.presentation === 'string'
    ? (() => { try { return JSON.parse(quotation.presentation); } catch { return null; } })()
    : quotation.presentation;
  const issuer = presentation?.company || company;
  const recipient = presentation?.client || null;
  const issuerShow = presentation?.show?.company || {};
  const recipientShow = presentation?.show?.client || {};

  const markup = Number(quotation.markupPercent || 0);
  const vat = Number(quotation.vatPercent || 0);
  const subtotal = Number(quotation.subtotal || 0);
  const withMarkup = subtotal * (1 + markup / 100);
  const vatAmount = withMarkup * (vat / 100);

  const rows = items.map((item, index) => (item.isSection
    ? `<tr class="section"><td colspan="6">${escape(item.description)}</td></tr>`
    : `<tr>
        <td class="ref">${escape(item.area || item.category || item.reference || index + 1)}</td>
        <td>${escape(item.description)}</td>
        <td class="unit">${escape(item.unit || '')}</td>
        <td class="qty num">${quantity(item.quantity)}</td>
        <td class="rate num">${item.rate === null || item.rate === undefined ? '' : money(item.rate)}</td>
        <td class="amount num">${money(item.amount)}</td>
      </tr>`)).join('');

  const commonNotes = lines(settings.quotationNotes || '');
  const quotationNotes = lines(quotation.notes || '');
  const terms = lines(quotation.terms || settings.quotationTerms || '');
  const paymentTerms = lines(quotation.paymentTerms || '');
  const methods = items.filter(item => item.methodStatement).map(item => ({
    name: item.area || item.category || item.description,
    steps: lines(item.methodStatement)
  }));
  const bank = presentation ? presentation.bank : bankAccount;
  const selectedBank = issuerShow.bankDetails === false ? [] : bank
    ? [bank.label, `Bank: ${bank.bankName}`, bank.branch && `Branch: ${bank.branch}`,
      `Account name: ${bank.accountName}`, `Account number: ${bank.accountNumber}`,
      bank.swiftCode && `SWIFT: ${bank.swiftCode}`].filter(Boolean)
    : lines(issuer.bankDetails || '');

  /* Totals belong to the table, so they travel with it rather than as a block of their own
     — a total floating away from the figures it sums would be worse than useless. */
  const totals = `<tfoot>
      <tr><td colspan="5" class="num">Subtotal</td><td class="num">${money(subtotal)}</td></tr>
      ${markup ? `<tr><td colspan="5" class="num">Overheads &amp; profit @ ${markup}%</td>
        <td class="num">${money(withMarkup - subtotal)}</td></tr>` : ''}
      ${vat ? `<tr><td colspan="5" class="num">VAT @ ${vat}%</td><td class="num">${money(vatAmount)}</td></tr>` : ''}
      <tr class="grand"><td colspan="5" class="num">Total</td><td class="num">${money(quotation.total)}</td></tr>
    </tfoot>`;

  const blocks = {
    letterhead: letterhead(issuer, 'Quotation', quotation.reference, quotation.quoteDate, design, issuerShow),

    parties: `<div class="parties" data-block="parties">
      <div class="party">
        <h3>Quotation for</h3>
        ${recipientShow.name !== false ? `<strong>${escape(recipient?.name || quotation.clientName || '—')}</strong>` : ''}
        ${recipientShow.registrationNumber !== false && recipient?.registrationNumber ? `<p><strong>Registration:</strong> ${escape(recipient.registrationNumber)}</p>` : ''}
        ${recipientShow.tin !== false && (recipient?.tin || (!recipient && quotation.clientTin)) ? `<p><strong>Purchaser TIN:</strong> ${escape(recipient?.tin || quotation.clientTin)}</p>` : ''}
        ${recipientShow.vatNumber !== false && (recipient?.vatNumber || (!recipient && quotation.clientVatNumber)) ? `<p><strong>VAT registration:</strong> ${escape(recipient?.vatNumber || quotation.clientVatNumber)}</p>` : ''}
        ${recipientShow.billingAddress !== false && (recipient?.billingAddress || (!recipient && quotation.clientAddress)) ? `<p><strong>Billing address:</strong> ${lines(recipient?.billingAddress || quotation.clientAddress).join('<br>')}</p>` : ''}
        ${recipientShow.siteAddress !== false && (recipient?.siteAddress || (!recipient && quotation.location)) ? `<p><strong>Location:</strong> ${escape(recipient?.siteAddress || quotation.location)}</p>` : ''}
        ${recipientShow.contactPerson !== false && (recipient?.contactPerson || (!recipient && quotation.contact)) ? `<p><strong>Contact:</strong> ${escape(recipient?.contactPerson || quotation.contact)}</p>` : ''}
        ${recipientShow.phone !== false && (recipient?.phone || (!recipient && quotation.clientPhone)) ? `<p>Telephone: ${escape(recipient?.phone || quotation.clientPhone)}</p>` : ''}
        ${recipientShow.alternatePhone !== false && recipient?.alternatePhone ? `<p>Alternate telephone: ${escape(recipient.alternatePhone)}</p>` : ''}
        ${recipientShow.email !== false && recipient?.email ? `<p>Email: ${escape(recipient.email)}</p>` : ''}
        ${recipientShow.city !== false && recipient?.city ? `<p>City: ${escape(recipient.city)}</p>` : ''}
        ${recipientShow.district !== false && recipient?.district ? `<p>District: ${escape(recipient.district)}</p>` : ''}
        ${recipientShow.province !== false && recipient?.province ? `<p>Province: ${escape(recipient.province)}</p>` : ''}
        ${recipientShow.country !== false && recipient?.country ? `<p>Country: ${escape(recipient.country)}</p>` : ''}
        ${recipientShow.project !== false && (recipient?.project || (!recipient && quotation.project)) ? `<p>Project: ${escape(recipient?.project || quotation.project)}</p>` : ''}
      </div>
      <div class="party">
        <h3>Details</h3>
        ${quotation.validUntil ? `<p><strong>Valid until:</strong> ${escape(longDate(quotation.validUntil))}</p>` : ''}
        ${quotation.boqReference ? `<p><strong>Based on BOQ:</strong> ${escape(quotation.boqReference)}</p>` : ''}
        <p><strong>Prepared by:</strong> ${escape(quotation.preparedBy || '')}</p>
      </div>
    </div>`,

    subject: quotation.title
      ? `<p class="subject" data-block="subject"><strong>Subject:</strong> ${escape(quotation.title)}</p>` : '',

    table: `<table data-block="table">
      <thead><tr>
        <th class="ref">Area</th><th>Description</th><th class="unit">Unit</th>
        <th class="qty num">Qty</th><th class="rate num">Rate (Rs.)</th><th class="amount num">Amount (Rs.)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      ${shows(design, 'totals') ? totals : ''}
    </table>`,

    words: `<p class="words" data-block="words"><strong>Amount in words:</strong>
      ${escape(amountInWords(quotation.total))}</p>`,

    notes: commonNotes.length || quotationNotes.length || methods.length || quotation.additionalNotes
      ? `<div class="terms" data-block="notes">
        ${commonNotes.length || quotationNotes.length ? `<h4>Notes</h4><ul>${[...commonNotes, ...quotationNotes].map(line => `<li>${line}</li>`).join('')}</ul>` : ''}
        ${methods.length ? `<h4>Method</h4>${methods.map(method => `<p><strong>${escape(method.name)}</strong></p><ul>${method.steps.map(step => `<li>${step}</li>`).join('')}</ul>`).join('')}` : ''}
        ${quotation.additionalNotes ? `<h4>Additional notes</h4><ul>${lines(quotation.additionalNotes).map(line => `<li>${line}</li>`).join('')}</ul>` : ''}
      </div>` : '',

    terms: paymentTerms.length || terms.length
      ? `<div class="terms" data-block="terms">
        ${paymentTerms.length ? `<h4>Payment terms</h4><ul>${paymentTerms.map(line => `<li>${line}</li>`).join('')}</ul>` : ''}
        ${terms.length ? `<h4>Terms &amp; conditions</h4><ul>${terms.map(line => `<li>${line}</li>`).join('')}</ul>` : ''}
      </div>` : '',

    bank: selectedBank.length
      ? `<div class="terms" data-block="bank"><h4>Bank details</h4>
        <p>${selectedBank.map(escape).join('<br>')}</p></div>` : '',

    signatures: `<div class="sign" data-block="signatures">
      <div>For and on behalf of ${issuerShow.name === false ? 'the issuing company' : escape(issuer.name)}<br><br>Name &amp; signature</div>
      <div>Accepted by the client<br><br>Name, signature &amp; date</div>
    </div>`,

    footer: footer({ ...issuer, name: issuerShow.name === false ? '' : issuer.name }, quotation.reference, settings)
  };

  return page({
    design, company, blocks, settings,
    title: `${quotation.reference} — ${quotation.clientName || 'Quotation'}`
  });
}

export function invoiceDocument({ company, invoice, items, settings: given, design: givenDesign }) {
  const settings = settingsFor(given);
  const design = normaliseDesign(givenDesign);
  const vat = Number(invoice.vatAmount || 0);
  const gross = Number(invoice.gross || 0);
  const net = Number(invoice.netPayable || 0);
  const rows = items.map((item, index) => `<tr>
    <td class="ref">${index + 1}</td><td>${escape(item.description)}</td>
    <td class="unit">${escape(item.unit || '')}</td><td class="qty num">${quantity(item.quantity)}</td>
    <td class="rate num">${money(item.rate)}</td><td class="amount num">${money(item.amount)}</td>
  </tr>`).join('');
  const totals = `<tfoot>
    <tr><td colspan="5" class="num">Total value of supply excluding VAT</td><td class="num">${money(gross)}</td></tr>
    ${invoice.taxTreatment !== 'Exempt' ? `<tr><td colspan="5" class="num">VAT @ ${money(invoice.vatRate)}%${invoice.taxTreatment === 'SVAT' ? ' (suspended)' : ''}</td><td class="num">${money(vat)}</td></tr>` : ''}
    <tr><td colspan="5" class="num">Total amount including VAT</td><td class="num">${money(gross + vat)}</td></tr>
    ${Number(invoice.retentionAmount) ? `<tr><td colspan="5" class="num">Retention withheld</td><td class="num">-${money(invoice.retentionAmount)}</td></tr>` : ''}
    ${Number(invoice.advanceRecovery) ? `<tr><td colspan="5" class="num">Advance recovered</td><td class="num">-${money(invoice.advanceRecovery)}</td></tr>` : ''}
    ${Number(invoice.otherDeductions) ? `<tr><td colspan="5" class="num">Other deductions</td><td class="num">-${money(invoice.otherDeductions)}</td></tr>` : ''}
    <tr class="grand"><td colspan="5" class="num">Net payable${invoice.taxTreatment === 'SVAT' ? ' (VAT suspended)' : ''}</td><td class="num">${money(net)}</td></tr>
  </tfoot>`;
  const terms = lines(settings.invoiceTerms || '');
  const blocks = {
    letterhead: letterhead(company, invoice.documentType || (invoice.taxTreatment === 'Exempt' ? 'Invoice' : 'Tax Invoice'), invoice.reference, invoice.invoiceDate, design),
    parties: `<div class="parties" data-block="parties">
      <div class="party"><h3>Supplier</h3><strong>${escape(company.name)}</strong>
        ${company.tin ? `<p><strong>TIN:</strong> ${escape(company.tin)}</p>` : ''}
        ${company.address ? `<p>${lines(company.address).join('<br>')}</p>` : ''}
        ${company.telephone ? `<p>Telephone: ${escape(company.telephone)}</p>` : ''}</div>
      <div class="party"><h3>Purchaser</h3><strong>${escape(invoice.client)}</strong>
        ${invoice.buyerTin ? `<p><strong>TIN:</strong> ${escape(invoice.buyerTin)}</p>` : ''}
        ${invoice.buyerVatNumber ? `<p><strong>VAT registration:</strong> ${escape(invoice.buyerVatNumber)}</p>` : ''}
        ${invoice.buyerAddress ? `<p>${lines(invoice.buyerAddress).join('<br>')}</p>` : ''}
        ${invoice.buyerPhone ? `<p>Telephone: ${escape(invoice.buyerPhone)}</p>` : ''}</div>
    </div>`,
    subject: `<div class="subject" data-block="subject"><strong>${escape(invoice.title)}</strong>
      ${invoice.project ? `<p>Project: ${escape(invoice.project)}</p>` : ''}
      ${invoice.deliveryDate ? `<p>Date of delivery: ${escape(longDate(invoice.deliveryDate))}</p>` : ''}
      ${invoice.placeOfSupply ? `<p>Place of supply: ${escape(invoice.placeOfSupply)}</p>` : ''}
      ${invoice.dueDate ? `<p>Payment due: ${escape(longDate(invoice.dueDate))}</p>` : ''}
      ${invoice.paymentMode ? `<p>Mode of payment: ${escape(invoice.paymentMode)}</p>` : ''}
      ${invoice.notes ? `<p>Additional information: ${escape(invoice.notes)}</p>` : ''}</div>`,
    table: `<table data-block="table"><thead><tr><th class="ref">Item</th><th>Description of goods or services</th>
      <th class="unit">Unit</th><th class="qty num">Quantity</th><th class="rate num">Rate (Rs.)</th>
      <th class="amount num">Amount excluding VAT (Rs.)</th></tr></thead><tbody>${rows}</tbody>
      ${shows(design, 'totals') ? totals : ''}</table>`,
    words: `<p class="words" data-block="words"><strong>Total amount in words:</strong> ${escape(amountInWords(net))}</p>`,
    notes: '',
    terms: terms.length ? `<div class="terms" data-block="terms"><h4>Terms &amp; conditions</h4><ul>${terms.map(line => `<li>${line}</li>`).join('')}</ul></div>` : '',
    bank: company.bankDetails ? `<div class="terms" data-block="bank"><h4>Bank details</h4><p>${lines(company.bankDetails).join('<br>')}</p></div>` : '',
    signatures: `<div class="sign" data-block="signatures"><div>For and on behalf of ${escape(company.name)}<br><br>Name &amp; signature</div></div>`,
    footer: footer(company, invoice.reference, settings)
  };
  return page({ design, company, blocks, settings, title: `${invoice.reference} — ${invoice.client}` });
}

export function receiptDocument({ company, receipt, settings: given, design: givenDesign }) {
  const settings = settingsFor(given);
  const design = normaliseDesign(givenDesign);
  const receiptReference = `RCPT-${new Date(receipt.receivedDate).getFullYear()}-${String(receipt.id).padStart(5, '0')}`;
  const blocks = {
    letterhead: letterhead(company, 'Payment Receipt', receiptReference, receipt.receivedDate, design),
    parties: `<div class="parties" data-block="parties"><div class="party"><h3>Received by</h3><strong>${escape(company.name)}</strong>
      ${company.address ? `<p>${lines(company.address).join('<br>')}</p>` : ''}</div>
      <div class="party"><h3>Received from</h3><strong>${escape(receipt.client)}</strong>
      ${receipt.buyerAddress ? `<p>${lines(receipt.buyerAddress).join('<br>')}</p>` : ''}</div></div>`,
    subject: `<div class="subject" data-block="subject"><strong>Payment received for ${escape(receipt.invoiceReference)}</strong>
      <p>Project: ${escape(receipt.project || 'Company account')}</p><p>Invoice: ${escape(receipt.invoiceTitle)}</p>
      <p>Date received: ${escape(longDate(receipt.receivedDate))}</p><p>Method: ${escape(receipt.method)}</p>
      ${receipt.reference ? `<p>Payment reference: ${escape(receipt.reference)}</p>` : ''}</div>`,
    table: `<table data-block="table"><thead><tr><th>Description</th><th class="amount num">Amount (Rs.)</th></tr></thead>
      <tbody><tr><td>Payment toward ${escape(receipt.invoiceReference)}</td><td class="num">${money(receipt.amount)}</td></tr></tbody>
      <tfoot><tr class="grand"><td>Amount received</td><td class="num">${money(receipt.amount)}</td></tr></tfoot></table>`,
    words: `<p class="words" data-block="words"><strong>Amount in words:</strong> ${escape(amountInWords(receipt.amount))}</p>`,
    notes: `<p data-block="notes">Invoice total: Rs. ${money(receipt.netPayable)} &nbsp;·&nbsp; Total received: Rs. ${money(receipt.paidAmount)} &nbsp;·&nbsp; Balance: Rs. ${money(Math.max(0, Number(receipt.netPayable) - Number(receipt.paidAmount)))}</p>`,
    terms: '', bank: '', signatures: `<div class="sign" data-block="signatures"><div>For and on behalf of ${escape(company.name)}<br><br>Authorized signature</div></div>`,
    footer: footer(company, receiptReference, settings)
  };
  return page({ design, company, blocks, settings, title: `${receiptReference} — ${receipt.client}` });
}

export function boqDocument({ company, boq, items, variations = [], settings: given, design: givenDesign }) {
  const settings = settingsFor(given);
  const design = normaliseDesign(givenDesign);

  const groups = [];
  for (const item of items) {
    const name = item.category || 'Items';
    const group = groups.find(entry => entry.name === name) || (groups.push({ name, rows: [] }), groups.at(-1));
    group.rows.push(item);
  }

  const sum = rows => rows.reduce((total, row) => total + Number(row.amount || 0), 0);
  const approved = variations.filter(variation => variation.status === 'Approved');
  const itemsTotal = sum(items);
  const variationsTotal = sum(approved);
  const boqTerms = lines(boq.terms || settings.boqTerms || '');

  let counter = 0;
  const body = groups.map(group => {
    const rows = group.rows.map(item => {
      counter += 1;
      return `<tr>
        <td class="ref">${escape(item.reference || counter)}</td>
        <td>${escape(item.description)}</td>
        <td class="unit">${escape(item.unit || '')}</td>
        <td class="qty num">${quantity(item.quantity)}</td>
        <td class="rate num">${item.rate === null || item.rate === undefined ? '' : money(item.rate)}</td>
        <td class="amount num">${money(item.amount)}</td>
      </tr>`;
    }).join('');
    const subtotal = groups.length > 1
      ? `<tr class="subtotal"><td colspan="5" class="num">Sub-total — ${escape(group.name)}</td>
          <td class="num">${money(sum(group.rows))}</td></tr>`
      : '';
    return `<tr class="section"><td colspan="6">${escape(group.name)}</td></tr>${rows}${subtotal}`;
  }).join('');

  const variationRows = approved.map(variation => `<tr>
      <td class="ref">${escape(variation.reference || '')}</td>
      <td colspan="4">${escape(variation.description)}</td>
      <td class="amount num">${money(variation.amount)}</td>
    </tr>`).join('');

  const totals = `<tfoot>
      ${variationRows ? `<tr><td colspan="5" class="num">Bill of quantities</td>
        <td class="num">${money(itemsTotal)}</td></tr>` : ''}
      <tr class="grand"><td colspan="5" class="num">Total</td>
        <td class="num">${money(itemsTotal + variationsTotal)}</td></tr>
    </tfoot>`;

  const blocks = {
    letterhead: letterhead(company, 'Bill of Quantities', boq.reference, boq.createdAt, design),

    parties: `<div class="parties" data-block="parties">
      <div class="party">
        <h3>Project</h3>
        <strong>${escape(boq.project || '—')}</strong>
        ${boq.title ? `<p>${escape(boq.title)}</p>` : ''}
      </div>
      <div class="party">
        <h3>Status</h3>
        <p><strong>${escape(boq.status)}</strong>${boq.version ? ` · revision ${escape(boq.version)}` : ''}</p>
        <p>Prepared by: ${escape(boq.preparedBy || '')}</p>
        ${boq.approvedBy ? `<p>Approved by: ${escape(boq.approvedBy)}</p>` : ''}
      </div>
    </div>`,

    subject: '',

    table: `<table data-block="table">
      <thead><tr>
        <th class="ref">Item</th><th>Description</th><th class="unit">Unit</th>
        <th class="qty num">Quantity</th><th class="rate num">Rate (Rs.)</th><th class="amount num">Amount (Rs.)</th>
      </tr></thead>
      <tbody>
        ${body}
        ${variationRows ? `<tr class="section"><td colspan="6">Approved variations</td></tr>${variationRows}
          <tr class="subtotal"><td colspan="5" class="num">Sub-total — variations</td>
            <td class="num">${money(variationsTotal)}</td></tr>` : ''}
      </tbody>
      ${shows(design, 'totals') ? totals : ''}
    </table>`,

    words: `<p class="words" data-block="words"><strong>Amount in words:</strong>
      ${escape(amountInWords(itemsTotal + variationsTotal))}</p>`,

    notes: boq.notes
      ? `<div class="terms" data-block="notes"><h4>Notes</h4><p>${lines(boq.notes).join('<br>')}</p></div>` : '',

    terms: boqTerms.length
      ? `<div class="terms" data-block="terms"><h4>Terms &amp; conditions</h4>
        <ul>${boqTerms.map(line => `<li>${line}</li>`).join('')}</ul></div>` : '',

    bank: '',

    signatures: `<div class="sign" data-block="signatures">
      <div>Prepared by — ${escape(boq.preparedBy || '')}<br><br>Signature &amp; date</div>
      <div>${boq.approvedBy ? `Approved by — ${escape(boq.approvedBy)}` : 'Approved by'}<br><br>Signature &amp; date</div>
    </div>`,

    footer: footer(company, boq.reference, settings)
  };

  return page({ design, company, blocks, settings, title: `${boq.reference} — ${boq.title || 'Bill of quantities'}` });
}

/**
 * The affidavit of outstanding contract commitments.
 *
 * Every public bid has to declare what the bidder already has on its hands: each live
 * contract by specialty, its initial amount and the value still outstanding, sworn before
 * a Justice of the Peace. The Sabaragamuwa document is blunt about it — "bidders who do
 * not provide all contract commitment shall be treated as non-responsive".
 *
 * The figures come from the live project register rather than from memory, which is the
 * whole reason for producing it here: the declaration and the accounts cannot disagree.
 */
export function commitmentsDocument({ company, tender, commitments, totals, asAt, settings: given, design: givenDesign }) {
  const settings = settingsFor(given);
  const design = normaliseDesign(givenDesign);

  const bySpecialty = new Map();
  for (const row of commitments) {
    const key = row.specialty || tender?.specialty || 'Buildings';
    if (!bySpecialty.has(key)) bySpecialty.set(key, []);
    bySpecialty.get(key).push(row);
  }

  const groups = [...bySpecialty.entries()].map(([specialty, rows]) => `
    <tr class="section"><td colspan="4">${escape(specialty)}</td></tr>
    ${rows.map(row => `<tr>
      <td>${escape(row.project)}</td>
      <td>${escape(row.client || '')}</td>
      <td class="num">${money(row.initialAmount)}</td>
      <td class="num">${money(row.outstanding)}</td>
    </tr>`).join('')}`).join('');

  const blocks = {
    letterhead: letterhead(company, 'Commitments', tender?.reference || 'Declaration', asAt, design),

    /* The declaration introduces the table, so it travels with the subject line rather than
       in the "terms" block, which every other document places after the figures. */
    subject: `<div class="subject" data-block="subject">
      <p><strong>Subject:</strong> Details of on-going jobs and awarded jobs as at ${escape(longDate(asAt))}
      ${tender ? `— for ${escape(tender.contractNo || tender.reference)}` : ''}</p>
      <p>In accordance with Clause 4.4 of the Instructions to Bidders, I / We declare that the outstanding
      contract commitments of <strong>${escape(tender?.biddingEntity || company.name)}</strong> are as set out
      below, and I / We further declare that all outstanding contract commitments are listed.</p>
    </div>`,

    table: `<table data-block="table">
      <thead><tr>
        <th>Name of the contract</th><th>Name of the client</th>
        <th class="num">Initial contract amount (Rs.)</th><th class="num">Outstanding work (Rs.)</th>
      </tr></thead>
      <tbody>${groups || '<tr><td colspan="4">No contracts are outstanding at this date.</td></tr>'}</tbody>
      <tfoot><tr class="grand">
        <td colspan="2" class="num">Total</td>
        <td class="num">${money(totals.initialAmount)}</td>
        <td class="num">${money(totals.outstanding)}</td>
      </tr></tfoot>
    </table>`,

    signatures: `<div class="signatures" data-block="signatures">
      <div>Signature of the Bidder<br><br>Date</div>
      <div>The foregoing affidavit having been read over and explained to the affirmant,
        signed before me at<br><br>Justice of the Peace</div>
    </div>`,

    footer: footer(company, tender?.reference || 'Contract commitments', settings)
  };

  return page({ design, company, blocks, settings, title: `Contract commitments — ${asAt}` });
}

/** The company identity and presentation settings a document needs, in one call. */
export async function documentContext(getOne, companyId = 1) {
  const [company, settings] = await Promise.all([
    getOne(`SELECT c.name,
      COALESCE(NULLIF(c.address,''),CASE WHEN c.id=1 THEN s.address END,'') address,
      COALESCE(NULLIF(c.telephone,''),CASE WHEN c.id=1 THEN s.telephone END,'') telephone,
      COALESCE(NULLIF(c.email,''),CASE WHEN c.id=1 THEN s.email END,'') email,
      COALESCE(NULLIF(c.tin,''),CASE WHEN c.id=1 THEN s.tin END,'') tin,
      COALESCE(NULLIF(c.vat_number,''),CASE WHEN c.id=1 THEN s.vat_number END,'') vatNumber,
      COALESCE(NULLIF(c.svat_number,''),CASE WHEN c.id=1 THEN s.svat_number END,'') svatNumber,
      COALESCE(NULLIF(c.bank_details,''),CASE WHEN c.id=1 THEN s.bank_details END,'') bankDetails,
      CASE WHEN c.id=1 THEN s.quotation_terms ELSE NULL END quotationTerms
      FROM companies c LEFT JOIN company_settings s ON s.id=1 WHERE c.id=?`, [companyId]),
    getOne(`SELECT accent_colour accentColour,paper_size paperSize,show_logo showLogo,
      show_signatures showSignatures,show_amount_in_words showAmountInWords,
      show_bank_details showBankDetails,footer_note footerNote,
      quotation_notes quotationNotes,quotation_terms quotationTerms,boq_terms boqTerms,invoice_terms invoiceTerms,design
      FROM document_settings WHERE id=1`)
  ]);
  /* MySQL hands JSON back already parsed on some drivers and as text on others. */
  const stored = typeof settings?.design === 'string'
    ? (() => { try { return JSON.parse(settings.design); } catch { return null; } })()
    : settings?.design;

  return {
    company: company || { name: 'G.K.U.C. Construction (Pvt) Ltd' },
    design: normaliseDesign(stored),
    settings: settings && {
      ...settings,
      showLogo: Boolean(settings.showLogo),
      showSignatures: Boolean(settings.showSignatures),
      showAmountInWords: Boolean(settings.showAmountInWords),
      showBankDetails: Boolean(settings.showBankDetails)
    }
  };
}
