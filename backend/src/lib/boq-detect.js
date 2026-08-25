/*
 * Reading a bill of quantities that was not written on our template.
 *
 * Bills arrive from consultants, clients and other contractors, and no two are laid out the
 * same way. The columns are called different things — "Particulars", "Item Description",
 * "Desc" — they appear in different orders, the headings start three or ten rows down under
 * a title block, and the body is broken up by section headings and subtotals that are not
 * priced items at all.
 *
 * So nothing here is assumed. The sheet is examined: which row looks like a heading row,
 * which column holds what, and then — the part that matters — whether the data underneath
 * actually behaves that way. A column called "Qty" that holds words is not a quantity
 * column, whatever it says at the top.
 */

/*
 * What each column might be called. Matched against a squashed form of the heading, so
 * "Rate (Rs.)", "RATE  Rs", and "rate_rs" all reduce to the same thing.
 *
 * `exact` beats `partial`, which is what stops "Item No" being read as the description
 * simply because the word "item" appears in both.
 */
const COLUMN_HINTS = {
  ref: {
    exact: ['item', 'itemno', 'itemnumber', 'no', 'nos', 'slno', 'sno', 'serial', 'sr', 'srno', 'code', 'billno', 'refno', 'ref'],
    partial: ['itemno', 'serialno']
  },
  description: {
    exact: ['description', 'descriptionofwork', 'descriptionofworks', 'desc', 'particulars',
      'particular', 'itemdescription', 'workdescription', 'details', 'scopeofwork', 'work', 'works'],
    partial: ['description', 'particular', 'scope']
  },
  unit: {
    exact: ['unit', 'units', 'uom', 'um', 'measure', 'unitofmeasure'],
    partial: ['unitofmeas']
  },
  quantity: {
    exact: ['quantity', 'qty', 'qnty', 'quantum', 'estimatedquantity', 'estqty', 'qtynos'],
    partial: ['quantity', 'qty']
  },
  rate: {
    exact: ['rate', 'unitrate', 'price', 'unitprice', 'rateperunit', 'raters', 'ratelkr', 'ratelkrs'],
    partial: ['rate', 'unitprice']
  },
  amount: {
    exact: ['amount', 'total', 'value', 'cost', 'amountrs', 'amountlkr', 'totalamount', 'totalrs', 'extension'],
    partial: ['amount', 'total', 'value']
  },
  category: {
    exact: ['category', 'type', 'trade', 'class', 'classification', 'group'],
    partial: ['categor', 'trade']
  }
};

/* Every column we try to place, in the order they are competed for. */
const KEYS = ['description', 'quantity', 'rate', 'amount', 'unit', 'ref', 'category'];

const squash = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const isBlank = value => value === null || value === undefined || String(value).trim() === '';

/**
 * A number as written by a person: "1,250.00", "Rs. 8,750", "250 m3", "(1,200)" for a
 * negative. Returns null when there is no number in there at all.
 */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  const negative = /^\(.*\)$/.test(text);
  const match = text.match(/-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|-?\.\d+/);
  if (!match) return null;
  const parsed = Number(match[0].replace(/,/g, ''));
  if (!Number.isFinite(parsed)) return null;
  return negative ? -Math.abs(parsed) : parsed;
}

/**
 * Whether a cell is a number, as opposed to text that happens to contain digits.
 *
 * Deciding what a column holds must not use the lenient reader below. "Supply and fix 12mm
 * plywood formwork" contains a number, and treating that as numeric made every description
 * column look like a figures column — so the description was thrown away on every bill
 * whose items mention a size, which is to say all of them.
 */
function looksNumeric(value) {
  if (value === null || value === undefined || value === '') return false;
  if (typeof value === 'number') return Number.isFinite(value);
  const text = String(value).trim()
    .replace(/^[(\[]|[)\]]$/g, '')          /* (1,200) — a negative in accounting style */
    .replace(/^(?:rs|lkr|usd)\.?\s*/i, '')   /* a currency word in front of the figure */
    .replace(/[,\s]/g, '');
  return /^-?\d+(?:\.\d+)?$/.test(text);
}

/** How well one heading cell matches one column type. Higher is better; 0 is no match. */
function scoreHeading(cell, key) {
  const text = squash(cell);
  if (!text) return 0;
  const hints = COLUMN_HINTS[key];
  if (hints.exact.includes(text)) return 10;
  /* A heading like "Rate (Rs.)" squashes to "raters", which is on the exact list; this
     catches the longer ones such as "Estimated Quantity in m3". */
  for (const hint of hints.partial) if (text.includes(hint)) return 5;
  return 0;
}

/**
 * Picks the row that looks most like a heading row.
 *
 * A title block above it may itself contain words like "Bill of Quantities", so rows are
 * judged on how many *different* column types they name, not on any single word.
 */
