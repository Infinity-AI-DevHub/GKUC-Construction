export const REPORT_PERMISSIONS={
  attendance:['hr.manage','hr.attendance'],employees:['hr.view','hr.manage'],projects:['projects.view'],
  tasks:['site.tasks','projects.view'],materials:['store.view','store.manage'],
  purchases:['store.view','store.manage','finance.pay'],vehicles:['transport.view','transport.manage'],
  equipment:['store.view','store.manage'],budget:['finance.reports','qs.view'],profit:['finance.reports'],
  progress:['projects.view','site.reports']
};
export const MODULE_PERMISSIONS={
  Dashboard:[],Coordination:['projects.view','resources.view','resources.reassign','projects.schedule','enquiries.manage'],Projects:['projects.view'],Tasks:['projects.view','site.tasks'],
  'Quantity Surveying':['qs.view','qs.costControl','qs.boq','qs.boqAmend','qs.quotation','qs.quotationRevise','qs.quotationFinalize','qs.tender','qs.retention','qs.templates','qs.approve','subcontractors.manage'],
  People:['hr.view','hr.manage','hr.attendance','hr.leave','hr.payroll','hr.settings','hr.conduct','hr.hiring','hr.insurance','hr.assets'],
  Materials:['store.view','store.manage','projects.manage','finance.pay'],
  'Stock locations':['store.view','store.manage','projects.view'],
  Fleet:['transport.view','transport.manage','store.view','store.manage','store.lending'],
  Finance:['finance.view','finance.manage','finance.invoice','finance.pay','finance.costReview','finance.reports','finance.managementAccounts','finance.managementAccountsManage','finance.cashComparison','finance.dailyExpenses','finance.vehicleExpenses','finance.expectedOutflows','finance.vatSchedules','finance.vatClearance','finance.supplierStatements'],
  'Daily reports':['projects.view'],'Site Today':['site.reports'],Chat:['chat.use'],Drive:['drive.use'],
  Reports:[...new Set(Object.values(REPORT_PERMISSIONS).flat())],
  Administration:['admin.users','admin.roles','admin.audit','admin.integrity','admin.importCentre','admin.lists','admin.notifications','admin.company','admin.documents','messages.send']
};

const departmentOrders=[
  [/\b(finance|accounts?|accounting)\b/,['Finance']],
  [/\b(hr|human resources?|people)\b/,['People']],
  [/\b(qs|quantity surveying|quantity surveyor)\b/,['Quantity Surveying']],
  [/\b(transport|fleet|logistics)\b/,['Fleet']],
  [/\b(stores?|storekeeper|warehouse|materials)\b/,['Materials','Stock locations','Fleet']],
  [/\b(coordination|coordinator|construction)\b/,['Coordination','Projects','Tasks']],
  [/\b(site|supervisor)\b/,['Site Today','Tasks','Daily reports','Projects']],
  [/\b(project manager|projects?)\b/,['Projects','Tasks','Coordination']],
  [/\b(administration|administrator|admin)\b/,['Administration']]
];
const identityOrder=text=>departmentOrders.find(([pattern])=>pattern.test(String(text||'').toLowerCase()))?.[1]||[];
const ownPrefixes={Finance:'finance.',People:'hr.','Quantity Surveying':'qs.',Fleet:'transport.',Materials:'store.',
  Coordination:'resources.',Projects:'projects.',Administration:'admin.','Site Today':'site.'};

export function navigationItems(items,user){
  const held=new Set(user?.permissions||[]);
  const visible=items.filter(([name])=>name==='Dashboard'||(MODULE_PERMISSIONS[name]||[]).some(key=>held.has(key)));
  const preferred=[...identityOrder(user?.department),...identityOrder(user?.role)];
  const primary=preferred.find(name=>visible.some(([label])=>label===name));
  // Roles and departments affect order only. Access always comes from explicit grants.
  const score=name=>{
    const prefix=ownPrefixes[name];
    if(!prefix)return 0;
    const keys=[...held].filter(key=>key.startsWith(prefix));
    return keys.reduce((sum,key)=>sum+(key.endsWith('.view')?1:4),0);
  };
  const broadLeadership=/^(managing director|assistant to the md|read-only viewer)$/i.test(user?.role||'')&&!user?.department;
  return visible.map((item,index)=>({item,index})).sort((a,b)=>{
    const [an]=a.item,[bn]=b.item;
    if(an==='Dashboard'||bn==='Dashboard')return an==='Dashboard'?-1:1;
    if(an===primary||bn===primary)return an===primary?-1:1;
    const ai=preferred.indexOf(an),bi=preferred.indexOf(bn);
    if(ai>=0||bi>=0)return (ai<0?Infinity:ai)-(bi<0?Infinity:bi);
    return (broadLeadership?0:score(bn)-score(an))||a.index-b.index;
  }).map(row=>row.item);
}
