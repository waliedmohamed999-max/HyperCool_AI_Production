import test from 'node:test';
import assert from 'node:assert/strict';
import {computeCategoryCounts,computeMemorySummary,computePriceConflicts,computeMemoryHealthIssues,computeMemoryUsage,buildMemoryWorkspace} from '../src/memory-ops.js';
import {openStore} from '../src/store.js';
import {installKnowledge,saveMemory} from '../src/knowledge.js';

const owner={id:'owner-1',name:'Owner',role:'owner'};
const entry=(overrides={})=>({id:'e1',kind:'product_fact',key:'k1',value:'v1',source:'https://example.com/doc',productId:null,status:'APPROVED',version:1,expiresAt:null,verifiedAt:new Date().toISOString(),approvedByName:'Owner',...overrides});

test('computeCategoryCounts counts only the latest version per key, never a superseded one twice',()=>{
 const entries=[entry({id:'e2',version:2}),entry({id:'e1',version:1})]; // rowid DESC order: newest first
 const counts=computeCategoryCounts(entries);
 assert.equal(counts.product_fact,1);
});

test('computeMemorySummary never fabricates a nonzero number with no data',()=>{
 const summary=computeMemorySummary([],[],[]);
 assert.equal(summary.totalRecords.value,0);
 assert.equal(summary.verified.value,0);
 assert.equal(summary.productsSynced.value,0);
});
test('computeMemorySummary counts an expired APPROVED record as expired, not verified',()=>{
 const summary=computeMemorySummary([entry({expiresAt:'2000-01-01T00:00:00.000Z'})],[],[]);
 assert.equal(summary.expired.value,1);
 assert.equal(summary.verified.value,0);
});
test('computeMemorySummary flags a time-sensitive kind with no expiry as needing review',()=>{
 const summary=computeMemorySummary([entry({kind:'price_reference'})],[],[]);
 assert.equal(summary.needsReview.value,1);
});
test('computeMemorySummary never flags brand_voice (not time-sensitive) as needing review',()=>{
 const summary=computeMemorySummary([entry({kind:'brand_voice'})],[],[]);
 assert.equal(summary.needsReview.value,0);
});

test('computePriceConflicts stays silent when memory and live Salla price agree',()=>{
 const products=[{id:'p1',name:{value:'Product'},price:{value:{amount:499,currency:'SAR'}},syncedAt:new Date().toISOString()}];
 const conflicts=computePriceConflicts([entry({kind:'price_reference',productId:'p1',value:'يبلغ السعر 499 ريال'})],products);
 assert.equal(conflicts.length,0);
});
test('computePriceConflicts flags a real mismatch and shows both real values, never silently corrects',()=>{
 const products=[{id:'p1',name:{value:'Product'},price:{value:{amount:599,currency:'SAR'}},syncedAt:new Date().toISOString()}];
 const conflicts=computePriceConflicts([entry({kind:'price_reference',productId:'p1',value:'يبلغ السعر 499 ريال'})],products);
 assert.equal(conflicts.length,1);
 assert.equal(conflicts[0].memoryAmount,499);
 assert.equal(conflicts[0].liveAmount,599);
});
test('computePriceConflicts ignores an expired memory fact — it is no longer an active claim',()=>{
 const products=[{id:'p1',name:{value:'Product'},price:{value:{amount:599,currency:'SAR'}},syncedAt:new Date().toISOString()}];
 const conflicts=computePriceConflicts([entry({kind:'price_reference',productId:'p1',value:'499',expiresAt:'2000-01-01T00:00:00.000Z'})],products);
 assert.equal(conflicts.length,0);
});
test('computePriceConflicts never touches a fact with no linked product',()=>{
 const conflicts=computePriceConflicts([entry({kind:'product_fact',productId:null,value:'499'})],[]);
 assert.equal(conflicts.length,0);
});

test('computeMemoryHealthIssues flags a short non-URL source as weak, and a real URL as fine',()=>{
 const issues=computeMemoryHealthIssues([entry({source:'قالها المدير'}),entry({id:'e2',key:'k2',source:'https://hyper-cool.com/policy.pdf'})],[]);
 assert.equal(issues.weakSource.length,1);
 assert.equal(issues.weakSource[0].key,'k1');
});

test('computeMemoryUsage returns nothing when no agent tool call ever touched this key',()=>{
 const store=openStore(':memory:');
 store.db.exec('CREATE TABLE agent_tool_calls (id TEXT PRIMARY KEY, run_id TEXT, tool TEXT, output TEXT, status TEXT, at TEXT); CREATE TABLE agent_runs (id TEXT PRIMARY KEY, agent_id TEXT);');
 const usage=computeMemoryUsage(store.db,'brand.voice');
 assert.deepEqual(usage,[]);
});
test('computeMemoryUsage attributes a real logged tool call to the agent that ran it',()=>{
 const store=openStore(':memory:');
 store.db.exec('CREATE TABLE agent_tool_calls (id TEXT PRIMARY KEY, run_id TEXT, tool TEXT, output TEXT, status TEXT, at TEXT); CREATE TABLE agent_runs (id TEXT PRIMARY KEY, agent_id TEXT);');
 store.db.prepare('INSERT INTO agent_runs VALUES (?,?)').run('run1','sales');
 store.db.prepare('INSERT INTO agent_tool_calls VALUES (?,?,?,?,?,?)').run('tc1','run1','search_brand_memory',JSON.stringify([{key:'brand.voice',value:'x'}]),'OK',new Date().toISOString());
 const usage=computeMemoryUsage(store.db,'brand.voice');
 assert.equal(usage.length,1);
 assert.equal(usage[0].agentId,'sales');
});

test('buildMemoryWorkspace assembles the full workspace end to end from real DB state',()=>{
 const store=openStore(':memory:');
 installKnowledge(store.db);
 saveMemory(store.db,{kind:'brand_voice',key:'brand.voice',value:'واثقة ومباشرة',source:'دليل العلامة v1',changeReason:'إعداد أولي',status:'APPROVED',expectedVersion:0},owner);
 const workspace=buildMemoryWorkspace(store,{pendingApprovals:[]});
 assert.equal(workspace.summary.totalRecords.value,1);
 assert.equal(workspace.categoryCounts.brand_voice,1);
});
