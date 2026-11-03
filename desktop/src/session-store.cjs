const fs=require('node:fs/promises');
const path=require('node:path');
// Only opaque sessions are stored. Passwords never enter this store.
function sessionStore(directory,safeStorage){
  const filename=path.join(directory,'session.enc');let pending=Promise.resolve();
  const queued=action=>{const result=pending.then(action);pending=result.catch(()=>{});return result;};
  const available=()=>safeStorage.isEncryptionAvailable()&&(process.platform!=='linux'||safeStorage.getSelectedStorageBackend?.()!=='basic_text');
  return {
    read:server=>queued(async()=>{
      if(!available())return null;
      try{const saved=JSON.parse(safeStorage.decryptString(await fs.readFile(filename)));return saved.server===server&&typeof saved.token==='string'?saved.token:null;}
      catch(error){if(error.code!=='ENOENT')await fs.rm(filename,{force:true});return null;}
    }),
    save:(server,token)=>queued(async()=>{
      if(typeof token!=='string'||token.length<20||token.length>4096)throw new Error('Invalid saved session.');
      if(!available())throw new Error('Secure device storage is unavailable. Unlock your device keychain and try again.');
      await fs.mkdir(directory,{recursive:true});
      await fs.writeFile(filename+'.tmp',safeStorage.encryptString(JSON.stringify({server,token})),{mode:0o600});
      await fs.rename(filename+'.tmp',filename);
    }),
    clear:()=>queued(async()=>{await fs.rm(filename,{force:true});await fs.rm(filename+'.tmp',{force:true});})
  };
}
module.exports={sessionStore};
