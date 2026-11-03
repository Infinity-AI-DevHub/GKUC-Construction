const fs=require('node:fs/promises');
const path=require('node:path');
(async()=>{
  const source=path.resolve(__dirname,'../../frontend/dist'),target=path.resolve(__dirname,'../ui');
  await fs.access(path.join(source,'index.html'));
  await fs.rm(target,{recursive:true,force:true});
  await fs.cp(source,target,{recursive:true});
  console.log('Bundled the existing web interface for desktop.');
})().catch(()=>{console.error('Build the frontend before preparing desktop assets.');process.exitCode=1;});
