import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0dashboard-checkouts-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import MyWorkToday from '/src/MyWorkToday.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
const permissions=location.search.includes('denied')?['finance.view']:location.search.includes('readonly')?['hr.view']:['hr.view','hr.attendance'];
createRoot(document.getElementById('root')).render(React.createElement('main',null,React.createElement(MyWorkToday,{user:{id:1,name:'HR QA',role:'HR Department Head',permissions},can:{has:key=>permissions.includes(key)},companyId:1,data:{tasks:[],projects:[]},go:()=>{}})));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'dashboard-checkouts-fixture',resolveId:v=>v==='/__checkout.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__checkout?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__checkout.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let records=[{id:1,employeeId:1,name:'Employee One',workDate:'2026-10-20'},{id:2,employeeId:1,name:'Employee One',workDate:'2026-10-21'},
      {id:3,employeeId:2,name:'Employee Two',workDate:'2026-10-22'}].map(row=>({...row,employeeCode:'EMP-'+row.employeeId,in:'07:30:00',out:null,state:'On site',workLocation:'Office',site:'Head office',source:'Biometric'}));
    const result=()=>({employeeCount:new Set(records.map(row=>row.employeeId)).size,recordCount:records.length,records,offset:0,hasMore:false,shiftEnd:'16:30'});
    await page.route('**/api/**',route=>{
      const req=route.request(),url=new URL(req.url());
      if(req.method()==='PATCH'){
        const body=req.postDataJSON();assert.equal(body.checkOut,'16:30');assert.ok(body.reason.length>5);
        records=records.filter(row=>row.id!==Number(url.pathname.split('/').at(-1)));return route.fulfill({json:{updated:true}});
      }
      return route.fulfill({json:url.pathname.endsWith('/queue')?{work:[],sheets:[],claims:[],invoicesDue:[],missingCheckouts:result()}:result()});
    });
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    await page.goto(base+'/__checkout?test');
    await page.getByText('2 employees not checked out',{exact:true}).waitFor();
    await page.screenshot({path:'/tmp/gkuc-dashboard-checkouts-'+width+'.png'});
    await page.getByRole('button',{name:'Resolve immediately',exact:true}).click();
    await page.getByText('2 employees · 3 overdue records',{exact:true}).waitFor();
    for(const date of ['2026-10-20','2026-10-21']){
      await page.getByRole('button',{name:'Correct attendance for Employee One on '+date,exact:true}).click();
      await page.locator('[name=state]').selectOption('Checked out');await page.locator('[name=checkOut]').fill('16:30');
      await page.locator('[name=reason]').fill('Verified checkout with HR evidence');
      await page.getByRole('button',{name:'Save correction',exact:true}).click();
      await page.locator('[name=reason]').waitFor({state:'detached'});
    }
    await page.getByText('1 employee · 1 overdue record',{exact:true}).waitFor();
    assert.equal(records.length,1);
    await page.goto(base+'/__checkout?readonly');
    await page.getByRole('button',{name:'Resolve immediately',exact:true}).click();
    await page.getByText('View only',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:/Correct attendance for/}).count(),0);
    await page.goto(base+'/__checkout?denied');await page.getByRole('heading',{name:'My work today',exact:true}).waitFor();
    assert.equal(await page.locator('.my-work-checkout-warning').count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
    await page.close();console.log(width+': warning, distinct employee count, audited correction flow and permissions passed');
  }
}finally{await browser?.close();await server.close()}
