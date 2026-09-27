import test from 'node:test';
import assert from 'node:assert/strict';
import { api, readableError, openDocument } from './api.js';
import { onNotice } from './notices.js';

test('document preview prepares a one-use server PDF link without an asynchronous synthetic click', async () => {
  const originals = { fetch: globalThis.fetch, window: globalThis.window, sessionStorage: globalThis.sessionStorage };
  let replacement;
  const button = { tagName: 'BUTTON', before() {}, replaceWith(link) { replacement = link; } };
  const tab = { document: { write() {}, open() {}, close() {}, title: 'QUO-2026-0007',
    querySelector: () => button, createElement: name => ({ tagName: name.toUpperCase(), style: {}, setAttribute() {}, addEventListener() {} }) },
    addEventListener() {} };
  globalThis.window = { open: () => tab };
  globalThis.sessionStorage = { getItem: () => 'test-token' };
  globalThis.fetch = async (path, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    if (path === '/api/document-download-tickets') {
      assert.equal(JSON.parse(options.body).path, '/qs/quotations/7/document?download=pdf');
      return Response.json({url:'/api/qs/quotations/7/document?download=pdf&downloadTicket=test'});
    }
    return new Response('<html></html>');
  };
  try {
    assert.equal(await openDocument('/qs/quotations/7/document'), true);
    for (let i = 0; i < 20 && !replacement; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(replacement.href, '/api/qs/quotations/7/document?download=pdf&downloadTicket=test');
    assert.equal(replacement.textContent, 'Download PDF');
  } finally { Object.assign(globalThis, originals); }
});

test('validation errors name the field that needs attention', () => {
  assert.match(readableError({ error: 'Invalid data', issues: {
    fieldErrors: { projectId: ['Choose the site for this import'] }, formErrors: []
  } }), /Choose the site for this import/);
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
