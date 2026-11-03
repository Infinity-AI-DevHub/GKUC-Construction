// Isolated manual QA only. Never attaches to the configured business database.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {createRequire}=require('node:module');
const net=require('node:net');
const backend=path.resolve(__dirname,'../../backend');
const req=createRequire(path.join(backend,'package.json'));
(async()=>{
 await new Promise((resolve,reject)=>{
  const probe=net.createServer();probe.once('error',()=>reject(new Error('QA port 43974 is already in use; stop the other QA session first.')));
  probe.listen(43974,()=>probe.close(resolve));
 });
 const config=req('dotenv').parse(await fs.readFile(path.join(backend,'.env')));
 if(!['127.0.0.1','localhost','::1'].includes(config.DB_HOST))throw new Error('Only loopback MySQL is allowed');
 if(config.STORAGE_DRIVER&&config.STORAGE_DRIVER!=='local')throw new Error('Use an isolated checkout configured for local storage; backend/.env owns its storage driver.');
 const mysql=await req('mysql2/promise').createConnection({host:config.DB_HOST,port:Number(config.DB_PORT||3306),user:config.DB_USER,password:config.DB_PASSWORD});
 const db='gkuc_manual_qa_'+Date.now();
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'gkuc-manual-qa-'));
 await mysql.query(`CREATE DATABASE \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
 const env={...process.env,...config,DB_NAME:db,PORT:'43974',STORAGE_DRIVER:'local',UPLOAD_DIR:path.join(temp,'uploads'),NOTIFY_CHANNELS:'',RESEND_API_KEY:'',TWILIO_ACCOUNT_SID:'',TWILIO_AUTH_TOKEN:'',WHATSAPP_TOKEN:'',WHATSAPP_PHONE_ID:'',RATE_MAX_REQUESTS:'100000',RATE_MAX_WRITES:'100000'};
 const log=await fs.open(path.join(temp,'backend.log'),'a');
 const child=spawn(process.env.SITEOPS_BACKEND_NODE||process.execPath,['src/index.js'],{cwd:backend,env,stdio:['ignore',log.fd,log.fd]});
 let electron;
 let closing=false;
 const cleanup=async(exitCode=0)=>{
  if(closing)return;closing=true;electron?.kill();
  if(child.exitCode===null&&child.signalCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}
  await mysql.query(`DROP DATABASE \`${db}\``);await mysql.end();await log.close();await fs.rm(temp,{recursive:true,force:true});process.exit(exitCode);
 };
 process.once('SIGTERM',()=>cleanup());process.once('SIGINT',()=>cleanup());
 child.once('exit',()=>{if(!closing){console.error('The isolated QA backend stopped.');void cleanup(1);}});
 let ready=false;
 for(let i=0;i<120;i++){try{const ownLog=await fs.readFile(path.join(temp,'backend.log'),'utf8');if(ownLog.includes('GKUC SiteOps running with MySQL')&&(await fetch('http://127.0.0.1:43974/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,150));}
 if(!ready){console.error('The isolated QA backend did not start.');await cleanup(1);return;}
 electron=spawn(require('electron'),[path.resolve(__dirname,'..')],{env:{...process.env,SITEOPS_SERVER_URL:'http://127.0.0.1:43974',SITEOPS_ALLOW_LOCAL_HTTP:'1',SITEOPS_DESKTOP_USER_DATA:path.join(temp,'profile')},stdio:'ignore'});
 console.log(JSON.stringify({database:db,port:43974,temp,pid:process.pid}));
})().catch(error=>{console.error(error.message);process.exit(1);});
