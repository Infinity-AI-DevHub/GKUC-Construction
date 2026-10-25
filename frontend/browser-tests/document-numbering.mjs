import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0numbering-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import Numbering from '/src/DocumentNumbering.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
createRoot(document.getElementById('root')).render(React.createElement('main',null,React.createElement(Numbering,{companyId:1,reloadInvoices:async()=>{}})));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'::1',port:0},plugins:[{
  name:'numbering-fixture',resolveId:v=>v==='/__numbering.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__numbering?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__numbering.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];const writes=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/**',async route=>{
      if(route.request().method()!=='GET')writes.push(route.request().postDataJSON());
      await route.fulfill({json:route.request().method()==='GET'?{settings:[],quotations:[{id:1,reference:'QUO-145',title:'Site surfacing',status:'Draft',revision:0}]}:{saved:true}});
    });
    await page.goto('http://[::1]:'+server.httpServer.address().port+'/__numbering?test');
    await page.getByRole('button',{name:'Invoice numbering',exact:true}).click();
    await page.locator('input[name="format"]').fill('GKUC/INV/{YYYY}/{N}');
    await page.locator('input[name="nextValue"]').fill('146');
    await page.locator('input[name="reason"]').fill('Continue existing documents');
    await page.getByRole('button',{name:'Save numbering',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'detached'});
    assert.equal(writes[0].nextValue,146);
    await page.getByRole('button',{name:'Edit number',exact:true}).click();
    await page.locator('input[name="reference"]').fill('GKUC/Q/145');
    await page.locator('input[name="reason"]').fill('Use existing document number');
    await page.screenshot({path:'/tmp/gkuc-numbering-'+width+'.png',fullPage:true});
    await page.getByRole('button',{name:'Save number',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'detached'});
    assert.equal(writes[1].reference,'GKUC/Q/145');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    assert.deepEqual(errors,[]);await page.close();console.log(width+': format, continuation and document number editing passed');
  }
}finally{await browser?.close();await server.close();}
