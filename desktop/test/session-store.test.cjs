const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const {sessionStore}=require('../src/session-store.cjs');
test('saved sign-in is encrypted, server-bound, survives reopen and is removed on logout',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'gkuc-session-')),key=crypto.randomBytes(32);
  const secure={isEncryptionAvailable:()=>true,encryptString:value=>{const iv=crypto.randomBytes(16),c=crypto.createCipheriv('aes-256-cbc',key,iv);return Buffer.concat([iv,c.update(value),c.final()]);},decryptString:buffer=>{const d=crypto.createDecipheriv('aes-256-cbc',key,buffer.subarray(0,16));return Buffer.concat([d.update(buffer.subarray(16)),d.final()]).toString();}};
  try{
    const store=sessionStore(directory,secure),server='https://staff.example',token='test-opaque-session-never-a-password';
    await store.save(server,token);
    assert.equal((await fs.readFile(path.join(directory,'session.enc'))).includes(token),false);
    assert.equal(await sessionStore(directory,secure).read(server),token);
    assert.equal(await store.read('https://different.example'),null);
    const saving=store.save(server,token),clearing=store.clear();await Promise.all([saving,clearing]);
    assert.equal(await store.read(server),null,'queued logout cannot be overtaken by an earlier save');
    const unavailable=sessionStore(directory,{isEncryptionAvailable:()=>false});
    await assert.rejects(unavailable.save(server,token),/Secure device storage/);
    await fs.writeFile(path.join(directory,'session.enc'),'corrupted');
    assert.equal(await store.read(server),null,'invalid encrypted data does not crash startup');
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});
