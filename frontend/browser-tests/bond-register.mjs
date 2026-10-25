import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0bond-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {Bonds} from '/src/Receivables.jsx';import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(React.createElement(Bonds,{data:{projects:[]},can:{invoice:true},companyId:1}));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'::1',port:0},plugins:[{
  name:'bond-fixture',resolveId:v=>v==='/__bond.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__bond?'))return next();res.setHeader('Content-Type','text/html');
    res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__bond.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/receivables/bonds?*',r=>r.fulfill({json:[{id:1,reference:'BND-QA',kind:'ESHS performance',beneficiary:'Project Director',bank:'PB',fd_reference:'10M Facility',project_description:'Historical tender',amount:214224.6,margin_held:0,issued_date:'2025-03-20',start_date:'2025-03-21',expiry_date:'2026-11-18',status:'Live',reminderDays:30,daysLeft:23,extensions:0,process_notes:'Letter issued'}]}));
    await page.goto('http://[::1]:'+server.httpServer.address().port+'/__bond?test');
    await page.getByText('BND-QA',{exact:true}).waitFor();
    await page.getByLabel('Search bonds').fill('unmatched');assert.equal(await page.getByText('BND-QA',{exact:true}).count(),0);
    await page.getByLabel('Search bonds').fill('10M');await page.getByText('BND-QA',{exact:true}).waitFor();
    await page.getByLabel('Status',{exact:true}).selectOption('Released');assert.equal(await page.getByText('BND-QA',{exact:true}).count(),0);
    await page.getByLabel('Status',{exact:true}).selectOption('');
    await page.getByRole('button',{name:'Edit BND-QA',exact:true}).click();
    assert.equal(await page.locator('[name=fdReference]').inputValue(),'10M Facility');
    assert.equal(await page.locator('[name=startDate]').inputValue(),'2025-03-21');
    await page.locator('[name=kind]').selectOption('Cash');
    await page.screenshot({path:'/tmp/gkuc-bond-form-'+width+'.png',fullPage:true});
    assert.deepEqual(errors,[]);await page.close();console.log(width+': bond search, status filter and edit fields passed');
  }
}finally{await browser?.close();await server.close();}
