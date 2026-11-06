/** Temporary, role-independent pause. Remove keys here and rebuild to restore access. */
export const PAUSED_FEATURES = Object.freeze(['pettyCash','bonds','expenses','boqs','invoices']);
export const PAUSE_ERROR = 'Error in local machine';
export const PAUSE_DETAIL = 'Error in windows operating system';
export const PAUSE_SOLUTION = 'Please ask the administrator to install the separate drivers required on this computer to continue working.';
export const FEATURE_LABELS = {pettyCash:'Petty cash',bonds:'Bonds',expenses:'Expenses',boqs:'QS BOQs',invoices:'Invoices'};
export const isFeaturePaused = key => PAUSED_FEATURES.includes(key);
const prefix = (path, root) => path === root || path.startsWith(`${root}/`);
export function normalizedFeaturePath(value) {
  try { return decodeURIComponent(new URL(value,'https://siteops.invalid').pathname).replace(/\/{2,}/g,'/').replace(/\/$/,'').toLowerCase().replace(/^\/api(?=\/|$)/,''); }
  catch { return ''; }
}
export function pausedApiFeature(value) {
  const p=normalizedFeaturePath(value);
  let key;
  if(prefix(p,'/progress-claims')&&new URL(value,'https://siteops.invalid').searchParams.get('type')==='invoice')return isFeaturePaused('invoices')?'invoices':null;
  if(prefix(p,'/receivables/petty-cash')||prefix(p,'/fleet/fuel-floats')) key='pettyCash';
  else if(prefix(p,'/receivables/bonds')) key='bonds';
  else if(['/finance/expenses','/finance/daily-expenses','/finance/office-expense-payments','/boq/cost-control/expenses'].some(root=>prefix(p,root))) key='expenses';
  else if(prefix(p,'/boq')&&!prefix(p,'/boq/cost-control')) key='boqs';
  else if(['/receivables/invoices','/receivables/paid-invoices','/receivables/receipts','/receivables/ageing','/receivables/quotation-plans','/receivables/accepted-quotations','/receivables/quote-lines','/receivables/boq-lines','/receivables/preview'].some(root=>prefix(p,root))||/^\/receivables\/quotation-terms\/\d+\/invoice$/.test(p)) key='invoices';
  return isFeaturePaused(key)?key:null;
}
const tabs = {'Petty cash':'pettyCash',Bonds:'bonds',Expenses:'expenses','Daily expenses':'expenses','Bills of quantities':'boqs','BOQ & estimates':'boqs',BOQs:'boqs',Invoices:'invoices'};
export const pausedTabFeature = name => isFeaturePaused(tabs[name])?tabs[name]:null;
export function pausedPageFeature(value) {
  const p=normalizedFeaturePath(value);
  if(prefix(p,'/finance/petty-cash')) return isFeaturePaused('pettyCash')?'pettyCash':null;
  if(prefix(p,'/finance/bonds')) return isFeaturePaused('bonds')?'bonds':null;
  if(['/finance/expenses','/finance/daily-expenses'].some(root=>prefix(p,root))) return isFeaturePaused('expenses')?'expenses':null;
  if(['/quantity-surveying/bills-of-quantities','/projects/boq-estimates','/projects/boq-and-estimates','/projects/boq-&-estimates'].some(root=>prefix(p,root))) return isFeaturePaused('boqs')?'boqs':null;
  if(prefix(p,'/finance/invoices')) return isFeaturePaused('invoices')?'invoices':null;
  return null;
}
