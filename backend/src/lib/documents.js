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
function letterhead(company, heading, reference, date, design = DEFAULT_DESIGN) {
  const header = design.header;

  const contents = {
    logo: design.logo.show === false
      ? ''
      : '<img src="/brand/gkuc-mark-256.png" alt="">',
    companyName: escape(company.name),
    companyDetails: [
      ...lines(company.address),
      company.telephone ? `Telephone: ${escape(company.telephone)}` : '',
      company.email ? escape(company.email) : '',
      company.tin ? `TIN: ${escape(company.tin)}` : '',
      company.vatNumber ? `VAT Reg. No: ${escape(company.vatNumber)}` : ''
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
    const type = element.id === 'logo'
      ? `height:${element.size}px`
      : `font-size:${element.size}px;font-weight:${element.weight};line-height:1.35`;
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

export function quotationDocument({ company, quotation, items, settings: given, design: givenDesign }) {
  const settings = settingsFor(given);
  const design = normaliseDesign(givenDesign);

  const markup = Number(quotation.markupPercent || 0);
  const vat = Number(quotation.vatPercent || 0);
  const subtotal = Number(quotation.subtotal || 0);
  const withMarkup = subtotal * (1 + markup / 100);
  const vatAmount = withMarkup * (vat / 100);

  const rows = items.map((item, index) => (item.isSection
    ? `<tr class="section"><td colspan="6">${escape(item.description)}</td></tr>`
    : `<tr>
        <td class="ref">${escape(item.reference || index + 1)}</td>
        <td>${escape(item.description)}</td>
        <td class="unit">${escape(item.unit || '')}</td>
        <td class="qty num">${quantity(item.quantity)}</td>
        <td class="rate num">${item.rate === null || item.rate === undefined ? '' : money(item.rate)}</td>
        <td class="amount num">${money(item.amount)}</td>
      </tr>`)).join('');

  const terms = lines(quotation.terms || settings.quotationTerms || '');

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
    letterhead: letterhead(company, 'Quotation', quotation.reference, quotation.quoteDate, design),

    parties: `<div class="parties" data-block="parties">
      <div class="party">
        <h3>Quotation for</h3>
        <strong>${escape(quotation.clientName || '—')}</strong>
        ${quotation.project ? `<p>Project: ${escape(quotation.project)}</p>` : ''}
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
        <th class="ref">Item</th><th>Description</th><th class="unit">Unit</th>
        <th class="qty num">Quantity</th><th class="rate num">Rate (Rs.)</th><th class="amount num">Amount (Rs.)</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      ${shows(design, 'totals') ? totals : ''}
    </table>`,

    words: `<p class="words" data-block="words"><strong>Amount in words:</strong>
      ${escape(amountInWords(quotation.total))}</p>`,

    notes: quotation.notes
      ? `<div class="terms" data-block="notes"><h4>Notes</h4><p>${lines(quotation.notes).join('<br>')}</p></div>` : '',

    terms: terms.length
      ? `<div class="terms" data-block="terms"><h4>Terms &amp; conditions</h4>
        <ul>${terms.map(line => `<li>${line}</li>`).join('')}</ul></div>` : '',

    bank: company.bankDetails
      ? `<div class="terms" data-block="bank"><h4>Bank details</h4>
        <p>${lines(company.bankDetails).join('<br>')}</p></div>` : '',

    signatures: `<div class="sign" data-block="signatures">
      <div>For and on behalf of ${escape(company.name)}<br><br>Name &amp; signature</div>
      <div>Accepted by the client<br><br>Name, signature &amp; date</div>
    </div>`,

    footer: footer(company, quotation.reference, settings)
  };

  return page({
    design, company, blocks, settings,
    title: `${quotation.reference} — ${quotation.clientName || 'Quotation'}`
  });
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

/** The company identity and presentation settings a document needs, in one call. */
export async function documentContext(getOne) {
  const [company, settings] = await Promise.all([
    getOne(`SELECT name,address,telephone,email,tin,vat_number vatNumber,bank_details bankDetails,
      quotation_terms quotationTerms FROM company_settings WHERE id=1`),
    getOne(`SELECT accent_colour accentColour,paper_size paperSize,show_logo showLogo,
      show_signatures showSignatures,show_amount_in_words showAmountInWords,
      show_bank_details showBankDetails,footer_note footerNote,
      quotation_terms quotationTerms,boq_terms boqTerms,invoice_terms invoiceTerms,design
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
