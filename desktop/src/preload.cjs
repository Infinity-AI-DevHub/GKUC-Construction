const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('siteopsDesktop',Object.freeze({
  connection:()=>ipcRenderer.invoke('connection:get'),
  saveConnection:serverUrl=>ipcRenderer.invoke('connection:set',serverUrl)
}));
