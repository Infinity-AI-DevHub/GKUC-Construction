import assert from 'node:assert/strict';
import {createServer} from 'vite';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const id='\0login-architecture-fixture';
const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {Login} from '/src/main.jsx';
createRoot(document.getElementById('root')).render(React.createElement(Login,{onLogin:user=>{window.loggedInUser=user;}}));`;
const server=await createServer({root:new URL('..',import.meta.url).pathname,server:{host:'::1',port:0},plugins:[{
  name:'login-fixture',enforce:'pre',resolveId:v=>v==='/__login.js'?id:null,load:v=>v===id?source:null,
  transform(code,path){if(path.endsWith('/src/main.jsx'))return code.replace("createRoot(document.getElementById('root')).render(<App />);",'export {Login};');},
  configureServer(dev){dev.middlewares.use(async(req,res,next)=>{
    if(!req.url.startsWith('/__login?'))return next();
    res.setHeader('Content-Type','text/html');res.end(await dev.transformIndexHtml(req.url,'<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__login.js"></script></body></html>'));
  })}
}]});
let browser;
try{
  await server.listen();browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  const base='http://[::1]:'+server.httpServer.address().port+'/__login?test';
  for(const [width,height] of [[320,740],[390,844],[600,960],[768,1024],[900,1000],[1100,900],[1440,1000],[2560,1440]]){
    const page=await browser.newPage({viewport:{width,height}});const errors=[];page.on('pageerror',error=>{errors.push(error.message);console.error(error.message);});
    page.on('console',message=>{if(message.type()==='error')console.error(message.text());});
    await page.goto(base);await page.locator('.login-architecture canvas').waitFor();
    await page.waitForFunction(()=>!document.querySelector('.login-architecture').classList.contains('is-unavailable'));
    // Read in the animation frame before the browser discards the WebGL drawing buffer.
    const pixels=await page.evaluate(()=>new Promise(resolve=>{
      let attempt=0;
      const inspect=()=>{
        const c=document.querySelector('canvas'),gl=c.getContext('webgl2'),bytes=new Uint8Array(c.width*c.height*4);
        gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
        let painted=0;for(let i=3;i<bytes.length;i+=64)if(bytes[i]>0)painted++;
        if(painted>100||attempt++>15)resolve(painted);else requestAnimationFrame(inspect);
      };requestAnimationFrame(inspect);
    }));assert.ok(pixels>100,`blank canvas at ${width}`);
    await page.getByLabel('Email address',{exact:true}).fill('staff@example.com');
    await page.getByLabel('Password',{exact:true}).fill('SamplePasswordOnly');
    await page.getByRole('button',{name:'Show password',exact:true}).click();
    assert.equal(await page.locator('#login-password').getAttribute('type'),'text');
    await page.getByRole('button',{name:'Hide password',exact:true}).click();
    assert.equal(await page.locator('#login-password').getAttribute('type'),'password');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`page overflow at ${width}`);
    const panel=await page.locator('.login-panel').boundingBox(),footer=await page.locator('.login-footer').boundingBox();
    assert.ok(panel.y+panel.height<=footer.y,`footer overlap at ${width}`);
    if(width===1440){
      const before=await page.locator('canvas').screenshot();await page.waitForTimeout(700);
      await page.mouse.move(300,500);await page.waitForTimeout(300);
      assert.notDeepEqual(await page.locator('canvas').screenshot(),before,'scene must animate');
      await page.route('**/api/auth/login',route=>route.fulfill({status:400,json:{error:'Incorrect sign-in details'}}));
      await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.getByRole('alert').waitFor();
      assert.equal(await page.getByRole('button',{name:'Sign in',exact:true}).isEnabled(),true);
    }
    await page.screenshot({path:`/tmp/gkuc-login-architecture-${width}.png`,fullPage:true});
    assert.deepEqual(errors,[]);await page.close();console.log(width+': nonblank canvas, form controls and layout passed');
  }
  const reduced=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await reduced.goto(base);await reduced.locator('canvas').waitFor();await reduced.waitForTimeout(600);
  const still=await reduced.locator('canvas').screenshot();await reduced.waitForTimeout(400);
  assert.deepEqual(await reduced.locator('canvas').screenshot(),still,'reduced motion must stop the scene');await reduced.close();
  const fallback=await browser.newPage({viewport:{width:390,height:844}});
  await fallback.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type.startsWith('webgl')?null:original.call(this,type,...args);};});
  await fallback.goto(base);await fallback.locator('.login-architecture.is-unavailable').waitFor();
  await fallback.getByRole('button',{name:'Sign in',exact:true}).waitFor();await fallback.close();
  console.log('Reduced motion and unavailable-WebGL fallback passed');
}finally{await browser?.close();await server.close();}
