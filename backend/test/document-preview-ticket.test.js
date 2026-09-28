import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalDocumentDownloadPath, pathFromTicketRequest } from '../src/lib/document-download-ticket.js';

test('commercial PDF preview and download tickets remain separately path-bound', () => {
  const preview = '/receivables/receipts/9/document?preview=pdf';
  const download = '/receivables/receipts/9/document?download=pdf';
  assert.equal(canonicalDocumentDownloadPath(preview), preview);
  assert.equal(canonicalDocumentDownloadPath(download), download);
  assert.equal(canonicalDocumentDownloadPath('/receivables/receipts/9/document?preview=pdf&download=pdf'), null);
  assert.equal(canonicalDocumentDownloadPath('/finance/expenses?preview=pdf'), null);
  assert.equal(pathFromTicketRequest(`/api${preview}&downloadTicket=${'a'.repeat(64)}`).path, preview);
});
