import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0vat-ledgers-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import VatSchedules from '/src/pages/VatSchedules.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(React.createElement('main',null,React.createElement(VatSchedules,{companyId:1,company:{name:'GKUC Construction'},can:{finance:!location.search.includes('readonly')}})));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'vat-ledgers-fixture',resolveId:v=>v==='/__vat.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__vat?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__vat.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});let periods=[],entries=[];
    const schedule=()=>({period:periods[0]||{status:'Draft'},totals:{adjustedOutputVat:entries.length*180,adjustedInputVat:0,netVatPayable:entries.length*180},output:entries,input:[],historicalSvat:[],svatAllowed:false});
    await page.route('**/api/finance/vat**',async route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.pathname.endsWith('/periods')){
        if(req.method()==='POST'){const body=req.postDataJSON();periods=[{id:1,...body,status:'Draft'}];return route.fulfill({status:201,json:schedule()})}
        return route.fulfill({json:periods});
      }
      if(url.pathname.endsWith('/entries')){
        const body=req.postDataJSON();assert.equal(body.companyId,1);assert.equal(body.direction,'Output');
        entries=[{id:'vat-manual-1',source:'Manual VAT entry',documentDate:body.documentDate,documentNumber:body.documentNumber,counterparty:body.counterparty,
          taxableAmount:body.taxableAmount,vatRate:body.vatRate,vatAmount:180,totalAmount:1180,status:'Recorded'}];
        return route.fulfill({status:201,json:{id:1}});
      }
      return route.fulfill({json:schedule()});
    });
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    await page.goto(base+'/__vat?test');
    await page.getByRole('button',{name:'Create VAT ledger',exact:true}).click();
    await page.locator('[name=start]').fill('2044-01-01');await page.locator('[name=end]').fill('2044-03-31');
    await page.getByRole('button',{name:'Create ledger',exact:true}).click();
    await page.getByRole('button',{name:'Add VAT entry',exact:true}).click();
    await page.locator('[name=documentDate]').fill('2044-01-15');await page.locator('[name=documentNumber]').fill('MANUAL-UI-1');
    await page.locator('[name=counterparty]').fill('QA Customer');await page.locator('[name=taxableAmount]').fill('1000');await page.locator('[name=vatRate]').fill('18');
    await page.getByRole('button',{name:'Save VAT entry',exact:true}).click();
    await page.getByText('MANUAL-UI-1',{exact:true}).waitFor();
    assert.equal(periods[0].start,'2044-01-01');assert.equal(entries.length,1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:'/tmp/gkuc-vat-ledgers-'+width+'.png'});
    await page.goto(base+'/__vat?readonly');await page.getByText('Output Schedule 01',{exact:false}).first().waitFor();
    assert.equal(await page.getByRole('button',{name:'Create VAT ledger',exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'Add VAT entry',exact:true}).count(),0);
    await page.close();console.log(width+': create ledger, add entry and restricted controls passed');
  }
}finally{await browser?.close();await server.close()}
