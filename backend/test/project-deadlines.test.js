import {test} from 'node:test';
import assert from 'node:assert/strict';
import {projectDeadline} from '../src/lib/project-deadlines.js';
import {projectExtensionDocument} from '../src/lib/documents.js';
const project={active:1,stage:'Mid-way',health:'On track',site_status:'Active',end_date:'2026-03-31'};
test('project completion reminders start one calendar month before and continue daily including overdue',()=>{
 assert.equal(projectDeadline(project,'2026-02-27'),null);
 assert.equal(projectDeadline(project,'2026-02-28').remaining,31);
 assert.equal(projectDeadline(project,'2026-03-01').remaining,30);
 assert.equal(projectDeadline(project,'2026-04-01').remaining,-1);
 for(const change of [{active:0},{end_date:null},{stage:'Completed'},{health:'Completed'},{site_status:'Completed'}])assert.equal(projectDeadline({...project,...change},'2026-03-30'),null);
 assert.equal(projectDeadline({...project,end_date:'2026-07-01'},'2026-04-01'),null);
});
test('extension request letter includes reason, client and both dates with escaped content and credit',()=>{
 const html=projectExtensionDocument({company:{name:'GKUC',address:'Saved company address'},project:{name:'Road project',site:'Project site'},extension:{reference:'PEX-1-1',previousEndDate:'2026-03-31',newEndDate:'2026-06-30',requestDate:'2026-03-01',reason:'Heavy rain\n<script>alert(1)</script>',recipientName:'Client office',recipientAddress:'Client address',signatoryName:'Project manager',signatoryTitle:'Manager'}});
 for(const text of ['Saved company address','Client office','2026-03-31','2026-06-30','Heavy rain','does not represent client approval','Developed by Infinity AI'])assert.ok(html.includes(text),text);
 assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>alert(1)</script>'));
});
