import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0employee-filter-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {Employees} from '/src/pages/People.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
const employees=[{id:1,name:'Anne Silva',code:'EMP-101',department:'HR',designation:'Officer',workerType:'Office',status:'Active'},
{id:2,name:'Nimal Perera',code:'BIO-202',department:'Operations',designation:'Driver',workerType:'Driver',status:'On leave'}];
createRoot(document.getElementById('root')).render(React.createElement('main',null,React.createElement(Employees,{data:{employees,departments:[]},can:{hr:false},onOpen:()=>{}})));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'employee-filter-fixture',resolveId:v=>v==='/__employees.js'?id:null,load:v=>v===id?source:null,
  transform(code,path){if(path.endsWith('/pages/People.jsx'))return code+'\nexport {Employees};';},
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__employees?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__employees.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,768,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__employees?test');
    await page.getByText('2 of 2 employees',{exact:true}).waitFor();
    await page.getByRole('searchbox',{name:'Search employees',exact:true}).fill('BIO-202');
    await page.getByText('1 of 2 employees',{exact:true}).waitFor();
    await page.getByLabel('Filter by department',{exact:true}).selectOption('HR');
    await page.getByText('No employees match the selected search and filters.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Clear filters',exact:true}).click();
    await page.getByLabel('Filter by employee type',{exact:true}).selectOption('Driver');
    await page.getByLabel('Filter by status',{exact:true}).selectOption('On leave');
    await page.getByText('1 of 2 employees',{exact:true}).waitFor();
    await page.screenshot({path:'/tmp/gkuc-employee-filters-'+width+'.png'});
    await page.getByRole('button',{name:'Clear filters',exact:true}).click();
    await page.getByText('2 of 2 employees',{exact:true}).waitFor();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
    await page.close();console.log(width+': combined employee search, filters, empty state and reset passed');
  }
}finally{await browser?.close();await server.close();}
