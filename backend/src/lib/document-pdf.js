import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../');
const browserCandidates = [process.env.DOCUMENT_PDF_BROWSER_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);

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
      `--user-data-dir=${path.join(temporary, 'profile')}`, `--print-to-pdf=${output}`, pathToFileURL(input).href],
    { stdio: 'ignore' });
    let browserError;
    browser.on('error', error => { browserError = error; });
    try {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        if (browserError) throw browserError;
        const pdf = await readFile(output).catch(() => null);
        if (pdf?.subarray(0, 5).toString() === '%PDF-' && pdf.subarray(-20).toString().includes('%%EOF')) return pdf;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw Object.assign(new Error('The PDF took too long to prepare. Try again or ask an administrator for help.'), { status: 503 });
    } finally {
      if (browser.exitCode === null) {
        const stopped = new Promise(resolve => browser.once('exit', resolve));
        browser.kill('SIGTERM');
        await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 3000))]);
        if (browser.exitCode === null) browser.kill('SIGKILL');
      }
    }
  } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

export async function sendDocument(req, res, html, filename) {
  if (req.query.download !== 'pdf') return res.type('html').send(html);
  const pdf = await renderDocumentPdf(html);
  res.type('application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename.replace(/[^\w.-]/g, '-')}"`);
  return res.send(pdf);
}
