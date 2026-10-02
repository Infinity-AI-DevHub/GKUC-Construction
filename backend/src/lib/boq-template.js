import { writeWorkbook, STYLE } from './xlsx-write.js';
import { readWorkbook } from './xlsx.js';
import { chooseSheet } from './boq-detect.js';

/*
 * The bill of quantities template, and reading one back in.
 *
 * The template and the parser are deliberately in the same file: they describe the same
 * agreement about what a column means, and the way that agreement breaks is somebody
 * changing one without the other.
 */

export const CATEGORIES = ['Material', 'Labour', 'Equipment', 'Subcontract', 'Overhead'];

/*
 * The columns, in order.
 *
 * `key` is what the row becomes in the system; `header` is what the estimator reads. The
 * headers are matched case-insensitively and ignoring punctuation when a file is read
 * back, because a spreadsheet that has been through three people will have picked up a
 * stray capital or a trailing space.
 */
export const COLUMNS = [
  { key: 'category', header: 'Category', width: 15, required: false,
    help: 'Optional. If filled, use a saved BOQ category.' },
  { key: 'description', header: 'Description of work', width: 48, required: true,
    help: 'What the item is. This appears on quotations and invoices.' },
  { key: 'unit', header: 'Unit', width: 10, required: true, help: 'e.g. m3, m2, kg, nos, item' },
  { key: 'quantity', header: 'Quantity', width: 12, required: true, help: 'Numbers only' },
  { key: 'rate', header: 'Rate (LKR)', width: 14, required: true, help: 'Price for one unit' },
  { key: 'amount', header: 'Amount (LKR)', width: 16, required: false,
    help: 'Leave blank — the system multiplies quantity by rate' },
  { key: 'method', header: 'Method statement', width: 40, required: false,
    help: 'How the work is carried out. Optional.' },
  { key: 'notes', header: 'Notes', width: 28, required: false, help: 'Anything else. Optional.' }
];

const HEADER_ROW = 8;   /* zero-based: rows 0-6 are the heading block, row 7 is the header */

/** Builds the template workbook a person downloads. */
export function buildTemplate({ company = 'GKUC Construction', title = '', client = '', categories = CATEGORIES } = {}) {
  const head = value => ({ value, style: STYLE.HEADER });
  const note = value => ({ value, style: STYLE.NOTE });
  const cell = value => ({ value, style: STYLE.CELL });

  const rows = [
    [{ value: `${company} — Bill of Quantities`, style: STYLE.PLAIN }],
    [note('Fill in the two boxes below, then list the work from row 9 downwards. Do not delete or reorder the columns.')],
    [],
    [cell('BOQ title'), cell(title || '')],
    [cell('Client'), cell(client || '')],
    [],
    [note('Every row needs Description, Unit, Quantity and Rate. Category is optional. Leave Amount blank — it is worked out for you.')],
    COLUMNS.map(column => head(column.header)),
    /* A worked example, so the shape is obvious without reading instructions. */
    [cell('Material'), cell('Supply and lay 20mm aggregate base course'), cell('m3'),
      { value: 250, style: STYLE.CELL }, { value: 8750, style: STYLE.MONEY }, null,
      cell('Laid in two layers, compacted to 95% MDD.'), cell('Example row — replace or delete it')]
  ];

  /* Blank rows, so the sheet looks ready to type into rather than ready to be extended. */
  for (let i = 0; i < 40; i++) rows.push(COLUMNS.map(() => ({ value: '', style: STYLE.CELL })));

  const guide = [
    [{ value: 'How to fill this in', style: STYLE.PLAIN }],
    [],
    [head('Column'), head('Needed?'), head('What to put in it')],
    ...COLUMNS.map(column => [
      { value: column.header, style: STYLE.CELL },
      { value: column.required ? 'Required' : 'Optional', style: STYLE.CELL },
      { value: column.help, style: STYLE.CELL }
    ]),
    [],
    [note('If you use a category, spell it exactly as shown:')],
    ...categories.map(name => [{ value: name, style: STYLE.CELL }]),
    [],
    [note('When you upload this file the system shows you everything it read, marks anything it could not understand, and lets you correct it on screen before anything is saved.')]
  ];

  return writeWorkbook([
    { name: 'BOQ', rows, columns: COLUMNS.map(column => column.width), freeze: HEADER_ROW + 1 },
    { name: 'Instructions', rows: guide, columns: [26, 14, 70] }
  ]);
}

