import {z} from 'zod';

export const incomeTaxFields={
  taxTreatment:z.enum(['None','Standard']).default('None'),
  vatRate:z.number().min(0).max(100).default(0)
};
const money=value=>Math.round((value+Number.EPSILON)*100)/100;
export function incomeTax(amount,{taxTreatment='None',vatRate=0}={}){
  if(taxTreatment!=='Standard')return {taxTreatment:'None',vatRate:0,netAmount:money(amount),vatAmount:0,totalAmount:money(amount)};
  const net=money(amount);
  const vat=money(net*vatRate/100);
  return {taxTreatment,vatRate,netAmount:net,vatAmount:vat,totalAmount:money(net+vat)};
}
