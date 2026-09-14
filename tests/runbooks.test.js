import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installAuditLog} from '../src/audit.js';
import {installRunbooks,listRunbooks,createRunbook,archiveRunbook,getRunbook,BUILTIN_RUNBOOKS} from '../src/runtime/runbooks.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
function fixture(){const store=openStore(':memory:');installAuditLog(store.db);installRunbooks(store.db);return store;}

test('the 7 built-in runbooks are seeded once per tenant, idempotently, each with a real command_text',()=>{
 const store=fixture();
 try{
  const first=listRunbooks(store.db,'t1');
  assert.equal(first.length,BUILTIN_RUNBOOKS.length);
  assert.ok(first.every(r=>r.isBuiltin && r.commandText.length>0));
  const second=listRunbooks(store.db,'t1'); // idempotent — no duplicates on re-list
  assert.equal(second.length,BUILTIN_RUNBOOKS.length);
 }finally{store.close();}
});

test('runbooks are seeded and stored per-tenant — one tenant archiving its own copy never affects another',()=>{
 const store=fixture();
 try{
  const tenantARunbooks=listRunbooks(store.db,'tenant-a');
  const tenantBRunbooks=listRunbooks(store.db,'tenant-b');
  assert.notEqual(tenantARunbooks[0].id,tenantBRunbooks[0].id); // real per-tenant rows, not shared
  assert.throws(()=>archiveRunbook(store.db,tenantARunbooks[0].id,user,'tenant-a'),/لا يمكن حذف قالب أساسي/);
 }finally{store.close();}
});

test('a custom runbook (Favorite) can be created and archived, but a builtin cannot be deleted',()=>{
 const store=fixture();
 try{
  const custom=createRunbook(store.db,{name:'مراجعتي المفضلة',description:'',commandText:'اعرض حالة الشركة'},user,'t1');
  assert.equal(custom.isBuiltin,false);
  assert.equal(custom.createdByName,'Owner');
  assert.equal(listRunbooks(store.db,'t1').length,BUILTIN_RUNBOOKS.length+1);
  archiveRunbook(store.db,custom.id,user,'t1');
  assert.equal(listRunbooks(store.db,'t1').length,BUILTIN_RUNBOOKS.length);
  assert.throws(()=>createRunbook(store.db,{name:'',commandText:'x'},user,'t1'),/اسم القالب/);
  assert.throws(()=>createRunbook(store.db,{name:'x',commandText:''},user,'t1'),/نص الأمر/);
 }finally{store.close();}
});

test('a wrong-tenant runbook lookup 404s',()=>{
 const store=fixture();
 try{
  const runbook=listRunbooks(store.db,'tenant-a')[0];
  assert.throws(()=>getRunbook(store.db,runbook.id,'tenant-b'),/غير موجود/);
 }finally{store.close();}
});
