import crypto from 'node:crypto';
import {readWorkbook,serialToDate} from './xlsx.js';

export const bondColumns=[
  ['reference','System reference','text'],['kind','Kind','select',['Advance payment','Performance','ESHS performance','Retention','Bid','Cash','Other']],
  ['projectId','Project ID','number'],['beneficiary','In favour of','text'],['bank','Issuing bank','text'],['bondNumber','Bond number','text'],
  ['amount','Amount (LKR)','number'],['marginHeld','Margin held','number'],['commission','Commission','number'],
  ['issuedDate','Issued on','date'],['startDate','Starting date','date'],['expiryDate','Expires on','date'],
  ['status','Status','select',['Live','Expired','Released','Called']],['releasedDate','Released on','date'],
  ['reminderDays','Remind before expiry (days)','number'],['fdReference','FD number / credit facility','text'],
  ['projectDescription','Project / tender description','text'],['processNotes','Process / follow-up notes','text'],['notes','Notes','text']
];
const dbFields={projectId:'project_id',bondNumber:'bond_number',marginHeld:'margin_held',issuedDate:'issued_date',startDate:'start_date',expiryDate:'expiry_date',releasedDate:'released_date',reminderDays:'reminder_days',fdReference:'fd_reference',projectDescription:'project_description',processNotes:'process_notes'};
const numeric=new Set(['projectId','amount','marginHeld','commission','reminderDays']);
const dates=new Set(bondColumns.filter(c=>c[2]==='date').map(c=>c[0]));
export const bondSnapshot=row=>crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex');
export function bondData(row){return Object.fromEntries(bondColumns.map(([key])=>{
  let value=row[dbFields[key]||key];
  if(value==null)value=dates.has(key)||key==='projectId'?null:'';
  if(numeric.has(key)&&value!==null&&value!=='')value=Number(value);
  return [key,value];
}));}
const norm=value=>String(value??'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function parseBondWorkbook(buffer){
  const workbook=readWorkbook(buffer),rows=[];
  const aliases=new Map(bondColumns.flatMap(([key,label])=>[[norm(key),key],[norm(label),key]]));
  for(const [alias,key] of Object.entries({bondtype:'kind',beneficiary:'beneficiary',bank:'bank',issueddate:'issuedDate',expirydate:'expiryDate',closingdate:'expiryDate',fdreference:'fdReference',reference:'reference',amount:'amount',marginheldlkr:'marginHeld',commissionpaid:'commission'}))aliases.set(alias,key);
  for(const sheet of workbook.names){
    const grid=workbook.sheet(sheet)?.rows||[];
    const header=grid.findIndex(row=>row&&row.some(cell=>aliases.get(norm(cell))==='amount')&&row.some(cell=>['bondNumber','reference','beneficiary'].includes(aliases.get(norm(cell)))));
    if(header<0)continue;
    const keys=grid[header].map(cell=>aliases.get(norm(cell)));
    const used=keys.filter(Boolean);if(new Set(used).size!==used.length)throw Object.assign(new Error(`Duplicate bond column in ${sheet}`),{status:422});
    grid.slice(header+1).forEach((cells,index)=>{
      if(!cells.some(value=>value!==''&&value!=null))return;
      const data={};keys.forEach((key,col)=>{if(!key)return;let value=cells[col];if(value==null||value==='')return;
        if(dates.has(key)&&typeof value==='number')value=serialToDate(value);
        else if(numeric.has(key))value=Number(String(value).replaceAll(',','').trim());
        else value=String(value).trim();data[key]=value;
      });
      rows.push({sheet,row:header+index+1,data});
    });
  }
  if(!rows.length)throw Object.assign(new Error('No bond rows found. Use the downloadable Excel template and keep its column headings.'),{status:422});
  if(rows.length>300)throw Object.assign(new Error('Import up to 300 bond rows at a time.'),{status:422});
  return rows;
}
export {dbFields};
