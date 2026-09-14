import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installRuntimeTables} from '../src/runtime/runtime.js';
import {getAiUsageSummary,getRunUsage} from '../src/runtime/ai-usage.js';

function fixture(){const store=openStore(':memory:');installRuntimeTables(store.db);return store;}
function insertRun(db,{tenantId,agentId='frost_commander',tokensIn,tokensOut,cost=null,provider='anthropic',startedAt}) {
 const id='run-'+Math.random().toString(36).slice(2);
 db.prepare(`INSERT INTO agent_runs (id,tenant_id,agent_id,trigger_type,status,input_context,started_at,finished_at,tokens_input,tokens_output,estimated_cost,latency_ms,provider,model)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(id,tenantId,agentId,'COMMAND','COMPLETED','{}',startedAt,startedAt,tokensIn,tokensOut,cost,250,provider,'test-model');
 return id;
}

test('AI usage aggregates real token counts by agent/provider for a real time period, tenant-scoped',()=>{
 const store=fixture();
 try{
  const now=new Date().toISOString();
  const runId=insertRun(store.db,{tenantId:'t1',tokensIn:100,tokensOut:50,startedAt:now});
  insertRun(store.db,{tenantId:'t1',agentId:'performance',tokensIn:200,tokensOut:80,startedAt:now});
  insertRun(store.db,{tenantId:'t2',tokensIn:9999,tokensOut:9999,startedAt:now}); // different tenant — must not leak in

  const summary=getAiUsageSummary(store.db,'t1',{period:'today'});
  assert.equal(summary.totals.calls,2);
  assert.equal(summary.totals.tokensInput,300);
  assert.equal(summary.totals.tokensOutput,130);
  assert.equal(summary.totals.hasCostData,false); // no pricing table filled in — never a fabricated cost
  assert.equal(summary.byAgent.frost_commander.calls,1);
  assert.equal(summary.byAgent.performance.calls,1);
  assert.equal(summary.byProvider.anthropic.calls,2);

  const usage=getRunUsage(store.db,runId,'t1');
  assert.equal(usage.tokensInput,100);
  assert.equal(usage.totalTokens,150);
  assert.equal(getRunUsage(store.db,runId,'t2'),null); // cross-tenant read refused
 }finally{store.close();}
});

test('AI usage never shows a monetary figure unless real cost data exists',()=>{
 const store=fixture();
 try{
  insertRun(store.db,{tenantId:'t1',tokensIn:100,tokensOut:50,cost:0.0042,startedAt:new Date().toISOString()});
  const summary=getAiUsageSummary(store.db,'t1',{period:'today'});
  assert.equal(summary.totals.hasCostData,true);
  assert.equal(summary.totals.estimatedCost,0.0042);
 }finally{store.close();}
});
