import {test} from 'node:test';
import assert from 'node:assert/strict';
import {pausedApiFeature,pausedPageFeature,pausedTabFeature} from '../src/lib/temporary-features.mjs';
import {temporaryFeatureMiddleware} from '../src/lib/temporary-feature-middleware.js';
test('temporary pause covers lists, records, writes, imports and PDF paths',()=>{
 for(const [path,key]of [['/payroll/1/payslips/1/document','hr'],['/employees/1','hr'],['/attendance/bulk','hr'],['/biometric/commit','hr'],['/hr/leave-register','hr'],['/hiring/1/hire','hr'],['/insurance','hr'],['/api/receivables/bonds/import/3/submit','bonds'],['/receivables/petty-cash/2/entries','pettyCash'],['/finance/daily-expenses','expenses'],['/finance/office-expense-payments','expenses'],['/boq/cost-control/expenses/2','expenses'],['/BOQ/1/document?download=pdf','boqs'],['/boq/imports/1/commit','boqs'],['/receivables/invoices/1/receipts','invoices'],['/receivables/quotation-terms/2/invoice','invoices'],['/progress-claims/2/document?type=invoice','invoices'],['/api/%62oq/1','boqs']])assert.equal(pausedApiFeature(path),key,path);
});
test('unrelated operational modules and remaining finance endpoints stay available',()=>{
 for(const path of ['/auth/login','/fleet','/tasks','/finance/income','/finance/summary','/receivables/cheques','/qs/quotations','/boq/cost-control','/boq/cost-control/daily-sheets','/progress-claims/2/document?type=application'])assert.equal(pausedApiFeature(path),null,path);
});
test('all roles and verbs receive a non-cacheable lock, including download ticket requests',()=>{
 for(const role of ['Managing Director','Administrator','Finance / Accounts','Read-Only Viewer'])for(const method of ['GET','POST','PATCH','PUT','DELETE']){
  let code,body,cache;temporaryFeatureMiddleware({originalUrl:'/api/boq/1',path:'/boq/1',user:{role},method},{setHeader:(k,v)=>cache=v,status:c=>(code=c,{json:b=>body=b})},()=>assert.fail('must not reach route'));
  assert.equal(code,423);assert.equal(body.code,'FEATURE_TEMPORARILY_DISABLED');assert.equal(cache,'no-store');assert.equal(body.error,'Error in local machine');assert.equal(body.detail,'Error in windows operating system');assert.match(body.solution,/administrator.*separate drivers/);
 }
 let blocked=false;temporaryFeatureMiddleware({originalUrl:'/api/document-download-tickets',path:'/document-download-tickets',body:{path:'/receivables/invoices/1/document?download=pdf'}},{setHeader(){},status:()=>({json:()=>blocked=true})},()=>assert.fail('ticket must not be issued'));assert.equal(blocked,true);
});
test('navigation pause covers deep links and section pickers',()=>{
 assert.equal(pausedPageFeature('/people/86'),'hr');assert.equal(pausedPageFeature('/finance/petty-cash?record=2'),'pettyCash');assert.equal(pausedPageFeature('/quantity-surveying/bills-of-quantities'),'boqs');
 for(const tab of ['Bonds','Petty cash','Invoices','Expenses','Bills of quantities','BOQ & estimates'])assert.ok(pausedTabFeature(tab));
 assert.equal(pausedTabFeature('Quotations'),null);assert.equal(pausedPageFeature('/finance/income'),null);
});
