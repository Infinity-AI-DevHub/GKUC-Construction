const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {_electron}=require('playwright');
test('packaged macOS app opens its bundled login without a server', {timeout:30000,skip:process.platform!=='darwin'},async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'gkuc-packaged-'));
  let app;
  try{
    app=await _electron.launch({executablePath:path.resolve(__dirname,'../release/mac-arm64/GKUC Construction.app/Contents/MacOS/GKUC Construction'),args:[],env:{...process.env,SITEOPS_SERVER_URL:'https://desktop-test.invalid',SITEOPS_DESKTOP_USER_DATA:profile}});
    const page=await app.firstWindow();await page.getByLabel('Email address').waitFor();
    assert.equal(await app.evaluate(({app})=>app.isPackaged),true);
    assert.equal(await app.evaluate(({app})=>app.getName()),'GKUC Construction');
    assert.match(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle()),/^GKUC Construction — /);
    assert.equal(await page.evaluate(()=>typeof require),'undefined');
    assert.equal((await page.evaluate(()=>window.siteopsDesktop.connection())).serverUrl,'https://desktop-test.invalid');
  }finally{if(app)await app.close();await fs.rm(profile,{recursive:true,force:true});}
});
