import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {writeWorkbook} from '../src/lib/xlsx-write.js';
import {specs,readLinkedWorkbook,isLinkedWorkbook,recordCode} from '../src/lib/linked-historical-import.js';

test('linked template parser preserves keys, child line numbers and Excel dates',()=>{
 const bytes=writeWorkbook([{name:'Projects',rows:[['Historical projects'],[],specs.projects.fields.map(f=>'* '+f),specs.projects.fields.map(f=>({PROJECT_CODE:'P-01',CLIENT_CODE:'C-01',START_DATE:45657,PROGRESS_PERCENT:0}[f]??''))]},
 {name:'Project Team',rows:[specs.team.fields,['P-01','E-01','Manager']]}]);
 assert.equal(isLinkedWorkbook('projects',bytes),true);
 const rows=readLinkedWorkbook('projects',bytes);assert.equal(rows.length,2);assert.equal(rows[0].data.PROJECT_CODE,'P-01');assert.equal(rows[0].data.START_DATE,'2024-12-31');assert.equal(rows[0].data.PROGRESS_PERCENT,0);
 assert.equal(rows[1].type,'team');assert.equal(recordCode('items',{BOQ_CODE:'B-01',LINE_NO:'1.2'}),'["B-01","1.2"]');
});
test('supplied 2024 linked workbooks parse without dropping related rows',{skip:!process.env.GKUC_LINKED_TEMPLATE_DIR},async()=>{
 const kinds=['clients','projects','boqs'],names=['01_GKUC_Clients_Import_Template.xlsx','02_GKUC_Projects_Import_Template.xlsx','03_GKUC_BOQs_Import_Template.xlsx'];
 for(let i=0;i<3;i++){
  const bytes=await readFile(`${process.env.GKUC_LINKED_TEMPLATE_DIR}/${names[i]}`);
  assert.equal(isLinkedWorkbook(kinds[i],bytes),true);const rows=readLinkedWorkbook(kinds[i],bytes);
  assert.equal(rows.filter(r=>r.type===kinds[i]).length,11);assert.equal(rows.length,i===2?316:22);
 }
});
