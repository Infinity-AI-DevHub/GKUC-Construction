import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0bonds-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {Bonds} from '/src/Receivables.jsx';
import '/src/styles.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(React.createElement(Bonds,{data:{projects:[]},can:{invoice:!location.search.includes('readonly')},companyId:1}));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'bonds-fixture',resolveId:v=>v==='/__bonds.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__bonds?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__bonds.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
    let rows=[{id:1,reference:'BND-QA',kind:'Other',beneficiary:'QA authority',bank:'QA Bank',amount:5000,margin_held:500,commission:100,issued_date:'2026-01-01',expiry_date:'2027-01-01',reminderDays:0,status:'Live',daysLeft:60,bond_number:null}];
    await page.route('**/api/**',route=>{
      const req=route.request();
      if(req.method()==='PUT'){
        const body=req.postDataJSON();assert.equal(body.bondNumber,'BANK-123');assert.equal(body.reminderDays,0);
        rows=rows.map(row=>({...row,bond_number:body.bondNumber}));return route.fulfill({status:204});
      }
      if(req.method()==='DELETE'){rows=[];return route.fulfill({status:204});}
      return route.fulfill({json:rows});
    });
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    await page.goto(base+'/__bonds?test');await page.getByText('Bond number pending',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Edit BND-QA',exact:true}).click();
    assert.equal(await page.locator('[name=beneficiary]').inputValue(),'QA authority');
    assert.equal(await page.locator('[name=reminderDays]').inputValue(),'0');
    await page.locator('[name=bondNumber]').fill('BANK-123');
    await page.screenshot({path:'/tmp/gkuc-bonds-edit-'+width+'.png'});
    await page.getByRole('button',{name:'Save changes',exact:true}).click();
    await page.getByText('BANK-123',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Delete BND-QA',exact:true}).click();
    await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(rows.length,1);
    await page.getByRole('button',{name:'Delete BND-QA',exact:true}).click();
    await page.getByRole('button',{name:'Delete bond',exact:true}).click();
    await page.getByText('No bonds recorded.',{exact:true}).waitFor();assert.equal(rows.length,0);
    await page.goto(base+'/__bonds?readonly');assert.equal(await page.getByRole('button',{name:'Record a bond',exact:true}).count(),0);
    assert.deepEqual(errors,[]);await page.close();console.log(width+': edit defaults, pending number, zero reminder, confirmed deletion and read-only permissions passed');
  }
}finally{await browser?.close();await server.close();}