/* ---- reading a filled-in template ------------------------------------- */

const normalise = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Finds the header row wherever it ended up, so an inserted row does not break the import. */
function locateHeader(rows) {
  const wanted = normalise(COLUMNS[1].header);
  for (let index = 0; index < Math.min(rows.length, 40); index++) {
    const row = rows[index];
    if (!row) continue;
    if (row.some(cell => normalise(cell) === wanted)) return index;
  }
  return -1;
}

/** Maps the sheet's header cells to our column keys, whatever order they are in. */
function mapColumns(headerRow) {
  const map = {};
  headerRow.forEach((cell, index) => {
    const found = COLUMNS.find(column => normalise(column.header) === normalise(cell));
    if (found) map[found.key] = index;
  });
  return map;
}

/*
 * A number as typed by a person: "1,250.00", "Rs. 8,750", "250 m3", an empty cell.
 * Anything that still is not a number after that is reported rather than guessed at.
 */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;

  /*
   * The number is found, not carved out by deleting everything else.
   *
   * Stripping non-digits turned "Rs. 310" into ".310", and so into 0.31 — a rate a
   * thousand times too small, carried silently into a quotation. Matching the number
   * itself leaves the currency word, the unit and the stray full stop where they are.
   */
  const match = String(value).match(/-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|-?\.\d+/);
  if (!match) return null;
  const parsed = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

const matchCategory = (value, categories = CATEGORIES) => {
  const wanted = normalise(value);
  return categories.find(name => normalise(name) === wanted) || null;
};

/**
 * Reads a filled-in template.
 *
 * Nothing is rejected outright. Every row comes back, with whatever could be read and a
 * plain-English note about whatever could not — the person who filled it in is the one who
 * can fix it, and they can only do that if they are told which row and what is wrong.
 */
