import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installKnowledge,proposeMemoryUpdate} from '../src/knowledge.js';
import {installApprovals,listApprovals,decideApproval} from '../src/runtime/approvals.js';

const operator={id:'op-1',name:'Sara',role:'operator'};
function fixture(){const store=openStore(':memory:');installKnowledge(store.db);installApprovals(store.db);return store;}

test('proposeMemoryUpdate never writes to the memory table directly — it only creates a pending approval',()=>{
 const store=fixture();
 proposeMemoryUpdate(store.db,{kind:'faq',key:'faq.warranty',value:'الضمان سنتان',source:'سياسة الشركة',changeReason:'إضافة سؤال شائع جديد'},operator);
 assert.equal(store.db.prepare('SELECT COUNT(*) c FROM memory').get().c,0);
 const approvals=listApprovals(store.db,{status:'PENDING'});
 assert.equal(approvals.length,1);
 assert.equal(approvals[0].action_type,'memory_policy_change');
 assert.equal(approvals[0].agent_id,'human');
});
test('proposeMemoryUpdate records who submitted it in the reason, since agent_approvals has no submitter column',()=>{
 const store=fixture();
 proposeMemoryUpdate(store.db,{kind:'faq',key:'faq.x',value:'v',source:'s',changeReason:'سبب معين'},operator);
 const approval=listApprovals(store.db)[0];
 assert.match(approval.reason,/Sara/);
 assert.match(approval.reason,/سبب معين/);
});
test('proposeMemoryUpdate rejects an unknown kind, same validation as the direct save path',()=>{
 const store=fixture();
 assert.throws(()=>proposeMemoryUpdate(store.db,{kind:'not_a_real_kind',key:'k',value:'v',source:'s',changeReason:'r'},operator));
});
test('proposeMemoryUpdate requires a productId for product_fact, same as saveMemory',()=>{
 const store=fixture();
 assert.throws(()=>proposeMemoryUpdate(store.db,{kind:'product_fact',key:'k',value:'v',source:'s',changeReason:'r'},operator));
});
test('a human-submitted proposal decides through the exact same approval flow as an agent one',()=>{
 const store=fixture();
 const row=proposeMemoryUpdate(store.db,{kind:'faq',key:'faq.y',value:'v',source:'s',changeReason:'r'},operator);
 const decided=decideApproval(store.db,row.id,'REJECTED',{id:'owner-1',name:'Owner'});
 assert.equal(decided.status,'REJECTED');
});
