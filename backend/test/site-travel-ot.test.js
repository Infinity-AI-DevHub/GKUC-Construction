import test from 'node:test';import assert from 'node:assert/strict';
import {siteTravelSuggestions,inferSiteStop,siteStopProblem} from '../src/lib/site-travel-ot.js';
import {calculateAttendancePayroll} from '../src/lib/attendance-payroll.js';
import {INITIAL_HR_RULES} from '../src/lib/hr-payroll-rules.js';
const employee={id:1,payroll_company_id:1,payroll_category:'Site labourer',daily_rate:1800};
const policy={id:1,company_id:1,effective_from:'2026-01-01',site_labour_site_ot_rate:225,site_labour_travel_ot_rate:100,supervisor_site_ot_rate:225,supervisor_travel_ot_rate:100,hr_rules:INITIAL_HR_RULES};
const day={id:7,work_date:'2026-11-05',work_location:'Site',check_in:'07:30',site_stop:'17:00',check_out:'17:45',state:'Checked out'};
const calc=(a=day,e=employee,ot=[],claims=[])=>calculateAttendancePayroll(e,[a],ot,[policy],claims);
test('Labour and Supervisor split at saved site stop with exact-minute money and independent minimums',()=>{
 for(const category of ['Site labourer','Supervisor']){
  const result=calc(day,{...employee,payroll_category:category});
  assert.equal(result.site_ot_hours,.5);assert.equal(result.site_ot_pay,112.5);assert.equal(result.travel_ot_hours,.75);assert.equal(result.travel_ot_pay,75);
  assert.equal(result.calculation_detail.overtime[1].rawMinutes,45);
  assert.deepEqual(result.calculation_detail.overtime.map(row=>row.intervals),[[[990,1020]],[[1020,1065]]]);
 }
 assert.equal(calc({...day,site_stop:'16:59',check_out:'17:30'}).site_ot_pay,0);
 assert.equal(calc({...day,site_stop:'16:59',check_out:'17:44'}).travel_ot_pay,75);
 assert.equal(calc({...day,check_out:'17:30'}).travel_ot_pay,0);
 assert.equal(calc({...day,site_stop:'16:30',check_out:'17:01'}).site_ot_pay,0);
});
test('existing morning eligibility stays in Site OT and travel begins only at site stop',()=>{
 const result=calc({...day,check_in:'06:30'});assert.equal(result.site_ot_pay,337.5);assert.equal(result.travel_ot_pay,75);
 assert.equal(calc({...day,check_in:'07:01'}).site_ot_pay,112.5);
 const split=siteTravelSuggestions(employee,{...day,check_in:'05:00',site_stop:'18:00',check_out:'19:00'},policy);
 assert.equal(split.Site.rawMinutes,240);assert.equal(split.Travel.rawMinutes,60);
 const early=siteTravelSuggestions(employee,{...day,check_in:'06:30',site_stop:'07:00',check_out:'08:00'},policy);
 assert.deepEqual(early.Site.intervals,[[390,420]]);assert.deepEqual(early.Travel.intervals,[[420,480]]);
});
test('missing or ambiguous boundary never turns travel into Site OT and is flagged before approval',()=>{
 const result=calc({...day,site_stop:null});assert.equal(result.overtime_pay,0);assert.equal(result.attendance_basic,1800);
 assert.ok(result.calculation_detail.warnings.some(row=>row.blocksApproval&&row.code==='SITE_STOP_REQUIRED'));
 assert.equal(siteStopProblem('08:00','07:59','18:00')!==null,true);
 assert.equal(siteStopProblem('08:00','18:01','18:00')!==null,true);
 assert.equal(inferSiteStop({checkIn:'07:30',checkOut:'18:00',punchTimes:['07:30','17:00','18:00']}),'17:00');
 assert.equal(inferSiteStop({checkIn:'07:30',checkOut:'18:00',punchTimes:['07:30','12:00','17:00','18:00']}),null);
});
test('reviewed types replace only that type; claims and rejected travel never add automatic duplicate travel',()=>{
 const site={id:1,work_date:day.work_date,overtime_type:'Site',hours:.5,status:'Approved',input_detail:{intervals:[[990,1020]]}};
 assert.equal(calc(day,employee,[site]).overtime_pay,187.5);
 assert.equal(calc(day,employee,[{...site,status:'Rejected'}]).overtime_pay,75);
 assert.equal(calc(day,employee,[{...site,overtime_type:'Travel',status:'Rejected'}]).travel_ot_pay,0);
 const reviewed={...site,overtime_type:'Travel',hours:.75,input_detail:{threePunch:true,actualMinutes:45,intervals:[[1020,1065]]}};
 assert.equal(calc(day,employee,[reviewed]).travel_ot_pay,75);
 const overlapping={...site,input_detail:{intervals:[[990,1065]]}};assert.ok(calc(day,employee,[overlapping]).calculation_detail.warnings.some(row=>row.code==='OT_SPLIT_CONFLICT'));
 const claims=[{work_date:day.work_date,status:'Draft',calculation:{travelHours:45/60,intervals:[[1020,1065]]}}];assert.equal(calc(day,employee,[],claims).travel_ot_pay,0);
 assert.equal(calc(day,employee,[],[{...claims[0],calculation:{method:'Manual',travelHours:0,intervals:[]}}]).travel_ot_pay,75);
});

test('Driver uses the same site boundary with Site 31 and Travel 30, while saved legacy thresholds remain dated',()=>{
 const driver={...employee,payroll_category:'Driver'},p={...policy,driver_site_ot_rate:225,driver_travel_ot_rate:100};
 const split=siteTravelSuggestions(driver,{...day,site_stop:'17:01',check_out:'17:31'},p);
 assert.equal(split.Site.rawMinutes,31);assert.equal(split.Site.hours,31/60);assert.equal(split.Travel.hours,.5);
 assert.equal(siteTravelSuggestions(driver,{...day,site_stop:'17:00',check_out:'17:29'},p).Site.hours,0);
 assert.equal(siteTravelSuggestions(driver,{...day,site_stop:'17:00',check_out:'17:29'},p).Travel.hours,0);
 const old={...policy,hr_rules:{...INITIAL_HR_RULES,labourTravelOtMinimumMinutes:31}};
 assert.equal(siteTravelSuggestions(employee,{...day,check_out:'17:31'},old).Travel.hours,31/60);
 assert.equal(siteTravelSuggestions(employee,{...day,check_out:'17:44'},policy).Travel.hours,0);
});
