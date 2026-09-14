import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installContextItems,createContextItem,listContextItems,updateContextItem,archiveContextItem,searchContextItems,contextSummaryForPlanner,withFreshness,detectContextConflicts} from '../src/runtime/context-items.js';
import {installAuditLog} from '../src/audit.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
function fixture(){const store=openStore(':memory:');installContextItems(store.db);installAuditLog(store.db);return store;}

test('createContextItem validates type/title/priority and stores real governance fields',()=>{
 const store=fixture();
 try{
  assert.throws(()=>createContextItem(store.db,{type:'not_a_real_type',title:'x',description:''},user,'t1'),/نوع السياق/);
  assert.throws(()=>createContextItem(store.db,{type:'company_goal',title:'',description:''},user,'t1'),/العنوان/);
  assert.throws(()=>createContextItem(store.db,{type:'company_goal',title:'x',description:'',priority:'URGENT'},user,'t1'),/الأولوية/);
  const item=createContextItem(store.db,{type:'company_goal',title:'زيادة المبيعات 20%',description:'هدف الربع',priority:'HIGH',tags:['sales','q4']},user,'t1');
  assert.equal(item.type,'company_goal');
  assert.equal(item.source,'manual');
  assert.equal(item.status,'ACTIVE');
  assert.equal(item.createdBy,user.id);
  assert.equal(item.createdByName,user.name);
  assert.deepEqual(item.tags,['sales','q4']);
  assert.ok(item.createdAt && item.updatedAt);
 }finally{store.close();}
});

test('context items are tenant-isolated exactly like every other resource',()=>{
 const store=fixture();
 try{
  const itemA=createContextItem(store.db,{type:'decision',title:'قرار أ',description:''},user,'tenant-a');
  createContextItem(store.db,{type:'decision',title:'قرار ب',description:''},user,'tenant-b');
  assert.equal(listContextItems(store.db,'tenant-a').length,1);
  assert.equal(listContextItems(store.db,'tenant-b').length,1);
  assert.throws(()=>updateContextItem(store.db,itemA.id,{title:'محاولة'},user,'tenant-b'),/غير موجود/);
 }finally{store.close();}
});

test('search filters by free text and type; archiving removes from the default ACTIVE listing but keeps the record',()=>{
 const store=fixture();
 try{
  createContextItem(store.db,{type:'brain_identity',title:'هوية العلامة',description:'شركة تبريد سريع'},user,'t1');
  const other=createContextItem(store.db,{type:'client_note',title:'ملاحظة عميل مهم',description:'يفضل التواصل صباحًا'},user,'t1');
  assert.equal(searchContextItems(store.db,'t1',{query:'تبريد'}).length,1);
  assert.equal(searchContextItems(store.db,'t1',{type:'client_note'}).length,1);
  archiveContextItem(store.db,other.id,user,'t1');
  assert.equal(listContextItems(store.db,'t1',{status:'ACTIVE'}).length,1);
  assert.equal(listContextItems(store.db,'t1',{status:'ARCHIVED'}).length,1);
 }finally{store.close();}
});

test('the planner summary is short, capped, and only includes high-signal ACTIVE types — never a full dump',()=>{
 const store=fixture();
 try{
  createContextItem(store.db,{type:'brain_goals',title:'هدف النمو',description:'مضاعفة الإيرادات خلال سنة'},user,'t1');
  createContextItem(store.db,{type:'client_note',title:'ملاحظة عادية',description:'لن تظهر في ملخص المخطط'},user,'t1');
  const summary=contextSummaryForPlanner(store.db,'t1');
  assert.equal(summary.length,1);
  assert.match(summary[0],/brain_goals/);
 }finally{store.close();}
});

test('freshness is derived (never a third stored status): ACTIVE stays ACTIVE, ARCHIVED stays ARCHIVED, and an ACTIVE item past its own expiry reads as STALE',()=>{
 const store=fixture();
 try{
  const fresh=createContextItem(store.db,{type:'decision',title:'قرار حديث',description:''},user,'t1');
  assert.equal(withFreshness(fresh).freshness,'ACTIVE');
  const expired=createContextItem(store.db,{type:'decision',title:'قرار قديم',description:'',expiresAt:new Date(Date.now()-1000).toISOString()},user,'t1');
  assert.equal(withFreshness(expired).freshness,'STALE');
  assert.equal(expired.status,'ACTIVE'); // the stored status itself never changes — freshness is read-time only
  archiveContextItem(store.db,expired.id,user,'t1');
  const archived=listContextItems(store.db,'t1',{status:'ARCHIVED'})[0];
  assert.equal(withFreshness(archived).freshness,'ARCHIVED');
 }finally{store.close();}
});

test('two ACTIVE brain_identity records are surfaced as a real conflict, never silently resolved to one',()=>{
 const store=fixture();
 try{
  assert.deepEqual(detectContextConflicts(store.db,'t1'),[]);
  createContextItem(store.db,{type:'brain_identity',title:'الهوية v1',description:'شركة تبريد'},user,'t1');
  assert.deepEqual(detectContextConflicts(store.db,'t1'),[]); // one record — no conflict yet
  createContextItem(store.db,{type:'brain_identity',title:'الهوية v2',description:'شركة تبريد سريع'},user,'t1');
  const conflicts=detectContextConflicts(store.db,'t1');
  assert.equal(conflicts.length,1);
  assert.equal(conflicts[0].type,'brain_identity');
  assert.equal(conflicts[0].items.length,2);
 }finally{store.close();}
});
