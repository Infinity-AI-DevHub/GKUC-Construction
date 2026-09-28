import test from 'node:test';
import assert from 'node:assert/strict';
import { api, readableError, openDocument } from './api.js';
import { onNotice } from './notices.js';

test('document preview displays server PDF and prepares a separate one-use download link', async () => {
  const originals = { fetch: globalThis.fetch, window: globalThis.window, sessionStorage: globalThis.sessionStorage,
    createObjectURL: URL.createObjectURL };
  let replacement;
  const button = { tagName: 'BUTTON', before() {}, replaceWith(link) { replacement = link; } };
  const frame = {};
  const tab = { document: { write() {}, open() {}, close() {}, title: 'QUO-2026-0007',
    querySelector: selector => selector === 'iframe' ? frame : button,
    createElement: name => ({ tagName: name.toUpperCase(), style: {}, setAttribute() {}, addEventListener() {} }) },
    addEventListener() {} };
  globalThis.window = { open: () => tab };
  globalThis.sessionStorage = { getItem: () => 'test-token' };
  globalThis.URL.createObjectURL = () => 'blob:document-preview';
  globalThis.fetch = async (path, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    if (path === '/api/document-download-tickets') {
      assert.equal(JSON.parse(options.body).path, '/qs/quotations/7/document?download=pdf');
      return Response.json({url:'/api/qs/quotations/7/document?download=pdf&downloadTicket=test'});
    }
    assert.equal(path, '/api/qs/quotations/7/document?download=pdf');
    return new Response(new Blob([new Uint8Array(1200)], { type: 'application/pdf' }));
  };
  try {
    assert.equal(await openDocument('/qs/quotations/7/document'), true);
    assert.equal(frame.src, 'blob:document-preview');
    for (let i = 0; i < 20 && !replacement; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(replacement.href, '/api/qs/quotations/7/document?download=pdf&downloadTicket=test');
    assert.equal(replacement.textContent, 'Download PDF');
  } finally {
    URL.createObjectURL = originals.createObjectURL;
    globalThis.fetch = originals.fetch;
    globalThis.window = originals.window;
    globalThis.sessionStorage = originals.sessionStorage;
  }
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
