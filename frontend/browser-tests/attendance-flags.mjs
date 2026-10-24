import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0attendance-flags-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import EmployeeProfile from '/src/pages/EmployeeProfile.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(React.createElement('main',null,React.createElement(EmployeeProfile,{employeeId:1,close:()=>{},canCorrect:!location.search.includes('readonly')})));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'attendance-flags-fixture',resolveId:v=>v==='/__flags.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__flags?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__flags.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    const attendance=[{id:1,in:'07:41:00',out:null,state:'On site'},{id:2,in:'08:20:00',out:null,state:'Late'},
      {id:3,in:'07:00:00',out:'17:00:00',state:'Checked out'},{id:4,in:null,out:'16:30:00',state:'Checked out'},
      {id:5,in:null,out:null,state:'Absent'},{id:6,in:'07:00:00',out:null,state:'Business trip'}]
      .map(row=>({...row,workDate:'2026-10-22',site:'Head office',source:'Biometric'}));
    const employee={id:1,name:'Attendance QA',code:'EMP-QA',status:'Active',workerType:'Office',designation:'Staff',attendance,
      tasks:[],projects:[],reports:[],reviews:[],monthlyTrend:[],attendanceStats:{rate:80,present:4,late:1,absent:1,needsReview:0},workStats:{tasks:0,completedTasks:0,reports:0}};
    await page.route('**/api/**',route=>route.fulfill({json:new URL(route.request().url()).pathname==='/api/employees/1'?employee:[]}));
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    await page.goto(base+'/__flags?test');await page.getByRole('heading',{name:'Attendance history',exact:true}).waitFor();
    assert.equal(await page.locator('.attendance-missing-checkout').count(),2);
    assert.equal(await page.getByText('Not checked out',{exact:true}).count(),2);
    await page.getByText('2 attendance records have a check-in but no checkout.',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:/Edit attendance for/}).count(),6);
    await page.getByRole('heading',{name:'Attendance history',exact:true}).scrollIntoViewIfNeeded();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:'/tmp/gkuc-attendance-flags-'+width+'.png'});
    employee.attendance[0].out='16:30:00';await page.goto(base+'/__flags?readonly');
    await page.getByRole('heading',{name:'Attendance history',exact:true}).waitFor();
    assert.equal(await page.locator('.attendance-missing-checkout').count(),1);
    assert.equal(await page.getByRole('button',{name:/Edit attendance for/}).count(),0);
    assert.deepEqual(errors,[]);await page.close();console.log(width+': missing-checkout flags, corrected row and permissions passed');
  }
}finally{await browser?.close();await server.close()}