export function parseBoqWorkbook(buffer, { categories = CATEGORIES } = {}) {
  let workbook;
  try {
    workbook = readWorkbook(buffer);
  } catch {
    return { ok: false, error: 'That file could not be opened as a spreadsheet. Save it as .xlsx and try again.' };
  }

  const layered = readLayeredBoq(workbook);
  if (layered) return layered;

  const sheetName = workbook.names.find(name => normalise(name) === 'boq') || workbook.names[0];
  const sheet = sheetName ? workbook.sheet(sheetName) : null;
  if (!sheet?.rows?.length) {
    return { ok: false, error: 'The spreadsheet has no sheet the system could read.' };
  }

  /* The reader returns a 1-based grid with a leading null, so the shape matches Excel. */
  const rows = sheet.rows;
  const headerIndex = locateHeader(rows);
  if (headerIndex === -1) {
    /*
     * Not our template. Bills arrive from consultants, clients and other contractors in
     * whatever shape their office uses, and refusing them would mean retyping a hundred
     * priced lines by hand. The sheet is examined instead — see boq-detect.js.
     */
    return readForeignWorkbook(workbook, categories);
  }

  const columns = mapColumns(rows[headerIndex]);
  const missing = COLUMNS.filter(column => column.required && columns[column.key] === undefined);
  if (missing.length) {
    return { ok: false, error: `The template is missing these columns: ${missing.map(c => c.header).join(', ')}` };
  }

  /* Title and client sit in the heading block, beside their labels. */
  let title = null;
  let client = null;
  for (let index = 0; index < headerIndex; index++) {
    const row = rows[index] || [];
    for (let column = 0; column < row.length; column++) {
      const label = normalise(row[column]);
      const beside = row[column + 1];
      if (label === 'boqtitle' && beside) title = String(beside).trim();
      if (label === 'client' && beside) client = String(beside).trim();
    }
  }

  const at = (row, key) => (columns[key] === undefined ? null : row[columns[key]] ?? null);
  const items = [];

  for (let index = headerIndex + 1; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    /* A row nobody typed in. Skipped silently — the template ships with 40 of them. */
    const hasAnything = COLUMNS.some(column => {
      const value = at(row, column.key);
      return value !== null && value !== undefined && String(value).trim() !== '';
    });
    if (!hasAnything) continue;

    const problems = [];
    /* Things the person should see but which do not stop the import. */
    const notices = [];
    const description = String(at(row, 'description') ?? '').trim();
    const rawCategory = at(row, 'category');
    const category = matchCategory(rawCategory, categories) || String(rawCategory ?? '').trim() || null;
    const unit = String(at(row, 'unit') ?? '').trim();
    const quantity = toNumber(at(row, 'quantity'));
    const rate = toNumber(at(row, 'rate'));
    const statedAmount = toNumber(at(row, 'amount'));

    if (!description) problems.push('No description');
    else if (description.length > 300) problems.push('Description is longer than 300 characters and will be shortened');

    if (category && !categories.includes(category)) problems.push(`"${rawCategory}" is not one of ${categories.join(', ')}`);

    if (!unit) problems.push('No unit');
    if (quantity === null) problems.push('Quantity is not a number');
    else if (quantity <= 0) problems.push('Quantity must be more than zero');
    if (rate === null) problems.push('Rate is not a number');
    else if (rate < 0) problems.push('Rate cannot be negative');

    const amount = quantity !== null && rate !== null ? Number((quantity * rate).toFixed(2)) : null;
    /*
     * A stated amount that disagrees with quantity times rate is worth saying out loud: it
     * usually means one of the three was edited and the others were not, and the system
     * would otherwise silently overwrite whichever the estimator actually meant.
     */
    if (statedAmount !== null && amount !== null && Math.abs(statedAmount - amount) > 1) {
      notices.push(`The file says ${statedAmount.toLocaleString('en-LK')}; quantity × rate is `
        + `${amount.toLocaleString('en-LK')}, which is what will be used`);
    }

    items.push({
      sourceRow: index + 1,
      category, description: description.slice(0, 300), unit: unit.slice(0, 30),
      quantity, rate, amount,
      method: String(at(row, 'method') ?? '').trim() || null,
      notes: String(at(row, 'notes') ?? '').trim() || null,
      raw: {
        category: rawCategory ?? null, description: at(row, 'description') ?? null,
        unit: at(row, 'unit') ?? null, quantity: at(row, 'quantity') ?? null,
        rate: at(row, 'rate') ?? null, amount: at(row, 'amount') ?? null
      },
      problems, notices
    });
  }

  if (!items.length) {
    return { ok: false, error: 'No priced rows were found. Fill in at least one line below the column headings.' };
  }

  return { ok: true, title, client, items, sheet: sheetName };
}

/* Consultant BOQs often put their control totals ahead of separate detail sheets. Keep
   those controls for reconciliation, but never turn them into additional priced work. */
