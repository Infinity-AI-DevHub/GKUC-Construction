import { writeWorkbook, STYLE } from './xlsx-write.js';
import { readWorkbook } from './xlsx.js';

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
  { key: 'category', header: 'Category', width: 15, required: true,
    help: `One of: ${CATEGORIES.join(', ')}` },
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
export function buildTemplate({ company = 'GKUC Construction', title = '', client = '' } = {}) {
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
    [note('Every row below needs a Category, Description, Unit, Quantity and Rate. Leave Amount blank — it is worked out for you.')],
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
    [note('Categories must be spelled exactly as shown:')],
    ...CATEGORIES.map(name => [{ value: name, style: STYLE.CELL }]),
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

const matchCategory = value => {
  const wanted = normalise(value);
  return CATEGORIES.find(name => normalise(name) === wanted) || null;
};

/**
 * Reads a filled-in template.
 *
 * Nothing is rejected outright. Every row comes back, with whatever could be read and a
 * plain-English note about whatever could not — the person who filled it in is the one who
 * can fix it, and they can only do that if they are told which row and what is wrong.
 */
export function parseBoqWorkbook(buffer) {
  let workbook;
  try {
    workbook = readWorkbook(buffer);
  } catch {
    return { ok: false, error: 'That file could not be opened as a spreadsheet. Save it as .xlsx and try again.' };
  }

  const sheetName = workbook.names.find(name => normalise(name) === 'boq') || workbook.names[0];
  const sheet = sheetName ? workbook.sheet(sheetName) : null;
  if (!sheet?.rows?.length) {
    return { ok: false, error: 'The spreadsheet has no sheet the system could read.' };
  }

  /* The reader returns a 1-based grid with a leading null, so the shape matches Excel. */
  const rows = sheet.rows;
  const headerIndex = locateHeader(rows);
  if (headerIndex === -1) {
    return {
      ok: false,
      error: 'This does not look like the BOQ template — no "Description of work" column was found. '
        + 'Download a fresh template and copy your rows into it.'
    };
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
    const category = matchCategory(rawCategory);
    const unit = String(at(row, 'unit') ?? '').trim();
    const quantity = toNumber(at(row, 'quantity'));
    const rate = toNumber(at(row, 'rate'));
    const statedAmount = toNumber(at(row, 'amount'));

    if (!description) problems.push('No description');
    else if (description.length > 300) problems.push('Description is longer than 300 characters and will be shortened');

    if (!rawCategory) problems.push('No category');
    else if (!category) problems.push(`"${rawCategory}" is not one of ${CATEGORIES.join(', ')}`);

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
