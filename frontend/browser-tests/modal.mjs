import assert from 'node:assert/strict';
import {createServer} from 'vite';

const {chromium}=await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const moduleId='\0modal-regression.js';
const source=`import React from 'react';
import {createRoot} from 'react-dom/client';
import {Modal,Field} from '/src/ui.jsx';
import {RecordScopeProvider} from '/src/record-scope.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
const h=React.createElement;
function Fixture(){const [open,setOpen]=React.useState(false),[nested,setNested]=React.useState(false);
return h(RecordScopeProvider,{scope:{kind:'shared'}},h('main',null,
h('div',{style:{height:180,width:300,overflow:'hidden',transform:'translateZ(0)',marginTop:400}},
h('button',{onClick:()=>setOpen(true)},'Open leave settings'),
open&&h(Modal,{title:'Leave settings',close:()=>setOpen(false)},
h('div',{className:'report-form'},h('button',{type:'button',onClick:()=>setNested(true)},'Open nested'),
...Array.from({length:28},(_,i)=>h(Field,{key:i,name:'field'+i,label:'Leave setting '+i,defaultValue:'14'})),
h('div',{className:'form-actions'},h('button',{className:'primary',type:'button'},'Save settings'))),
nested&&h(Modal,{title:'Nested review',close:()=>setNested(false)},h('p',null,'Nested content'))))));}
createRoot(document.getElementById('root')).render(h(Fixture));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,
  server:{host:'127.0.0.1',port:0},plugins:[{name:'modal-regression',
    resolveId:id=>id==='/__modal-regression.js'?moduleId:null,
    load:id=>id===moduleId?source:null,
    configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
      if(req.url!=='/__modal-regression')return next();
      res.setHeader('Content-Type','text/html');
      res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__modal-regression.js"></script></body></html>'));
    });}
  }]});
let browser;
try {
  await server.listen();
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  for(const [name,width,height] of [['desktop',1440,900],['mobile',390,844]]){
    const page=await browser.newPage({viewport:{width,height}});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__modal-regression`);
    await page.getByRole('button',{name:'Open leave settings',exact:true}).click();
    await page.getByRole('dialog',{name:'Leave settings',exact:true}).waitFor();
    const box=await page.locator('body > .modal-backdrop').boundingBox();
    assert.deepEqual(box,{x:0,y:0,width,height});
    const dialog=await page.getByRole('dialog',{name:'Leave settings',exact:true}).boundingBox();
    assert.ok(dialog.x>=0&&dialog.y>=0&&dialog.x+dialog.width<=width&&dialog.y+dialog.height<=height);
    assert.equal(await page.locator('body').evaluate(body=>body.style.overflow),'hidden');
    assert.equal(await page.getByText('Shared resource',{exact:true}).count(),1,'portal retains React scope context');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.getByRole('button',{name:'Save settings',exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.keyboard.press('Tab');
    assert.equal(await page.getByRole('button',{name:'Close dialog',exact:true}).evaluate(el=>el===document.activeElement),true);
    await page.getByRole('button',{name:'Open nested',exact:true}).click();
    await page.getByRole('dialog',{name:'Nested review',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(),1);
    assert.equal(await page.locator('body').evaluate(body=>body.style.overflow),'hidden');
    await page.getByRole('button',{name:'Save settings',exact:true}).scrollIntoViewIfNeeded();
    await page.getByRole('button',{name:'Save settings',exact:true}).click();
    await page.locator('.modal-content').evaluate(el=>el.scrollTop=0);
    await page.screenshot({path:`/tmp/gkuc-modal-${name}.png`});
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(),0);
    assert.equal(await page.locator('body').evaluate(body=>body.style.overflow),'');
    assert.equal(await page.getByRole('button',{name:'Open leave settings',exact:true}).evaluate(el=>el===document.activeElement),true);
    assert.deepEqual(errors,[]);
    await page.close();
    console.log(`${name}: full-viewport portal, scrolling, focus, context and nested dialogs passed`);
  }
} finally {await browser?.close();await server.close();}
