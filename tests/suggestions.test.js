import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installCRM,createLead} from '../src/crm.js';
import {installIntegrationConnections,createConnection} from '../src/integrations/connections.js';
import {installIntegrationDefinitions} from '../src/integrations/definitions.js';
import {installKnowledge} from '../src/knowledge.js';
import {installEscalations,listEscalations} from '../src/runtime/escalations.js';
import {installApprovals} from '../src/runtime/approvals.js';
import {installAuditLog} from '../src/audit.js';
import {installSuggestions,syncSuggestions,listSuggestions,acceptSuggestion,dismissSuggestion,createTaskFromSuggestion} from '../src/runtime/suggestions.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
function fixture(){
 const store=openStore(':memory:');
 installCRM(store.db);installIntegrationDefinitions(store.db);installIntegrationConnections(store.db);
 installKnowledge(store.db);installEscalations(store.db);installApprovals(store.db);installAuditLog(store.db);installSuggestions(store.db);
 return store;
}

test('syncSuggestions computes a real, evidence-backed suggestion for a genuinely unhealthy connection',()=>{
 const store=fixture();
 try{
  const connection=createConnection(store.db,{integrationDefinitionId:'salla',name:'متجر تجريبي'},'t1');
  store.db.prepare("UPDATE integration_connections SET status='ERROR',last_error_code='AUTH_FAILED' WHERE id=?").run(connection.id);
  const suggestions=syncSuggestions(store.db,'t1');
  const found=suggestions.find(s=>s.type==='unhealthy_connection');
  assert.ok(found,'expected a real unhealthy_connection suggestion');
  assert.equal(found.priority,'HIGH');
  assert.equal(found.evidence.connectionId,connection.id);
  assert.equal(found.status,'OPEN');
 }finally{store.close();}
});

test('dismissing a suggestion is stable — recomputing never resurrects it while the same condition persists',()=>{
 const store=fixture();
 try{
  const connection=createConnection(store.db,{integrationDefinitionId:'salla',name:'متجر تجريبي'},'t1');
  store.db.prepare("UPDATE integration_connections SET status='ERROR' WHERE id=?").run(connection.id);
  const first=syncSuggestions(store.db,'t1').find(s=>s.type==='unhealthy_connection');
  dismissSuggestion(store.db,first.id,user,'t1');
  const second=syncSuggestions(store.db,'t1').find(s=>s.type==='unhealthy_connection');
  assert.equal(second.id,first.id);
  assert.equal(second.status,'DISMISSED');
  assert.equal(listSuggestions(store.db,'t1',{status:'OPEN'}).length,0);
 }finally{store.close();}
});

test('accepting a suggestion is stable the same way, and Create Task reuses the real escalations-as-Tasks model',()=>{
 const store=fixture();
 try{
  const connection=createConnection(store.db,{integrationDefinitionId:'salla',name:'متجر تجريبي'},'t1');
  store.db.prepare("UPDATE integration_connections SET status='ERROR' WHERE id=?").run(connection.id);
  const suggestion=syncSuggestions(store.db,'t1').find(s=>s.type==='unhealthy_connection');
  const escalation=createTaskFromSuggestion(store.db,suggestion.id,user,'t1');
  assert.equal(escalation.agentId,'human');
  const openTasks=listEscalations(store.db,{status:'OPEN'},'t1');
  assert.equal(openTasks.length,1);
  assert.match(openTasks[0].reason,new RegExp(suggestion.title.slice(0,10)));
  const resynced=syncSuggestions(store.db,'t1').find(s=>s.type==='unhealthy_connection');
  assert.equal(resynced.status,'ACCEPTED');
 }finally{store.close();}
});

test('suggestions are tenant-isolated: a tenant with no real problems gets zero suggestions, never borrowed from another tenant',()=>{
 const store=fixture();
 try{
  const connection=createConnection(store.db,{integrationDefinitionId:'salla',name:'متجر أ'},'t1');
  store.db.prepare("UPDATE integration_connections SET status='ERROR' WHERE id=?").run(connection.id);
  syncSuggestions(store.db,'t1');
  assert.equal(syncSuggestions(store.db,'t2').length,0);
 }finally{store.close();}
});

test('a high-value hot lead waiting produces a real, evidence-backed HIGH priority suggestion',()=>{
 const store=fixture();
 try{
  const lead=createLead(store,{name:'شركة كبيرة',company:'شركة كبيرة القابضة',customerType:'B2B',sourceType:'INBOUND',phone:'+966500000000'},user,'t1');
  store.db.prepare(`UPDATE crm_leads SET json=json_set(json,'$.temperature','HOT','$.stage','QUOTE_SENT','$.valueSAR',80000) WHERE id=?`).run(lead.id);
  const found=syncSuggestions(store.db,'t1').find(s=>s.type==='high_value_lead_waiting');
  assert.ok(found,'expected a real high_value_lead_waiting suggestion');
  assert.equal(found.evidence.leadId,lead.id);
  assert.equal(found.priority,'HIGH');
 }finally{store.close();}
});
