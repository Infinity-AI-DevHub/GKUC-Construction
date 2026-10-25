import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {progressDocument} from '../../backend/src/lib/documents.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const items=Array.from({length:22},(_,i)=>({code:`D${i+1}`,description:`Measured drainage construction work item ${i+1}`,unit:'m',boqQuantity:100,rate:100,
  previousQuantity:10,previousAmount:1000,quantity:30,current:2000,cumulative:3000}));
items.unshift({code:'A-1',basis:'Note',description:'Preliminaries\nRates are subject to the agreed contract conditions. Insurance and securities are valued separately.',unit:'Note',rate:0,boqQuantity:0,quantity:0,current:0,cumulative:0,previousQuantity:0,previousAmount:0},
  {code:'A-2',basis:'Percentage',description:'Insurance of works and third-party property',unit:'P.S',rate:165000,boqQuantity:1,quantity:1,current:165000,cumulative:165000,previousQuantity:0,previousAmount:0},
  {code:'A-4',basis:'Percentage',description:'Contractor facilities including site office and utilities',unit:'L.Sum',rate:50000,boqQuantity:1,quantity:.8,current:40000,cumulative:40000,previousQuantity:0,previousAmount:0});
const claim={reference:'IPA-QA-0001',document_details:{billNumber:'02',projectReference:'S/232/26',recipientTitle:'Deputy General Manager (Construction)',recipientOrganisation:'Example Land Development Corporation',recipientAddress:'P.O. Box 56\nSri Jayawardenapura Mawatha\nRajagiriya',signatoryName:'Sample Authorised Signatory',signatoryDesignation:'Managing Director',letterBody:'We are pleased to inform you that the work of the above-mentioned project is being carried out.\n\nPlease make the necessary payment arrangements for bill no 02 submitted with this letter.'},application_date:'2042-03-01',period_from:'2042-02-01',period_to:'2042-02-28',project:'Drainage QA project',client:'QA client',
  versionNo:1,source:'QS prepared',approvalStatus:'Internally approved',status:'Certified',submitted_items:items,certified_items:items,submitted_amount:249000,
  certificate_reference:'CLIENT-QA-1',certified_date:'2042-03-02',certification:{retention:2000,advance:1000,other:0,stampDuty:25,vatRate:0,taxBasis:'Gross',vat:0,net:245975,reason:'Verified client certificate'}};
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
const logo=(await readFile(new URL('../public/brand/gkuc-mark-256.png',import.meta.url))).toString('base64');
try{
  for(const type of ['application','letter','certificate']){
    const page=await browser.newPage({viewport:{width:1300,height:1400}});
    const html=progressDocument({company:{name:'QA Construction Company',address:'QA office',telephone:'000000'},claim,type}).replaceAll('/brand/gkuc-mark-256.png',`data:image/png;base64,${logo}`);
    await page.setContent(html);await page.pdf({path:`/tmp/gkuc-progress-${type}.pdf`,format:'A4',preferCSSPageSize:true,printBackground:true});
    await page.screenshot({path:`/tmp/gkuc-progress-${type}.png`,fullPage:true});
    assert.ok(await page.getByText(/Drainage QA project/).count()>0);
    if(type==='application'){assert.ok((await page.textContent('body')).includes('80%'));assert.ok((await page.textContent('body')).includes('40,000.00'));}
    if(type==='letter'){assert.ok((await page.textContent('body')).includes('Deputy General Manager'));assert.ok((await page.textContent('body')).includes('Sample Authorised Signatory'));}
    const overflow=await page.locator('table').evaluateAll(tables=>tables.some(table=>table.getBoundingClientRect().right>document.documentElement.clientWidth));
    assert.equal(overflow,false);await page.close();console.log(`${type}: A4 PDF and document layout checks passed`);
  }
}finally{await browser.close();}
