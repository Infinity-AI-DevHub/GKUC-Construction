import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0expenses-workspace';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import Finance from '/src/pages/Finance.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
const mode=new URLSearchParams(location.search).get('mode'),has=key=>mode==='both'?['finance.manage','finance.dailyExpenses'].includes(key):key===(mode==='daily'?'finance.dailyExpenses':'finance.manage');
createRoot(document.getElementById('root')).render(React.createElement('main',null,React.createElement(Finance,{user:{id:1},data:{projects:[],employees:[],companies:[{id:1,name:'GKUC Construction'}]},companyId:1,company:{name:'GKUC Construction'},can:{finance:has('finance.manage'),has},reload:async()=>{}})));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'expenses-workspace',resolveId:v=>v==='/__expenses.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/finance/'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__expenses.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440])for(const mode of ['both','daily','ledger']){
    const page=await browser.newPage({viewport:{width,height:1000}}),requests=[];
    await page.route('**/api/**',route=>{
      const url=route.request().url();requests.push(url);
      return route.fulfill({json:url.includes('/daily-expenses')?{company:{name:'GKUC Construction'},entries:[],total:0,unverifiedManualExpenses:0}:url.includes('/expenses?')?[]:{}});
    });
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/finance/'+(mode==='daily'?'daily-expenses':'expenses')+'?mode='+mode);
    await page.locator('.toolbar .segments button').filter({hasText:/^Expenses$/}).waitFor({state:'attached'});
    assert.equal(await page.getByRole('button',{name:'Daily expenses',exact:true}).count(),0);
    if(mode!=='ledger')await page.getByRole('heading',{name:'Payment register',exact:true}).waitFor();
    if(mode!=='daily')await page.getByRole('heading',{name:'Project expense ledger',exact:true}).waitFor();
    assert.equal(requests.some(url=>url.includes('/daily-expenses?')),mode!=='ledger');
    assert.equal(requests.some(url=>url.includes('/finance/expenses?')),mode!=='daily');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:'/tmp/gkuc-expenses-'+width+'-'+mode+'.png'});
    await page.close();console.log(width+' '+mode+': unified navigation and permission boundaries passed');
  }
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});
    const float={id:42,name:'QA Office Float',companyId:1,accountType:'Office expenses',holderName:'Cashier',balance:2000,lowAt:100,active:1};
    const entries=[];
    await page.route('**/api/**',route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      if(path.endsWith('/42/entries')){
        if(request.method()==='POST'){
          const body=request.postDataJSON();
          assert.equal(body.amount,2500);
          float.balance-=body.amount;
          entries.push({id:2,entryDate:body.entryDate,description:body.description,amount:-body.amount,kind:'Spend',recordedBy:'QA'});
          return route.fulfill({status:201,json:{id:2}});
        }
        return route.fulfill({json:entries});
      }
      return route.fulfill({json:path.endsWith('/petty-cash')?[float]:{}});
    });
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/finance/petty-cash?mode=ledger');
    await page.getByRole('button',{name:/QA Office Float/}).click();
    await page.getByRole('button',{name:'Record a movement'}).click();
    await page.getByLabel('Amount (LKR)').fill('2500');
    await page.getByLabel('Description').fill('Office purchase');
    await page.getByRole('button',{name:'Record it'}).click();
    await page.getByRole('heading',{name:'QA Office Float — LKR -500.00 balance'}).waitFor();
    await page.getByText('Negative balance',{exact:true}).waitFor();
    await page.close();
    console.log(width+': LKR 2,500 spend from LKR 2,000 shows LKR -500.00');
  }
}finally{await browser?.close();await server.close()}
