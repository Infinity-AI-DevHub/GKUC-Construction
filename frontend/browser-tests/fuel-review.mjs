import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0fuel-review-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';
import FuelSubmissions from '/src/pages/FuelSubmissions.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
const reviewer=location.search.includes('reviewer');
createRoot(document.getElementById('root')).render(React.createElement(FuelSubmissions,{
 companyId:2,user:{id:reviewer?9:4,name:reviewer?'QA Reviewer':'QA Recorder'},can:{has:key=>key===(reviewer?'fuel.review':'fuel.submit')},reload:async()=>{}
}));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'fuel-review-fixture',resolveId:path=>path==='/__fuel.js'?id:null,load:path=>path===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__fuel?'))return next();
    res.setHeader('Content-Type','text/html');
    res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__fuel.js"></script></body></html>'));
  });}
}]});
let browser;
try {
  await server.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const base='http://127.0.0.1:'+server.httpServer.address().port;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV4kAAAAASUVORK5CYII=','base64');
  for(const width of [390,1440]){
    const context=await browser.newContext({viewport:{width,height:950}});
    const page=await context.newPage();
    const row={id:22,vehicleId:1,projectId:2,vehicle:'Truck',registration:'QA-42',project:'Bridge',status:'Rejected',reviewNote:'Correct the litres',
      submittedBy:'QA Recorder',submittedById:4,hasPhoto:true,fuelDate:'2026-11-10',reviewDue:'2026-11-11',litres:10,cost:4200,odometer:160};
    let posts=0;
    await page.route('**/api/fuel-submissions**',async route=>{
      const req=route.request(),path=new URL(req.url()).pathname;
      if(path.endsWith('/photo')) return route.fulfill({contentType:'image/png',body:png});
      if(path.endsWith('/options')) return route.fulfill({json:{vehicles:[{id:1,vehicle:'Truck',registration:'QA-42'}],projects:[{id:2,name:'Bridge'}],floats:[]}});
      if(path.endsWith('/claim')) return route.fulfill({status:204});
      if(path.endsWith('/review')) {
        assert.deepEqual(req.postDataJSON(),{decision:'Rejected',note:'Use the corrected receipt'});
        row.status='Rejected';
        return route.fulfill({json:{status:'Rejected'}});
      }
      if(req.method()==='POST') {
        posts++;
        if (req.headers()['content-type'].startsWith('multipart/')) {
          assert.ok(req.postDataBuffer().includes(png));
        } else assert.equal(req.postDataJSON().replacesId,22);
        return route.fulfill({status:201,json:{id:23,status:'Pending'}});
      }
      return route.fulfill({json:[row]});
    });
    await page.goto(base+'/__fuel?new=1');
    await page.getByRole('dialog',{name:'Record fuel'}).waitFor();
    await page.getByLabel('Vehicle').selectOption('1');
    await page.getByLabel('Litres').fill('12');
    await page.getByLabel('Amount (LKR)').fill('4500');
    await page.getByLabel('Choose a photo').setInputFiles({name:'receipt.png',mimeType:'image/png',buffer:png});
    await page.getByRole('button',{name:'Save draft on this device'}).click();
    await page.getByText('Draft saved on this device',{exact:true}).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Record fuel',exact:true}).click();
    assert.equal(await page.getByLabel('Litres').inputValue(),'12');
    await page.getByText('receipt.png',{exact:true}).waitFor();
    await context.setOffline(true);
    await page.getByRole('button',{name:'Save for later submission'}).click();
    await page.getByText(/Waiting to submit · saved on this device/).waitFor();
    assert.equal(posts,0);
    await context.setOffline(false);
    await page.getByRole('button',{name:'Send for approval'}).click();
    await page.getByText('Submitted for review',{exact:true}).waitFor();
    assert.equal(posts,1);
    await page.goto(base+'/__fuel?record=22');
    await page.getByRole('dialog',{name:'Fix and resubmit fuel entry'}).waitFor();
    assert.equal(await page.getByLabel('Litres').inputValue(),'10');
    await page.getByText('Correction requested: Correct the litres',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Send for approval'}).click();
    await page.getByText('Submitted for review',{exact:true}).waitFor();
    assert.equal(posts,2);
    row.status='Pending';row.previousDetails={litres:9,cost:4100};
    await page.goto(base+'/__fuel?reviewer&record=22');
    const review=page.getByRole('dialog',{name:'Fuel entry · Truck'});
    await review.getByRole('img',{name:'Fuel receipt photo'}).waitFor();
    await review.getByText(/Previous submission: 9 L/).waitFor();
    await review.getByRole('button',{name:'Take ownership'}).click();
    await review.getByText(/Reviewer: QA Reviewer/).waitFor();
    await review.getByRole('button',{name:'Return for correction'}).click();
    await page.getByLabel('Correction reason').fill('Use the corrected receipt');
    await page.getByRole('button',{name:'Return for correction',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'detached'});
    await context.close();
    console.log(width+': quick entry, photo draft, offline save, correction and reviewer evidence passed');
  }
} finally { await browser?.close(); await server.close(); }
