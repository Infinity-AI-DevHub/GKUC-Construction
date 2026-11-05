import React,{useEffect,useState} from 'react';
import {api,post,rupeesExact as rupees,todayInput} from './api.js';
import {askText,Field,FormModal,TextArea} from './ui.jsx';
const parse=value=>typeof value==='string'?JSON.parse(value||'{}'):value||{};
const blank=()=>({description:'',unit:'Nos',quantity:1,rate:0,amount:null,itemNo:'',materialId:null});
export default function PurchaseOrderForm({data,order=null,close,reload}){
 const [suppliers,setSuppliers]=useState([]),[items,setItems]=useState(order?order.items.map(i=>({...i,quantity:Number(i.quantity),rate:Number(i.rate),amount:i.amount==null?null:Number(i.amount)})):[blank()]);
 const presentation=parse(order?.presentation),[customHeader,setCustomHeader]=useState(presentation.companyName!==undefined);
 const [supplierChoice,setSupplierChoice]=useState(order?.supplierId||''),[projectChoice,setProjectChoice]=useState(order?.projectId||data.projects[0]?.id||'');
 const [attention,setAttention]=useState(presentation.attention??order?.supplier??''),[site,setSite]=useState(presentation.site??order?.site??data.projects[0]?.site??'');
 useEffect(()=>{api('/purchasing/suppliers').then(rows=>{setSuppliers(rows);if(!order&&rows.length){setSupplierChoice(rows[0].id);setAttention(current=>current||rows[0].name);}}).catch(()=>setSuppliers([]));},[]);

 const linked=Boolean(order?.invoices?.length||order?.items?.some(i=>Number(i.receivedQuantity)>0));
 const change=(index,field,value)=>setItems(rows=>rows.map((row,i)=>i===index?{...row,[field]:value}:row));
 const total=items.reduce((sum,i)=>sum+Math.round(Number(i.amount??Number(i.quantity)*Number(i.rate))*100)/100,0);
 return <FormModal title={order?`Edit PO — ${order.reference}`:'Create purchase order'} label={order?'Save PO revision':'Create PO'} close={close} wide onSubmit={async values=>{
  const p={};for(const key of ['documentTitle','attention','site','paymentText','vehicleNumber','closing','preparedBy','checkedBy','approvedBy'])p[key]=values[key]||'';
  if(customHeader)for(const key of ['companyName','companyAddress','companyEmail','companyTelephone'])p[key]=values[key]||'';
  const body={supplierId:Number(values.supplierId||order?.supplierId),projectId:Number(values.projectId||order?.projectId),orderDate:values.orderDate,presentation:p,items:items.map((i,index)=>({...(i.id?{id:i.id}:{}),materialId:i.materialId?Number(i.materialId):null,itemNo:i.itemNo||String(index+1),description:i.description,unit:i.unit,quantity:Number(i.quantity),rate:Number(i.rate),amount:i.amount===null?null:Number(i.amount)})),...(values.reference?.trim()?{reference:values.reference.trim()}:{}),...(order?{revision:order.revision||0,reason:values.reason}:{} )};
  if(order&&!body.reference)throw new Error('Enter the PO number.');
  const check=await post(order?`/purchasing/orders/${order.id}/check`:'/purchasing/orders/check',body);
  if(check.warnings.length){const reason=await askText(check.warnings.map(w=>w.message).join('\n')+'\nExplain why this purchase should proceed:');if(!reason||reason.trim().length<10)throw new Error('Enter a purchase risk reason of at least 10 characters.');body.riskAccepted=true;body.riskReason=reason.trim();}
  if(order)await api(`/purchasing/orders/${order.id}`,{method:'PUT',body:JSON.stringify(body)});else await post('/purchasing/orders',body);
  await reload();
 }}>
  <p className="form-note wide">This PO is a purchase commitment. Expenses follow goods receipt/stock issue; supplier invoices and payments determine outstanding. Printing Cash or Credit here does not create a payment. Commercial edits return purchase-order commitments for fresh approval.</p>
  <Field name="reference" label={order?'PO number':'PO number (optional — auto if blank)'} required={Boolean(order)} defaultValue={order?.reference||''} maxLength={60}/>
  <Field name="documentTitle" label="Printed document title" defaultValue={presentation.documentTitle||'Purchase Order'}/>
  <label>Supplier account<select aria-label="Supplier account" name="supplierId" required disabled={linked} value={supplierChoice} onChange={e=>{setSupplierChoice(e.target.value);setAttention(suppliers.find(s=>Number(s.id)===Number(e.target.value))?.name||'');}}>{suppliers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
  <label>Project account<select aria-label="Project account" name="projectId" required disabled={linked} value={projectChoice} onChange={e=>{setProjectChoice(e.target.value);setSite(data.projects.find(p=>Number(p.id)===Number(e.target.value))?.site||'');}}>{data.projects.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
  {linked&&<p className="form-note wide">Deliveries/invoices already exist: retain their supplier/project accounts. You can edit the printed Attention/Site below. Received quantities/materials/units and posted financial history must be preserved.</p>}
  <Field name="orderDate" label="PO date" type="date" defaultValue={order?.orderDate||todayInput()}/>
  <label>Attention (printed)<input name="attention" value={attention} onChange={e=>setAttention(e.target.value)}/></label>
  <label>Site (printed)<input name="site" value={site} onChange={e=>setSite(e.target.value)}/></label>
  <Field name="paymentText" label="Cash / Credit / Cheque No (printed)" required={false} defaultValue={presentation.paymentText||''}/>
  <Field name="vehicleNumber" label="Vehicle No (printed)" required={false} defaultValue={presentation.vehicleNumber||''}/>
  <label className="wide"><input type="checkbox" checked={customHeader} onChange={e=>setCustomHeader(e.target.checked)} style={{width:'auto'}}/> Customize letterhead text for this PO</label>
  {customHeader&&<><Field name="companyName" label="Company name (printed)" required={false} defaultValue={presentation.companyName||''}/><TextArea name="companyAddress" label="Company address (printed)" required={false} defaultValue={presentation.companyAddress||''}/><Field name="companyEmail" label="Company email (printed)" required={false} defaultValue={presentation.companyEmail||''}/><Field name="companyTelephone" label="Company telephone (printed)" required={false} defaultValue={presentation.companyTelephone||''}/></>}
  <div className="wide"><h3>PO items</h3>{items.map((item,index)=><section key={index} className="workspace-surface" style={{padding:16,marginBottom:12}}><h4>Item {index+1}</h4><div className="po-item-fields">
   <label>Item No<input value={item.itemNo} onChange={e=>change(index,'itemNo',e.target.value)}/></label>
   <label>Material link (optional)<select value={item.materialId||''} onChange={e=>{const m=data.materials.find(m=>Number(m.id)===Number(e.target.value));setItems(rows=>rows.map((r,i)=>i===index?{...r,materialId:m?.id||null,...(m?{description:m.name,unit:m.unit,rate:Number(m.unit_cost||0)}:{})}:r));}}><option value="">Non-stock item / service</option>{data.materials.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
   <label>Description<input required value={item.description} onChange={e=>change(index,'description',e.target.value)}/></label><label>Unit<input required value={item.unit} onChange={e=>change(index,'unit',e.target.value)}/></label>
   <label>Quantity<input required type="number" min="0.001" step="0.001" value={item.quantity} onChange={e=>change(index,'quantity',e.target.value)}/></label><label>Unit price<input required type="number" min="0" step="0.01" value={item.rate} onChange={e=>change(index,'rate',e.target.value)}/></label>
   <label>Line amount mode<select value={item.amount===null?'auto':'manual'} onChange={e=>change(index,'amount',e.target.value==='auto'?null:Math.round(Number(item.quantity)*Number(item.rate)*100)/100)}><option value="auto">Quantity × unit price</option><option value="manual">Manual line amount</option></select></label>
   <label>Amount<input type="number" step="0.01" min="0" readOnly={item.amount===null} value={item.amount??Math.round(Number(item.quantity)*Number(item.rate)*100)/100} onChange={e=>change(index,'amount',e.target.value)}/></label>
  </div><button type="button" className="secondary" disabled={items.length===1||Number(item.receivedQuantity)>0} onClick={()=>setItems(rows=>rows.filter((_,i)=>i!==index))}>Remove item</button></section>)}
  <button type="button" className="secondary" onClick={()=>setItems(rows=>[...rows,blank()])}>Add item</button><p><strong>Sub Amount: {rupees(total)}</strong></p><p className="form-note">Manual amounts value received goods proportionately to the ordered quantity. Previous receipts retain their original values.</p></div>
  <TextArea name="closing" label="Closing text (printed)" required={false} defaultValue={presentation.closing??'Thank you for your cooperation.\n\nYours sincerely,'}/>
  <Field name="preparedBy" label="Prepared By (printed)" required={false} defaultValue={presentation.preparedBy??order?.issuedBy??''}/><Field name="checkedBy" label="Checked By (printed)" required={false} defaultValue={presentation.checkedBy||''}/><Field name="approvedBy" label="Approved By (printed)" required={false} defaultValue={presentation.approvedBy||''}/>
  <p className="form-note wide">Printed names are not electronic signatures or system approval.</p>
  {order&&<TextArea name="reason" label="Reason for revision"/>}
 </FormModal>;
}
