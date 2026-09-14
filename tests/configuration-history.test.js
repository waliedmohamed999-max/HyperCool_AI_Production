import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installAuditLog} from '../src/audit.js';
import {installAgentToolAssignments,upsertAssignment} from '../src/runtime/tool-assignments.js';
import {installIntegrationConnections,createConnection} from '../src/integrations/connections.js';
import {installIntegrationDefinitions} from '../src/integrations/definitions.js';
import {installConfigurationHistory,recordConfigurationChange,listConfigurationHistory,undoConfigurationChange} from '../src/runtime/configuration-history.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
function fixture(){
 const store=openStore(':memory:');
 installAuditLog(store.db);installAgentToolAssignments(store.db);installIntegrationDefinitions(store.db);installIntegrationConnections(store.db);installConfigurationHistory(store.db);
 return store;
}

test('recordConfigurationChange stores a real, structured before/after entry and undo restores the exact previous value through the canonical service',()=>{
 const store=fixture();
 try{
  const connA=createConnection(store.db,{integrationDefinitionId:'whatsapp',name:'WhatsApp A'},'t1');
  const connB=createConnection(store.db,{integrationDefinitionId:'whatsapp',name:'WhatsApp B'},'t1');
  upsertAssignment(store.db,'t1','followup','whatsapp_send',{connectionId:connA.id});
  const changeId=recordConfigurationChange(store.db,{tenantId:'t1',entityType:'agent_tool_connection',entityId:'followup::whatsapp_send',field:'connectionId',
   previousValue:{connectionId:connA.id},newValue:{connectionId:connB.id},actor:user,commandRunId:'run-1',reversible:true});
  upsertAssignment(store.db,'t1','followup','whatsapp_send',{connectionId:connB.id});
  const history=listConfigurationHistory(store.db,'t1');
  assert.equal(history.length,1);
  assert.equal(history[0].id,changeId);
  assert.equal(history[0].reversible,true);
  assert.equal(history[0].previousValue.connectionId,connA.id);
  assert.equal(history[0].newValue.connectionId,connB.id);

  const result=undoConfigurationChange(store.db,changeId,user,'t1');
  assert.equal(result.undone,true);
  assert.equal(result.assignment.connectionId,connA.id); // restored through upsertAssignment, not a raw write
  const historyAfter=listConfigurationHistory(store.db,'t1');
  assert.equal(historyAfter.length,2); // the undo itself is its own new, honest history entry
  assert.ok(historyAfter.find(h=>h.id===changeId).revertedAt);
 }finally{store.close();}
});

test('undo refuses a second time on an already-reverted change',()=>{
 const store=fixture();
 try{
  const conn=createConnection(store.db,{integrationDefinitionId:'whatsapp',name:'A'},'t1');
  upsertAssignment(store.db,'t1','followup','whatsapp_send',{connectionId:conn.id});
  const changeId=recordConfigurationChange(store.db,{tenantId:'t1',entityType:'agent_tool_connection',entityId:'followup::whatsapp_send',field:'connectionId',
   previousValue:{connectionId:null},newValue:{connectionId:conn.id},actor:user,reversible:true});
  undoConfigurationChange(store.db,changeId,user,'t1');
  assert.throws(()=>undoConfigurationChange(store.db,changeId,user,'t1'),/تم التراجع/);
 }finally{store.close();}
});

test('undo refuses when the setting changed again since this record (stale state) rather than silently discarding the newer change',()=>{
 const store=fixture();
 try{
  const connA=createConnection(store.db,{integrationDefinitionId:'whatsapp',name:'A'},'t1');
  const connB=createConnection(store.db,{integrationDefinitionId:'whatsapp',name:'B'},'t1');
  const connC=createConnection(store.db,{integrationDefinitionId:'whatsapp',name:'C'},'t1');
  upsertAssignment(store.db,'t1','followup','whatsapp_send',{connectionId:connA.id});
  const changeId=recordConfigurationChange(store.db,{tenantId:'t1',entityType:'agent_tool_connection',entityId:'followup::whatsapp_send',field:'connectionId',
   previousValue:{connectionId:null},newValue:{connectionId:connA.id},actor:user,reversible:true});
  upsertAssignment(store.db,'t1','followup','whatsapp_send',{connectionId:connA.id}); // matches newValue at first
  // A second, later, real change moves it to connB — the FIRST change's undo must not clobber this.
  upsertAssignment(store.db,'t1','followup','whatsapp_send',{connectionId:connB.id});
  assert.throws(()=>undoConfigurationChange(store.db,changeId,user,'t1'),/تغيير هذا الإعداد مرة أخرى/);
  void connC;
 }finally{store.close();}
});

test('a non-reversible entry can never be undone (irreversible external action policy)',()=>{
 const store=fixture();
 try{
  const changeId=recordConfigurationChange(store.db,{tenantId:'t1',entityType:'agent_tool_connection',entityId:'followup::whatsapp_send',field:'connectionId',
   previousValue:{connectionId:null},newValue:{connectionId:'x'},actor:user,reversible:false});
  assert.throws(()=>undoConfigurationChange(store.db,changeId,user,'t1'),/CANNOT_UNDO_EXTERNAL_ACTION|لا يمكن التراجع/);
 }finally{store.close();}
});

test('configuration history is tenant-isolated',()=>{
 const store=fixture();
 try{
  recordConfigurationChange(store.db,{tenantId:'tenant-a',entityType:'agent_tool_connection',entityId:'x::y',field:'connectionId',previousValue:null,newValue:{connectionId:'c'},actor:user,reversible:true});
  assert.equal(listConfigurationHistory(store.db,'tenant-a').length,1);
  assert.equal(listConfigurationHistory(store.db,'tenant-b').length,0);
 }finally{store.close();}
});
