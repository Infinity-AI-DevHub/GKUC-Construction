import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0credit-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {InvoiceForm} from '/src/pages/Finance.jsx';import MyWorkToday from '/src/MyWorkToday.jsx';
import '/src/styles.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(location.search.includes('dashboard')?React.createElement(MyWorkToday,{user:{id:1,permissions:[]},can:{has:()=>false},companyId:1,data:{tasks:[]},go:()=>{}}):React.createElement(InvoiceForm,{creditOnly:true,companyId:1,close:()=>{},reload:async()=>{}}));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'credit-fixture',resolveId:v=>v==='/__credit.js'?id:null,load:v=>v===id?source:null,
  transform(code,path){if(path.endsWith('/pages/Finance.jsx'))return code+'\nexport {InvoiceForm};';},
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__credit?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__credit.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});let saved,acknowledged=false;const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/**',route=>{
      const path=new URL(route.request().url()).pathname;
      if(path.endsWith('/credit-reminder-users'))return route.fulfill({json:[{id:1,name:'Finance One',role:'Finance'},{id:2,name:'Finance Two',role:'Finance'}]});
      if(path.endsWith('/suppliers'))return route.fulfill({json:[{id:1,name:'Cement supplier'}]});
      if(path.endsWith('/orders'))return route.fulfill({json:[]});
      if(path.endsWith('/invoices/check'))return route.fulfill({json:{warnings:[]}});
      if(path.endsWith('/invoices')){saved=route.request().postDataJSON();return route.fulfill({json:{id:1}});}
      if(path.endsWith('/acknowledge')){acknowledged=true;return route.fulfill({status:204});}
      if(path.endsWith('/queue'))return route.fulfill({json:{work:[],sheets:[],claims:[],invoicesDue:[],creditReminders:acknowledged?[]:[{id:1,invoiceNo:'CR-1',supplier:'Cement supplier',description:'Cement bags',frequency:'Weekly',dueDate:'2026-10-30',outstanding:3000}]}});
      return route.fulfill({json:[]});
    });
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    await page.goto(base+'/__credit?form');
    await page.getByRole('heading',{name:'Record credit purchase',exact:true}).waitFor();
    await page.locator('[name=supplierId]').selectOption('1');
    await page.locator('[name=invoiceNo]').fill('CR-1');await page.locator('[name=amount]').fill('3000');
    await page.locator('[name=creditDescription]').fill('Cement bags');
    await page.locator('[name=reminderFrequency]').selectOption('Weekly');
    await page.getByLabel('Finance One').check();await page.getByLabel('Finance Two').check();
    await page.screenshot({path:'/tmp/gkuc-credit-form-'+width+'.png'});
    const response=page.waitForResponse(result=>new URL(result.url()).pathname.endsWith('/purchasing/invoices'));
    await page.getByRole('button',{name:'Save credit purchase',exact:true}).click();await response;
    assert.deepEqual(saved.creditReminder.userIds,[1,2]);assert.equal(saved.creditReminder.frequency,'Weekly');
    await page.goto(base+'/__credit?dashboard');await page.getByText('Credit payment reminder · Cement supplier',{exact:true}).waitFor();
    await page.screenshot({path:'/tmp/gkuc-credit-dashboard-'+width+'.png'});
    await page.getByRole('button',{name:'Remind me weekly',exact:true}).click();
    await page.getByText('Credit payment reminder · Cement supplier',{exact:true}).waitFor({state:'detached'});
    assert.ok(acknowledged);assert.deepEqual(errors,[]);await page.close();console.log(width+': multi-recipient credit form and targeted dashboard acknowledgement passed');
  }
}finally{await browser?.close();await server.close();}
