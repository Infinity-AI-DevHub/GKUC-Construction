// Render a white icon canvas around the unchanged GKUC rings; package native icons.
const fs=require('node:fs/promises');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
(async()=>{
  const root=path.resolve(__dirname,'..'),out=path.join(root,'resources');
  const mark=await fs.readFile(path.join(root,'../frontend/public/brand/gkuc-mark-512.png'));
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="white"/><image x="112" y="112" width="800" height="800" preserveAspectRatio="xMidYMid meet" href="data:image/png;base64,${mark.toString('base64')}"/></svg>`;
  await fs.writeFile(path.join(out,'icon.svg'),svg);
  const executablePath=process.env.ICON_BROWSER_BIN||(process.platform==='darwin'?'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome':undefined);
  const browser=await chromium.launch({executablePath,headless:true});
  const sizes=[16,32,48,64,128,256,512,1024],images=new Map();
  try{
    const page=await browser.newPage({viewport:{width:1024,height:1024},deviceScaleFactor:1});
    await page.setContent(`<style>html,body{margin:0;background:white}svg{display:block;width:100vw;height:100vh}</style>${svg}`);
    await page.locator('image').evaluate(async image=>{const img=new Image();img.src=image.getAttribute('href');await img.decode();});
    for(const size of sizes){await page.setViewportSize({width:size,height:size});images.set(size,await page.screenshot());}
  }finally{await browser.close();}
  await fs.writeFile(path.join(out,'icon.png'),images.get(1024));
  // ICO supports PNG payloads. Keep all Windows sizes in one directory.
  const icoSizes=sizes.filter(size=>size<=256),header=Buffer.alloc(6+icoSizes.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(icoSizes.length,4);
  let offset=header.length;
  icoSizes.forEach((size,i)=>{const p=6+i*16,data=images.get(size);header[p]=header[p+1]=size===256?0:size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(data.length,p+8);header.writeUInt32LE(offset,p+12);offset+=data.length;});
  await fs.writeFile(path.join(out,'icon.ico'),Buffer.concat([header,...icoSizes.map(size=>images.get(size))]));
  if(process.platform==='darwin'){
    const iconset=path.join(out,'gkuc.iconset');await fs.mkdir(iconset,{recursive:true});
    try{for(const size of [16,32,128,256,512]){await fs.writeFile(path.join(iconset,`icon_${size}x${size}.png`),images.get(size));await fs.writeFile(path.join(iconset,`icon_${size}x${size}@2x.png`),images.get(size*2));}execFileSync('iconutil',['-c','icns',iconset,'-o',path.join(out,'icon.icns')]);}
    finally{await fs.rm(iconset,{recursive:true,force:true});}
  }
  console.log('Generated GKUC rings on opaque white, with native Windows/macOS icons.');
})().catch(error=>{console.error(error);process.exitCode=1;});
