import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0record-search-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';
import DocumentSearch from '/src/DocumentSearch.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
const project=location.search.includes('project')?{id:4,name:'Bridge Works'}:null;
createRoot(document.getElementById('root')).render(React.createElement(DocumentSearch,{open:true,onClose:()=>{},project,companies:[{id:2,name:'GKUC Readymix'}]}));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'record-search-fixture',resolveId:path=>path==='/__record-search.js'?id:null,load:path=>path===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__record-search?'))return next();
    res.setHeader('Content-Type','text/html');
    res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__record-search.js"></script></body></html>'));
  });}
}]});
let browser;
try {
  await server.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const base='http://127.0.0.1:'+server.httpServer.address().port;
  for(const width of [320,390,1440]){
    const page=await browser.newPage({viewport:{width,height:900}});
    const queries=[];
    await page.route('**/api/search?**',route=>{
      const params=new URL(route.request().url()).searchParams;
      queries.push(params);
      const second=params.get('page')==='2';
      return route.fulfill({json:{hasMore:!second,results:[{
        id:second?35:21,type:'boq',reference:second?'BOQ-OLD':'BOQ-42',title:'Bridge works',
        version:2,companyId:2,company:'GKUC Readymix',status:'Approved',recordDate:'2026-01-20',
        path:'/quantity-surveying/bills-of-quantities?record=21'
      }]}});
    });
    await page.route('**/api/uploads/search/documents?**',route=>route.fulfill({json:{results:[{id:9,title:'Scanned bridge plan',filename:'plan.pdf'}]}}));
    await page.route('**/quantity-surveying/bills-of-quantities?**',route=>route.fulfill({body:'BOQ destination'}));
    await page.goto(base+'/__record-search?global');
    await page.getByRole('searchbox',{name:'Search SiteOps'}).fill('bridge');
    await page.getByText('BOQ-42 · Bridge works',{exact:true}).waitFor();
    await page.getByText('Scanned bridge plan',{exact:true}).waitFor();
    await page.getByLabel('Company').selectOption('2');
    await page.getByText('BOQ-42 · Bridge works',{exact:true}).waitFor();
    assert.equal(queries.at(-1).get('companyId'),'2');
    assert.equal(await page.getByText('Scanned bridge plan',{exact:true}).count(),0);
    await page.getByRole('button',{name:'Load more records'}).click();
    await page.getByText('BOQ-OLD · Bridge works',{exact:true}).waitFor();
    assert.equal(queries.at(-1).get('page'),'2');
    assert.ok(await page.locator('.docsearch').evaluate(el=>el.scrollWidth<=el.clientWidth));
    await page.getByRole('button',{name:/BOQ-42/}).click();
    await page.waitForURL('**/quantity-surveying/bills-of-quantities?record=21');
    assert.equal(await page.evaluate(()=>localStorage.getItem('gkuc:company-id')),'2');
    await page.goto(base+'/__record-search?project');
    await page.getByText('BOQ-42 · Bridge works',{exact:true}).waitFor();
    assert.equal(queries.at(-1).get('projectId'),'4');
    assert.equal(queries.at(-1).get('q'),'');
    await page.close();
    console.log(width+': search, scanned results, filters, pagination, company link and project context passed');
  }
} finally { await browser?.close(); await server.close(); }
