import assert from 'node:assert/strict';
import {createServer} from 'vite';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const moduleId='\0paid-leave-regression.js';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';
import {LeaveForm,PayrollDetail} from '/src/pages/People.jsx';
import {RecordScopeProvider} from '/src/record-scope.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
const h=React.createElement,noop=()=>{};
const slip={id:1,employee:'Paid Leave QA',employeeCode:'LEAVE-QA',daysPresent:1,paidLeaveDays:1,unpaidLeaveDays:1,payableDays:2,
basic:3200,paidLeavePay:1600,grossEarnings:3200,netPay:800,employerCost:7700,deductions:2400,epfEmployeeDeduction:2400,reimbursementTotal:0,allowanceTotal:0,
overtimePay:0,lateDeduction:0,advanceRecoveries:[],components:[],calculationDetail:{attendance:[],overtime:[],warnings:[],
leave:{dailyRate:1600,days:[{workDate:'2026-10-02',paymentType:'Paid'},{workDate:'2026-10-03',paymentType:'Unpaid'}]}}};
const child=location.search.includes('payroll')?h(PayrollDetail,{close:noop,run:{reference:'PAY-LEAVE-QA',payFrequency:'Monthly',
periodStart:'2026-10-01',periodEnd:'2026-10-03',status:'Draft',total:3200,payslips:[slip]}}):
h(LeaveForm,{close:noop,reload:noop,data:{employees:[{id:1,name:'Leave Eligibility QA',joinDate:'2026-10-01',annualLeaveEntitlement:14,casualLeaveEntitlement:7}]}});
createRoot(document.getElementById('root')).render(h(RecordScopeProvider,{scope:{kind:'shared'}},child));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'paid-leave-regression',enforce:'pre',
  resolveId:id=>id==='/__paid-leave.js'?moduleId:null,load:id=>id===moduleId?source:null,
  transform(code,id){if(id.endsWith('/src/pages/People.jsx'))return code+'\nexport {LeaveForm,PayrollDetail};';},
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__paid-leave?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,
      '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__paid-leave.js"></script></body></html>'));
  });}
}]});
let browser;
try {
  await server.listen();
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  for(const [name,width,height] of [['desktop',1440,1000],['mobile',390,844]]) {
    const page=await browser.newPage({viewport:{width,height}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/api/**',route=>route.fulfill({json:route.request().url().includes('/leave/settings')
      ?{policies:[{id:1,effective_from:'2020-01-01',waiting_months:6,allow_unpaid_during_wait:1,annual_default:14,casual_default:7,monthly_limit:5}]}
      :[{listKey:'leave.type',values:[{value:'Annual',active:true}]}]}));
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    await page.goto(base+'/__paid-leave?mode=form');
    await page.locator('[name=fromDate]').fill('2026-10-23');
    await page.waitForFunction(()=>document.querySelector('[name=paymentType]')?.value==='Unpaid');
    assert.deepEqual(await page.locator('[name=paymentType] option').allTextContents(),['Unpaid']);
    await page.locator('[name=fromDate]').fill('2027-04-01');
    await page.waitForFunction(()=>document.querySelectorAll('[name=paymentType] option').length===2);
    await page.locator('[name=paymentType]').selectOption('Paid');
    await page.locator('[name=fromDate]').fill('2026-10-23');
    await page.waitForFunction(()=>document.querySelector('[name=paymentType]')?.value==='Unpaid');
    await page.screenshot({path:'/tmp/gkuc-paid-leave-form-'+name+'.png'});
    await page.goto(base+'/__paid-leave?mode=payroll');
    await page.getByText(/Includes.*1,600/).waitFor();
    await page.getByText('Employee EPF: LKR 2,400',{exact:true}).waitFor();
    await page.getByText('OT, leave and late deductions by work date',{exact:true}).click();
    await page.getByText('Approved leave in payroll',{exact:true}).waitFor();
    assert.equal(await page.getByText('Paid',{exact:true}).count(),1);
    assert.equal(await page.getByText('Unpaid',{exact:true}).count(),1);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.locator('.modal-content').evaluate(el=>el.scrollTop=0);
    await page.screenshot({path:'/tmp/gkuc-paid-leave-payroll-'+name+'.png'});
    assert.deepEqual(errors,[]);
    await page.close();console.log(name+': real leave form eligibility and payroll paid/unpaid breakdown passed');
  }
} finally {await browser?.close();await server.close();}
