import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const moduleId='\0labour-boq-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';
import {ExpenseForm} from '/src/pages/CostControl.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(React.createElement(ExpenseForm,{
  projectId:1,items:[{id:11,boqReference:'BOQ-1',description:'Concreting'},{id:12,boqReference:'BOQ-1',description:'Formwork'}],
  close:()=>{},reload:async()=>{},onImport:()=>{}
}));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'labour-boq-fixture',resolveId:value=>value==='/__labour.js'?moduleId:null,load:value=>value===moduleId?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(req.url!=='/__labour') return next();
    res.setHeader('Content-Type','text/html');
    res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__labour.js"></script></body></html>'));
  });}
}]});
let browser;
try {
  await server.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:900}});
    let saved;
    await page.route('**/api/boq/cost-control/**',route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.pathname.endsWith('/options')) return route.fulfill({json:{
        tasks:[{id:5,status:'Completed',title:'Complete bridge deck'}],employees:[{id:8,name:'QA Worker'}],quotationItems:[{id:81,reference:'QUO-1',description:'Concrete',amount:1000}]
      }});
      if(url.pathname.endsWith('/labour-day')) return route.fulfill({json:{
        workedHours:10,dailyPay:2200,hourlyCost:220,basic:2000,overtime:250,lateDeduction:50,reservedHours:0,reservedAmount:0,remainingHours:10,remainingAmount:2200
      }});
      saved=req.postDataJSON();
      return route.fulfill({status:201,json:{id:30}});
    });
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__labour');
    await page.getByRole('checkbox',{name:/Complete bridge deck/}).check();
    await page.getByLabel('Category').selectOption('Labour');
    await page.getByLabel('What was used or paid for').fill('Bridge crew');
    await page.getByLabel('Employee (optional)').selectOption('8');
    await page.getByLabel('BOQ item 1').selectOption('11');
    await page.getByLabel('Hours for item 1').fill('4');
    await page.getByRole('button',{name:'Add BOQ item'}).click();
    await page.getByLabel('BOQ item 2').selectOption('12');
    await page.getByLabel('Hours for item 2').fill('7');
    await page.getByText('Combined allocations exceed the worked hours available.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Send to Finance for review'}).click();
    assert.equal(saved,undefined);
    await page.getByLabel('Hours for item 2').fill('6');
    await page.getByText('10 h allocated · LKR 2,200.00',{exact:true}).waitFor();
    assert.equal(await page.locator('output[aria-label="Cost for item 1"]').innerText(),'LKR 880.00');
    assert.equal(await page.locator('output[aria-label="Cost for item 2"]').innerText(),'LKR 1,320.00');
    await page.getByText('Quotation recovery for item 2',{exact:true}).click();
    await page.getByLabel('Accepted quotation item').filter({visible:true}).selectOption('81');
    await page.getByLabel('Recovery for this day').fill('125');
    await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith('/daily-sheets')),
      page.getByRole('button',{name:'Send to Finance for review'}).click()]);
    assert.deepEqual(saved.lines.map(({employeeId,taskIds,boqItemId,labourHours,amount,quotationItemId,quotedRecovery})=>
      ({employeeId,taskIds,boqItemId,labourHours,amount,quotationItemId,quotedRecovery})),[
      {employeeId:8,taskIds:[5],boqItemId:11,labourHours:4,amount:880,quotationItemId:null,quotedRecovery:0},
      {employeeId:8,taskIds:[5],boqItemId:12,labourHours:6,amount:1320,quotationItemId:81,quotedRecovery:125}
    ]);
    assert.ok(await page.locator('.labour-boq-allocation').evaluate(node=>node.scrollWidth<=node.clientWidth));
    await page.close();
    console.log(width+': employee selected once, two BOQ allocations, over-allocation guard and exact amounts passed');
  }
} finally { await browser?.close(); await server.close(); }
