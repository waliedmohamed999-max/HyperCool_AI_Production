import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installContextItems,createContextItem,listContextItems,updateContextItem,archiveContextItem,searchContextItems,contextSummaryForPlanner} from '../src/runtime/context-items.js';
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
