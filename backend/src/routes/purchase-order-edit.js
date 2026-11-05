import {z} from 'zod';
import {auth,permit,validate,wrap,fail} from '../lib/http.js';
import {query,transaction,audit} from '../db.js';
import {poItem,poPresentation,orderTotal} from '../lib/purchase-order-edit.js';
import {controlNumber,orderWarnings} from '../lib/procurement-controls.js';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'Enter a valid date');
export function installPurchaseOrderEdit(router){
 router.get('/orders/:id/revisions',auth,permit('store.view','store.manage','finance.pay'),wrap(async(req,res)=>{
  res.json(await query('SELECT id,revision,reason,created_at createdAt,created_by createdBy,before_json beforeJson,after_json afterJson FROM purchase_order_revisions WHERE order_id=? ORDER BY revision DESC',[req.params.id]));
 }));
 router.post('/orders/:id/check',auth,permit('store.manage','finance.pay'),validate(z.object({supplierId:z.number().int().positive(),projectId:z.number().int().positive(),items:z.array(poItem).min(1).max(200)})),wrap(async(req,res)=>{
  res.json({warnings:await orderWarnings({...req.body,excludeOrderId:Number(req.params.id)}),total:orderTotal(req.body.items)});
 }));
 router.put('/orders/:id',auth,permit('store.manage','finance.pay'),validate(z.object({reference:z.string().trim().min(1).max(60),supplierId:z.number().int().positive(),projectId:z.number().int().positive(),orderDate:date,presentation:poPresentation,items:z.array(poItem).min(1).max(200),revision:z.number().int().nonnegative(),reason:z.string().trim().min(3).max(1000),riskAccepted:z.boolean().default(false),riskReason:z.string().trim().max(500).optional()})),wrap(async(req,res)=>{
  const b=req.body,total=orderTotal(b.items);if(!Number.isFinite(total)||total<=0||total>9999999999999.99)throw fail(400,'The order total must be greater than zero.');
  const warnings=await orderWarnings({...b,excludeOrderId:Number(req.params.id)});
  if(warnings.length&&(!b.riskAccepted||!b.riskReason||b.riskReason.length<10))return res.status(409).json({error:'Review the purchase warnings and record why this revision should proceed.',warnings});
  try{
   const outcome=await transaction(async connection=>{
    const [[before]]=await connection.execute('SELECT * FROM purchase_orders WHERE id=? FOR UPDATE',[req.params.id]);
    if(!before)throw fail(404,'Purchase order not found.');if(before.status==='Cancelled')throw fail(409,'A cancelled order cannot be revised.');
    if(Number(before.revision)!==b.revision)throw fail(409,'This order changed. Reload before editing.');
    const [oldItems]=await connection.execute('SELECT * FROM purchase_order_items WHERE order_id=? ORDER BY id FOR UPDATE',[before.id]);
    const [invoices]=await connection.execute('SELECT id,po_snapshot FROM supplier_invoices WHERE order_id=? FOR UPDATE',[before.id]);
    const used=oldItems.some(i=>Number(i.received_quantity)>0)||invoices.length>0;
    if(before.request_id&&Number(before.project_id)!==b.projectId)throw fail(409,'Keep the project linked to the approved purchase request. Printed Site remains editable.');
    if(used&&(Number(before.supplier_id)!==b.supplierId||Number(before.project_id)!==b.projectId))throw fail(409,'Supplier/project cannot move after deliveries or invoices. Printed Attention and Site can still be corrected without moving those records.');
    const [[project]]=await connection.execute('SELECT id FROM projects WHERE id=? AND active=1',[b.projectId]);
    const [[supplier]]=await connection.execute('SELECT id FROM suppliers WHERE id=? AND active=1',[b.supplierId]);if(!project||!supplier)throw fail(400,'Choose an active project and supplier.');
    const ids=b.items.map(i=>i.id).filter(Boolean);if(new Set(ids).size!==ids.length)throw fail(400,'Duplicate order line IDs.');
    for(const item of b.items){
     const previous=item.id?oldItems.find(i=>Number(i.id)===item.id):null;
     if(item.id&&!previous)throw fail(400,'An item does not belong to this order.');
     if(previous&&Number(previous.received_quantity)>item.quantity+.0001)throw fail(409,`Cannot reduce ${previous.description} below its already received quantity. Correct the goods receipt separately.`);
     if(previous&&Number(previous.received_quantity)>0&&(Number(previous.material_id||0)!==Number(item.materialId||0)||previous.unit!==item.unit))throw fail(409,'Material and unit on a received line must retain their original meaning. Add a separate line.');
     if(item.materialId){const [[material]]=await connection.execute('SELECT id,procurement_route,category,name FROM materials WHERE id=?',[item.materialId]);if(!material)throw fail(400,'Material not found.');
      const route=material.procurement_route==='Direct delivery'||String(material.category).toLowerCase()==='concrete'||/concrete/i.test(material.name)?'Direct delivery':'Purchase order';
      if(route!==before.procurement_route)throw fail(409,'Keep direct-delivery and purchase-order materials in separate orders.');
     }
    }
    for(const previous of oldItems)if(!ids.includes(Number(previous.id))&&Number(previous.received_quantity)>0)throw fail(409,'A received line cannot be removed; its delivery history must remain.');
    const commercial=Number(before.supplier_id)!==b.supplierId||Number(before.project_id)!==b.projectId||Number(before.total)!==total||oldItems.length!==b.items.length||b.items.some(i=>{const p=oldItems.find(p=>Number(p.id)===i.id);return !p||p.description!==i.description||p.unit!==i.unit||Number(p.quantity)!==i.quantity||Number(p.rate)!==i.rate||Number(p.material_id||0)!==Number(i.materialId||0)||Number(p.amount_override??-1)!==Number(i.amount??-1);});
    for(const invoice of invoices)if(!invoice.po_snapshot)await connection.execute('UPDATE supplier_invoices SET po_snapshot=? WHERE id=?',[JSON.stringify({id:before.id,supplier_id:before.supplier_id,total:before.total,status:before.status,revision:before.revision}),invoice.id]);
    await connection.execute('UPDATE goods_receipt_items g JOIN purchase_order_items i ON i.id=g.order_item_id SET g.unit_rate=i.rate WHERE i.order_id=? AND g.unit_rate IS NULL',[before.id]);
    for(const previous of oldItems){
     if(previous.received_value==null)await connection.execute('UPDATE purchase_order_items SET received_value=received_quantity*rate WHERE id=?',[previous.id]);
     if(!ids.includes(Number(previous.id)))await connection.execute('DELETE FROM purchase_order_items WHERE id=?',[previous.id]);
    }
    for(const item of b.items){
     const values=[item.materialId||null,item.description,item.unit,item.quantity,item.rate,item.amount??null,item.itemNo||null];
     if(item.id)await connection.execute('UPDATE purchase_order_items SET material_id=?,description=?,unit=?,quantity=?,rate=?,amount_override=?,item_no=? WHERE id=?',[...values,item.id]);
     else await connection.execute('INSERT INTO purchase_order_items (material_id,description,unit,quantity,rate,amount_override,item_no,order_id,received_value) VALUES (?,?,?,?,?,?,?,?,0)',[...values,before.id]);
    }
    // Changed commitments require fresh approval; printed wording alone preserves approval.
    const outstanding=b.items.reduce((sum,item)=>sum+item.quantity-Number(oldItems.find(p=>Number(p.id)===item.id)?.received_quantity||0),0);
    const received=oldItems.reduce((sum,item)=>sum+Number(item.received_quantity),0);
    const deliveryStatus=outstanding<=.0001?'Received':received>0?'Partially received':'Issued';
    const status=commercial?(before.procurement_route==='Direct delivery'?deliveryStatus:'Pending approval'):before.status;
    await connection.execute(`UPDATE purchase_orders SET reference=?,supplier_id=?,project_id=?,order_date=?,total=?,presentation=?,revision=revision+1,last_revised_by=?,status=?${commercial?',first_approved_by=NULL,first_approved_at=NULL,second_approved_by=NULL,second_approved_at=NULL':''} WHERE id=?`,[b.reference,b.supplierId,b.projectId,b.orderDate,total,JSON.stringify(b.presentation),req.user.id,status,before.id]);
    const after={...b,total,status,revision:b.revision+1};
    await connection.execute('INSERT INTO purchase_order_revisions (order_id,revision,reason,before_json,after_json,created_by) VALUES (?,?,?,?,?,?)',[before.id,after.revision,b.reason,JSON.stringify({...before,items:oldItems}),JSON.stringify(after),req.user.id]);
    await audit(connection,req.user.id,'REVISE','purchase_order',before.id,{...before,items:oldItems},after,req.ip);
    return {id:before.id,revision:after.revision,status,total};
   });res.json(outcome);
  }catch(error){if(error.code==='ER_DUP_ENTRY')throw fail(409,'That PO number is already recorded.');if(['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error.code))throw fail(409,'This order is being updated. Reload and retry the revision.');throw error;}
 }));
}
