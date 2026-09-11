import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installPlanning} from '../src/planning.js';
import {installCompliance} from '../src/compliance.js';
import {installAutonomy,setAutonomy} from '../src/autonomy.js';
import {installCRM,createLead} from '../src/crm.js';
import {installReporting,buildWeeklyReport,saveWeeklyReport,listWeeklyReports,currentWeekStart} from '../src/reporting.js';
import {createContent} from '../src/domain.js';
import {installContent,insertContent} from '../src/content.js';
import {installAuditLog,listAuditLog} from '../src/audit.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
function fixture(){
 const store=openStore(':memory:');
 installPlanning(store.db);installCompliance(store.db);installAutonomy(store.db);installCRM(store.db);installReporting(store.db);installContent(store.db);installAuditLog(store.db);
 return store;
}

test('a week must start on a Sunday and rejects non-Sunday dates',()=>{
 const store=fixture();
 try{
  assert.throws(()=>buildWeeklyReport(store,'2026-09-10'),/الأحد/);
  assert.doesNotThrow(()=>buildWeeklyReport(store,'2026-09-06'));
 }finally{store.close();}
});

test('report only counts content whose planned date falls inside the week window',()=>{
 const store=fixture();
 try{
  insertContent(store.db,{...createContent({title:'In week',body:'x',platform:'X',date:'2026-09-08',url:'https://hyper-cool.com/offers'}),status:'DRAFT'});
  insertContent(store.db,{...createContent({title:'Before week',body:'x',platform:'X',date:'2026-09-06',url:'https://hyper-cool.com/offers'}),status:'DRAFT'});
  insertContent(store.db,{...createContent({title:'After week',body:'x',platform:'X',date:'2026-09-13',url:'https://hyper-cool.com/offers'}),status:'DRAFT'});
  const report=buildWeeklyReport(store,'2026-09-06');
  assert.equal(report.weekStart,'2026-09-06');assert.equal(report.weekEnd,'2026-09-13');
  assert.equal(report.content.total,2);
  assert.equal(report.content.byPlatform.X,2);
 }finally{store.close();}
});

test('report aggregates CRM leads, autonomy changes and never fabricates external metrics',()=>{
 const store=fixture();
 try{
  createLead(store,{name:'Test lead',customerType:'B2C',sourceType:'INBOUND',phone:'+966501234567'},user);
  setAutonomy(store,'copy',{level:'L1',reason:'clean run',expectedVersion:0},user);
  const weekStart=currentWeekStart();
  const report=buildWeeklyReport(store,weekStart);
  assert.equal(report.crm.leadsCreated,1);
  assert.equal(report.crm.bySource.INBOUND,1);
  assert.equal(report.autonomy.changes,1);
  assert.equal(report.autonomy.promotions,1);
  assert.equal(report.metrics.publishedPosts,null);
  assert.equal(report.deliveryStatus,'LOCAL_ONLY');
 }finally{store.close();}
});

test('saving a weekly report is idempotent per week and logs to audit',()=>{
 const store=fixture();
 try{
  const weekStart='2026-09-06';
  const first=saveWeeklyReport(store,weekStart,user);
  assert.equal(first.replayed,undefined);
  const second=saveWeeklyReport(store,weekStart,user);
  assert.equal(second.replayed,true);
  assert.equal(listWeeklyReports(store.db).length,1);
  assert.equal(listAuditLog(store.db)[0].action,'WEEKLY_REPORT_CREATED');
 }finally{store.close();}
});

test('currentWeekStart always resolves to a Sunday in Riyadh time',()=>{
 for(const now of [Date.now(),Date.parse('2026-09-10T22:00:00Z'),Date.parse('2026-01-01T00:00:00Z')]) {
  const start=currentWeekStart(now);
  assert.match(start,/^\d{4}-\d{2}-\d{2}$/);
  assert.equal(new Date(start+'T12:00:00Z').getUTCDay(),0);
 }
});
