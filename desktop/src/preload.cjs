const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('siteopsDesktop',Object.freeze({
  restoreSession:()=>ipcRenderer.invoke('session:get'),
  saveSession:token=>ipcRenderer.invoke('session:set',token),
  clearSession:()=>ipcRenderer.invoke('session:clear'),
  connection:()=>ipcRenderer.invoke('connection:get'),
  saveConnection:serverUrl=>ipcRenderer.invoke('connection:set',serverUrl)
}));
