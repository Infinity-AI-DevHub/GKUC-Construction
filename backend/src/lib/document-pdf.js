import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const browserCandidates = [process.env.DOCUMENT_PDF_BROWSER_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);

function completePdf(pdf) {
  if (!pdf || pdf.length < 1000 || pdf.subarray(0, 5).toString() !== '%PDF-') return false;
  const tail = pdf.subarray(-2048).toString('latin1');
  const match = tail.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
  if (!match) return false;
  const offset = Number(match[1]);
  if (!Number.isSafeInteger(offset) || offset < 5 || offset >= pdf.length) return false;
  return /^(?:xref\b|\d+\s+\d+\s+obj\b)/.test(pdf.subarray(offset, offset + 40).toString('latin1'));
}

async function browserBinary() {
  for (const candidate of browserCandidates) {
    try { await access(candidate); return candidate; } catch { /* try the next installed browser */ }
  }
  throw Object.assign(new Error('PDF download is not available on this server. Ask an administrator to configure the document PDF browser.'), { status: 503 });
}

/** Prints the same styled HTML used by the preview; no user-controlled URL is opened. */
export async function renderDocumentPdf(html) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gkuc-document-pdf-'));
  try {
    const logo = await readFile(path.join(root, 'frontend/public/brand/gkuc-mark-256.png'));
    const localHtml = html.replaceAll('/brand/gkuc-mark-256.png', `data:image/png;base64,${logo.toString('base64')}`);
    const input = path.join(temporary, 'document.html');
    const output = path.join(temporary, 'document.pdf');
    await writeFile(input, localHtml);
    const binary = await browserBinary();
    const browser = spawn(binary, ['--headless=new', '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--no-first-run', '--no-default-browser-check', '--no-pdf-header-footer',
      ...(process.env.DOCUMENT_PDF_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
      ...(process.platform === 'linux' ? ['--disable-dev-shm-usage'] : []),
      `--user-data-dir=${path.join(temporary, 'profile')}`, `--print-to-pdf=${output}`, pathToFileURL(input).href],
    { stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnostic = '';
    browser.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
    let browserError;
    browser.once('error', error => { browserError = error; });
    try {
      // Chromium's print command does not reliably exit on every host. A bare %%EOF
      // is insufficient too: it can appear before file buffers settle. Require a valid
      // cross-reference pointer plus at least 1.2 seconds of unchanged size/mtime.
      let stableSince = 0, previous = '';
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (browserError) throw browserError;
        const file = await stat(output).catch(() => null);
        if (file) {
          const signature = `${file.size}:${file.mtimeMs}`;
          if (signature !== previous) { previous = signature; stableSince = Date.now(); }
          if (Date.now() - stableSince >= 1200) {
            const pdf = await readFile(output).catch(() => null);
            if (completePdf(pdf) && (await stat(output)).size === pdf.length) return pdf;
          }
        }
        if (browser.exitCode !== null && browser.exitCode !== 0) {
          console.error('PDF renderer exited unsuccessfully', { code: browser.exitCode, diagnostic });
          throw Object.assign(new Error('The PDF renderer could not complete this document. Ask an administrator to check the PDF browser service.'), { status: 503 });
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw Object.assign(new Error('The PDF took too long to prepare or was incomplete. Ask an administrator to check the PDF browser service.'), { status: 503 });
    } finally {
      if (browser.exitCode === null && !browser.killed) browser.kill('SIGKILL');
    }
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

export async function sendDocument(req, res, html, filename) {
  if (req.query.download !== 'pdf' && req.query.preview !== 'pdf') return res.type('html').send(html);
  const pdf = await renderDocumentPdf(html);
  res.type('application/pdf');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `${req.query.preview === 'pdf' ? 'inline' : 'attachment'}; filename="${filename.replace(/[^\w.-]/g, '-')}"`);
  return res.send(pdf);
}
