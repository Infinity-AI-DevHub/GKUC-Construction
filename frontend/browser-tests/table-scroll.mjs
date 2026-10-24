import assert from 'node:assert/strict';
import {createServer} from 'vite';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0table-scroll-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';
import {Table,Row,Modal} from '/src/ui.jsx';
import {RecordScopeProvider} from '/src/record-scope.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
const h=React.createElement,template='minmax(200px,1fr) 160px 180px 180px 160px 160px 160px 120px';
const table=h(Table,{title:'Employee register',columns:['Employee','Type','Department','Designation','EPF/ETF basis','Daily rate','Status','Actions'],template,
tools:h('input',{'aria-label':'Search employees',placeholder:'Search employees'})},
...Array.from({length:66},(_,i)=>h(Row,{key:i,template},h('strong',null,'Employee '+i),h('span',null,'Office'),h('span',null,'HR'),h('span',null,'HR team'),h('span',null,'LKR 30,000'),h('span',null,'LKR 1,600'),h('span',null,'Active'),h('button',{onClick:()=>document.body.dataset.action='clicked'},'Configure'))));
createRoot(document.getElementById('root')).render(h(RecordScopeProvider,{scope:{kind:'shared'}},h('main',null,
location.search.includes('modal')?h(Modal,{title:'Payroll detail',close:()=>{}},table):h('div',{style:{display:'grid',gridTemplateColumns:'minmax(0,1fr)'}},table))));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'table-scroll-fixture',resolveId:value=>value==='/__table.js'?id:null,load:value=>value===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__table?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,
      '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__table.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();
  browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,600,900,1100,1366,1500,1680,1920]){
    const page=await browser.newPage({viewport:{width,height:900}});
    for(const mode of ['page','modal']){
      await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__table?'+mode);
      const scroll=page.locator('.table-scroll');await scroll.waitFor();
      const dimensions=await scroll.evaluate(el=>({w:el.clientWidth,sw:el.scrollWidth,h:el.clientHeight,sh:el.scrollHeight}));
      assert.ok(dimensions.sh>dimensions.h,JSON.stringify({width,mode,dimensions}));
      if(width<=1366||mode==='modal')assert.ok(dimensions.sw>dimensions.w,JSON.stringify({width,mode,dimensions}));
      await scroll.focus();await page.keyboard.press('ArrowRight');
      await scroll.evaluate(el=>{el.scrollLeft=el.scrollWidth;el.scrollTop=el.scrollHeight});
      assert.ok(await scroll.evaluate(el=>el.scrollTop>0));
      await scroll.locator('button').last().click();
      assert.equal(await page.locator('body').getAttribute('data-action'),'clicked');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await page.screenshot({path:'/tmp/gkuc-table-scroll-'+width+'-'+mode+'.png'});
    }
    await page.close();console.log(width+': page and modal scrolling, final action and page containment passed');
  }
}finally{await browser?.close();await server.close()}
