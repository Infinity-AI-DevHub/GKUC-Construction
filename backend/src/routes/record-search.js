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
  },
  supplierBill: {
    permissions:['finance.view','finance.pay'],
    from:'supplier_invoices i JOIN suppliers s ON s.id=i.supplier_id LEFT JOIN purchase_orders o ON o.id=i.order_id LEFT JOIN projects p ON p.id=o.project_id LEFT JOIN supplier_credit_reminders cr ON cr.invoice_id=i.id',
    record:'i', company:'i.company_id', reference:'i.invoice_no', title:'s.name', client:'NULL', project:'p.name',
    date:'i.invoice_date', status:'i.status', extra:'o.reference,cr.description,i.amount', visible:activeProject, amount:'i.amount',
    path:row=>'/finance/supplier-invoices?record='+row.id
  },
  operatingBill: {
    permissions:['finance.view','finance.manage'], from:'operating_bills b LEFT JOIN projects p ON p.id=b.project_id',
    record:'b', company:'b.company_id', reference:'b.reference', title:'b.provider', client:'NULL', project:'p.name',
    date:'b.bill_date', status:'b.status', extra:'b.bill_type,b.account_number,b.notes,b.payment_reference,b.total_amount', visible:activeProject, amount:'b.total_amount',
    path:row=>'/finance/bills?record='+row.id
  },
  supplierPayment: {
    permissions:['finance.pay'],
    from:'supplier_payments sp JOIN supplier_invoices i ON i.id=sp.invoice_id JOIN suppliers s ON s.id=i.supplier_id LEFT JOIN purchase_orders o ON o.id=i.order_id LEFT JOIN projects p ON p.id=o.project_id',
    record:'sp', company:'COALESCE(sp.payment_company_id,i.company_id)', reference:"COALESCE(NULLIF(sp.reference,''),CONCAT('Payment #',sp.id))",
    alternateReference:'i.invoice_no', title:'s.name', client:'NULL', project:'p.name', date:'sp.paid_date',
    status:"'Paid'", extra:"sp.method,sp.amount,IF(sp.petty_cash_entry_id IS NULL,NULL,'Petty cash')",
    visible:activeProject, amount:'sp.amount', parent:'i.id', targetCompany:'i.company_id',
    path:row=>'/finance/supplier-invoices?record='+row.parentId+'&payment='+row.id
  },
  clientPayment: {
    permissions:finance, from:'client_receipts r JOIN client_invoices i ON i.id=r.invoice_id LEFT JOIN projects p ON p.id=i.project_id',
    record:'r', company:'i.company_id', reference:'r.receipt_number', alternateReference:'r.reference',
    title:'i.title', client:'i.client', project:'p.name', date:'r.received_date', status:"'Received'",
    extra:'r.method,i.reference,r.amount', visible:activeProject, amount:'r.amount', parent:'i.id',
    path:row=>'/finance/invoices?record='+row.parentId+'&receipt='+row.id
  },
  officePayment: {
    permissions:['finance.dailyExpenses'],
    from:'office_expense_payments o LEFT JOIN md_personal_expenses md ON md.office_payment_id=o.id',
    record:'o', company:'o.company_id', reference:'o.reference', title:'o.payee', client:'NULL', project:'NULL',
    date:'o.payment_date', status:"'Paid'", extra:'o.description,o.category,o.payment_method,o.amount',
    visible:'md.id IS NULL', amount:'o.amount',
    path:row=>'/finance/daily-expenses?date='+row.recordDate+'&entry=office:'+row.id
  },
  pettyPayment: {
    permissions:['finance.dailyExpenses'],
    from:'petty_cash_entries e JOIN petty_cash_floats f ON f.id=e.float_id LEFT JOIN projects p ON p.id=e.project_id LEFT JOIN md_personal_expenses md ON md.petty_cash_entry_id=e.id',
    record:'e', company:'COALESCE(e.company_id,f.company_id)', reference:"CONCAT('Petty cash #',e.id)", title:'e.description',
    client:'NULL', project:'p.name', date:'e.entry_date', status:"'Paid'", extra:'e.payee,e.category,f.name,ABS(e.amount)',
    visible:"(p.id IS NULL OR p.active=1) AND e.kind='Spend' AND f.account_type<>'Salary advance' AND md.id IS NULL AND NOT EXISTS (SELECT 1 FROM supplier_payments sp WHERE sp.petty_cash_entry_id=e.id)",
    amount:'ABS(e.amount)', path:row=>'/finance/daily-expenses?date='+row.recordDate+'&entry=petty:'+row.id
  },
  projectPayment: {
    permissions:['finance.dailyExpenses'], from:'expenses e JOIN projects p ON p.id=e.project_id',
    record:'e', company:'p.company_id', reference:"COALESCE(NULLIF(e.reference,''),CONCAT('Expense #',e.id))", title:'e.description',
    client:'NULL', project:'p.name', date:'e.paid_date', status:"'Paid'", extra:'e.source,e.payee,e.payment_method,e.amount',
    visible:'p.active=1 AND e.paid_date IS NOT NULL AND e.payment_method IS NOT NULL AND e.origin_type IS NULL', amount:'e.amount',
    path:row=>'/finance/daily-expenses?date='+row.recordDate+'&entry=expense:'+row.id
  },
  siteReport: {
    permissions:['site.reports','projects.view'], from:`daily_reports r JOIN projects p ON p.id=r.project_id ${projectClient}`,
    record:'r', company:'p.company_id', reference:"CONCAT('Site report #',r.id)", title:'p.name', client, project:'p.name',
    date:'r.report_date', status:"'Submitted'", extra:'p.site,r.supervisor,r.work_completed,r.issue,r.weather', visible:'p.active=1',
    path:row=>'/daily-reports?record='+row.id
  },
  vehicle: {
    permissions:['transport.view','transport.manage'], from:'fleet f LEFT JOIN projects p ON p.id=f.project_id',
    record:'f', company:'NULL', reference:'f.registration', title:'f.vehicle', client:'NULL', project:'p.name',
    date:'f.created_at', status:'f.status', extra:'f.driver,f.renewal_type,f.make,f.model,f.engine_code', shared:true,
    path:row=>'/fleet/vehicles?record='+row.id
  },
  fuel: {
    permissions:['transport.view','transport.manage'],
    from:'fuel_records r JOIN fleet f ON f.id=r.vehicle_id LEFT JOIN projects p ON p.id=r.project_id',
    record:'r', company:'COALESCE(r.company_id,p.company_id)', allowUnassigned:true, reference:'f.registration', title:'f.vehicle', client:'NULL', project:'p.name',
    date:'r.fuel_date', status:"'Recorded'", extra:"r.driver,r.litres,r.cost,'Fuel'", visible:activeProject,
    amount:'r.cost', parent:'f.id', path:row=>'/fleet/vehicles?record='+row.parentId+'&fuel='+row.id
  },
  maintenance: {
    permissions:['transport.view','transport.manage'],
    from:'vehicle_maintenance m JOIN fleet f ON f.id=m.vehicle_id LEFT JOIN projects p ON p.id=m.project_id',
    record:'m', company:'COALESCE(m.company_id,p.company_id)', allowUnassigned:true, reference:'f.registration', title:'m.description', client:'NULL', project:'p.name',
    date:'m.service_date', status:'m.maintenance_kind', extra:'m.garage,m.cost,f.vehicle', visible:activeProject,
    amount:'m.cost', parent:'f.id', path:row=>'/fleet/vehicles?record='+row.parentId+'&maintenance='+row.id
  },
  vehicleRenewal: {
    permissions:['transport.view','transport.manage'],
    from:'vehicle_document_renewals d JOIN fleet f ON f.id=d.vehicle_id LEFT JOIN projects p ON p.id=f.project_id',
    record:'d', company:'NULL', reference:'COALESCE(d.reference,f.registration)', alternateReference:'f.registration',
    title:"CONCAT(d.doc_type,' renewal · ',f.vehicle)", client:'NULL', project:'p.name', date:'d.renewed_on',
    status:"'Renewed'", shared:true, parent:'f.id', amount:'d.cost',
    path:row=>'/fleet/vehicles?record='+row.parentId+'&renewal='+row.id
  },
  vehicleDocument: {
    permissions:['transport.view','transport.manage'],
    from:'vehicle_documents d JOIN fleet f ON f.id=d.vehicle_id LEFT JOIN projects p ON p.id=f.project_id',
    record:'d', company:'NULL', reference:'COALESCE(d.reference,f.registration)', alternateReference:'f.registration',
    title:"CONCAT(d.doc_type,' · ',f.vehicle)", client:'NULL', project:'p.name', date:'d.expiry_date',
    status:"IF(d.expiry_date<CURDATE(),'Overdue','Current')", shared:true, parent:'f.id',
    path:row=>'/fleet/vehicles?record='+row.parentId+'&document='+row.id
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
    if ((projectId && (kind==='project'||source.project==='NULL')) || (type && kind!==type) || !source.permissions.some(key=>can(req,key))) continue;
    const fields = [source.reference,source.title,source.client,source.project,source.alternateReference,source.extra].filter(Boolean).join(',');
    const conditions = source.shared ? ['1=1'] : [source.allowUnassigned ? `(co.active=1 OR ${source.company} IS NULL)` : 'co.active=1'];
    const args = [];
    if (source.visible) conditions.push(source.visible);
    if (companyId && !source.shared) { conditions.push(source.allowUnassigned ? `(co.id=? OR ${source.company} IS NULL)` : 'co.id=?'); args.push(companyId); }
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
      ${source.client} client,${source.project} project,${source.shared?"NULL companyId,'Shared fleet' company":"co.id companyId,COALESCE(co.name,'Shared fleet') company"},DATE(${source.date}) recordDate,
      ${source.status} status,${source.version||'NULL'} version,
      ${source.amount||'NULL'} amount,${source.parent||'NULL'} parentId,${source.targetCompany||'NULL'} targetCompanyId,
      CASE WHEN ? IN (${references.join(',')}) THEN 0 WHEN ${prefix} THEN 1 ELSE 2 END relevance
      FROM ${source.from} ${source.shared?'':(source.allowUnassigned?'LEFT JOIN':'JOIN')+' companies co ON co.id='+source.company}
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
      return {...row,path:row.type==='project'||path.includes('?')?path:`${path}?record=${row.id}`};
    })
  });
}));

export default router;
