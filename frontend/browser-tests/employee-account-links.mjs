import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0account-link-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import Link from '/src/EmployeeAccountLink.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(React.createElement(Link,{...(location.search.includes('profile')?{employeeId:2}:{user:{id:7,name:'Existing Account'}}),close:()=>{document.body.dataset.saved='yes'},reload:async()=>{}}));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'account-link-fixture',resolveId:v=>v==='/__link.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__link?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__link.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440])for(const mode of ['admin','profile']){
    const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];let submitted;
    page.on('pageerror',e=>{errors.push(e.message); console.error(e.message);});
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url());
      let body=url.pathname.endsWith('employee-links')?[{id:1,name:'Old Profile',code:'EMP-1',userId:7,status:'Active'},{id:2,name:'Existing HR Profile',code:'EMP-2',userId:null,status:'Active'}]:[{id:7,name:'Existing Account',email:'account@example.com'}];
      if(route.request().method()==='PUT'){submitted=route.request().postDataJSON();body={};}
      await route.fulfill({json:body});
    });
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__link?'+mode);
    await page.locator('select').waitFor();
    if(mode==='admin')await page.locator('select[name="employeeId"]').selectOption('2');
    else await page.locator('select[name="accountId"]').selectOption('7');
    await page.getByLabel('Reason for change').fill('Correct duplicate profile link');
    await page.screenshot({path:'/tmp/gkuc-account-link-'+mode+'-'+width+'.png'});
    await page.getByRole('button',{name:'Save link',exact:true}).click();
    await page.waitForFunction(()=>document.body.dataset.saved==='yes');
    assert.equal(submitted.employeeId,2);assert.deepEqual(submitted.previousEmployeeIds,[1]);assert.deepEqual(errors,[]);
    await page.close();console.log(width+' '+mode+': account relink passed');
  }
}finally{await browser?.close();await server.close();}
