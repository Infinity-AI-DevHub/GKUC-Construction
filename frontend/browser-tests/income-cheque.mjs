import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0income-cheque-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {IncomeForm} from '/src/pages/Finance.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(React.createElement(IncomeForm,{companyId:1,data:{projects:[{id:1,name:'Test project'}]},close:()=>{},reload:async()=>{}}));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'income-cheque-fixture',enforce:'pre',resolveId:v=>v==='/__income.js'?id:null,load:v=>v===id?source:null,
  transform(code,path){if(path.endsWith('/src/pages/Finance.jsx'))return code+'\nexport {IncomeForm};'},
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__income?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__income.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});const writes=[];
    await page.route('**/api/**',async route=>{
      if(route.request().method()==='POST')writes.push({url:route.request().url(),body:route.request().postDataJSON()});
      return route.fulfill({json:route.request().url().includes('/options')?[]:{id:1}});
    });
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__income?test');
    await page.locator('[name=amount]').fill('3000');
    await page.locator('[name=description]').fill('Project receipt');
    assert.equal(await page.locator('[name=projectId]').inputValue(),'other');
    await page.locator('[name=incomeSource]').fill('Equipment rental');
    await page.locator('[name=projectId]').selectOption('1');
    assert.equal(await page.locator('[name=incomeSource]').count(),0);
    await page.locator('[name=projectId]').selectOption('other');
    await page.locator('[name=incomeSource]').fill('Equipment rental');
    await page.getByRole('button',{name:'Save income',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.primary')?.disabled);
    assert.equal(writes[0].body.projectId,null);assert.equal(writes[0].body.companyId,1);
    assert.equal(writes[0].body.incomeSource,'Equipment rental');
    assert.equal(writes[0].body.taxTreatment,'None');assert.equal(writes[0].body.vatRate,0);
    await page.locator('[name=taxTreatment]').selectOption('Standard');
    await page.locator('[name=vatRate]').fill('18');
    await page.getByRole('button',{name:'Save income',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.primary')?.disabled);
    assert.equal(writes[1].body.taxTreatment,'Standard');assert.equal(writes[1].body.vatRate,18);
    assert.equal(writes[1].body.amountIncludesVat,undefined);
    await page.locator('[name=taxTreatment]').selectOption('None');
    await page.locator('[name=method]').selectOption('Cheque');
    await page.locator('[name=chequeNumber]').fill('CHQ-123');
    await page.locator('[name=bank]').fill('Test Bank');await page.locator('[name=payer]').fill('Test Client');
    await page.getByRole('button',{name:'Record cheque',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.primary')?.disabled);
    assert.equal(writes.length,3);assert.ok(writes[2].url.endsWith('/receivables/cheques'));
    assert.equal(writes[2].body.chequeNumber,'CHQ-123');assert.equal(writes[2].body.amount,3000);
    assert.equal(writes[2].body.purpose,'Project receipt');assert.equal(writes[2].body.projectId,null);
    assert.equal(writes[2].body.incomeSource,'Equipment rental');
    assert.equal(writes[2].body.vatRate,0);assert.equal(writes[2].body.taxTreatment,'None');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:'/tmp/gkuc-income-cheque-'+width+'.png'});await page.close();
    console.log(width+': cheque details and received-cheque submission passed');
  }
}finally{await browser?.close();await server.close()}
