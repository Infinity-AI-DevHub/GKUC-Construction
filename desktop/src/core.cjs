const path=require('node:path');
const ORIGIN='siteops://app';
function serverOrigin(value,allowLocal=false){
  const url=new URL(String(value).trim());
  const local=allowLocal&&url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if((url.protocol!=='https:'&&!local)||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname))throw new Error('Enter the HTTPS origin of your SiteOps server, without a path or credentials.');
  return url.origin;
}
function requestTarget(value,server){
  const url=new URL(value);
  if(url.protocol!=='siteops:'||url.hostname!=='app'||url.username||url.password||url.port)throw new Error('Untrusted application URL');
  if(/^\/(api(?:\/|$)|uploads(?:\/|$)|s(?:\/|$))/.test(url.pathname))return {remote:new URL(url.pathname+url.search,server).href};
  let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{throw new Error('Invalid path');}
  if(decoded.includes('\\')||decoded.includes('\0')||decoded.split('/').includes('..'))throw new Error('Invalid path');
  return {file:decoded==='/'?'index.html':decoded.slice(1)};
}
function assetPath(root,file){
  const target=path.resolve(root,file);
  if(target!==root&&!target.startsWith(path.resolve(root)+path.sep))throw new Error('Invalid asset path');
  return target;
}
function navigationAllowed(value,server){
  try{
    if(value==='about:blank')return true;
    if(value.startsWith('blob:'))return value.startsWith(`blob:${ORIGIN}/`);
    const url=new URL(value);
    return url.origin===server||(url.protocol==='siteops:'&&url.hostname==='app'&&!url.port&&!url.username&&!url.password);
  }catch{return false;}
}
function externalAllowed(value){try{const url=new URL(value);return ['https:','mailto:','tel:'].includes(url.protocol)&&!url.username&&!url.password;}catch{return false;}}
module.exports={ORIGIN,serverOrigin,requestTarget,assetPath,navigationAllowed,externalAllowed};
