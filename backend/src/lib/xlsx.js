import zlib from 'node:zlib';

/**
 * A minimal reader for .xlsx workbooks — enough to pull cell values out of a sheet, and
 * nothing more.
 *
 * GKUC's fingerprint terminal exports its reports as a workbook rather than a text file,
 * so the attendance import has to be able to open one. A spreadsheet library would do this,
 * but an .xlsx is only a ZIP of XML documents, and the parts needed here are small and
 * well defined: the shared string table, and the cells of one sheet. Reading it directly
 * keeps the project free of dependencies, as with the QR encoder and the upload parser.
 *
 * What is deliberately not supported: styles, formulas (the cached value is used), charts,
 * and anything to do with writing. Dates are returned as their raw serial number; the
 * caller decides what a number means, because only the caller knows the column.
 */

/* ------------------------------------------------------------------ ZIP */

const EOCD_SIGNATURE = 0x06054b50;
const FILE_HEADER_SIGNATURE = 0x02014b50;

/** Locates the end-of-central-directory record, which is at the tail of the file. */
function endOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw Object.assign(new Error('That file is not a readable workbook'), { status: 422 });
}

/** Every entry in the archive, by name, decompressed. */
export function unzip(buffer) {
  const eocd = endOfCentralDirectory(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(pointer) !== FILE_HEADER_SIGNATURE) break;
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);

    /* The local header repeats the name and extra field, with its own lengths. */
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(start, start + compressedSize);

    files.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

/* ------------------------------------------------------------------ XML */

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const decode = text => text.replace(/&(lt|gt|amp|quot|apos|#x?[0-9a-fA-F]+);/g, (whole, code) => {
  if (ENTITIES[code]) return ENTITIES[code];
  const number = code[1] === 'x' || code[1] === 'X'
    ? parseInt(code.slice(2), 16)
    : parseInt(code.slice(1), 10);
  return Number.isFinite(number) ? String.fromCodePoint(number) : whole;
});

/** The workbook's shared strings, which most text cells point at rather than repeat. */
function sharedStrings(files) {
  const xml = files.get('xl/sharedStrings.xml');
  if (!xml) return [];
  const text = xml.toString('utf8');
  const strings = [];
  /* Each <si> is one string, possibly split across several <t> runs. */
  for (const [, item] of text.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let value = '';
    for (const [, run] of item.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) value += decode(run);
    strings.push(value);
  }
  return strings;
}

/** Sheet name → the part inside the archive that holds it. */
function sheetIndex(files) {
  const workbook = (files.get('xl/workbook.xml') || Buffer.alloc(0)).toString('utf8');
  const relations = (files.get('xl/_rels/workbook.xml.rels') || Buffer.alloc(0)).toString('utf8');

  const targets = new Map();
  for (const [, id, target] of relations.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\//, ''));
  }

  const sheets = new Map();
  for (const [, attributes] of workbook.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attributes.match(/name="([^"]*)"/)?.[1];
    const id = attributes.match(/r:id="([^"]*)"/)?.[1];
    if (name && targets.has(id)) sheets.set(decode(name), `xl/${targets.get(id)}`);
  }
  return sheets;
}

/** "BC12" → { row: 12, column: 55 } */
function cellAddress(reference) {
  const match = /^([A-Z]+)(\d+)$/.exec(reference || '');
  if (!match) return null;
  let column = 0;
  for (const character of match[1]) column = column * 26 + (character.charCodeAt(0) - 64);
  return { row: Number(match[2]), column };
}

/**
 * Reads one sheet into a row-major array of arrays, 1-indexed to match what a person sees
 * in Excel, so a position read off the screen is the position used here.
 */
function readSheet(xml, strings) {
  const text = xml.toString('utf8');
  const grid = [];
  let maxColumn = 0;

  /* Lazy, so that the trailing slash of an empty cell — <c r="B3" s="2"/> — is left for the
     alternation to match. Greedy would swallow it and run on to the next cell's </c>. */
  for (const [, attributes, body] of text.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const address = cellAddress(attributes.match(/r="([A-Z]+\d+)"/)?.[1]);
    if (!address) continue;
    const type = attributes.match(/t="([^"]*)"/)?.[1];

    let value = null;
    if (type === 'inlineStr') {
      value = [...(body || '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(m => decode(m[1])).join('');
    } else {
      const raw = (body || '').match(/<v>([\s\S]*?)<\/v>/)?.[1];
      if (raw !== undefined) {
        value = type === 's' ? (strings[Number(raw)] ?? '') : type === 'str' ? decode(raw) : Number(raw);
      }
    }
    if (value === null || value === '') continue;

    (grid[address.row] ||= [])[address.column] = value;
    if (address.column > maxColumn) maxColumn = address.column;
  }

  return { rows: grid, rowCount: grid.length ? grid.length - 1 : 0, columnCount: maxColumn };
}

/** Opens a workbook. `sheet(name)` returns its cells; `names` lists what is inside. */
export function readWorkbook(buffer) {
  const files = unzip(buffer);
  const strings = sharedStrings(files);
  const index = sheetIndex(files);

  return {
    names: [...index.keys()],
    sheet(name) {
      const part = index.get(name);
      if (!part || !files.has(part)) return null;
      return readSheet(files.get(part), strings);
    }
  };
}

/** Excel keeps dates as days since 1899-12-30. */
export const serialToDate = serial => {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000);
  return date.toISOString().slice(0, 10);
};
