import {z} from 'zod';
export const printFlags=['number','date','logo','companyName','companyDetails','clientDetails','workDetails','unit','quantity','rate','lineAmounts','totals','words','notes','terms','bank','signatures','methods','footer'];
export const printOptionsSchema=z.object({printedReference:z.string().trim().max(120).default(''),...Object.fromEntries(printFlags.map(key=>[key,z.boolean().default(true)]))}).strict();
export function printOptions(value){return printOptionsSchema.parse(typeof value==='string'?JSON.parse(value):value||{});}
/** Render only selected cells/sections; financial records are never recalculated. */
export function printBlocks(blocks,settings,{columnCount=6}={}){
  const map={clientDetails:'parties',workDetails:'subject',notes:'notes',terms:'terms',bank:'bank',signatures:'signatures',methods:'methods',footer:'footer'};
  const result={...blocks};for(const [flag,block] of Object.entries(map))if(!settings[flag])result[block]='';
  if(!settings.words||!settings.totals)result.words='';
  let table=result.table||'';
  if(!settings.totals)table=table.replace(/<tfoot>[\s\S]*?<\/tfoot>/g,'').replace(/<tr class="(?:subtotal|category-total)">[\s\S]*?<\/tr>/g,'');
  let removed=0;
  for(const [flag,cls] of [['unit','unit'],['quantity','qty'],['rate','rate'],['lineAmounts','amount']]){
    if(settings[flag])continue;
    const cell=new RegExp(`<th\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>[\\s\\S]*?<\\/th>`,'g');
    if(cell.test(table))removed++;
    table=table.replace(cell,'').replace(new RegExp(`<td\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>[\\s\\S]*?<\\/td>`,'g'),'');
  }
  const count=columnCount-removed;
  table=table.replace(/colspan="(\d+)"/g,(_,n)=>`colspan="${Math.max(1,Number(n)===columnCount?count:count-1)}"`);
  result.table=table;return result;
}
export function printDesign(design,settings){
  const fields={reference:'number',docDate:'date',logo:'logo',companyName:'companyName',companyDetails:'companyDetails'};
  design.header.elements=design.header.elements.map(item=>({...item,...(fields[item.id]?{show:settings[fields[item.id]]}:{})}));
  const blocks={parties:'clientDetails',subject:'workDetails',notes:'notes',terms:'terms',bank:'bank',signatures:'signatures',methods:'methods',footer:'footer',totals:'totals',words:'words'};
  design.blocks=design.blocks.map(item=>({...item,...(blocks[item.id]?{show:settings[blocks[item.id]]}:{})}));return design;
}
