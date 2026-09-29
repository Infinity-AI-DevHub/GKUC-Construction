import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestSteps,orderSteps} from './purchasing-workflow.js';
import {tenderSteps,payrollSteps,clientCollectionSteps} from './workflow-paths.js';

test('a purchase request reveals its next responsibility as actual records advance',()=>{
  const request={reference:'PR-1',status:'Pending',quotes:[],orders:[]};
  assert.equal(requestSteps(request).find(step=>!step.done&&!step.skipped).label,'Approval');
  request.status='Approved';
  assert.equal(requestSteps(request).find(step=>!step.done&&!step.skipped).label,'Supplier quotations');
  request.quotes=[{id:1}];
  assert.equal(requestSteps(request).find(step=>!step.done&&!step.skipped).label,'Purchase order');
  request.orders=[{id:2,reference:'PO-1',status:'Issued',invoiceCount:0,unpaidInvoiceCount:0}];
  assert.equal(requestSteps(request).find(step=>!step.done&&!step.skipped).label,'Goods received');
  request.orders[0].status='Received';
  assert.equal(requestSteps(request).find(step=>!step.done&&!step.skipped).label,'Invoice verified');
});

test('a direct order skips an absent request and does not claim payment is complete',()=>{
  const steps=orderSteps({reference:'PO-2',status:'Received',requestId:null,receipts:[{id:1}],invoices:[{status:'Unpaid'}]});
  assert.equal(steps[0].skipped,true);
  assert.equal(steps.find(step=>!step.done&&!step.skipped).label,'Invoice verified');
  assert.equal(steps.at(-1).done,false);
});

test('supplier invoice verification and payment remain separate steps',()=>{
  const order={reference:'PO-3',status:'Received',requestId:1,receipts:[{id:1}],invoices:[{status:'Unpaid',verifiedAt:'2026-09-29'}]};
  assert.equal(orderSteps(order).find(step=>step.label==='Invoice verified').done,true);
  assert.equal(orderSteps(order).find(step=>step.label==='Payment').done,false);
});

test('tender, payroll and collection paths reflect the authoritative statuses',()=>{
  assert.equal(tenderSteps({reference:'T-1',status:'Preparing',checklist:[{mandatory:true,done:false}]}).find(step=>step.label==='Mandatory documents checked').done,false);
  assert.equal(payrollSteps({status:'Draft',payslips:[{}]}).find(step=>step.label==='Salary sheet approved').done,false);
  assert.equal(payrollSteps({status:'Paid',payslips:[{}]}).at(-1).done,true);
  assert.equal(clientCollectionSteps({reference:'INV-1',status:'Part paid',outstanding:500},[{id:1}]).at(-1).done,false);
});
