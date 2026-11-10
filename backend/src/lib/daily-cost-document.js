import {query,getOne} from '../db.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=value=>Number(value||0).toLocaleString('en-LK',{minimumFractionDigits:2,maximumFractionDigits:2});
const day=value=>String(value||'').slice(0,10);
export async function dailyCostExport(projectId,sheetId){
 const project=await getOne('SELECT p.id,p.name,p.company_id companyId,c.name company FROM projects p JOIN companies c ON c.id=p.company_id WHERE p.id=? AND p.active=1',[projectId]);
 if(!project)return null;
 const sheets=await query(`SELECT s.*,u.name submittedBy,r.name reviewedBy FROM daily_cost_sheets s
 JOIN users u ON u.id=s.submitted_by LEFT JOIN users r ON r.id=s.reviewed_by WHERE s.project_id=? ${sheetId?'AND s.id=?':''} ORDER BY s.work_date,s.id`,sheetId?[projectId,sheetId]:[projectId]);
 const lines=sheets.length?await query(`SELECT l.*,t.title work,e.name employee,v.vehicle,v.registration,
 qi.description quotationItem FROM daily_cost_lines l JOIN daily_cost_sheets s ON s.id=l.sheet_id
 JOIN tasks t ON t.id=l.task_id LEFT JOIN visible_employees e ON e.id=l.employee_id LEFT JOIN fleet v ON v.id=l.vehicle_id
 LEFT JOIN quotation_items qi ON qi.id=l.quotation_item_id WHERE s.project_id=? ${sheetId?'AND s.id=?':''} ORDER BY s.work_date,s.id,l.id`,sheetId?[projectId,sheetId]:[projectId]):[];
 const links=sheets.length?await query(`SELECT lt.line_id,t.title FROM daily_cost_line_tasks lt JOIN daily_cost_lines l ON l.id=lt.line_id
 JOIN daily_cost_sheets s ON s.id=l.sheet_id JOIN tasks t ON t.id=lt.task_id WHERE s.project_id=? ${sheetId?'AND s.id=?':''} ORDER BY lt.line_id,t.id`,sheetId?[projectId,sheetId]:[projectId]):[];
 for(const line of lines){const tasks=links.filter(row=>Number(row.line_id)===Number(line.id));if(tasks.length)line.work=tasks.map(row=>row.title).join(' · ');}
 return {project,sheets:sheets.map(sheet=>({...sheet,lines:lines.filter(line=>Number(line.sheet_id)===Number(sheet.id))}))};
}
export function dailyCostDocument({project,sheets}){
 const sum=(lines,key)=>Math.round(lines.reduce((total,line)=>total+Number(line[key]||0),0)*100)/100;
 const all=sheets.flatMap(sheet=>sheet.lines.map(line=>({...line,status:sheet.status})));
 const table=(headers,rows)=>`<table><thead><tr>${headers.map(text=>`<th>${esc(text)}</th>`).join('')}</tr></thead><tbody>${rows.length?rows.map(row=>`<tr>${row.map(text=>`<td>${esc(text)}</td>`).join('')}</tr>`).join(''):`<tr><td colspan="${headers.length}">No saved daily cost sheets.</td></tr>`}</tbody></table>`;
 const categories=[...new Set(all.map(line=>line.source))].sort();
 return `<!doctype html><html><head><meta charset="utf-8"><title>Daily cost sheets - ${esc(project.name)}</title><style>
 @page{size:A4 landscape;margin:14mm}body{font:11px Arial;color:#17334c}h1{font-size:23px;margin:6px 0}h2{font-size:16px;margin:20px 0 8px}p{line-height:1.5}.summary{display:flex;gap:12px;margin:18px 0}.summary>div{flex:1;border:1px solid #cad8e3;padding:12px}.summary strong{display:block;font-size:17px;margin-top:6px}table{width:100%;border-collapse:collapse;margin:10px 0 18px;table-layout:fixed}th,td{padding:7px;border:1px solid #d5dfe7;text-align:left;overflow-wrap:anywhere;vertical-align:top}th{background:#edf3f7}thead{display:table-header-group}tr{break-inside:avoid}.sheet{break-before:page}small{color:#607587}.basis{color:#536b80}
 </style></head><body><h1>${esc(project.company)}</h1><h2>Daily cost sheets with summary</h2><p><strong>Project:</strong> ${esc(project.name)} | ${sheets.length} saved sheet(s) | LKR</p>
 <p class="basis">Approved costs are posted. Submitted and Returned costs are shown separately and are not approved expenditure. Quoted recovery is an allocation, not a receipt or booked revenue.</p>
 <div class="summary">${['Approved','Submitted','Returned'].map(status=>`<div>${status} · ${sheets.filter(sheet=>sheet.status===status).length} sheet(s)<strong>${money(sum(all.filter(line=>line.status===status),'amount'))}</strong></div>`).join('')}<div>Approved quoted recovery<strong>${money(sum(all.filter(line=>line.status==='Approved'),'quoted_recovery'))}</strong></div></div>
 <h2>Category summary</h2>${table(['Category','Approved cost','Awaiting review','Returned cost'],categories.map(category=>[category,...['Approved','Submitted','Returned'].map(status=>money(sum(all.filter(line=>line.source===category&&line.status===status),'amount')))]))}
 <h2>Sheet register</h2>${table(['Sheet / date','Status','Submitted by','Lines','Cost','Quoted recovery','Net against quoted work'],sheets.map(sheet=>[`#${sheet.id} · ${day(sheet.work_date)}`,sheet.status,sheet.submittedBy,sheet.lines.length,money(sum(sheet.lines,'amount')),money(sum(sheet.lines,'quoted_recovery')),money(sum(sheet.lines,'quoted_recovery')-sum(sheet.lines,'amount'))]))}
 ${sheets.map(sheet=>`<section class="sheet"><h2>Sheet #${sheet.id} · ${esc(day(sheet.work_date))} · ${esc(sheet.status)}</h2><p>Project: ${esc(project.name)} | Submitted by: ${esc(sheet.submittedBy)}${sheet.reviewedBy?` | Reviewed by: ${esc(sheet.reviewedBy)}`:''}</p>${sheet.notes?`<p><strong>Daily notes:</strong> ${esc(sheet.notes)}</p>`:''}${table(['Work task','Category / type','Cost item','Person / vehicle','Qty / rate','Cost','Quoted recovery'],sheet.lines.map(line=>[line.work,`${line.source} / ${line.cost_type}`,`${line.description}${line.reference?' · '+line.reference:''}`,line.employee||[line.vehicle,line.registration].filter(Boolean).join(' · ')||'—',line.quantity?`${line.quantity} ${line.unit||''}${line.unit_rate===null||line.unit_rate===undefined?'':` × ${money(line.unit_rate)}`}`:'Lump sum',money(line.amount),money(line.quoted_recovery)]))}<p><strong>Sheet total: ${money(sum(sheet.lines,'amount'))} | Quoted recovery: ${money(sum(sheet.lines,'quoted_recovery'))} | Net against quoted work: ${money(sum(sheet.lines,'quoted_recovery')-sum(sheet.lines,'amount'))}</strong></p>${sheet.review_note?`<p><strong>Finance note:</strong> ${esc(sheet.review_note)}</p>`:''}</section>`).join('')}
 </body></html>`;
}
