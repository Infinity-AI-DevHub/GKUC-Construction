import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const number = value => {
  if (value === null || value === undefined) return null;
  const match = String(value).match(/-?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|-?\.\d+/);
  if (!match) return null;
  const parsed = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
};

const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
const isNoise = line => !line || /^page\s+\d+\s+of\s+\d+/i.test(clean(line));
const heading = line => {
  const value = clean(line).toLowerCase();
  if (/^preliminaries$/.test(value)) return 'Preliminaries';
  if (/^civil works?$/.test(value)) return 'Civil Works';
  return null;
};

/*
 * Reads the layout text rather than the flattened OCR helper. BOQs exported from Excel
 * use spaces to keep the four numeric columns aligned; retaining those spaces lets us
 * distinguish a wrapped description from the actual item row.
 */
export async function readPdfText(filePath) {
  try {
    const result = await execFileAsync('pdftotext', ['-layout', '-q', filePath, '-'], {
      maxBuffer: 8 * 1024 * 1024
    });
    return String(result.stdout || '');
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('PDF reading is not available on this server. Ask an administrator to install the PDF text reader.');
    }
    throw new Error('This PDF could not be read. It may be damaged or password protected.');
  }
}

/* Columns are read from the right so descriptions may contain numbers and punctuation. */
const rowPattern = /^\s*(\d+(?:\.\d+)?)\s*(.*?)\s{2,}([A-Za-z][A-Za-z0-9²./-]*)\s+([^\s]+)\s+([^\s]+)\s+([\d,]+(?:\.\d{1,2})?)\s*$/;
const subtotalPattern = /\b(sub\s*total|total\s+civil|engineer\s+estimate|grand\s+total|total)\b/i;

function rowFrom(line, sourceRow, category, trailing) {
  const match = line.match(rowPattern);
  if (!match) return null;
  const [, reference, inlineDescription, unit, rawQuantity, rawRate, rawAmount] = match;
  const amount = number(rawAmount);
  const quantity = number(rawQuantity);
  const rate = number(rawRate);
  const problems = [];
  const notices = [];

  /* "Item / Allow" is the conventional way preliminaries are priced in this export. */
  let finalQuantity = quantity;
  let finalRate = rate;
  if (quantity === null && /^item$/i.test(rawQuantity) && /^allow$/i.test(rawRate) && amount !== null) {
    finalQuantity = 1;
    finalRate = amount;
    notices.push('The PDF uses Item / Allow; it was normalised to quantity 1 × the stated amount. Verify this before approving.');
  }
  if (!clean(unit)) problems.push('No unit');
  if (finalQuantity === null) problems.push('Quantity is not a number');
  else if (finalQuantity <= 0) problems.push('Quantity must be more than zero');
  if (finalRate === null) problems.push('Rate is not a number');
  if (amount === null) problems.push('Amount is not a number');

  const description = clean([...trailing, inlineDescription].filter(Boolean).join(' '));
  if (!description) problems.push('No description');

  return {
    sourceRow,
    category: category || 'Imported',
    description: description.slice(0, 300),
    unit: clean(unit).slice(0, 30),
    quantity: finalQuantity,
    rate: finalRate,
    amount,
    method: null,
    notes: reference ? `Source item ${reference}` : null,
    raw: { reference, description, unit, quantity: rawQuantity, rate: rawRate, amount: rawAmount },
    problems,
    notices
  };
}

function metadataFrom(lines) {
  const meaningful = lines.map(clean).filter(Boolean);
  const titleIndex = meaningful.findIndex(value => /bill\s+of\s+quant/i.test(value));
  const title = meaningful.slice(titleIndex + 1).find(value => value && !/^item\s+description/i.test(value)) || null;
  const clientLine = meaningful.find(value => /^(?:client|employer|procuring\s+entity)\s*[:\-]/i.test(value));
  const client = clientLine ? clientLine.replace(/^(?:client|employer|procuring\s+entity)\s*[:\-]\s*/i, '').trim() : null;
  const reference = meaningful.find(value => /^[A-Z0-9][A-Z0-9/.-]{5,}$/.test(value)) || null;
  const locations = meaningful.filter(value => /^:/.test(value)).map(value => value.replace(/^:\s*/, ''));
  /* Do not mistake a tender reference such as 25/01/02 for a document date. */
  const dates = meaningful.join(' ').match(/\b(?:\d{1,2}[/-]\d{1,2}[/-](?:19|20)\d{2}|(?:19|20)\d{2}[/-]\d{1,2}[/-]\d{1,2})\b/g) || [];
  return { title, client, reference, location: locations.join(' · ') || null, documentDate: dates[0] || null };
}

/**
 * Parses a text-layer BOQ PDF into the same staged-row shape used by the Excel importer.
 * It intentionally returns rows with warnings instead of guessing silently: the caller
 * stores them in Review status and a person confirms/corrects them before a BOQ exists.
 */
export async function parseBoqPdf(filePath) {
  let text;
  try { text = await readPdfText(filePath); } catch (error) {
    return { ok: false, error: error.message };
  }
  const lines = text.split(/\r?\n/);
  if (!lines.some(line => clean(line))) {
    return { ok: false, error: 'This PDF contains no readable text. Export a text PDF, or ask an administrator to enable scanned-document OCR.' };
  }

  const metadata = metadataFrom(lines);
  const items = [];
  let category = null;
  let pending = [];
  let current = null;
  const subtotals = [];

  const finish = () => {
    if (!current) return;
    const parsed = rowFrom(current.line, current.sourceRow, current.category,
      [...current.leading, ...current.continuations]);
    if (parsed) items.push(parsed);
    current = null;
  };

  lines.forEach((line, index) => {
    const value = clean(line);
    const section = heading(line) || (clean(line).match(/^\d+\s+(Preliminaries|Civil Works)$/i)?.[1]
      ? clean(line).match(/^\d+\s+(Preliminaries|Civil Works)$/i)[1].replace(/\b\w/g, char => char.toUpperCase())
      : null);
    if (section) {
      finish();
      category = section;
      pending = [];
      return;
    }
    if (isNoise(line) || /^item\s+description\s+units?/i.test(value)) return;
    if (subtotalPattern.test(value)) {
      finish();
      subtotals.push(value);
      pending = [];
      return;
    }
    const looksLikeRow = rowPattern.test(line);
    if (looksLikeRow) {
      finish();
      current = { line, sourceRow: index + 1, category, leading: [...pending], continuations: [] };
      pending = [];
      return;
    }
    if (!value) return;
    /* Heading block text before the first row becomes that row's description. */
    /* A lower-case line immediately after a row is usually a wrapped continuation. Other
       lines are the description that leads into the next numbered row (common in Excel PDF
       exports), so keep them pending rather than attaching them to the previous item. */
    if (current && /^[a-z]/.test(value) && current.continuations.length < 1) current.continuations.push(value);
    else if (!/bill\s+of\s+quant|^\d{4,}\/|^:/.test(value)) pending.push(value);
  });
  finish();

  if (!items.length) {
    return { ok: false, error: 'No priced BOQ rows were found in this PDF. Check that it contains a selectable text table.' };
  }
  return {
    ok: true,
    title: metadata.title,
    client: metadata.client,
    items,
    layout: {
      foreign: true,
      format: 'PDF',
      parser: 'pdftotext-layout',
      reference: metadata.reference,
      location: metadata.location,
      documentDate: metadata.documentDate,
      subtotals,
      notes: ['Read from the PDF text layer. Wrapped descriptions were joined to their item rows.', 'Check every line and document detail before approving.']
    }
  };
}
