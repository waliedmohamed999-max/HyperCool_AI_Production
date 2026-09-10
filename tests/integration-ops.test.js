import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIntegrationsDashboard,INTEGRATIONS,ERROR_ACTIONS} from '../src/integration-ops.js';
import {openStore} from '../src/store.js';

function fixture(){return openStore(':memory:');}
const noEnv={};

test('buildIntegrationsDashboard marks a fully unconfigured system as NEEDS_SETUP for the two real connectors',()=>{
 const store=fixture();
 const dash=buildIntegrationsDashboard(store,{env:noEnv,aiRuns:[],complianceRuns:[]});
 const anthropic=dash.integrations.find(i=>i.id==='anthropic');
 const salla=dash.integrations.find(i=>i.id==='salla');
 assert.equal(anthropic.status,'NEEDS_SETUP');
 assert.equal(salla.status,'NEEDS_SETUP');
});
test('a service with zero real connector code is never marked CONNECTED, even with its token present',()=>{
 const store=fixture();
 const dash=buildIntegrationsDashboard(store,{env:{WHATSAPP_ACCESS_TOKEN:'present'},aiRuns:[],complianceRuns:[]});
 const whatsapp=dash.integrations.find(i=>i.id==='whatsapp');
 assert.equal(whatsapp.status,'CONFIGURED_NO_CONNECTOR');
 assert.notEqual(whatsapp.status,'CONNECTED');
});
test('Anthropic is CONNECTED when configured with no error activity newer than its last success',()=>{
 const store=fixture();
 const env={ANTHROPIC_API_KEY:'k',ANTHROPIC_MODEL:'m'};
 const aiRuns=[{status:'COMPLETED',createdAt:'2026-01-01T00:00:00.000Z',finishedAt:'2026-01-01T00:00:02.000Z'}];
 const dash=buildIntegrationsDashboard(store,{env,aiRuns,complianceRuns:[]});
 const anthropic=dash.integrations.find(i=>i.id==='anthropic');
 assert.equal(anthropic.status,'CONNECTED');
 assert.equal(anthropic.lastActivity.note,'توليد محتوى');
});
test('Anthropic flips to ERROR when the most recent real event is a failure',()=>{
 const store=fixture();
 const env={ANTHROPIC_API_KEY:'k',ANTHROPIC_MODEL:'m'};
 const aiRuns=[
  {status:'COMPLETED',createdAt:'2026-01-01T00:00:00.000Z',finishedAt:'2026-01-01T00:00:02.000Z'},
  {status:'ERROR',errorCode:'CREDENTIALS_REJECTED',createdAt:'2026-01-02T00:00:00.000Z',finishedAt:'2026-01-02T00:00:01.000Z'}
 ];
 const dash=buildIntegrationsDashboard(store,{env,aiRuns,complianceRuns:[]});
 const anthropic=dash.integrations.find(i=>i.id==='anthropic');
 assert.equal(anthropic.status,'ERROR');
 assert.equal(anthropic.recentErrors[0].code,'CREDENTIALS_REJECTED');
 assert.equal(anthropic.recentErrors[0].action,ERROR_ACTIONS.CREDENTIALS_REJECTED);
});
test('Anthropic recovers to CONNECTED once a newer success follows an older error',()=>{
 const store=fixture();
 const env={ANTHROPIC_API_KEY:'k',ANTHROPIC_MODEL:'m'};
 const aiRuns=[
  {status:'ERROR',errorCode:'RATE_LIMITED',createdAt:'2026-01-01T00:00:00.000Z',finishedAt:'2026-01-01T00:00:01.000Z'},
  {status:'COMPLETED',createdAt:'2026-01-02T00:00:00.000Z',finishedAt:'2026-01-02T00:00:02.000Z'}
 ];
 const dash=buildIntegrationsDashboard(store,{env,aiRuns,complianceRuns:[]});
 assert.equal(dash.integrations.find(i=>i.id==='anthropic').status,'CONNECTED');
});
test('Salla lastActivity reflects the real audit trail, including who ran it',()=>{
 const store=fixture();
 store.mutate(state=>{state.audit.unshift({id:'a1',action:'SALLA_CATALOG_SYNCED',itemId:'catalog',count:42,actorId:'u1',actorName:'Owner',at:'2026-01-01T00:00:00.000Z'});});
 const dash=buildIntegrationsDashboard(store,{env:{SALLA_ACCESS_TOKEN:'t'},aiRuns:[],complianceRuns:[]});
 const salla=dash.integrations.find(i=>i.id==='salla');
 assert.equal(salla.status,'CONNECTED');
 assert.equal(salla.lastActivity.count,42);
 assert.equal(salla.lastActivity.by,'Owner');
});
test('a failed Salla sync with no later success is surfaced as ERROR with a real error code',()=>{
 const store=fixture();
 store.mutate(state=>{state.audit.unshift({id:'a1',action:'SALLA_CATALOG_SYNC_FAILED',itemId:'catalog',errorCode:'CREDENTIALS_REJECTED',actorId:'u1',actorName:'Owner',at:'2026-01-01T00:00:00.000Z'});});
 const dash=buildIntegrationsDashboard(store,{env:{SALLA_ACCESS_TOKEN:'t'},aiRuns:[],complianceRuns:[]});
 const salla=dash.integrations.find(i=>i.id==='salla');
 assert.equal(salla.status,'ERROR');
 assert.equal(salla.recentErrors[0].code,'CREDENTIALS_REJECTED');
});
test('the Salla webhook var is tracked separately and never gates the base "configured" flag',()=>{
 const store=fixture();
 const dash=buildIntegrationsDashboard(store,{env:{SALLA_ACCESS_TOKEN:'t'},aiRuns:[],complianceRuns:[]});
 const salla=dash.integrations.find(i=>i.id==='salla');
 assert.equal(salla.status,'CONNECTED');
 const webhookRow=salla.envVars.find(v=>v.name==='SALLA_WEBHOOK_SECRET');
 assert.equal(webhookRow.configured,false);
});
test('agentsUsing reflects the real AGENT_INTEGRATIONS map, not a guess',()=>{
 const store=fixture();
 const dash=buildIntegrationsDashboard(store,{env:noEnv,aiRuns:[],complianceRuns:[]});
 const whatsapp=dash.integrations.find(i=>i.id==='whatsapp');
 assert.ok(whatsapp.agentsUsing.some(a=>a.id==='sales'));
 assert.ok(whatsapp.agentsUsing.some(a=>a.id==='followup'));
 const anthropic=dash.integrations.find(i=>i.id==='anthropic');
 assert.equal(anthropic.agentsUsing.length,0); // no agent lists 'anthropic' as a required integration key
});
test('summary counts match the real per-integration statuses, covering every catalog entry',()=>{
 const store=fixture();
 const dash=buildIntegrationsDashboard(store,{env:noEnv,aiRuns:[],complianceRuns:[]});
 assert.equal(dash.summary.total,INTEGRATIONS.length);
 assert.equal(dash.summary.needsSetup,INTEGRATIONS.length); // every integration is a real, actionable "needs setup" item now — none are marked unsupported
 assert.equal(dash.summary.connected,0);
 assert.equal(dash.summary.errors,0);
});
test('OpenAI (a real second AgentRuntime provider) needs setup with no env vars configured',()=>{
 const store=fixture();
 const dash=buildIntegrationsDashboard(store,{env:noEnv,aiRuns:[],complianceRuns:[],agentRuns:[]});
 const openai=dash.integrations.find(i=>i.id==='openai');
 assert.equal(openai.status,'NEEDS_SETUP');
 assert.deepEqual(openai.envVars.map(v=>v.name),['OPENAI_API_KEY','OPENAI_DEFAULT_MODEL']);
});
test('OpenAI configured but never actually run by any agent is CONFIGURED_NO_CONNECTOR, not CONNECTED — only a real successful agent run proves it works',()=>{
 const store=fixture();
 const env={OPENAI_API_KEY:'sk-whatever',OPENAI_DEFAULT_MODEL:'gpt-test'};
 const configuredNoRuns=buildIntegrationsDashboard(store,{env,aiRuns:[],complianceRuns:[],agentRuns:[]});
 assert.equal(configuredNoRuns.integrations.find(i=>i.id==='openai').status,'CONFIGURED_NO_CONNECTOR');
 const withRealRun=buildIntegrationsDashboard(store,{env,aiRuns:[],complianceRuns:[],agentRuns:[{agent_id:'sales',provider:'openai',status:'COMPLETED',started_at:'2030-01-01T00:00:00.000Z',finished_at:'2030-01-01T00:00:01.000Z',latency_ms:1000}]});
 assert.equal(withRealRun.integrations.find(i=>i.id==='openai').status,'CONNECTED');
});
test('no integration exposes a raw secret value anywhere in the dashboard payload',()=>{
 const store=fixture();
 const env={ANTHROPIC_API_KEY:'sk-super-secret-value',ANTHROPIC_MODEL:'m',SALLA_ACCESS_TOKEN:'salla-secret-value'};
 const dash=buildIntegrationsDashboard(store,{env,aiRuns:[],complianceRuns:[]});
 const payload=JSON.stringify(dash);
 assert.ok(!payload.includes('sk-super-secret-value'));
 assert.ok(!payload.includes('salla-secret-value'));
});
