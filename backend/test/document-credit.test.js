import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {withDeveloperCredit,DEVELOPER_CREDIT} from '../src/lib/developer-credit.js';
import {invoiceDocument} from '../src/lib/documents.js';
import {payslipDocument} from '../src/lib/payroll-export.js';
import {employeeLetterHtml} from '../src/lib/employee-letters.js';
import {renderDocumentPdf} from '../src/lib/document-pdf.js';
const exec=promisify(execFile);
const company={name:'GKUC Construction',address:'Test office address'};
const invoice=invoiceDocument({company,invoice:{reference:'INV-CREDIT',invoiceDate:'2026-11-04',clientName:'Credit QA',subtotal:40000,total:40000},items:Array.from({length:70},(_,i)=>({description:`Work item ${i+1}`,quantity:1,rate:1000,amount:1000})),design:{blocks:[{id:'footer',show:false}]}});
const run={company:'GKUC Construction',reference:'PAY-CREDIT',periodStart:'2026-10-01',periodEnd:'2026-10-31',status:'Draft',payFrequency:'Monthly'};
const slip={employee:'Synthetic Employee',employeeCode:'CREDIT-QA',basic:45000,netPay:45000,daysPresent:25,calculationDetail:{salary:{dailyRate:1800},sourceAttendance:[],attendance:[]},components:Array.from({length:60},(_,i)=>({name:`Approved allowance ${i+1}`,kind:'Allowance',amount:100}))};
const payslip=payslipDocument(run,slip);
test('mandatory developer credit survives hidden company footer and is idempotent',()=>{
  assert.equal((invoice.match(/data-developer-credit="end"/g)||[]).length,1);
  assert.equal(withDeveloperCredit(invoice),invoice);
  assert.ok(invoice.includes(DEVELOPER_CREDIT));assert.doesNotMatch(invoice,/Built by Infinity/);
  assert.match(payslip,/data-developer-credit="every-page"/);assert.match(payslip,/@bottom-center/);
  const letter=employeeLetterHtml({company,employee:{name:'QA',code:'QA',joinDate:'2025-01-01'},type:'one-year',milestone:'2026-01-01',issuedOn:'2026-11-04',signer:'HR'});
  assert.ok(letter.includes(DEVELOPER_CREDIT));
  const old='<html><head></head><body><article class="paper">Archived letter</article></body></html>';
  assert.match(withDeveloperCredit(old),/data-developer-credit="end">[^<]+<\/p><\/article>/);
});
test('actual multi-page PDF prints credit once at document end, but on every payslip page',async t=>{
  try{await exec('pdftotext',['-v']);await exec('pdfinfo',['-v']);}catch{t.skip('Poppler is required for actual PDF text checks');return;}
  const directory=await mkdtemp(path.join(os.tmpdir(),'gkuc-credit-'));
  try{
    for(const [name,html,repeated] of [['invoice',invoice,false],['payslip',payslip,true]]){
      const file=path.join(directory,`${name}.pdf`);await writeFile(file,await renderDocumentPdf(html));
      const {stdout}=await exec('pdftotext',['-layout',file,'-']);const pages=stdout.split('\f').filter(page=>page.trim());
      assert.ok(pages.length>=2,`${name} exercises page breaks`);
      pages.forEach((text,index)=>assert.equal(text.split(DEVELOPER_CREDIT).length-1,repeated||index===pages.length-1?1:0,`${name} page ${index+1}`));
      if(process.env.GKUC_LAYOUT_ARTIFACT_DIR){await mkdir(process.env.GKUC_LAYOUT_ARTIFACT_DIR,{recursive:true});await writeFile(path.join(process.env.GKUC_LAYOUT_ARTIFACT_DIR,`${name}-credit.pdf`),await import('node:fs/promises').then(fs=>fs.readFile(file)));}
    }
  }finally{await rm(directory,{recursive:true,force:true});}
});