function readLayeredBoq(workbook) {
  const find = wanted => workbook.names.find(name => normalise(name) === wanted);
  const grand = find('grandsummary');
  const collection = find('summarycollection');
  const prelim = find('preliminaries');
  const measured = find('measuredworks');
  if (![grand, collection, prelim, measured].every(Boolean)) return null;

  const cell = (sheet, row, col) => workbook.sheet(sheet)?.rows?.[row]?.[col] ?? null;
  const summaryRows = (sheet, start, end, labelColumn, amountColumn) => {
    const entries = [];
    for (let row = start; row <= end; row++) {
      const label = String(cell(sheet, row, labelColumn) || '').trim();
      const amount = toNumber(cell(sheet, row, amountColumn));
      if (label && amount !== null) entries.push({ row, label, amount });
    }
    return entries;
  };
  const grandRows = summaryRows(grand, 4, workbook.sheet(grand).rows.length - 1, 1, 3);
  const collectionRows = summaryRows(collection, 5, workbook.sheet(collection).rows.length - 1, 2, 3);
  const grandTotal = grandRows.find(row => normalise(row.label) === 'grandtotal')?.amount;
  const prelimTotal = grandRows.find(row => normalise(row.label) === 'preliminaries')?.amount;
  const measuredTotal = collectionRows.find(row => /totalcarriedtosummary/i.test(normalise(row.label)))?.amount;

  const items = [];
  const sourceSections = [];
  let sequence = 0;
  let section = '';
  const add = (sheet, sheetRow, ref, description, unit, quantity, rate, statedAmount, extra = '') => {
    const amount = quantity !== null && rate !== null ? Number((quantity * rate).toFixed(2)) : null;
    const problems = [];
    const notices = [];
    if (!description) problems.push('No description');
    if (!unit) problems.push('No unit');
    if (quantity === null || quantity <= 0) problems.push('Quantity must be more than zero');
    if (rate === null || rate < 0) problems.push('Rate must be zero or more');
    if (statedAmount !== null && amount !== null && Math.abs(statedAmount - amount) > 1)
      notices.push(`Source amount ${statedAmount.toLocaleString('en-LK')} differs from quantity × rate ${amount.toLocaleString('en-LK')}`);
    if (sheet === prelim) notices.push('The source gives a single amount; imported as quantity 1 at that rate');
    items.push({ sourceRow: ++sequence, sourceSheet: sheet, sheetRow, category: null,
      description: description.slice(0, 300), unit: unit.slice(0, 30), quantity, rate, amount,
      method: null, notes: [`${sheet} row ${sheetRow}`, section, ref ? `Ref ${ref}` : '', extra].filter(Boolean).join(' · ').slice(0, 600),
      raw: { sheet, row: sheetRow, ref, description, unit, quantity, rate, amount: statedAmount },
      problems, notices });
  };

  for (let row = 14; row < workbook.sheet(prelim).rows.length; row++) {
    const ref = cell(prelim, row, 1);
    const description = String(cell(prelim, row, 2) || '').trim();
    const rawAmount = cell(prelim, row, 5);
    if (!description && ref && !toNumber(rawAmount)) { section = String(ref).trim(); sourceSections.push({ sheet: prelim, row, title: section }); continue; }
    if (!description || /total\s+preliminaries/i.test(description)) continue;
    if (String(rawAmount || '').trim().toLowerCase() === 'deleted') {
      sourceSections.push({ sheet: prelim, row, title: `${ref || ''} ${description}`.slice(0, 200), status: 'Deleted in source' });
      continue;
    }
    const amount = toNumber(rawAmount);
    if (amount === null) continue;
    add(prelim, row, ref, description, String(cell(prelim, row, 4) || 'Item'), 1, amount, amount,
      cell(prelim, row, 3) ? `Payment category ${cell(prelim, row, 3)}` : '');
  }
  const prelimCount = items.length;
  section = '';
  for (let row = 3; row < workbook.sheet(measured).rows.length; row++) {
    const ref = cell(measured, row, 1);
    const description = String(cell(measured, row, 2) || '').trim();
    const quantity = toNumber(cell(measured, row, 3));
    const unit = String(cell(measured, row, 4) || '').trim();
    const rate = toNumber(cell(measured, row, 5));
    const statedAmount = toNumber(cell(measured, row, 6));
    if (description && quantity === null && rate === null) {
      if (statedAmount === null && description.length < 120) { section = description; sourceSections.push({ sheet: measured, row, title: section }); }
      continue;
    }
    if (description && (quantity !== null || rate !== null || statedAmount !== null))
      add(measured, row, ref, description, unit, quantity, rate, statedAmount);
  }
  if (!items.length) return { ok: false, error: 'The detail sheets contain no priced BOQ lines.' };
  const prelimAmount = items.slice(0, prelimCount).reduce((sum, item) => sum + (item.amount || 0), 0);
  const measuredAmount = items.slice(prelimCount).reduce((sum, item) => sum + (item.amount || 0), 0);
  const total = prelimAmount + measuredAmount;
  const checks = [
    { label: 'Preliminaries', source: prelimTotal, imported: prelimAmount },
    { label: 'Measured works', source: measuredTotal, imported: measuredAmount },
    { label: 'Grand total', source: grandTotal, imported: total }
  ].map(check => ({ ...check, matches: check.source !== undefined && Math.abs(check.source - check.imported) < 0.02 }));
  return { ok: true, title: String(cell(grand, 2, 1) || '').replace(/^Project:\s*/i, '').slice(0, 180) || null,
    client: null, items, sheet: prelim, layout: { foreign: true, format: 'Layered BOQ',
      sheet: prelim, sheets: [grand, collection, prelim, measured],
      summaries: [{ sheet: grand, rows: grandRows }, { sheet: collection, rows: collectionRows }],
      sections: sourceSections, checks,
      sourceNotes: [
        ...Array.from({ length: 11 }, (_, index) => ({ sheet: prelim, row: index + 2, text: cell(prelim, index + 2, 1) }))
          .filter(note => typeof note.text === 'string' && /^Note\s*\d/i.test(note.text)),
        { sheet: measured, row: 3, text: cell(measured, 3, 2) }
      ].filter(note => note.text),
      notes: checks.filter(check => !check.matches).map(check => `${check.label} does not match the source summary; review the detail lines`) } };
}

