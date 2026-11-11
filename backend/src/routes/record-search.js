import {Router} from 'express';
import {z} from 'zod';
import {query} from '../db.js';
import {auth, can, fail, wrap} from '../lib/http.js';

const router = Router();
const client = 'COALESCE(d.name,p.client)';
const projectClient = 'LEFT JOIN clients d ON d.id=p.client_id';
const activeProject = '(p.id IS NULL OR p.active=1)';
const qs = ['qs.view','qs.boq','qs.approve'];
const finance = ['finance.view','finance.invoice'];

const sources = {
  project: {
    permissions:['projects.view'], from:`projects p ${projectClient} LEFT JOIN project_awards a ON a.project_id=p.id`,
    record:'p', company:'p.company_id', reference:'a.reference', title:'p.name', client, project:'p.name',
    date:'COALESCE(p.start_date,p.created_at)', status:'p.health', extra:'p.site,p.stage', visible:'p.active=1',
    path:row=>`/projects/${row.id}`
  },
  quotation: {
    permissions:['qs.view'], from:'quotations_client q LEFT JOIN projects p ON p.id=q.project_id',
    record:'q', company:'q.company_id', reference:"COALESCE(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(q.print_options,'$.printedReference')),''),q.reference)", alternateReference:'q.reference', title:'q.title', client:'q.client_name', project:'p.name',
    date:'q.quote_date', status:'q.status', version:'q.revision_number', visible:activeProject,
    items:'quotation_items line WHERE line.quotation_id=q.id', path:()=>'/quantity-surveying/quotations'
  },
  boq: {
    permissions:['qs.view','qs.boq'], from:`boqs b JOIN projects p ON p.id=b.project_id ${projectClient}`,
    record:'b', company:'p.company_id', reference:'b.reference', title:'b.title', client, project:'p.name',
    date:'b.created_at', status:'b.status', version:'b.version', visible:'p.active=1',
    items:'boq_items line WHERE line.boq_id=b.id', path:()=>'/quantity-surveying/bills-of-quantities'
  },
  invoice: {
    permissions:finance, from:'client_invoices i LEFT JOIN projects p ON p.id=i.project_id',
    record:'i', company:'i.company_id', reference:'i.reference', title:'i.title', client:'i.client', project:'p.name',
    date:'i.invoice_date', status:'i.status', visible:activeProject,
    items:'client_invoice_items line WHERE line.invoice_id=i.id', path:()=>'/finance/invoices'
  },
  retention: {
    permissions:['qs.view','qs.retention','finance.view','finance.manage'],
    from:`retentions r JOIN projects p ON p.id=r.project_id ${projectClient}`,
    record:'r', company:'p.company_id', reference:"CONCAT('Retention #',r.id)", title:'r.description', client, project:'p.name',
    date:'r.release_date', status:'r.status', extra:'r.notes', visible:'p.active=1',
    path:(_row,req)=>['finance.view','finance.manage'].some(key=>can(req,key))?'/finance/retention':'/quantity-surveying/retention'
  },
  claim: {
    permissions:[...qs,...finance], from:`progress_claims c JOIN projects p ON p.id=c.project_id ${projectClient}`,
    record:'c', company:'p.company_id', reference:'c.reference', title:"COALESCE(NULLIF(c.certificate_reference,''),c.reference)",
    client, project:'p.name', date:'c.application_date', status:'c.status', visible:'p.active=1',
    extra:"c.notes,JSON_UNQUOTE(JSON_EXTRACT(c.document_details,'$.billNumber')),JSON_UNQUOTE(JSON_EXTRACT(c.document_details,'$.projectReference'))",
    path:(_row,req)=>qs.some(key=>can(req,key))?'/quantity-surveying/progress-claims':'/finance/progress-claims'
  }
};

