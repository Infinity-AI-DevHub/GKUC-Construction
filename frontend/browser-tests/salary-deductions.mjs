import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0deductions-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import PayrollInputs from '/src/pages/PayrollInputs.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(React.createElement(PayrollInputs,{data:{employees:[{id:1,name:'Employee QA'},{id:2,name:'Employee Two'}],projects:[]}}));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'deduction-fixture',resolveId:v=>v==='/__deduction.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__deduction?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__deduction.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));let saved;
    await page.route('**/api/**',route=>{
      if(route.request().method()==='POST'){
        saved=route.request().postDataJSON();
        if(saved.employeeIds)return route.fulfill({status:saved.claim.preview?200:201,json:{results:saved.employeeIds.map(employeeId=>({employeeId,employee:employeeId===1?'Employee QA':'Employee Two',calculation:{allowance:saved.claim.amount,travelHours:0,method:'Manual'}}))}});
        return route.fulfill({status:saved.preview?200:201,json:saved.preview?{calculation:{allowance:saved.amount,travelHours:0,method:'Manual'}}:{id:1}});
      }
      return route.fulfill({json:{claims:[],suggestions:[],issues:[]}});
    });
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__deduction?test');
    const claim=page.getByRole('button',{name:'Add travel / allowance claim',exact:true});await claim.waitFor();
    assert.equal(await claim.evaluate(el=>getComputedStyle(el).color),'rgb(255, 255, 255)');
    await page.screenshot({path:'/tmp/gkuc-deduction-buttons-'+width+'.png'});
    await page.getByRole('button',{name:'Add salary deduction',exact:true}).click();
    await page.locator('[name=amount]').fill('275');await page.locator('[name=notes]').fill('Agreed one-time deduction');
    await page.screenshot({path:'/tmp/gkuc-deduction-form-'+width+'.png'});
    await page.getByRole('button',{name:'Save deduction draft',exact:true}).click();
    await page.getByRole('heading',{name:'Add one-time salary deduction',exact:true}).waitFor({state:'detached'});
    assert.equal(saved.kind,'Salary deduction');assert.equal(saved.amount,275);assert.equal(saved.employeeId,1);
    await claim.click();
    await page.locator('label').filter({hasText:'Allowance calculation'}).locator('select').selectOption('Manual');
    assert.equal(await page.locator('[name=departure]').count(),0);
    await page.locator('[name=amount]').fill('875');await page.locator('[name=notes]').fill('Management approved fixed travel payment');
    await page.getByRole('button',{name:'Review details',exact:true}).click();
    await page.getByRole('button',{name:'Calculate and preview',exact:true}).click();
    await page.getByText('Manual travel allowance (LKR)',{exact:true}).waitFor();
    await page.screenshot({path:'/tmp/gkuc-manual-travel-preview-'+width+'.png'});
    await page.getByRole('button',{name:'Save draft claim',exact:true}).click();
    await page.getByText('Manual travel allowance (LKR)',{exact:true}).waitFor({state:'detached'});
    assert.equal(saved.calculationMethod,'Manual');assert.equal(saved.amount,875);assert.equal(saved.departure,undefined);
    await claim.click();
    await page.locator('label').filter({hasText:'Apply allowance to'}).locator('select').selectOption('Multiple');
    await page.getByLabel('Employee QA',{exact:true}).check();await page.getByLabel('Employee Two',{exact:true}).check();
    assert.equal(await page.locator('[name=employeeId]').count(),0);
    await page.locator('[name=amount]').fill('875');await page.locator('[name=notes]').fill('Team fixed travel payment');
    await page.getByRole('button',{name:'Review details',exact:true}).click();await page.getByRole('button',{name:'Calculate and preview',exact:true}).click();
    await page.getByRole('heading',{name:'Employee Two',exact:true}).waitFor();
    assert.equal(await page.getByText('Manual travel allowance (LKR)',{exact:true}).count(),2);
    await page.screenshot({path:'/tmp/gkuc-batch-claims-preview-'+width+'.png'});
    await page.getByRole('button',{name:'Save draft claim',exact:true}).click();
    await page.getByRole('heading',{name:'Employee Two',exact:true}).waitFor({state:'detached'});
    assert.deepEqual(saved.employeeIds,[1,2]);assert.equal(saved.claim.amount,875);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
    await page.close();console.log(width+': white claim button, responsive actions and deduction submission passed');
  }
}finally{await browser?.close();await server.close();}