/**
 * Reads a bill written on somebody else's template.
 *
 * Comes back in the same shape as a reading of our own, with two differences the reviewer
 * is told about: the category is usually absent, because no other company groups work the
 * way we do, and the rate is sometimes worked back from the amount. Both are marked so the
 * person checking knows which figures the system decided rather than read.
 */
function readForeignWorkbook(workbook, categories = CATEGORIES) {
  const found = chooseSheet(workbook);
  if (!found) {
    return {
      ok: false,
      error: 'The system could not find a bill of quantities in this file. It looks for a row '
        + 'naming the columns — a description, and a quantity or a rate. If the sheet has one, '
        + 'check it is not split across merged cells; otherwise copy the rows into our template.'
    };
  }

  const items = found.items.map(item => {
    const problems = [];
    const notices = [];
    const category = matchCategory(item.category, categories) || String(item.category ?? '').trim() || null;

    if (!item.description) problems.push('No description');
    if (category && !categories.includes(category)) {
      problems.push(`"${item.category}" is not one of ${categories.join(', ')}`);
    }
    if (!item.unit) problems.push('No unit');
    if (item.quantity === null) problems.push('Quantity is not a number');
    else if (item.quantity <= 0) problems.push('Quantity must be more than zero');
    if (item.rate === null) problems.push('No rate, and none could be worked out from the amount');

    const amount = item.quantity !== null && item.rate !== null
      ? Number((item.quantity * item.rate).toFixed(2)) : null;
    if (item.statedAmount !== null && amount !== null && Math.abs(item.statedAmount - amount) > 1) {
      notices.push(`The file says ${item.statedAmount.toLocaleString('en-LK')}; quantity × rate is `
        + `${amount.toLocaleString('en-LK')}, which is what will be used`);
    }
    /* Said plainly: a worked-back rate is arithmetic of ours, not a figure they quoted. */
    if (item.rateDerived) {
      notices.push('The file gave no rate; this one was worked back from the amount ÷ quantity');
    }

    /* Where the line sat in their bill, kept so it can be traced back to their document. */
    const notes = [item.section, item.ref ? `Ref ${item.ref}` : null]
      .filter(Boolean).join(' · ') || null;

    return {
      sourceRow: item.sourceRow,
      category,
      description: String(item.description || '').slice(0, 300),
      unit: (item.unit || '').slice(0, 30),
      quantity: item.quantity,
      rate: item.rate,
      amount,
      method: null,
      notes: notes ? notes.slice(0, 600) : null,
      raw: item.raw,
      problems, notices
    };
  });

  if (!items.length) {
    return { ok: false, error: 'A bill was found in this file but it holds no priced lines.' };
  }

  return {
    ok: true,
    title: null,
    client: null,
    items,
    sheet: found.sheet,
    /* What the reviewer needs in order to trust — or correct — how the sheet was read. */
    layout: {
      foreign: true,
      sheet: found.sheet,
      headerRow: found.headerRow,
      headings: found.headings,
      notes: found.notes
    }
  };
}
