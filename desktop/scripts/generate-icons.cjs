// Render a white icon canvas around the unchanged GKUC rings; package native icons.
const fs=require('node:fs/promises');
const path=require('node:path');
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
    const page=await browser.newPage();
    // Rasterize directly into a fresh canvas for every size. Resizing a viewport
    // between screenshots can capture stale compositor tiles (duplicated/clipped mark).
    const rendered=await page.evaluate(async({svg,sizes})=>{
      const source=new Image();source.src='data:image/svg+xml;base64,'+btoa(svg);await source.decode();
      return sizes.map(size=>{
        const canvas=document.createElement('canvas');canvas.width=canvas.height=size;
        const context=canvas.getContext('2d');context.imageSmoothingEnabled=true;context.imageSmoothingQuality='high';
        context.drawImage(source,0,0,size,size);
        const pixels=context.getImageData(0,0,size,size).data,padding=Math.floor(size*.08);let ink=0;
        for(let y=0;y<size;y++)for(let x=0;x<size;x++){
          const i=(y*size+x)*4;if(pixels[i+3]!==255)throw new Error(`Transparent icon: ${size}`);
          if(Math.min(pixels[i],pixels[i+1],pixels[i+2])<240){
            ink++;
            if(x<padding||y<padding||x>=size-padding||y>=size-padding)throw new Error(`Clipped icon: ${size}`);
          }
        }
        if(!ink)throw new Error(`Blank icon: ${size}`);
        return [size,canvas.toDataURL('image/png').split(',')[1]];
      });
    },{svg,sizes});
    for(const [size,data] of rendered)images.set(size,Buffer.from(data,'base64'));
  }finally{await browser.close();}
  await fs.writeFile(path.join(out,'icon.png'),images.get(1024));
  // ICO supports PNG payloads. Keep all Windows sizes in one directory.
  const icoSizes=sizes.filter(size=>size<=256),header=Buffer.alloc(6+icoSizes.length*16);header.writeUInt16LE(1,2);header.writeUInt16LE(icoSizes.length,4);
  let offset=header.length;
  icoSizes.forEach((size,i)=>{const p=6+i*16,data=images.get(size);header[p]=header[p+1]=size===256?0:size;header.writeUInt16LE(1,p+4);header.writeUInt16LE(32,p+6);header.writeUInt32LE(data.length,p+8);header.writeUInt32LE(offset,p+12);offset+=data.length;});
  await fs.writeFile(path.join(out,'icon.ico'),Buffer.concat([header,...icoSizes.map(size=>images.get(size))]));
  // Use PNG-backed ICNS entries, including 16/32-point Retina sizes. Legacy entries from
  // iconutil also cropped the 16/32px representations on this build host.
  const representations=[['ic07',128],['ic08',256],['ic09',512],['ic10',1024],['ic11',32],['ic12',64],['ic13',256],['ic14',512]];
  const chunks=representations.map(([type,size])=>{const data=images.get(size),header=Buffer.alloc(8);header.write(type);header.writeUInt32BE(data.length+8,4);return Buffer.concat([header,data]);});
  const icnsHeader=Buffer.alloc(8);icnsHeader.write('icns');icnsHeader.writeUInt32BE(8+chunks.reduce((sum,chunk)=>sum+chunk.length,0),4);
  await fs.writeFile(path.join(out,'icon.icns'),Buffer.concat([icnsHeader,...chunks]));
  console.log('Generated GKUC rings on opaque white, with native Windows/macOS icons.');
})().catch(error=>{console.error(error);process.exitCode=1;});
