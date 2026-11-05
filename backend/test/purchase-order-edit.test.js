import {test} from 'node:test';
import assert from 'node:assert/strict';
import {poItem,lineAmount,orderTotal,receiptRate} from '../src/lib/purchase-order-edit.js';
import {purchaseOrderDocument} from '../src/lib/documents.js';
test('PO manual amounts and quantity/rate totals are explicit and value partial receipts proportionately',()=>{
 const line={description:'Concrete',unit:'m3',quantity:4,rate:14850,amount:29700};
 assert.equal(poItem.safeParse(line).success,true);assert.equal(lineAmount(line),29700);assert.equal(receiptRate({...line,amount_override:29700}),7425);
 assert.equal(orderTotal([line,{...line,quantity:1,rate:100,amount:null}]),29800);
 assert.equal(poItem.safeParse({...line,quantity:1.0001}).success,false);
});
test('PO sample renderer prints editable fields, multi-row table, exact manual amount and three signoff lines',()=>{
 const html=purchaseOrderDocument({company:{name:'GKUC',address:'Saved address'},order:{reference:'GKUC/Int/91',orderDate:'2026-11-05',total:29700,status:'Issued',procurementRoute:'Purchase order',supplier:'Supplier',site:'Yard',presentation:{documentTitle:'PURCHASE ORDER',attention:'GKUC International',site:'Nelundeniya',paymentText:'Credit',vehicleNumber:'ABC-123',checkedBy:'Checker',approvedBy:'Approver',closing:'Thank you for your cooperation.'}},items:[{itemNo:'1',description:'Concrete',unit:'m3',quantity:4,rate:14850,amount:29700}]});
 for(const text of ['Saved address','GKUC/Int/91','GKUC International','Nelundeniya','ABC-123','Credit','Concrete','29,700.00','14,850.00','Sub Amount','Prepared By','Checked By','Approved By','Checker','Approver','Developed by Infinity AI'])assert.ok(html.includes(text),text);
 assert.match(html,/<tbody><tr>/);assert.ok(!html.includes('59,400.00'));
});