function findHeaderRow(rows, limit = 60) {
  let best = { index: -1, score: 0, mapping: null };

  for (let index = 0; index < Math.min(rows.length, limit); index++) {
    const row = rows[index];
    if (!row) continue;
    const filled = row.filter(cell => !isBlank(cell)).length;
    if (filled < 2) continue;

    const mapping = mapRow(row);
    const distinct = Object.keys(mapping).length;
    if (distinct < 2) continue;

    /*
     * A heading row must at least name something to price. Weighted so that a row naming
     * description, quantity and rate beats one that happens to say "Total" twice.
     */
    let score = distinct * 2;
    if (mapping.description !== undefined) score += 5;
    if (mapping.quantity !== undefined) score += 3;
    if (mapping.rate !== undefined) score += 3;
    if (mapping.amount !== undefined) score += 1;
    /* Earlier rows are likelier to be the heading than a repeat further down. */
    score -= index * 0.05;

    if (score > best.score) best = { index, score, mapping };
  }
  return best;
}

/** Assigns each heading cell to the column type it matches best, without collisions. */
function mapRow(row) {
  const candidates = [];
  row.forEach((cell, column) => {
    for (const key of KEYS) {
      const score = scoreHeading(cell, key);
      if (score) candidates.push({ key, column, score });
    }
  });
  /* Strongest claims settled first, so "Item No" takes ref before description sees it. */
  candidates.sort((a, b) => b.score - a.score || a.column - b.column);

  const mapping = {};
  const taken = new Set();
  for (const candidate of candidates) {
    if (mapping[candidate.key] !== undefined || taken.has(candidate.column)) continue;
    mapping[candidate.key] = candidate.column;
    taken.add(candidate.column);
  }
  return mapping;
}

/**
 * Checks the guess against the data, and corrects it.
 *
 * This is what makes the difference between reading an unfamiliar sheet and merely hoping.
 * A column named "Qty" holding words is not a quantity; a numeric column nobody labelled
 * may well be the amount. Numbers are counted down the column and the mapping adjusted.
 */
function verifyWithData(rows, headerIndex, mapping, columnCount) {
  const sample = rows.slice(headerIndex + 1, headerIndex + 200).filter(Boolean);
  const numericShare = column => {
    let filled = 0;
    let numeric = 0;
    for (const row of sample) {
      const value = row?.[column];
      if (isBlank(value)) continue;
      filled += 1;
      if (looksNumeric(value)) numeric += 1;
    }
    return filled < 3 ? null : numeric / filled;
  };
  const textShare = column => {
    const share = numericShare(column);
    return share === null ? null : 1 - share;
  };

  const corrected = { ...mapping };
  const notes = [];

  /* A "quantity" or "rate" column that is mostly words was mislabelled or misread. */
  for (const key of ['quantity', 'rate', 'amount']) {
    const column = corrected[key];
    if (column === undefined) continue;
    const share = numericShare(column);
    if (share !== null && share < 0.5) {
      notes.push(`the "${key}" column holds mostly text, so it was ignored`);
      delete corrected[key];
    }
  }

  /* A description column that is mostly numbers is really a reference column. */
  if (corrected.description !== undefined) {
    const share = textShare(corrected.description);
    if (share !== null && share < 0.4) {
      notes.push('the column taken for the description held mostly numbers');
      delete corrected.description;
    }
  }

  /*
   * Nothing named the description. The widest column of text is what a person reads as the
   * description, so that is what is used.
   */
  if (corrected.description === undefined) {
    let bestColumn = -1;
    let bestLength = 0;
    for (let column = 0; column < columnCount; column++) {
      if (Object.values(corrected).includes(column)) continue;
      const lengths = sample.map(row => (isBlank(row?.[column]) ? 0 : String(row[column]).trim().length));
      const filled = lengths.filter(Boolean);
      if (filled.length < 3) continue;
      const average = filled.reduce((sum, n) => sum + n, 0) / filled.length;
      const share = textShare(column);
      if (share !== null && share > 0.6 && average > bestLength) {
        bestLength = average;
        bestColumn = column;
      }
    }
    if (bestColumn >= 0) {
      corrected.description = bestColumn;
      notes.push('no column was named as the description, so the longest text column was used');
    }
  }

  return { mapping: corrected, notes };
}

/*
 * Rows that are not priced items.
 *
 * A real bill is full of them: section headings, "Total carried to summary", page totals,
 * "brought forward". Importing those as items would put a subtotal into the bill as though
 * it were work to be done, and double the value of everything above it.
 */
const SUBTOTAL_WORDS = /\b(sub\s*total|subtotal|total|carried\s+(to|forward)|brought\s+forward|c\/?f|b\/?f|page\s+total|grand\s+total|summary|collection)\b/i;

