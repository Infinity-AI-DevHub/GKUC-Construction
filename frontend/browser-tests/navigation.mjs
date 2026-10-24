import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0navigation-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {Square} from 'lucide-react';
import NavBar from '/src/NavBar.jsx';import {MODULE_PERMISSIONS,navigationItems} from '/src/navigation.js';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
function Fixture(){const [user,setUser]=React.useState({permissions:[]});window.setNavUser=setUser;
return React.createElement('div',{className:'app'},React.createElement('aside',{className:'open'},
React.createElement('div',{className:'brand'},'GKUC'),React.createElement(NavBar,{items:navigationItems(Object.keys(MODULE_PERMISSIONS).map(name=>[name,Square]),user),activePage:'Dashboard',openTasks:3,onSelect:name=>document.body.dataset.selected=name}),
React.createElement('div',{className:'sidebar-bottom'},'Account')),React.createElement('div',{className:'workspace'},React.createElement('main',null,'Workspace')))}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'navigation-fixture',resolveId:v=>v==='/__navigation.js'?id:null,load:v=>v===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__navigation?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__navigation.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  const profiles=[['Finance Department Head',['finance.view','finance.invoice','projects.view','qs.view','store.view','chat.use','drive.use'],'Finance'],
    ['HR Department Head',['hr.view','hr.manage','projects.view','transport.view'],'People'],
    ['QS Department Head',['qs.view','qs.boq','projects.view','finance.view'],'Quantity Surveying'],
    ['Transport Department Head',['transport.view','transport.manage','projects.view'],'Fleet'],
    ['Store Keeper',['store.view','store.manage','store.lending','projects.view'],'Materials']];
  for(const width of [390,600,900,1100,1366,1500,1680,1920]){
    const page=await browser.newPage({viewport:{width,height:1000}});
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__navigation?test');
    await page.waitForFunction(()=>typeof window.setNavUser==='function');
    for(const [role,permissions,primary] of profiles){
      await page.evaluate(user=>window.setNavUser(user),{role,permissions});
      await page.waitForFunction(name=>document.querySelectorAll('[data-nav-item]')[1]?.textContent===name,primary);
      const links=page.locator('[data-nav-item]');assert.equal(await links.first().innerText(),'Dashboard');
      assert.ok(await links.nth(1).isVisible(),width+' '+role+' primary workspace hidden');
      assert.equal(await links.filter({hasText:/^Administration$/}).count(),0);
      await links.nth(1).click();assert.equal(await page.locator('body').getAttribute('data-selected'),primary);
      const more=page.locator('.nav-more-button');
      if(await page.locator('nav').evaluate(el=>getComputedStyle(el).flexDirection==='column'))assert.equal(await more.isVisible(),false);
      if(await more.isVisible()){
        await more.click();const allowed=await links.allTextContents();
        for(const label of await page.getByRole('menuitem').allTextContents())assert.ok(allowed.includes(label));
        await page.keyboard.press('Escape');
      }
    }
    await page.screenshot({path:'/tmp/gkuc-navigation-'+width+'.png'});
    await page.evaluate(()=>window.setNavUser({role:'Finance Department Head',permissions:[]}));
    await page.waitForFunction(()=>document.querySelectorAll('[data-nav-item]').length===1);
    assert.equal(await page.locator('[data-nav-item]').innerText(),'Dashboard');
    assert.equal(await page.getByRole('menuitem').count(),0);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.close();console.log(width+': department priority, More menu, selection and permission revocation passed');
  }
}finally{await browser?.close();await server.close()}
