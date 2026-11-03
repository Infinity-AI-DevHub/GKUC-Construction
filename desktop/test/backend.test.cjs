// Explicitly opt-in: uses only a new, disposable database on loopback MySQL.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createRequire}=require('node:module');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const net=require('node:net');
const {_electron}=require('playwright');
const backend=path.resolve(__dirname,'../../backend');
const backendRequire=createRequire(path.join(backend,'package.json'));
test('desktop login and live authenticated bootstrap against the actual backend', {timeout:90000,skip:process.env.SITEOPS_TEST_MYSQL!=='1'},async()=>{
  await new Promise((resolve,reject)=>{
    const probe=net.createServer();probe.once('error',()=>reject(new Error('Desktop test port 43973 is already in use')));
    probe.listen(43973,()=>probe.close(resolve));
  });
  const config=backendRequire('dotenv').parse(await fs.readFile(path.join(backend,'.env')));
  const env={...config,...process.env,STORAGE_DRIVER:'local',NOTIFY_CHANNELS:'',RESEND_API_KEY:'',TWILIO_ACCOUNT_SID:'',TWILIO_AUTH_TOKEN:'',WHATSAPP_TOKEN:'',WHATSAPP_PHONE_ID:''};
  assert.ok(['localhost','127.0.0.1','::1'].includes(env.DB_HOST),'Desktop tests require local MySQL');
  assert.ok(!config.STORAGE_DRIVER||config.STORAGE_DRIVER==='local','Use a local-storage checkout for desktop integration tests');
  const db=`gkuc_desktop_test_${process.pid}`;
  const mysql=await backendRequire('mysql2/promise').createConnection({host:env.DB_HOST,port:Number(env.DB_PORT||3306),user:env.DB_USER,password:env.DB_PASSWORD});
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gkuc-real-desktop-'));
  let child,electron,created=false;
  try{
    await mysql.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);created=true;
    child=spawn(process.env.SITEOPS_BACKEND_NODE||process.execPath,['src/index.js'],{cwd:backend,env:{...env,DB_NAME:db,PORT:'43973',UPLOAD_DIR:path.join(temp,'uploads'),RATE_MAX_REQUESTS:'100000',RATE_MAX_WRITES:'100000'},stdio:'ignore'});
    let ready=false;for(let i=0;i<120;i++){try{if((await fetch('http://127.0.0.1:43973/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,150));}
    assert.ok(ready,'Local backend started');
    electron=await _electron.launch({args:[path.resolve(__dirname,'..')],env:{...process.env,SITEOPS_SERVER_URL:'http://127.0.0.1:43973',SITEOPS_ALLOW_LOCAL_HTTP:'1',SITEOPS_DESKTOP_USER_DATA:path.join(temp,'profile')}});
    const page=await electron.firstWindow();
    await page.getByLabel('Email address').fill('owner@gkuc.lk');await page.getByLabel('Password',{exact:true}).fill('GKUC@2026');
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.locator('.bell-group.is-live').first().waitFor({timeout:30000});
    assert.equal(await page.getByRole('button',{name:'Sign in',exact:true}).count(),0);
    const result=await page.evaluate(async()=>{const r=await fetch('/api/bootstrap',{headers:{Authorization:`Bearer ${sessionStorage.getItem('gkuc-token')}`}});const body=await r.json();return {status:r.status,hasUser:!!body.user,hasData:!!body.data};});
    assert.deepEqual(result,{status:200,hasUser:true,hasData:true});
    // A write from a second API client must cause a renderer bootstrap refresh.
    await page.waitForTimeout(1000); // Let the initial connection resync finish first.
    const login=await fetch('http://127.0.0.1:43973/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'owner@gkuc.lk',password:'GKUC@2026'})}).then(r=>r.json());
    assert.ok(login.token);
    const bootstrap=page.waitForResponse(r=>r.url().endsWith('/api/bootstrap')&&r.status()===200);
    const write=await fetch('http://127.0.0.1:43973/api/clients',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${login.token}`},body:JSON.stringify({type:'Private',name:'Desktop live update test'})});
    assert.equal(write.status,201);await bootstrap;
    const savedToken=await page.evaluate(()=>sessionStorage.getItem('gkuc-token'));
    await page.evaluate(()=>{window.__originalFetch=window.fetch;window.fetch=(url,options)=>{
      if(url==='/api/bootstrap'){window.__desktopFailedRefresh=true;return Promise.resolve(new Response(JSON.stringify({error:'Temporary test outage'}),{status:503,headers:{'content-type':'application/json'}}));}
      return window.__originalFetch(url,options);
    };});
    await fetch('http://127.0.0.1:43973/api/clients',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${login.token}`},body:JSON.stringify({type:'Private',name:'Desktop outage test'})});
    await page.waitForFunction(()=>window.__desktopFailedRefresh);await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('gkuc-token')),savedToken);
    assert.equal(await page.getByRole('button',{name:'Sign in',exact:true}).count(),0);
    await page.evaluate(()=>{window.fetch=window.__originalFetch;delete window.__originalFetch;});
    const recovered=page.waitForResponse(r=>r.url().endsWith('/api/bootstrap')&&r.status()===200,{timeout:30000});
    const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;
    await page.locator('.bell-group.is-live').first().waitFor({state:'detached',timeout:10000});
    child=spawn(process.env.SITEOPS_BACKEND_NODE||process.execPath,['src/index.js'],{cwd:backend,env:{...env,DB_NAME:db,PORT:'43973',UPLOAD_DIR:path.join(temp,'uploads'),RATE_MAX_REQUESTS:'100000',RATE_MAX_WRITES:'100000'},stdio:'ignore'});
    await recovered;await page.locator('.bell-group.is-live').first().waitFor();
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('gkuc-token')),savedToken);
    await page.screenshot({path:path.resolve(__dirname,'../test-results/dashboard.png')});
  }finally{
    if(electron)await electron.close();
    if(child){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}
    if(created)await mysql.query(`DROP DATABASE \`${db}\``);
    await mysql.end();await fs.rm(temp,{recursive:true,force:true});
  }
});
