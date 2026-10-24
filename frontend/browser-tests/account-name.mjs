import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0account-name-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';
import AccountPanel from '/src/AccountPanel.jsx';import {Modal} from '/src/ui.jsx';
import '/src/styles.css';import '/src/theme.css';import '/src/reference.css';import '/src/responsive.css';import '/src/workspace.css';
function Fixture(){const [name,setName]=React.useState('Original Name');React.useEffect(()=>{const update=e=>setName(e.detail);window.addEventListener('account-name-changed',update);return()=>window.removeEventListener('account-name-changed',update)},[]);
return React.createElement(React.Fragment,null,React.createElement('span',{id:'current-name'},name),React.createElement(Modal,{title:'My account',close:()=>{}},React.createElement(AccountPanel)))}
createRoot(document.getElementById('root')).render(React.createElement(Fixture));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'127.0.0.1',port:0},plugins:[{
  name:'account-name-fixture',resolveId:value=>value==='/__account.js'?id:null,load:value=>value===id?source:null,
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__account?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,
      '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__account.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE});
  for(const width of [390,1440]){
    const page=await browser.newPage({viewport:{width,height:950}});let name='Original Name',fail=false;
    await page.route('**/api/auth/me',async route=>{
      if(route.request().method()==='PATCH'){
        if(fail)return route.fulfill({status:400,json:{error:'Name could not be saved'}});
        name=route.request().postDataJSON().name.trim();
      }
      return route.fulfill({json:{user:{name}}});
    });
    await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/__account?test');
    const input=page.getByRole('textbox',{name:'Display name'});
    await input.fill('Updated Name');await page.getByRole('button',{name:'Save display name'}).click();
    await page.getByRole('status').filter({hasText:'Display name saved.'}).waitFor();
    assert.equal(await page.locator('#current-name').textContent(),'Updated Name');
    await page.reload();await page.waitForFunction(()=>document.querySelector('[name=displayName]')?.value==='Updated Name');
    fail=true;await input.fill('Unsaved Name');await page.getByRole('button',{name:'Save display name'}).click();
    await page.getByRole('alert').filter({hasText:'Name could not be saved'}).waitFor();
    assert.equal(name,'Updated Name');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.screenshot({path:'/tmp/gkuc-account-name-'+width+'.png'});
    await page.close();console.log(width+': display name save, reload and failure states passed');
  }
}finally{await browser?.close();await server.close()}
