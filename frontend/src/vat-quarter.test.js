import{test}from'node:test';import assert from'node:assert/strict';import{quarterBounds,quarterCountdown,vatBusinessToday}from'./vat-quarter.js';
test('VAT countdown follows selected quarter and handles last day, ended quarters and year rollover',()=>{
 assert.deepEqual(quarterBounds('2026-11-09'),{label:'Q4 2026',start:'2026-10-01',end:'2026-12-31'});
 assert.equal(quarterCountdown('2026-12-31','2026-11-09').days,52);
 assert.equal(quarterCountdown('2026-12-31','2026-12-31').state,'Ends today');
 assert.equal(quarterCountdown('2026-12-31','2027-01-01').state,'Ended');
 assert.equal(quarterCountdown('2026-12-31','2027-01-01').days,0);
 assert.equal(quarterBounds('2028-02-29').end,'2028-03-31');
 assert.equal(quarterBounds('2026-02-30'),null);assert.equal(quarterBounds(''),null);
});
test('VAT business date changes at Sri Lanka midnight',()=>{
 assert.equal(vatBusinessToday(new Date('2026-11-09T18:29:59Z')),'2026-11-09');
 assert.equal(vatBusinessToday(new Date('2026-11-09T18:30:00Z')),'2026-11-10');
});
