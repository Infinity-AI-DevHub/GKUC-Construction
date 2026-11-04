import test from 'node:test';
import assert from 'node:assert/strict';
import {quotationDocument,invoiceDocument} from '../src/lib/documents.js';
import {printOptions,printOptionsSchema} from '../src/lib/document-print-options.js';
const company={name:'GKUC',address:'Test address'};
const items=[{description:'Test work',unit:'Barrels',quantity:2,rate:333,amount:666}];
const quote={reference:'QUO-RECORD-1',clientName:'Test purchaser',quoteDate:'2026-11-04',total:666};
const opts={printedReference:'SHARED-WORK-42',totals:false,lineAmounts:false,quantity:false};
test('quotation print choices hide totals/words/category totals and share a printed number without changing amounts',()=>{
 for(const calculationMode of ['Combined Total','Separate Category Totals']){
  const html=quotationDocument({company,quotation:{...quote,calculationMode,printOptions:opts},items});
  assert.match(html,/SHARED-WORK-42/);assert.doesNotMatch(html,/QUO-RECORD-1/);
  assert.doesNotMatch(html,/<tfoot>|Amount in words:|class="subtotal"|class="category-total"|class="amount num"|class="qty num"/);
  assert.match(html,/Test work/);assert.match(html,/333.00/);assert.match(html,/Developed by Infinity AI/);
  assert.equal(quote.total,666);
 }
});
test('invoice print choices apply with legacy columns and keep mandatory credit when footer is hidden',()=>{
 const invoice={reference:'INV-QA',client:'Purchaser',invoiceDate:'2026-11-04',gross:666,netPayable:666,taxTreatment:'Exempt',invoiceOptions:{columns:{unit:true,quantity:true,rate:true}},printOptions:{totals:false,lineAmounts:false,rate:false,footer:false}};
 const html=invoiceDocument({company,invoice,items});assert.doesNotMatch(html,/<tfoot>|Total amount in words|class="amount num"|class="rate num"/);assert.match(html,/Barrels/);assert.match(html,/Developed by Infinity AI/);assert.equal(invoice.netPayable,666);
 assert.equal(printOptions({}).totals,true);assert.equal(printOptionsSchema.safeParse({totals:'false'}).success,false);
});

test('rendered quotation PDF omits hidden prices and totals rather than just hiding labels',async t=>{
 const {promisify}=await import('node:util');const exec=promisify((await import('node:child_process')).execFile);
 try{await exec('pdftotext',['-v']);}catch{t.skip('Poppler is required');return;}
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gkuc-hidden-total-'));
 try{
  const html=quotationDocument({company,quotation:{...quote,printOptions:{...opts,rate:false,unit:false}},items});
  const {renderDocumentPdf}=await import('../src/lib/document-pdf.js');const file=path.join(dir,'quote.pdf');await fs.writeFile(file,await renderDocumentPdf(html));
  const {stdout}=await exec('pdftotext',['-layout',file,'-']);assert.match(stdout,/SHARED-WORK-42/);assert.match(stdout,/Test work/);assert.doesNotMatch(stdout,/666.00|333.00|Amount in words|Grand total/);assert.match(stdout,/Developed by Infinity AI/);
 }finally{await fs.rm(dir,{recursive:true,force:true});}
});
