const parse=value=>{if(!value)return {};if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{return {};}};
const cash=value=>Math.round((Number(value||0)+Number.EPSILON)*100)/100;
const dateKey=value=>value instanceof Date?value.toISOString().slice(0,10):String(value||'').slice(0,10);
const worked=new Set(['On site','Late','Checked out','Business trip','Worked (saved)']);
export function payslipDetail(run,slip) {
  const detail=parse(slip.calculationDetail);
  const complete=Array.isArray(detail.sourceAttendance);
  const sources=complete?detail.sourceAttendance:(detail.attendance||[]).map(row=>({workDate:row.workDate,state:'Worked (saved)',checkIn:row.checkIn,checkOut:row.checkOut}));
  const rate=detail.salary?.dailyRate??detail.leave?.dailyRate??detail.attendance?.[0]?.dailyRate??null;
  const components=(slip.components||[]).map(row=>{
    const data=parse(row.calculationDetail);
    const date=dateKey(data.date||data.workDate);
    return {...row,amount:cash(row.amount),date:/^\d{4}-\d{2}-\d{2}$/.test(date)&&date>=dateKey(run.periodStart)&&date<=dateKey(run.periodEnd)?date:null,
      description:data.reason||data.calculation?.method||''};
  });
  const days=[];
  const start=dateKey(run.periodStart),end=dateKey(run.periodEnd);
  for(let cursor=new Date(`${start}T00:00:00Z`);Number.isFinite(cursor.getTime())&&dateKey(cursor)<=end;cursor.setUTCDate(cursor.getUTCDate()+1)) {
    const date=dateKey(cursor),source=sources.filter(row=>dateKey(row.workDate||row.work_date)===date);
    const attendance=(detail.attendance||[]).filter(row=>dateKey(row.workDate)===date);
    const leave=detail.leave?.days?.find(row=>dateKey(row.workDate)===date);
    const overtime=(detail.overtime||[]).filter(row=>dateKey(row.workDate)===date);
    const adjustments=components.filter(row=>row.date===date);
    const shortReduction=cash(attendance.reduce((sum,row)=>sum+Number(row.shortDay?.amount||0),0));
    const late=cash(attendance.reduce((sum,row)=>sum+Number(row.lateDeduction||0),0));
    const payable=source.some(row=>worked.has(row.state))||leave?.paymentType==='Paid';
    const known=complete||source.length>0||Boolean(leave);
    const dailyRate=attendance[0]?.dailyRate??rate;
    const basic=known && (!payable||dailyRate!=null)?cash(payable?Math.max(0,Number(dailyRate)-shortReduction):0):null;
    const plus=cash(adjustments.filter(row=>row.kind!=='Deduction').reduce((sum,row)=>sum+row.amount,0));
    const minus=cash(adjustments.filter(row=>row.kind==='Deduction').reduce((sum,row)=>sum+row.amount,0));
    const ot=cash(overtime.reduce((sum,row)=>sum+Number(row.amount||0),0));
    days.push({date,state:leave?`${leave.paymentType} leave`:source.map(row=>row.state).join(', ')||(complete?'No recorded work':'No saved entry'),
      source,attendance,dailyRate,basic,shortReduction,late,lateMinutes:attendance.reduce((sum,row)=>sum+Number(row.lateMinutes||0),0),
      chargedLateMinutes:attendance.reduce((sum,row)=>sum+Number(row.deductibleMinutes||0),0),overtime,ot,adjustments,plus,minus,
      subtotal:basic==null?null:cash(basic+ot+plus-late-minus),warnings:(detail.warnings||[]).filter(row=>dateKey(row.workDate)===date)});
  }
  const knownBasic=cash(days.reduce((sum,row)=>sum+Number(row.basic||0),0));
  return {detail,complete,rate,components,periodComponents:components.filter(row=>!row.date),days,
    reconciliation:{basic:cash(Number(slip.basic)-knownBasic),ot:cash(Number(slip.overtimePay)-days.reduce((sum,row)=>sum+row.ot,0)),
      late:cash(Number(slip.lateDeduction)-days.reduce((sum,row)=>sum+row.late,0))}};
}
