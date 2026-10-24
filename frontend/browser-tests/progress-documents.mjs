import assert from 'node:assert/strict';
import {progressDocument} from '../../backend/src/lib/documents.js';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const items=Array.from({length:22},(_,i)=>({code:`D${i+1}`,description:`Measured drainage construction work item ${i+1}`,unit:'m',boqQuantity:100,rate:100,
  previousQuantity:10,previousAmount:1000,quantity:30,current:2000,cumulative:3000}));
const claim={reference:'IPA-QA-0001',application_date:'2042-03-01',period_from:'2042-02-01',period_to:'2042-02-28',project:'Drainage QA project',client:'QA client',
  versionNo:1,source:'QS prepared',approvalStatus:'Internally approved',status:'Certified',submitted_items:items,certified_items:items,submitted_amount:44000,
  certificate_reference:'CLIENT-QA-1',certified_date:'2042-03-02',certification:{retention:2000,advance:1000,other:0,stampDuty:25,vatRate:0,taxBasis:'Gross',vat:0,net:40975,reason:'Verified client certificate'}};
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
try{
  for(const type of ['application','letter','certificate']){
    const page=await browser.newPage({viewport:{width:1300,height:1400}});
    const html=progressDocument({company:{name:'QA Construction Company',address:'QA office',telephone:'000000'},claim,type});
    await page.setContent(html);await page.pdf({path:`/tmp/gkuc-progress-${type}.pdf`,format:'A4',preferCSSPageSize:true,printBackground:true});
    await page.screenshot({path:`/tmp/gkuc-progress-${type}.png`,fullPage:true});
    assert.ok(await page.getByText('Drainage QA project',{exact:true}).count()>0);
    const overflow=await page.locator('table').evaluateAll(tables=>tables.some(table=>table.getBoundingClientRect().right>document.documentElement.clientWidth));
    assert.equal(overflow,false);await page.close();console.log(`${type}: A4 PDF and document layout checks passed`);
  }
}finally{await browser.close();}