const classify = (row, mapping) => {
  const description = mapping.description === undefined ? '' : String(row[mapping.description] ?? '').trim();
  const quantity = mapping.quantity === undefined ? null : toNumber(row[mapping.quantity]);
  const rate = mapping.rate === undefined ? null : toNumber(row[mapping.rate]);
  const amount = mapping.amount === undefined ? null : toNumber(row[mapping.amount]);

  const priced = quantity !== null || rate !== null;
  if (!description && !priced && amount === null) return 'blank';
  /* A total line carries a figure and a word saying what it totals, but no quantity. */
  if (SUBTOTAL_WORDS.test(description) && quantity === null) return 'subtotal';
  /* Words alone, with nothing priced against them, introduce a section. */
  if (description && !priced && amount === null) return 'section';
  if (!description && priced) return 'item';
  return 'item';
};

/**
 * Reads a bill of quantities out of a sheet that was not written on our template.
 *
 * Returns the rows it could make sense of, what it decided each column was, and the notes
 * explaining any decision it had to make — so the person checking it can see how the sheet
 * was read rather than being asked to trust it.
 */
export function detectBoq(sheet) {
  const rows = (sheet?.rows || []).map(row => (row ? row.slice(1) : row));   /* drop the 1-based pad */
  if (!rows.length) return { ok: false, error: 'That sheet is empty.' };

  /* The grid is sparse — a blank line in the sheet leaves a hole — and spreading a hole
     into Math.max yields NaN, so the lengths are collected explicitly. */
  const lengths = [];
  for (const row of rows) lengths.push(row ? row.length : 0);
  const columnCount = lengths.length ? Math.max(...lengths) : 0;
  const header = findHeaderRow(rows);
  if (header.index === -1) {
    return {
      ok: false,
      error: 'No row in this sheet looks like column headings. The system needs a row naming '
        + 'at least the description and either a quantity or a rate.'
    };
  }

  const verified = verifyWithData(rows, header.index, header.mapping, columnCount);
  const mapping = verified.mapping;
  if (mapping.description === undefined) {
    return { ok: false, error: 'No column in this sheet holds anything that reads as a description of work.' };
  }

  const at = (row, key) => (mapping[key] === undefined ? null : row[mapping[key]] ?? null);
  const items = [];
  let section = null;

  for (let index = header.index + 1; index < rows.length; index++) {
    const row = rows[index];
    if (!row) continue;
    const kind = classify(row, mapping);
    if (kind === 'blank') continue;

    if (kind === 'section') {
      section = String(at(row, 'description')).trim().slice(0, 200);
      continue;
    }
    if (kind === 'subtotal') continue;

    const quantity = toNumber(at(row, 'quantity'));
    const rate = toNumber(at(row, 'rate'));
    const statedAmount = toNumber(at(row, 'amount'));
    /*
     * Some bills give the amount and the quantity but leave the rate implied. Working it
     * back is exact and saves the reviewer retyping it.
     */
    const derivedRate = rate === null && statedAmount !== null && quantity ? statedAmount / quantity : null;

    items.push({
      sourceRow: index + 1,
      section,
      ref: at(row, 'ref') === null ? null : String(at(row, 'ref')).trim().slice(0, 40) || null,
      category: mapping.category === undefined ? null : String(at(row, 'category') ?? '').trim() || null,
      description: String(at(row, 'description') ?? '').trim(),
      unit: String(at(row, 'unit') ?? '').trim().slice(0, 30) || null,
      quantity,
      rate: rate ?? (derivedRate === null ? null : Number(derivedRate.toFixed(2))),
      rateDerived: rate === null && derivedRate !== null,
      statedAmount,
      raw: {
        ref: at(row, 'ref'), description: at(row, 'description'), unit: at(row, 'unit'),
        quantity: at(row, 'quantity'), rate: at(row, 'rate'), amount: at(row, 'amount')
      }
    });
  }

  return {
    ok: true,
    headerRow: header.index + 1,
    columns: Object.fromEntries(Object.entries(mapping).map(([key, column]) => [key, column + 1])),
    headings: Object.fromEntries(Object.entries(mapping)
      .map(([key, column]) => [key, String(rows[header.index]?.[column] ?? '').trim()])),
    notes: verified.notes,
    items
  };
}

/** Picks the sheet in a workbook that most looks like the bill. */
export function chooseSheet(workbook) {
  let best = { name: null, result: null, score: -1 };
  for (const name of workbook.names) {
    const sheet = workbook.sheet(name);
    if (!sheet?.rows?.length) continue;
    const result = detectBoq(sheet);
    if (!result.ok) continue;
    /* The bill itself has more priced lines than a summary or a cover sheet. */
    const score = result.items.filter(item => item.quantity !== null || item.rate !== null).length;
    if (score > best.score) best = { name, result, score };
  }
  return best.name ? { sheet: best.name, ...best.result } : null;
}
