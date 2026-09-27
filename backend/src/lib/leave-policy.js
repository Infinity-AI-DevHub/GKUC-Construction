export function addCalendarMonths(value, months) {
  const date=value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
  const [year,month,day]=date.split('-').map(Number);
  if(!year||!month||!day)return null;
  const target=new Date(Date.UTC(year,month-1+Number(months),1));
  const last=new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate();
  target.setUTCDate(Math.min(day,last));
  return target.toISOString().slice(0,10);
}
