import {z} from 'zod';
export const poPresentation=z.object({documentTitle:z.string().trim().max(120).optional(),
 companyName:z.string().trim().max(300).optional(),companyAddress:z.string().trim().max(1000).optional(),companyEmail:z.string().trim().max(190).optional(),companyTelephone:z.string().trim().max(180).optional(),
 attention:z.string().trim().max(300).optional(),site:z.string().trim().max(1000).optional(),paymentText:z.string().trim().max(300).optional(),vehicleNumber:z.string().trim().max(100).optional(),
 closing:z.string().trim().max(1500).optional(),preparedBy:z.string().trim().max(180).optional(),checkedBy:z.string().trim().max(180).optional(),approvedBy:z.string().trim().max(180).optional()
}).strict();
export const poDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'Enter a valid date');
const money=z.number().finite().nonnegative().max(9999999999999.99);
export const poItem=z.object({id:z.number().int().positive().optional(),itemNo:z.string().trim().max(40).optional(),materialId:z.number().int().positive().nullable().optional(),description:z.string().trim().min(2).max(1000),unit:z.string().trim().min(1).max(30),quantity:z.number().finite().positive().max(99999999999.999).refine(n=>Math.abs(n*1000-Math.round(n*1000))<.00001,'Up to 3 decimal places'),rate:money.max(999999999999.99).refine(n=>Math.abs(n*100-Math.round(n*100))<.00001,'Up to 2 decimal places'),amount:money.multipleOf(.01).nullable().optional()});
export const lineAmount=item=>Math.round(Number(item.amount??(Number(item.quantity)*Number(item.rate)))*100)/100;
export const orderTotal=items=>Math.round(items.reduce((sum,item)=>sum+lineAmount(item),0)*100)/100;
export const receiptRate=item=>item.amount_override==null?Number(item.rate):Number(item.amount_override)/Number(item.quantity);
