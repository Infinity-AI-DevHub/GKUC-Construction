const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {_electron}=require('playwright');
test('real Electron: bundled UI, secure renderer, API auth, upload, streaming, popup and PDF', {timeout:90000},async()=>{
  const received=[];
  const server=http.createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    received.push({url:req.url,auth:req.headers.authorization,body:Buffer.concat(chunks).toString()});
    if(req.url==='/api/events-test'){
      res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');
      setTimeout(()=>res.end('data: second\n\n'),150);return;
    }
    if(req.url==='/api/pdf-test'){res.writeHead(200,{'content-type':'application/pdf'});res.end('%PDF-1.4\nfixture');return;}
    if(req.url==='/api/download-test'){res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="report.csv"'});res.end('name,value\nDesktop,1\n');return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({status:'active',ok:true}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'siteops-electron-'));
  let electron;
  try{
    electron=await _electron.launch({args:[path.resolve(__dirname,'..')],env:{...process.env,SITEOPS_SERVER_URL:`http://127.0.0.1:${server.address().port}`,SITEOPS_ALLOW_LOCAL_HTTP:'1',SITEOPS_DESKTOP_USER_DATA:directory}});
    const page=await electron.firstWindow();
    await page.getByLabel('Email address').waitFor();
    assert.equal(await page.evaluate(()=>typeof require),'undefined');
    assert.equal(await page.evaluate(()=>typeof process),'undefined');
    const results=await page.evaluate(async()=>{
      const headers={Authorization:'Bearer local-test-token'};
      const api=await fetch('/api/transport-test',{headers}).then(r=>r.json());
      const form=new FormData();form.append('file',new Blob(['attendance test']), 'attendance.txt');
      const upload=await fetch('/api/upload-test',{method:'POST',headers,body:form}).then(r=>r.json());
      const response=await fetch('/api/events-test',{headers});const reader=response.body.getReader();
      const first=await reader.read();let rest='';for(;;){const next=await reader.read();if(next.done)break;rest+=new TextDecoder().decode(next.value);}
      const pdf=await fetch('/api/pdf-test',{headers}).then(r=>r.text());
      const child=window.open('about:blank','_blank');child.document.write('<html><body>SiteOps print verification</body></html>');child.document.close();
      return {api,upload,first:new TextDecoder().decode(first.value),rest,pdf,popup:!!child};
    });
    assert.equal(results.api.ok,true);assert.equal(results.upload.ok,true);
    assert.match(results.first,/first/);assert.match(results.rest,/second/);assert.match(results.pdf,/^%PDF/);assert.equal(results.popup,true);
    const childDenied=await electron.evaluate(async({BrowserWindow})=>{
      const child=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='about:blank');
      return child.webContents.executeJavaScript('(async()=>{try{await window.siteopsDesktop.restoreSession();return false;}catch{return true;}})()');
    });
    assert.equal(childDenied,true,'print/pop-up frames cannot read saved sign-in');
    assert.equal(received.find(r=>r.url==='/api/transport-test').auth,'Bearer local-test-token');
    assert.match(received.find(r=>r.url==='/api/upload-test').body,/attendance test/);
    const bytes=await electron.evaluate(async({BrowserWindow})=>Array.from(await BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='about:blank').webContents.printToPDF({})));
    assert.match(Buffer.from(bytes).toString('ascii',0,5),/^%PDF/);
    const download=path.join(directory,'report.csv');
    await electron.evaluate(({session},destination)=>{globalThis.__testDownload=new Promise(resolve=>{
      session.defaultSession.once('will-download',(_event,item)=>{item.setSavePath(destination);item.once('done',(_event,state)=>resolve(state));});
    });},download);
    await page.evaluate(()=>{const link=document.createElement('a');link.href='/api/download-test';document.body.append(link);link.click();link.remove();});
    assert.equal(await electron.evaluate(()=>globalThis.__testDownload),'completed');
    assert.match(await fs.readFile(download,'utf8'),/Desktop,1/);
    await fs.mkdir(path.resolve(__dirname,'../test-results'),{recursive:true});
    await page.screenshot({path:path.resolve(__dirname,'../test-results/login.png')});
    await page.goto('siteops://app/desktop-setup');
    await assert.rejects(page.evaluate(()=>window.siteopsDesktop.restoreSession()),/only to the main application/);
  }finally{if(electron)await electron.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
});
