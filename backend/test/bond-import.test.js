import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeWorkbook} from '../src/lib/xlsx-write.js';
import {bondColumns,parseBondWorkbook,bondData} from '../src/lib/bond-import.js';

test('bond workbook reads all editable fields, Excel dates and formatted money',()=>{
 const headers=bondColumns.map(([,label])=>label);
 const values={reference:'BND-2026-001',kind:'Cash',beneficiary:'Authority',bank:'Bank',bondNumber:'BG-01',amount:'1,500.50',issuedDate:46023,expiryDate:'2027-12-31',status:'Live',fdReference:'00123',processNotes:'Follow up'};
 const bytes=writeWorkbook([{name:'Bonds',rows:[headers,bondColumns.map(([key])=>values[key]??'')]}]);
 const [row]=parseBondWorkbook(bytes);
 assert.equal(row.data.amount,1500.5);assert.match(row.data.issuedDate,/^2026-/);assert.equal(row.data.fdReference,'00123');assert.equal(row.row,2);
 assert.equal(bondData({amount:'2500.00',project_id:null,expiry_date:'2027-12-31'}).amount,2500);
});
test('bond workbook rejects missing records and duplicate headings',()=>{
 assert.throws(()=>parseBondWorkbook(writeWorkbook([{name:'Notes',rows:[['Unrelated'],['Text']]}])),/No bond rows/);
 assert.throws(()=>parseBondWorkbook(writeWorkbook([{name:'Bonds',rows:[['Amount','Bond number','Amount'],[10,'BG',20]]}])),/Duplicate bond column/);
});
