const {app,BrowserWindow,protocol,net,session,ipcMain,Menu,shell,dialog,safeStorage}=require('electron');
const fs=require('node:fs/promises');
const path=require('node:path');
const {ORIGIN,serverOrigin,requestTarget,assetPath,navigationAllowed,externalAllowed}=require('./core.cjs');
protocol.registerSchemesAsPrivileged([{scheme:'siteops',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);
if(process.env.SITEOPS_DESKTOP_USER_DATA)app.setPath('userData',process.env.SITEOPS_DESKTOP_USER_DATA);
app.setName('GKUC Construction');
// Keep existing desktop profiles and saved connection settings across the name change.
if(!process.env.SITEOPS_DESKTOP_USER_DATA)app.setPath('userData',path.join(app.getPath('appData'),app.isPackaged?'GKUC SiteOps':'gkuc-siteops-desktop'));
const {sessionStore}=require('./session-store.cjs');
const windows=new Set();let mainWindow,server,savedSession;
const allowLocal=!app.isPackaged&&process.env.SITEOPS_ALLOW_LOCAL_HTTP==='1';
const uiRoot=path.resolve(__dirname,'../ui');
const preferences={preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,plugins:true};
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.woff2':'font/woff2','.ico':'image/x-icon','.json':'application/json'};
async function connection(){
  let saved;try{saved=JSON.parse(await fs.readFile(path.join(app.getPath('userData'),'connection.json'),'utf8'));}catch{}
  const defaults=require('../resources/connection.json');
  return serverOrigin(process.env.SITEOPS_SERVER_URL||saved?.serverUrl||defaults.serverUrl,allowLocal);
}
function secureWindow(window){
  windows.add(window);window.on('closed',()=>windows.delete(window));
  window.webContents.on('will-navigate',(event,url)=>{if(!navigationAllowed(url,server))event.preventDefault();});
  window.webContents.on('will-redirect',(event,url)=>{if(!navigationAllowed(url,server))event.preventDefault();});
  window.webContents.on('will-attach-webview',event=>event.preventDefault());
  window.webContents.setWindowOpenHandler(({url})=>{
    if(navigationAllowed(url,server))return {action:'allow',overrideBrowserWindowOptions:{width:1100,height:800,autoHideMenuBar:true,webPreferences:preferences}};
    if(externalAllowed(url))void shell.openExternal(url);
    return {action:'deny'};
  });
  window.webContents.on('did-create-window',child=>secureWindow(child));
}
async function route(request){
  try{
    const target=requestTarget(request.url,server);
    if(target.remote){
      const headers=new Headers(request.headers);
      for(const name of ['host','connection','origin','referer','sec-fetch-site','sec-fetch-mode','sec-fetch-dest'])headers.delete(name);
      const init={method:request.method,headers,redirect:'manual',signal:request.signal};
      if(!['GET','HEAD'].includes(request.method)){init.body=request.body;init.duplex='half';}
      const response=await net.fetch(target.remote,init);
      if(response.status>=300&&response.status<400){
        const location=response.headers.get('location');
        if(location){const url=new URL(location,target.remote);if(url.origin!==server)return new Response('External redirect refused',{status:502});
          const copied=new Headers(response.headers);copied.set('location',ORIGIN+url.pathname+url.search);return new Response(null,{status:response.status,headers:copied});}
      }
      return response;
    }
    const setup=target.file==='desktop-setup';
    let filename=setup?path.join(__dirname,'setup.html'):assetPath(uiRoot,target.file);
    try{await fs.access(filename);}catch{
      if(path.extname(target.file))return new Response('Asset not found',{status:404});
      filename=path.join(uiRoot,'index.html');
    }
    const body=await fs.readFile(filename);
    return new Response(request.method==='HEAD'?null:body,{headers:{'content-type':mime[path.extname(filename)]||'application/octet-stream',
      'Content-Security-Policy':"default-src 'self' blob: data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' blob: data: https:; connect-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'",'X-Content-Type-Options':'nosniff'}});
  }catch{
    return new Response(JSON.stringify({error:'The SiteOps server could not be reached. Check your connection and server address.'}),{status:502,headers:{'content-type':'application/json'}});
  }
}
function createWindow(){
  mainWindow=new BrowserWindow({width:1440,height:950,minWidth:800,minHeight:600,show:false,backgroundColor:'#102a43',icon:path.join(__dirname,'../resources/icon.png'),webPreferences:preferences});
  secureWindow(mainWindow);mainWindow.once('ready-to-show',()=>mainWindow.show());
  mainWindow.webContents.on('page-title-updated',event=>{event.preventDefault();mainWindow.setTitle(`GKUC Construction — ${new URL(server).host}`);});
  void mainWindow.loadURL(ORIGIN+'/');
}
app.whenReady().then(async()=>{
  server=await connection();
  savedSession=sessionStore(app.getPath('userData'),safeStorage);
  protocol.handle('siteops',route);
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>{
    const own=navigationAllowed(contents.getURL(),server);
    callback(own&&['media','notifications','clipboard-sanitized-write','fullscreen'].includes(permission));
  });
  session.defaultSession.on('will-download',(_event,item)=>item.setSaveDialogOptions({title:'Save GKUC Construction file',defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))}));
  const sessionFrame=event=>{
    const url=new URL(event.senderFrame?.url||'about:blank');
    if(event.sender!==mainWindow?.webContents||event.senderFrame!==event.sender.mainFrame||url.protocol!=='siteops:'||url.hostname!=='app'||url.pathname==='/desktop-setup')throw new Error('Saved sign-in is available only to the main application.');
  };
  ipcMain.handle('session:get',event=>{sessionFrame(event);return savedSession.read(server);});
  ipcMain.handle('session:set',(event,value)=>{sessionFrame(event);return savedSession.save(server,value);});
  ipcMain.handle('session:clear',event=>{sessionFrame(event);return savedSession.clear();});
  ipcMain.handle('connection:get',()=>({serverUrl:server}));
  ipcMain.handle('connection:set',async(event,value)=>{
    if(event.senderFrame?.url!==ORIGIN+'/desktop-setup')throw new Error('Connection settings are not open.');
    const next=serverOrigin(value,allowLocal);
    await savedSession.clear();
    await fs.mkdir(app.getPath('userData'),{recursive:true});
    const config=path.join(app.getPath('userData'),'connection.json');
    await fs.writeFile(config+'.tmp',JSON.stringify({serverUrl:next}));await fs.rename(config+'.tmp',config);
    app.relaunch();app.exit(0);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform==='darwin'?[{role:'appMenu'}]:[]),
    {label:'GKUC Construction',submenu:[{label:'Connection settings…',click:()=>{
      for(const window of windows)if(window!==mainWindow)window.close();
      void mainWindow.loadURL(ORIGIN+'/desktop-setup');
    }},{label:'Open browser version',click:()=>void shell.openExternal(server)},{type:'separator'},{role:'quit'}]},
    {role:'editMenu'},{label:'View',submenu:[{role:'reload'},{role:'forceReload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'},...(!app.isPackaged?[{role:'toggleDevTools'}]:[])]},
    {label:'Window',submenu:[{role:'minimize'},{role:'close'}]}
  ]));
  createWindow();
}).catch(()=>{dialog.showErrorBox('GKUC Construction','The desktop client could not start. Check its connection configuration or reinstall it.');app.quit();});
app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0&&server)createWindow();});
app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
