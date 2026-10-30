import test from 'node:test';
import assert from 'node:assert/strict';
import {canonicalDocumentDownloadPath,pathFromTicketRequest} from '../src/lib/document-download-ticket.js';
test('progress document tickets support only known types and remain bound to the exact document',()=>{
  for(const type of ['application','letter','payment-request','certificate','invoice']){
    const path=canonicalDocumentDownloadPath(`/progress-claims/1/document?type=${type}&preview=pdf`);
    assert.equal(path,`/progress-claims/1/document?preview=pdf&type=${type}`);
    assert.equal(pathFromTicketRequest(`/api${path}&downloadTicket=one-use-token`).path,path);
  }
  assert.equal(canonicalDocumentDownloadPath('/progress-claims/1/document?type=unknown&preview=pdf'),null);
  assert.equal(canonicalDocumentDownloadPath('/progress-claims/1/document?type=letter&type=invoice&preview=pdf'),null);
  assert.equal(canonicalDocumentDownloadPath('/receivables/invoices/1/document?type=letter&preview=pdf'),null);
});
