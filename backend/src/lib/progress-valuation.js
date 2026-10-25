export const money=value=>Math.round((Number(value)+Number.EPSILON)*100)/100;
export function valueProgress(items,quantities,previous=[]){
  if(items.reduce((sum,item)=>sum+Number(item.quantity)*Number(item.rate),0)>9e12)throw new Error('Valuation BOQ exceeds the supported total amount.');
  const byCode=new Map(previous.map(item=>[item.code,item]));
  const known=new Set(items.map(item=>item.code));
  if(Object.keys(quantities).some(code=>!known.has(code)))throw new Error('Unknown valuation item.');
  return items.map(item=>{
    if(item.basis==='Note'){
      if(Number(quantities[item.code]||0)!==0)throw new Error(`${item.code}: note rows do not have completed quantities.`);
      return {...item,rate:0,quantity:0,boqQuantity:0,previousQuantity:0,previousAmount:0,cumulative:0,current:0};
    }
    const quantity=Number(quantities[item.code]??0),before=byCode.get(item.code);
    if(!Number.isFinite(quantity)||quantity<Number(before?.quantity||0)||quantity>Number(item.quantity)+0.0001)
      throw new Error(`${item.code}: cumulative quantity must be between the previous certified quantity and the BOQ quantity.`);
    const cumulative=money(quantity*Number(item.rate)),previousAmount=Number(before?.cumulative||0);
    if(cumulative<previousAmount)throw new Error(`${item.code}: the cumulative value cannot reduce a previous certificate.`);
    return {...item,quantity,boqQuantity:Number(item.quantity),previousQuantity:Number(before?.quantity||0),previousAmount,
      cumulative,current:money(cumulative-previousAmount)};
  });
}
export function progressTotals(lines,{retention=0,advance=0,other=0,stampDuty=0,vatRate=0,taxBasis='Gross'}={}){
  const gross=money(lines.reduce((sum,item)=>sum+item.current,0));
  if(retention+advance+other>gross)throw new Error('Recoveries cannot exceed the current certified work value.');
  const netBeforeVat=money(gross-retention-advance-other);
  const vat=money((taxBasis==='After recoveries'?netBeforeVat:gross)*vatRate/100);
  if(stampDuty>netBeforeVat+vat)throw new Error('Stamp duty exceeds the payable amount.');
  if(netBeforeVat+vat-stampDuty>9e12)throw new Error('Certificate exceeds the supported total amount.');
  return {gross,retention,advance,other,stampDuty,netBeforeVat,vatRate,taxBasis,vat,net:money(netBeforeVat+vat-stampDuty)};
}
