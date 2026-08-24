import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { scratchDir } from './storage.js';
import { unzip } from './xlsx.js';

const run = promisify(execFile);

/*
 * Reading the text inside scanned documents and photographs.
 *
 * Tesseract and Poppler are called as programs rather than pulled in as libraries. That
 * keeps the zero-dependency rule this codebase follows, and — more importantly for the
 * documents involved — every page stays on this server. Tenders, payslips and identity
 * documents are never sent to a third party to be read.
 *
 * Two kinds of file arrive. A PDF may already carry a text layer, in which case extracting
 * it is instant and perfectly accurate; only when it does not is it a scan, and the pages
 * are rendered to images and read. Photographs go straight to the reader.
 */

/** Languages to read. Sinhala and Tamil need their traineddata installed to be useful. */
const LANGUAGES = process.env.OCR_LANGUAGES || 'eng';

/* A scan of a long bidding document should not tie up the machine indefinitely. */
const PAGE_TIMEOUT_MS = Number(process.env.OCR_PAGE_TIMEOUT_MS || 120000);
const MAX_PAGES = Number(process.env.OCR_MAX_PAGES || 100);

/** Anything below this is not a text layer, it is a scan with a stray caption on it. */
const TEXT_LAYER_MIN_CHARS = 120;

/* Scans and photographs: the character recogniser is the only way in. */
const OCR_TYPES = new Set([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'
]);

/*
 * Formats whose text can simply be read. Recognising characters from a picture of text
 * would be a strange thing to do to a file that already contains the text — it is slower
 * and it introduces mistakes. These are read directly instead.
 */
const TEXT_TYPES = new Set(['text/plain', 'text/csv']);
const ZIP_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);

export const canOcr = mime => OCR_TYPES.has(mime) || TEXT_TYPES.has(mime) || ZIP_TYPES.has(mime);

/** Strips XML tags, keeping the words and the breaks between them. */
const stripXml = xml => xml
  .replace(/<(w:p|w:br|w:tab|\/row|\/c)\b[^>]*>/g, ' \n')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/**
 * Reads a Word document or a spreadsheet.
 *
 * Both are zip containers of XML. Word keeps its text in one document part; a spreadsheet
 * keeps most of its strings in a shared table, with the sheets referring to them by number.
 * Taking the shared strings gets the words without having to rebuild the grid, which is
 * what searching needs.
 */
function readOfficeDocument(buffer, mime) {
  const files = unzip(buffer);
  const parts = [];
  if (mime.includes('wordprocessingml')) {
    const document = files.get('word/document.xml');
    if (document) parts.push(stripXml(document.toString('utf8')));
  } else {
    const shared = files.get('xl/sharedStrings.xml');
    if (shared) parts.push(stripXml(shared.toString('utf8')));
    for (const [name, content] of files) {
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) parts.push(stripXml(content.toString('utf8')));
    }
  }
  return parts.join('\n');
}

let availability = null;

/**
 * Whether the tools are installed. Checked once and remembered: the answer cannot change
 * while the process runs, and the alternative is spawning two processes per document just
 * to ask.
 */
export async function ocrAvailable() {
  if (availability) return availability;
  /*
   * Each tool is asked the way it actually answers, and the reply is matched on a version
   * number rather than any particular wording. pdftoppm treats --version as a filename and
   * reports an I/O error; tesseract prints "tesseract 5.5.3" and never uses the word
   * "version" at all. Both write to stdout or stderr depending on the build.
   */
  const has = async (command, args) => {
    const looksLikeVersion = text => /\d+\.\d+/.test(text);
    try {
      const { stdout, stderr } = await run(command, args, { timeout: 5000 });
      return looksLikeVersion(`${stdout}${stderr}`);
    } catch (error) {
      return looksLikeVersion(`${error.stdout || ''}${error.stderr || ''}`);
    }
  };
  const [tesseract, poppler] = await Promise.all([
    has('tesseract', ['--version']),
    has('pdftoppm', ['-v'])
  ]);
  availability = {
    tesseract,
    poppler,
    ready: tesseract,
    /* Without Poppler a scanned PDF cannot be rendered to pages, so only images can be read. */
    detail: tesseract
      ? (poppler ? null : 'Poppler is not installed, so scanned PDFs cannot be read — only photographs')
      : 'Tesseract is not installed on this server, so nothing can be read from scans'
  };
  return availability;
}

/** Resets the cached answer. Used by the tests, which install and remove the tools. */
export const forgetAvailability = () => { availability = null; };

const clean = text => text
  .replace(/\r\n?/g, '\n')
  /* Tesseract leaves ragged spacing that makes the text hard to search and hard to read. */
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/** Reads one image file. */
async function readImage(imagePath) {
  const { stdout } = await run('tesseract', [imagePath, 'stdout', '-l', LANGUAGES], {
    timeout: PAGE_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024
  });
  return stdout;
}

/**
 * Reads a PDF: its own text layer if it has one, otherwise page by page as images.
 *
 * Trying the text layer first is not an optimisation so much as a correctness choice — a
 * PDF produced by a computer carries its text exactly, and running that same page through
 * a character recogniser can only introduce mistakes.
 */
async function readPdf(pdfPath) {
  try {
    const { stdout } = await run('pdftotext', ['-layout', '-q', pdfPath, '-'], {
      timeout: PAGE_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024
    });
    if (clean(stdout).length >= TEXT_LAYER_MIN_CHARS) {
      return { text: stdout, source: 'text-layer', pages: null };
    }
  } catch { /* no pdftotext, or an unreadable file: fall through to rendering */ }

  const { poppler } = await ocrAvailable();
  if (!poppler) {
    throw Object.assign(new Error('This PDF is a scan, and Poppler is not installed to render it'),
      { code: 'NO_POPPLER' });
  }

  const base = scratchDir();
  await fsp.mkdir(base, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(base, 'ocr-'));
  try {
    /* 300dpi greyscale: what tesseract reads best, and far smaller than colour. */
    await run('pdftoppm', ['-r', '300', '-gray', '-png', '-l', String(MAX_PAGES), pdfPath, path.join(dir, 'page')], {
      timeout: PAGE_TIMEOUT_MS * 4
    });
    const pages = (await fsp.readdir(dir)).filter(name => name.endsWith('.png')).sort();
    const parts = [];
    for (const page of pages) parts.push(await readImage(path.join(dir, page)));
    return { text: parts.join('\n\n'), source: 'ocr', pages: pages.length };
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Extracts the text of one stored file.
 *
 * Returns the text, how it was obtained and how many pages were read. Throws only on a
 * genuine failure; a document with nothing readable in it comes back as empty text, which
 * is a legitimate answer and is recorded as such.
 */
export async function extractText(filePath, mime) {
  if (!canOcr(mime)) return { text: '', source: 'unsupported', pages: null };

  /* These carry their own text and need no recogniser — and no tesseract installed. */
  if (TEXT_TYPES.has(mime)) {
    return { text: clean(await fsp.readFile(filePath, 'utf8')), source: 'text-layer', pages: null };
  }
  if (ZIP_TYPES.has(mime)) {
    return { text: clean(readOfficeDocument(await fsp.readFile(filePath), mime)), source: 'text-layer', pages: null };
  }

  const { ready } = await ocrAvailable();
  if (!ready) throw Object.assign(new Error('OCR is not available on this server'), { code: 'NO_TESSERACT' });

  const result = mime === 'application/pdf'
    ? await readPdf(filePath)
    : { text: await readImage(filePath), source: 'ocr', pages: 1 };

  return { ...result, text: clean(result.text) };
}
