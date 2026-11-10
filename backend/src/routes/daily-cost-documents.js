import {getOne} from '../db.js';
import {auth,permit,wrap,fail} from '../lib/http.js';
import {dailyCostExport,dailyCostDocument} from '../lib/daily-cost-document.js';
import {sendDocument} from '../lib/document-pdf.js';
export function installDailyCostDocuments(router){
 const permissions=['qs.view','qs.boq','qs.costControl','finance.view','finance.manage','finance.costReview'];
 const send=wrap(async(req,res)=>{
  const sheetId=req.params.id?Number(req.params.id):null;
  if(req.params.id&&(!Number.isInteger(sheetId)||sheetId<1))throw fail(400,'Choose a saved daily cost sheet.');
  const sheet=sheetId?await getOne('SELECT project_id FROM daily_cost_sheets WHERE id=?',[sheetId]):null;
  if(sheetId&&!sheet)throw fail(404,'Daily cost sheet not found.');
  const projectId=sheet?.project_id||Number(req.query.projectId);
  if(!Number.isInteger(projectId)||projectId<1)throw fail(400,'Choose a project.');
  const data=await dailyCostExport(projectId,sheetId);if(!data)throw fail(404,'Active project not found.');
  return sendDocument(req,res,dailyCostDocument(data),`daily-cost-${projectId}${sheetId?'-'+sheetId:''}.pdf`);
 });
 router.get('/cost-control/daily-sheets/document',auth,permit(...permissions),send);
 router.get('/cost-control/daily-sheets/:id/document',auth,permit(...permissions),send);
}
