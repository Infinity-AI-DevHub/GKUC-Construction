import React from 'react';
import {patch,post} from './api.js';
import {Field,FormModal,SelectField,TextArea} from './ui.jsx';

export default function MaterialForm({ material=null, close, reload, onCreated, repeat=true }) {
  return <FormModal title={material?'Edit material':'Add material'} close={close} label={material?'Save material':'Add material'} repeat={!material && repeat} onSubmit={async values=>{
    const payload={name:values.name,unit:values.unit,stock:Number(values.stock||0),minimum:Number(values.minimum),site:values.site,
      unitCost:Number(values.unitCost||0),stockKind:values.stockKind,category:values.category,procurementRoute:values.procurementRoute,
      ...(material?{reason:values.reason,expectedStock:Number(material.stock)}:{})};
    if(material)await patch(`/materials/${material.id}`,payload);else {const created=await post('/materials',payload);await onCreated?.(created);}
    await reload();
  }}>
    <Field name="name" label="Material name" wide defaultValue={material?.name}/>
    <Field name="unit" label="Unit label" placeholder="bags, m³, sheets" defaultValue={material?.unit}/>
    <SelectField name="stockKind" label="Stock type" options={['Consumable','Returnable']} defaultValue={material?.stock_kind||'Consumable'}/>
    <SelectField name="category" label="Material category" options={['General','Concrete','Aggregate','Cement','Steel','Timber','Fuel','Other',...(material?.category?[material.category]:[])].filter((value,index,all)=>all.indexOf(value)===index)} defaultValue={material?.category||'General'}/>
    <SelectField name="procurementRoute" label="Purchasing route" options={['Purchase order','Direct delivery']} defaultValue={material?.procurement_route||'Purchase order'}/>
    <Field name="site" label="Store" defaultValue={material?.site}/>
    <Field name="stock" label={material?'Current store stock':'Opening stock'} type="number" step="0.001" min="0" defaultValue={material?.stock??0}/>
    <Field name="minimum" label="Minimum level" type="number" step="any" min="0" defaultValue={material?.minimum}/>
    <Field name="unitCost" label="Unit cost (LKR)" type="number" step="0.01" min="0" defaultValue={material?.unit_cost??0}/>
    {material&&<><TextArea name="reason" label="Reason for correction" rows={2}/>
      <p className="form-note wide">Changing stock creates a separate receipt or downward adjustment in the history. Unit edits change the label, not the quantities. Consumable/Returnable type stays fixed after stock activity.</p></>}
    <p className="form-note wide">Direct delivery is for supplies sent straight to a project. Unit-cost changes apply to future issues; existing issue costs keep their recorded rate.</p>
  </FormModal>;
}

