import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0account-link-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import Link from '/src/EmployeeAccountLink.jsx';import Admin from '/src/pages/Admin.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(location.search.includes('create')?React.createElement(Admin,{can:{manage:true,has:()=>false},user:{id:99},reload:async()=>{}}):React.createElement(Link,{...(location.search.includes('profile')?{employeeId:2}:{user:{id:7,name:'Existing Account'}}),close:()=>{document.body.dataset.saved='yes'},reload:async()=>{}}));`;
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
  for(const width of [390,1440])for(const mode of ['admin','profile','create']){
    const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];let submitted;
    page.on('pageerror',e=>{errors.push(e.message); console.error(e.message);});
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url());
      let body=url.pathname.endsWith('employee-links')?[{id:1,name:'Old Profile',code:'EMP-1',userId:7,status:'Active'},{id:2,name:'Existing HR Profile',code:'EMP-2',userId:null,status:'Active'}]:[{id:7,name:'Existing Account',email:'account@example.com'}];
      if(url.pathname.endsWith('/users/roles')) body=[{id:1,name:'Employee'}];
      if(url.pathname.endsWith('/users/employee-options')) body=[
        {id:3,name:'Existing Labourer',code:'EMP-3',designation:'Mason',workerType:'Site',payrollCategory:'Site labourer'},
        {id:4,name:'Existing Driver',code:'EMP-4',workerType:'Site',payrollCategory:'Driver'}
      ];
      if(mode==='create'&&route.request().method()==='POST'){
        submitted=route.request().postDataJSON();
        return route.fulfill({status:201,json:{id:8,employeeId:3}});
      }
      if(route.request().method()==='PUT'){submitted=route.request().postDataJSON();body={};}
      await route.fulfill({json:body});
    });
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__link?'+mode);
    if(mode==='create'){
      await page.getByRole('button',{name:'Add user'}).click();
      await page.getByLabel('Find an existing employee').fill('labourer');
      await page.getByLabel('Employee profile').selectOption('3');
      assert.equal(await page.getByLabel('Full name').inputValue(),'Existing Labourer');
      assert.equal(await page.getByLabel('Payroll category').count(),0);
      await page.getByLabel('Login email').fill('labourer@example.com');
      await page.locator('[name=password]').fill('EmployeeTest!2026');
      await page.getByLabel('Access role').selectOption('1');
      await page.getByRole('button',{name:'Create user'}).click();
      await page.getByRole('dialog',{name:'Add user'}).waitFor({state:'detached'});
      assert.equal(submitted.employeeId,3);
      assert.equal(submitted.roleId,1);
      assert.equal(submitted.workerType,undefined);
      await page.getByRole('button',{name:'Add user'}).click();
      await page.getByLabel('Employee type').selectOption('Site');
      assert.equal(await page.getByLabel('Payroll category').inputValue(),'Site labourer');
      await page.getByLabel('Payroll category').selectOption('Driver');
      await page.getByLabel('Full name').fill('New Driver');
      await page.getByLabel('Login email').fill('driver@example.com');
      await page.locator('[name=password]').fill('EmployeeTest!2026');
      await page.getByLabel('Access role').selectOption('1');
      await page.getByRole('button',{name:'Create user'}).click();
      await page.getByRole('dialog',{name:'Add user'}).waitFor({state:'detached'});
      assert.equal(submitted.employeeId,undefined);
      assert.equal(submitted.workerType,'Site');
      assert.equal(submitted.payrollCategory,'Driver');

      assert.deepEqual(errors,[]);
      await page.close();console.log(width+' add user: searchable labour profile and access role passed');
      continue;
    }
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
