import test from 'node:test';
import assert from 'node:assert/strict';
import { api, readableError, openDocument, openPrintDocument } from './api.js';
import { onNotice } from './notices.js';

test('document preview uses same-site inline PDF and a separate one-use download link', async () => {
  const originals = { fetch: globalThis.fetch, window: globalThis.window, sessionStorage: globalThis.sessionStorage };
  let replacement;
  const button = { tagName: 'BUTTON', before() {}, replaceWith(link) { replacement = link; } };
  const frame = {};
  const tab = { document: { write() {}, open() {}, close() {}, title: 'QUO-2026-0007',
    querySelector: selector => selector === 'iframe' ? frame : button,
    createElement: name => ({ tagName: name.toUpperCase(), style: {}, setAttribute() {}, addEventListener() {} }) },
    addEventListener() {} };
  globalThis.window = { open: () => tab };
  globalThis.sessionStorage = { getItem: () => 'test-token' };
  const requested = [];
  globalThis.fetch = async (path, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(path, '/api/document-download-tickets');
    const requestedPath = JSON.parse(options.body).path;
    requested.push(requestedPath);
    return Response.json({url:`/api${requestedPath}&downloadTicket=test`});
  };
  try {
    assert.equal(await openDocument('/qs/quotations/7/document'), true);
    assert.equal(frame.src, '/api/qs/quotations/7/document?preview=pdf&downloadTicket=test');
    for (let i = 0; i < 20 && !replacement; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(requested, ['/qs/quotations/7/document?preview=pdf', '/qs/quotations/7/document?download=pdf']);
    assert.equal(replacement.href, '/api/qs/quotations/7/document?download=pdf&downloadTicket=test');
    assert.equal(replacement.textContent, 'Download PDF');
  } finally {
    globalThis.fetch = originals.fetch;
    globalThis.window = originals.window;
    globalThis.sessionStorage = originals.sessionStorage;
  }
});

test('print documents authenticate, resolve local branding and wait for assets before printing', async () => {
  const originals={fetch:globalThis.fetch,window:globalThis.window,sessionStorage:globalThis.sessionStorage};
  let written='',printed=false,decoded=false;
  const tab={document:{write:html=>{written=html;},open(){},close(){},images:[{decode:async()=>{decoded=true;}}],fonts:{ready:Promise.resolve()}},focus(){},print(){assert.equal(decoded,true);printed=true;},close(){}};
  globalThis.window={open:()=>tab,location:{origin:'https://siteops.example'}};
  globalThis.sessionStorage={getItem:()=> 'test-token'};
  globalThis.fetch=async(path,options)=>{
    assert.equal(path,'/api/progress-claims/7/document?type=letter');
    assert.equal(options.headers.Authorization,'Bearer test-token');
    return new Response('<html><head></head><body>Request for Payment</body></html>',{headers:{'content-type':'text/html'}});
  };
  try{assert.equal(await openPrintDocument('/progress-claims/7/document?type=letter'),true);assert.equal(printed,true);assert.match(written,/<base href="https:\/\/siteops.example\/">/);}
  finally{Object.assign(globalThis,originals);}
});

test('Safari opens the inline PDF directly instead of a blank embedded frame', async () => {
  const originals = { fetch: globalThis.fetch, window: globalThis.window, sessionStorage: globalThis.sessionStorage };
  let destination = '';
  globalThis.window = { navigator: { userAgent: 'Mozilla/5.0 Version/18.0 Safari/605.1.15' },
    open: () => ({ document: { write() {} }, location: { replace: url => { destination = url; } }, close() {} }) };
  globalThis.sessionStorage = { getItem: () => 'test-token' };
  globalThis.fetch = async (_path, options) => {
    assert.equal(JSON.parse(options.body).path, '/receivables/receipts/9/document?preview=pdf');
    return Response.json({ url: '/api/receivables/receipts/9/document?preview=pdf&downloadTicket=test' });
  };
  try {
    assert.equal(await openDocument('/receivables/receipts/9/document'), true);
    assert.equal(destination, '/api/receivables/receipts/9/document?preview=pdf&downloadTicket=test');
  } finally { Object.assign(globalThis, originals); }
});

test('validation errors name the field that needs attention', () => {
  assert.match(readableError({ error: 'Invalid data', issues: {
    fieldErrors: { projectId: ['Choose the site for this import'] }, formErrors: []
  } }), /Choose the site for this import/);
});

test('a valid JSON null response means no saved record, not a malformed response', async () => {
  const originalFetch = globalThis.fetch;
  const originalSession = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null };
  globalThis.fetch = async () => Response.json(null);
  try {
    assert.equal(await api('/employees/1/bank-account'), null);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.sessionStorage = originalSession;
  }
});

test('API failures show a plain-language notice even when the caller swallows the error', async () => {
  const originalFetch = globalThis.fetch;
  const originalSession = globalThis.sessionStorage;
  const notices = [];
  const unsubscribe = onNotice(item => notices.push(item));
  globalThis.sessionStorage = { getItem: () => null };
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Invalid data', issues: {
    fieldErrors: { workLocation: ['Please choose a work location'] }, formErrors: []
  } }), { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    await assert.rejects(api('/test/validation'), /Please choose a work location/);
    assert.match(notices[0].message, /Please choose a work location/);
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
    globalThis.sessionStorage = originalSession;
  }
});

test('biometric form data is sent without a JSON content type', async () => {
  const originalFetch = globalThis.fetch;
  const originalSession = globalThis.sessionStorage;
  globalThis.sessionStorage = { getItem: () => null };
  globalThis.fetch = async (_path, options) => {
    assert.equal(options.headers['Content-Type'], undefined);
    assert.ok(options.body instanceof FormData);
    return new Response(JSON.stringify({ rows: [] }), { status: 200 });
  };
  try {
    await api('/biometric/preview', { method: 'POST', body: new FormData() });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.sessionStorage = originalSession;
  }
});
