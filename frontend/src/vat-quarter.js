export const vatBusinessToday=(date=new Date())=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Colombo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const iso=date=>date.toISOString().slice(0,10);
export function quarterBounds(value){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||Number.isNaN(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)return null;
  const [year,month]=value.split('-').map(Number),first=Math.floor((month-1)/3)*3;
  if(month<1||month>12)return null;
  return {label:`Q${first/3+1} ${year}`,start:iso(new Date(Date.UTC(year,first,1))),end:iso(new Date(Date.UTC(year,first+3,0)))};
}
export function quarterCountdown(selectedEnd,today){
  const quarter=quarterBounds(selectedEnd);if(!quarter)return null;
  const remaining=Math.round((Date.parse(quarter.end+'T00:00:00Z')-Date.parse(today+'T00:00:00Z'))/86400000);
  return {...quarter,days:Math.max(0,remaining),state:remaining<0?'Ended':remaining===0?'Ends today':'Upcoming'};
}