const calendarDay = z.string().date().optional();
const filters = z.object({
  q:z.string().trim().max(120).default(''), type:z.enum(Object.keys(sources)).optional(),
  companyId:z.coerce.number().int().positive().optional(),
  projectId:z.coerce.number().int().positive().optional(),
  project:z.string().trim().min(1).max(180).optional(),
  from:calendarDay, to:calendarDay, status:z.string().trim().min(1).max(40).optional(),
  page:z.coerce.number().int().min(1).max(1000).default(1)
});
const pageSize = 30;
const literal = value => value.replace(/[!%_]/g,'!$&');

router.get('/',auth,wrap(async(req,res)=>{
  const parsed = filters.safeParse(req.query);
  if (!parsed.success) throw fail(400,'Enter a search term and valid filters.');
  const {q,type,companyId,projectId,project,from,to,status,page} = parsed.data;
  if (q.length<2 && (!projectId || q.length)) throw fail(400,'Enter at least two characters.');
  if (from && to && from > to) throw fail(400,'Choose a start date before or on the end date.');
  const terms = q ? [...new Set(q.split(/\s+/))] : [];
  if (terms.length > 10) throw fail(400,'Use up to ten search words.');
  const selects = [];
  const params = [];
  for (const [kind, source] of Object.entries(sources)) {
    if ((projectId && kind==='project') || (type && kind!==type) || !source.permissions.some(key=>can(req,key))) continue;
    const fields = [source.reference,source.title,source.client,source.project,source.alternateReference,source.extra].filter(Boolean).join(',');
    const conditions = ['co.active=1'];
    const args = [];
    if (source.visible) conditions.push(source.visible);
    if (companyId) { conditions.push('co.id=?'); args.push(companyId); }
    if (projectId) { conditions.push('p.id=?'); args.push(projectId); }
    if (project) { conditions.push(`${source.project} LIKE ? ESCAPE '!'`); args.push(`%${literal(project)}%`); }
    if (from) { conditions.push(`DATE(${source.date})>=?`); args.push(from); }
    if (to) { conditions.push(`DATE(${source.date})<=?`); args.push(to); }
    if (status) { conditions.push(`${source.status}=?`); args.push(status); }
    for (const term of terms) {
      const pattern = `%${literal(term)}%`;
      const header = `CONCAT_WS(' ',${fields}) LIKE ? ESCAPE '!'`;
      conditions.push(source.items ? `(${header} OR EXISTS (SELECT 1 FROM ${source.items} AND line.description LIKE ? ESCAPE '!'))` : header);
      args.push(pattern);
      if (source.items) args.push(pattern);
    }
    const references = [source.reference,source.alternateReference].filter(Boolean);
    const prefix = references.map(reference=>`${reference} LIKE ? ESCAPE '!'`).join(' OR ');
    selects.push(`SELECT '${kind}' type,${source.record}.id,${source.reference} reference,${source.title} title,
      ${source.client} client,${source.project} project,co.id companyId,co.name company,DATE(${source.date}) recordDate,
      ${source.status} status,${source.version||'NULL'} version,
      CASE WHEN ? IN (${references.join(',')}) THEN 0 WHEN ${prefix} THEN 1 ELSE 2 END relevance
      FROM ${source.from} JOIN companies co ON co.id=${source.company}
      WHERE ${conditions.join(' AND ')}`);
    params.push(q,...references.map(()=>`${literal(q)}%`),...args);
  }
  if (!selects.length) return res.json({results:[],hasMore:false});
  const rows = await query(`SELECT * FROM (${selects.join(' UNION ALL ')}) hits
    ORDER BY relevance,recordDate DESC,type,id DESC LIMIT ${pageSize+1} OFFSET ${(page-1)*pageSize}`, params);
  res.json({
    hasMore:rows.length>pageSize,
    results:rows.slice(0,pageSize).map(({relevance,...row})=>{
      const path = sources[row.type].path(row,req);
      return {...row,path:row.type==='project'?path:`${path}?record=${row.id}`};
    })
  });
}));

export default router;
