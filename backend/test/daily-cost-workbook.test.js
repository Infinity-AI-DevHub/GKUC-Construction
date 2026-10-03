import test from 'node:test';
import assert from 'node:assert/strict';
import { writeWorkbook } from '../src/lib/xlsx-write.js';
import { parseDailyCostWorkbook } from '../src/lib/daily-cost-workbook.js';

test('existing project workbook becomes editable cost lines without importing totals twice', () => {
  const workbook = writeWorkbook([{ name:'Existing work', rows:[
    ['PROJECT COSTS'],
    ['date','work','vehicle cost','','','','','additional','','man power','','material','','','total cost','running total'],
    ['','','name','hr','fuel','cost','total','type','cost','name','cost','type','qty','cost'],
    [46158,'site clearing','excavator',2,1000,4000,5000,'food',1200,'Nimal',2500,'cement',4,9200],
    ['', 'dewatering','pump',1,'',1500,1500,'transport',500,'Kamal',2000],
    ['', '', '', '', '', '',6500,'',1700,'',4500,'','',9200,21900,21900],
    ['', '', '', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', 'summary only',99999]
  ] }]);
  const parsed = parseDailyCostWorkbook(workbook);
  assert.equal(parsed.rows.length,7);
  assert.equal(parsed.rows.reduce((sum,row)=>sum+row.amount,0),21900);
  assert.deepEqual(parsed.rows.map(row=>row.source),
    ['Equipment','Other','Labour','Material','Equipment','Other','Labour']);
  assert.equal(parsed.rows[0].workDate,'2026-05-16');
  assert.equal(parsed.rows[0].sourceRow,4);
  assert.equal(parsed.rows[4].workTask,'dewatering');
  assert.ok(!parsed.rows.some(row=>row.description==='summary only'));
});
