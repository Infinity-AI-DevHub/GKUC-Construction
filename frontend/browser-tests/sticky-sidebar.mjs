import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0sticky-sidebar-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {Page,Tabs} from '/src/ui.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';import '/src/pages/quantity-surveying.css';
const h=React.createElement,qs=location.search.includes('qs'),labels=Array.from({length:30},(_,i)=>'Section '+(i+1));
const content=h('div',{className:'test-content',style:{height:3000}},h('h2',{id:'content-marker'},'Page content'),h('p',null,'Main page continues scrolling'));
const buttons=labels.slice(0,6).map(label=>h('button',{key:label,onClick:()=>document.body.dataset.clicked=label},h('span',null,'+'),h('span',null,h('strong',null,label),h('small',null,'Commercial workspace'))));
const body=qs?h('div',{className:'qs-workspace'},h(Page,{title:'Quantity Surveying'},h('div',{className:'qs-layout'},
h('aside',{className:'qs-navigation'},h('div',{className:'qs-navigation-title'},'Commercial desk'),h('nav',null,...buttons),h('div',{className:'qs-navigation-note'},h('strong',null,'One connected workflow'),h('p',null,'Estimate. Quote. Review. Track every project cost.'))),h('div',{className:'qs-content'},content)))):
h(Page,{title:'People'},h(Tabs,{tabs:labels,active:labels[0],onChange:label=>document.body.dataset.clicked=label}),content);
createRoot(document.getElementById('root')).render(h('div',{className:'app'},h('aside',null,h('div',{className:'brand'},'GKUC SiteOps')),
h('div',{className:'workspace'},h('main',null,h('div',{style:{height:250}},'Company and workspace context'),body))));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'sticky-sidebar-fixture',resolveId:v=>v==='/__sticky.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__sticky?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__sticky.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,600,900,1100,1366,1500,1680,1920])for(const mode of ['qs','shared']){
    const page=await browser.newPage({viewport:{width,height:440}});
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__sticky?'+mode);
    const sidebar=page.locator(mode==='qs'?'.qs-navigation':'.module-navigation');await sidebar.waitFor();
    await page.evaluate(()=>document.fonts.ready);
    const desktop=width>(mode==='qs'?900:800);
    if(desktop){
      const initial=await sidebar.boundingBox();assert.ok(initial.y>24);
      await page.evaluate(y=>scrollTo(0,y),initial.y+100);await page.waitForTimeout(80);
      const first=await sidebar.boundingBox();assert.ok(Math.abs(first.y-24)<2,JSON.stringify({width,mode,first}));
      const marker=await page.locator('#content-marker').boundingBox();
      await page.evaluate(()=>scrollBy(0,200));await page.waitForTimeout(80);
      const second=await sidebar.boundingBox();assert.ok(Math.abs(second.y-first.y)<2);
      assert.ok((await page.locator('#content-marker').boundingBox()).y<marker.y-190);
      const menu=sidebar.locator(mode==='qs'?'nav':'.toolbar');
      assert.ok(await menu.evaluate(el=>el.scrollHeight>el.clientHeight),width+' '+mode+' needs internal scroll');
      const scrollY=await page.evaluate(()=>window.scrollY);
      await menu.evaluate(el=>el.scrollTop=el.scrollHeight);
      assert.ok(await menu.evaluate(el=>el.scrollTop>0));assert.equal(await page.evaluate(()=>window.scrollY),scrollY);
      await menu.locator('button').last().click();assert.equal(await page.locator('body').getAttribute('data-clicked'),mode==='qs'?'Section 6':'Section 30');
      assert.ok(Math.abs((await sidebar.boundingBox()).y-24)<2);
    }else assert.equal(await sidebar.evaluate(el=>getComputedStyle(el).position),'static');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:'/tmp/gkuc-sticky-sidebar-'+width+'-'+mode+'.png'});
    await page.close();console.log(width+' '+mode+': sticky position, internal scrolling and responsive containment passed');
  }
}finally{await browser?.close();await server.close()}
