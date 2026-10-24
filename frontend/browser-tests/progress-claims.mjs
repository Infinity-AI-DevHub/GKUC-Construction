import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0progress-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import ProgressClaims from '/src/pages/ProgressClaims.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
const permissions=location.search.includes('readonly')?['qs.view']:['qs.view','qs.boq','qs.approve','finance.invoice'];
createRoot(document.getElementById('root')).render(React.createElement('main',null,React.createElement(ProgressClaims,{companyId:1,can:{has:key=>permissions.includes(key)}})));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'progress-fixture',resolveId:v=>v==='/__progress.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__progress?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__progress.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    const data={projects:[{id:1,name:'Drainage project',client:'QA Client',billingRoute:'Quotation and invoice'}],schedules:[],claims:[]};
    await page.route('**/api/**',route=>{
      const req=route.request(),url=new URL(req.url()),body=req.postData()?req.postDataJSON():{};
      if(req.method()==='GET')return route.fulfill({json:url.pathname.endsWith('/progress-claims')?data:[]});
      if(url.pathname.endsWith('/schedules')){
        data.schedules=[{id:1,project_id:1,version_no:1,source:body.source,status:'Draft',revision_reason:body.revisionReason,items:body.items}];data.projects[0].billingRoute='Progress claims';
      }else if(url.pathname.endsWith('/schedules/1')){data.schedules[0].status=body.status;data.schedules[0].agreement_reference=body.reference;}
      else if(url.pathname.endsWith('/progress-claims')){
        const item=data.schedules[0].items[0];
        data.claims=[{id:1,reference:'IPA-QA-1',project_id:1,schedule_id:1,application_date:body.applicationDate,period_from:body.periodFrom,period_to:body.periodTo,status:'Draft',schedule_snapshot:data.schedules[0],submitted_amount:3000,
          submitted_items:[{...item,boqQuantity:100,quantity:30,previousQuantity:0,previousAmount:0,current:3000,cumulative:3000}],paidAmount:0}];
      }else if(url.pathname.endsWith('/status')){data.claims[0].status=body.status;}
      else if(url.pathname.endsWith('/certify')){
        const claim=data.claims[0];claim.status='Certified';claim.certified_items=[{...claim.submitted_items[0],quantity:20,current:2000,cumulative:2000}];claim.netPayable=2000;claim.invoice_id=1;claim.receivableReference='IPC-QA-1';
        assert.equal(body.quantities.D1,20);
      }else if(url.pathname.endsWith('/invoice')){data.claims[0].invoice_reference='INV-QA-1';}
      else if(url.pathname.endsWith('/receipts')){data.claims[0].paidAmount=Number(body.amount);}
      return route.fulfill({status:req.method()==='PATCH'?204:201,...(req.method()==='PATCH'?{}:{json:{id:1}})});
    });
    const base='http://127.0.0.1:'+server.httpServer.address().port;
    await page.goto(base+'/__progress?test');await page.getByLabel('Progress claim project',{exact:true}).selectOption('1');
    await page.getByRole('button',{name:'Create valuation BOQ',exact:true}).click();
    await page.locator('[name=revisionReason]').fill('QS prepared initial valuation');
    await page.getByLabel('code item 1',{exact:true}).fill('D1');await page.getByLabel('description item 1',{exact:true}).fill('Drainage work');
    await page.getByLabel('quantity item 1',{exact:true}).fill('100');await page.getByLabel('rate item 1',{exact:true}).fill('100');
    await page.getByRole('button',{name:'Save valuation BOQ draft',exact:true}).click();
    await page.getByRole('button',{name:'Approve internally',exact:true}).click();await page.locator('[name=reference]').fill('Approved estimate QA');
    await page.getByRole('button',{name:'Save approval',exact:true}).click();
    await page.getByRole('button',{name:'New interim application',exact:true}).click();
    await page.locator('[name=applicationDate]').fill('2042-02-28');await page.locator('[name=periodFrom]').fill('2042-02-01');await page.locator('[name=periodTo]').fill('2042-02-28');
    await page.getByLabel('Cumulative quantity D1',{exact:true}).fill('30');await page.getByRole('button',{name:'Save application draft',exact:true}).click();
    await page.getByRole('button',{name:'Open',exact:true}).click();await page.getByRole('button',{name:'Submit application',exact:true}).click();
    await page.locator('[name=reason]').fill('Measured application submitted');await page.getByRole('button',{name:'Confirm',exact:true}).click();
    await page.getByRole('button',{name:'Record client certificate',exact:true}).click();
    await page.locator('[name=certificateReference]').fill('CLIENT-1');await page.locator('[name=certifiedDate]').fill('2042-03-01');await page.locator('[name=dueDate]').fill('2042-03-15');
    await page.getByLabel('Cumulative quantity D1',{exact:true}).fill('20');await page.locator('[name=reason]').fill('Client certified twenty units');
    await page.getByRole('button',{name:'Save certificate and receivable',exact:true}).click();
    await page.getByRole('button',{name:'Issue optional invoice',exact:true}).click();
    await page.getByRole('button',{name:'Invoice PDF · INV-QA-1',exact:true}).waitFor();
    await page.screenshot({path:'/tmp/gkuc-progress-claims-'+width+'.png'});
    await page.getByRole('button',{name:'Record payment',exact:true}).click();await page.locator('[name=amount]').fill('1000');
    await page.getByRole('button',{name:'Record payment',exact:true}).last().click();
    assert.equal(data.claims[0].paidAmount,1000);
    await page.goto(base+'/__progress?readonly');await page.getByLabel('Progress claim project',{exact:true}).selectOption('1');
    assert.equal(await page.getByRole('button',{name:'New interim application',exact:true}).count(),0);
    assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.close();
    console.log(width+': BOQ approval, application, independent certification, optional invoice, partial payment and read-only controls passed');
  }
}finally{await browser?.close();await server.close();}
