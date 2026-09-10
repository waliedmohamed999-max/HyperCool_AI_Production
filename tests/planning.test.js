import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openStore} from '../src/store.js';
import {createContent,reviewContent,approveContent} from '../src/domain.js';
import {installPlanning,createCalendar,listSlots,listJobs,scheduleContent,cancelJobs,prepareDue,buildBrief,saveDailyBrief,riyadhDate,authorizeAutomation} from '../src/planning.js';
const owner={id:'owner',name:'Owner',role:'owner'};
const now=Date.parse('2030-01-01T00:00:00Z');
function setup(){const store=openStore(':memory:');installPlanning(store.db);createCalendar(store,'2030-01-01',owner);return store;}
function approved(store,overrides={}) {
 let item=createContent({title:'Test',body:'Test',date:'2030-01-01',platform:'X',url:'https://hyper-cool.com/offers',...overrides});
 item=reviewContent(item,{reviewer:'Reviewer',evidence:'Verified',facts:true,claims:true,link:true,asset:true});item.review.userId='reviewer';item=approveContent(item,{owner:'Owner'});item.approval.userId=owner.id;
 store.mutate(state=>state.content.push(item));return item;
}
test('30-day calendar follows Saudi cadence and does not duplicate overlapping requests',()=>{
 const store=setup();try{
 const slots=listSlots(store.db);assert.equal(new Set(slots.map(s=>s.date)).size,30);
 assert.equal(slots.filter(s=>s.platform==='X').length,30);
 for(const slot of slots.filter(s=>s.platform==='LinkedIn'))assert.ok([0,2,4].includes(new Date(slot.date).getUTCDay()));
 assert.equal(createCalendar(store,'2030-01-01',owner).created,0);
 assert.equal(listSlots(store.db).length,slots.length);
 const firstWeek=slots.filter(s=>s.platform==='Instagram'&&s.date<'2030-01-08');
 assert.equal(firstWeek.filter(s=>s.pillar==='تعليمي').length,3);
 assert.equal(firstWeek.filter(s=>s.pillar==='منتج أو عرض معتمد').length,2);
 }finally{store.close();}
});
test('schedule snapshots require current approval and deduplicate due preparation without publishing',()=>{
 const store=setup();try{
 const item=approved(store),request={contentId:item.id,scheduledAt:'2030-01-01T12:00:00+03:00'};
 const job=scheduleContent(store,request,owner,now);
 assert.equal(scheduleContent(store,request,owner,now).replayed,true);
 assert.equal(listJobs(store.db).length,1);
 assert.equal(prepareDue(store,owner,now).ready,0);
 const due=Date.parse('2030-01-01T10:00:00Z');
 assert.deepEqual(prepareDue(store,owner,due),{ready:1,blocked:0,externalActions:0});
 const auditCount=store.read().audit.length;prepareDue(store,owner,due);assert.equal(store.read().audit.length,auditCount);
 assert.equal(listJobs(store.db)[0].idempotencyKey,job.idempotencyKey);
 store.mutate(state=>{state.content[0].body='tampered';});
 assert.equal(prepareDue(store,owner,due).blocked,1);
 assert.equal(listJobs(store.db)[0].status,'BLOCKED');
 }finally{store.close();}
});
test('schedule enforces one daily slot, media, bilingual LinkedIn and Riyadh date',()=>{
 const store=setup();try{
 const x=approved(store),other=approved(store);
 scheduleContent(store,{contentId:x.id,scheduledAt:'2030-01-01T12:00:00+03:00'},owner,now);
 assert.throws(()=>scheduleContent(store,{contentId:other.id,scheduledAt:'2030-01-01T13:00:00+03:00'},owner,now),/بالفعل/);
 const ig=approved(store,{platform:'Instagram'});
 assert.throws(()=>scheduleContent(store,{contentId:ig.id,scheduledAt:'2030-01-01T12:00:00+03:00'},owner,now),/البصري/);
 const linkedin=approved(store,{platform:'LinkedIn'});
 assert.throws(()=>scheduleContent(store,{contentId:linkedin.id,scheduledAt:'2030-01-01T12:00:00+03:00'},owner,now),/إنجليزية/);
 assert.throws(()=>scheduleContent(store,{contentId:x.id,scheduledAt:'2030-01-01T23:00:00Z'},owner,now),/الرياض/);
 assert.equal(riyadhDate(Date.parse('2030-01-01T22:00:00Z')),'2030-01-02');
 store.mutate(state=>cancelJobs(store,state,x.id,owner));
 assert.equal(listJobs(store.db)[0].status,'CANCELLED');
 assert.doesNotThrow(()=>scheduleContent(store,{contentId:other.id,scheduledAt:'2030-01-01T13:00:00+03:00'},owner,now));
 }finally{store.close();}
});
test('changed reviewed content cannot be approved and media must be reviewed',()=>{
 const draft=createContent({title:'test',body:'test',platform:'X',date:'2030-01-01',url:'https://hyper-cool.com/offers',assetUrl:'https://hyper-cool.com/image.jpg'});
 assert.throws(()=>reviewContent(draft,{reviewer:'Reviewer',evidence:'evidence',facts:true,claims:true,link:true}),/البصري/);
 const reviewed=reviewContent(draft,{reviewer:'Reviewer',evidence:'evidence',facts:true,claims:true,link:true,asset:true});
 assert.throws(()=>approveContent({...reviewed,englishCopy:'Changed'},{owner:'Owner'}),/تغير/);
});
test('brief snapshots are idempotent and do not fabricate disconnected KPIs',()=>{
 const store=setup();try{
 const brief=buildBrief(store,'2030-01-01');assert.equal(brief.targetDate,'2030-01-02');assert.equal(brief.metrics.published,null);assert.equal(brief.gaps.length,3);
 assert.equal(saveDailyBrief(store,'2030-01-01',owner).deliveryStatus,'LOCAL_ONLY');
 assert.equal(saveDailyBrief(store,'2030-01-01',owner).replayed,true);
 }finally{store.close();}
});
test('automation secret is required and workflow remains inactive without outbound publishing',()=>{
 assert.throws(()=>authorizeAutomation({headers:{}},{}));
 assert.throws(()=>authorizeAutomation({headers:{'x-hypercool-token':'wrong'}},{AUTOMATION_TOKEN:'x'.repeat(32)}));
 assert.doesNotThrow(()=>authorizeAutomation({headers:{'x-hypercool-token':'x'.repeat(32)}},{AUTOMATION_TOKEN:'x'.repeat(32)}));
 const workflow=JSON.parse(readFileSync(new URL('../workflows/daily-operations.json',import.meta.url),'utf8'));
 assert.equal(workflow.active,false);assert.equal(workflow.settings.timezone,'Asia/Riyadh');
 for(const node of workflow.nodes.filter(n=>n.type==='n8n-nodes-base.httpRequest'))assert.match(node.parameters.url,/^http:\/\/127\.0\.0\.1:3000\/api\/automation\/(daily-brief|prepare-due)$/);
});
