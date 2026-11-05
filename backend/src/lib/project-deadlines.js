import {insuranceReminderDate} from './insurance-reminders.js';
export const calendarDate=value=>value instanceof Date?value.toISOString().slice(0,10):String(value||'').slice(0,10);
export function projectDeadline(project,stamp){
 const end=calendarDate(project.end_date);
 if(!end||!project.active||project.stage==='Completed'||project.health==='Completed'||project.site_status==='Completed')return null;
 const reminderDate=insuranceReminderDate(end,{unit:'Months',value:1});
 if(stamp<reminderDate)return null;
 return {end,reminderDate,remaining:Math.round((Date.parse(end)-Date.parse(stamp))/86400000)};
}
