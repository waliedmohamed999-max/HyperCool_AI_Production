import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';
import {createTenant} from '../src/tenancy.js';
import {createAuth} from '../src/auth.js';
import {createConnection,updateConnection} from '../src/integrations/connections.js';
import {upsertAssignment} from '../src/runtime/tool-assignments.js';
import {installToolDefinitions} from '../src/runtime/tool-definitions.js';
import {createDraftConnector,upsertActionForConnector,publishConnector} from '../src/connectors/dynamic/builder.js';
import {buildAgentConnectionMap,buildToolCompatibilityView} from '../src/runtime/agent-connection-map.js';

// Phase 6G, Part 43-47 — Agent Connection Map + Tool Compatibility View. Reuses
// evaluateAllToolsReadiness/resolveToolConnection directly — this file mostly proves the
// ENRICHMENT (connector slug/version/health/REAUTH_REQUIRED) and filtering on top of that
// already-tested readiness computation, not readiness itself (see agent-readiness tests).
const key32=randomBytes(32).toString('hex');
const PLATFORM_ADMIN_USERNAMES='platform_admin';

async function harness() {
 const directory=await mkdtemp(join(tmpdir(),'hypercool-agentmap-'));
 const app=await createApp({dataDir:directory,env:{INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES}});
 const auth=createAuth(app.store.db);
 const admin=auth.createUser({username:'platform_admin',name:'Platform Admin',password:'a-long-test-password'},'owner');
 const owner=auth.createUser({username:'owner_'+Math.random().toString(36).slice(2),name:'Owner',password:'a-long-test-password'},'owner');
 const tenantId=createTenant(app.store.db,{name:'Co '+Math.random().toString(36).slice(2),slug:'co-'+Math.random().toString(36).slice(2)},owner.id);
 const env={INTEGRATION_ENCRYPTION_KEY:key32,PLATFORM_ADMIN_USERNAMES};
 installToolDefinitions(app.store.db);
 return {app,db:app.store.db,env,admin,owner,tenantId,cleanup:async()=>{app.store.close();await rm(directory,{recursive:true,force:true});}};
}
function insertCustomTool(db,slug,capability) {
 db.prepare("INSERT OR IGNORE INTO tool_definitions (id,slug,description,category,risk_level,action_type,integration_slug,requires_connection,is_read_only,is_external_action,capability,requires_approval_below_level,min_level,allowed_agents,input_schema,is_available,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))")
  .run(slug,slug,'x','commerce','LOW','READ',null,1,1,0,capability,null,'L0',JSON.stringify(['frost']),'{}',1);
}

test('Map row: a READY agent/tool pair carries the real connectorSlug/connectionId/connectorVersion/healthStatus',async()=>{
 const {db,env,admin,owner,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,{
   slug:'map_co',nameAr:'x',nameEn:'x',category:'commerce',descriptionAr:'x',descriptionEn:'x',
   adapterType:'GENERIC_REST',connectionMode:'SINGLE',auth:{type:'API_KEY',headerName:'X-Key'},
   capabilities:['commerce.orders.read'],rest:{baseUrl:'https://map-co.test'}
  });
  upsertActionForConnector(db,env,admin,def.id,{slug:'get_orders',nameAr:'x',nameEn:'x',httpMethod:'GET',pathTemplate:'/orders',requiredCapability:'commerce.orders.read',actionType:'READ',riskLevel:'LOW'});
  publishConnector(db,env,admin,def.id);
  insertCustomTool(db,'map_tool','commerce.orders.read');
  const conn=createConnection(db,{integrationDefinitionId:'map_co',name:'c1'},tenantId);
  updateConnection(db,conn.id,{status:'CONNECTED',connectorVersion:1},tenantId);
  upsertAssignment(db,tenantId,'frost','map_tool',{enabled:true,connectionId:conn.id});

  const rows=buildAgentConnectionMap(db,env,tenantId,{agentId:'frost'});
  const row=rows.find(r=>r.toolSlug==='map_tool');
  assert.ok(row);
  assert.equal(row.connectorSlug,'map_co');
  assert.equal(row.connectionId,conn.id);
  assert.equal(row.connectorVersion,1);
  assert.equal(row.healthStatus,'CONNECTED');
  assert.equal(row.readinessStatus,'READY');
  assert.equal(row.capability,'commerce.orders.read');
 } finally { await cleanup(); }
});

test('Map row enrichment: TOKEN_EXPIRED connection surfaces REAUTH_REQUIRED, not the generic CONNECTION_UNHEALTHY',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,{
   slug:'map_reauth',nameAr:'x',nameEn:'x',category:'commerce',descriptionAr:'x',descriptionEn:'x',
   adapterType:'GENERIC_REST',connectionMode:'SINGLE',auth:{type:'API_KEY',headerName:'X-Key'},
   capabilities:['commerce.orders.read'],rest:{baseUrl:'https://map-reauth.test'}
  });
  publishConnector(db,env,admin,def.id);
  insertCustomTool(db,'map_reauth_tool','commerce.orders.read');
  const conn=createConnection(db,{integrationDefinitionId:'map_reauth',name:'c1'},tenantId);
  updateConnection(db,conn.id,{status:'CONNECTED',connectorVersion:1},tenantId);
  upsertAssignment(db,tenantId,'frost','map_reauth_tool',{enabled:true,connectionId:conn.id});
  // The token expires AFTER the assignment already exists — a real, realistic lifecycle
  // (assignment validation itself requires a healthy/capability-granting connection at the
  // moment it is CREATED, exactly like every other assignment in this codebase).
  updateConnection(db,conn.id,{status:'TOKEN_EXPIRED'},tenantId);

  const rows=buildAgentConnectionMap(db,env,tenantId,{agentId:'frost'});
  const row=rows.find(r=>r.toolSlug==='map_reauth_tool');
  assert.equal(row.readinessReason,'REAUTH_REQUIRED');
 } finally { await cleanup(); }
});

test('Filters: agentId/connectorSlug/status/capability all narrow the result set correctly',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,{
   slug:'map_filter',nameAr:'x',nameEn:'x',category:'commerce',descriptionAr:'x',descriptionEn:'x',
   adapterType:'GENERIC_REST',connectionMode:'SINGLE',auth:{type:'API_KEY',headerName:'X-Key'},
   capabilities:['commerce.orders.read'],rest:{baseUrl:'https://map-filter.test'}
  });
  publishConnector(db,env,admin,def.id);
  insertCustomTool(db,'map_filter_tool','commerce.orders.read');
  const conn=createConnection(db,{integrationDefinitionId:'map_filter',name:'c1'},tenantId);
  updateConnection(db,conn.id,{status:'CONNECTED',connectorVersion:1},tenantId);
  upsertAssignment(db,tenantId,'frost','map_filter_tool',{enabled:true,connectionId:conn.id});

  const byAgent=buildAgentConnectionMap(db,env,tenantId,{agentId:'strategy'});
  assert.equal(byAgent.some(r=>r.toolSlug==='map_filter_tool'),false,'strategy never gets frost\'s row (allowedAgents restricted to frost)');

  const byConnector=buildAgentConnectionMap(db,env,tenantId,{connectorSlug:'map_filter'});
  assert.ok(byConnector.some(r=>r.toolSlug==='map_filter_tool'));

  const byStatus=buildAgentConnectionMap(db,env,tenantId,{status:'READY',agentId:'frost'});
  assert.ok(byStatus.some(r=>r.toolSlug==='map_filter_tool'));
  const byWrongStatus=buildAgentConnectionMap(db,env,tenantId,{status:'BLOCKED',agentId:'frost',connectorSlug:'map_filter'});
  assert.equal(byWrongStatus.length,0);

  const byCapability=buildAgentConnectionMap(db,env,tenantId,{capability:'commerce.orders.read',agentId:'frost'});
  assert.ok(byCapability.some(r=>r.toolSlug==='map_filter_tool'));
 } finally { await cleanup(); }
});

test('Tool Compatibility View: real compatible connections + real per-agent assignment/missing-reason',async()=>{
 const {db,env,admin,tenantId,cleanup}=await harness();
 try{
  const def=createDraftConnector(db,env,admin,{
   slug:'map_compat',nameAr:'x',nameEn:'x',category:'commerce',descriptionAr:'x',descriptionEn:'x',
   adapterType:'GENERIC_REST',connectionMode:'MULTI',auth:{type:'API_KEY',headerName:'X-Key'},
   capabilities:['commerce.orders.read'],rest:{baseUrl:'https://map-compat.test'}
  });
  publishConnector(db,env,admin,def.id);
  insertCustomTool(db,'map_compat_tool','commerce.orders.read');
  const conn=createConnection(db,{integrationDefinitionId:'map_compat',name:'c1'},tenantId);
  updateConnection(db,conn.id,{status:'CONNECTED'},tenantId);

  const view=buildToolCompatibilityView(db,env,tenantId);
  const entry=view.find(v=>v.toolSlug==='map_compat_tool');
  assert.ok(entry);
  assert.equal(entry.compatibleConnections.length,1);
  assert.equal(entry.compatibleConnections[0].id,conn.id);
  // No assignment row exists yet anywhere — resolveToolConnection's own documented contract
  // (Part 12.3 in tool-assignments.js) is "let legacy resolution decide" here, a neutral
  // pass-through, not a blocked/missing state — so this tool legitimately has nothing to
  // report for frost yet, and the view correctly omits it rather than fabricating a reason.
  assert.equal(entry.assignments.find(a=>a.agentId==='frost'),undefined);

  upsertAssignment(db,tenantId,'frost','map_compat_tool',{enabled:true,connectionId:conn.id});
  const view2=buildToolCompatibilityView(db,env,tenantId);
  const frostRow2=view2.find(v=>v.toolSlug==='map_compat_tool').assignments.find(a=>a.agentId==='frost');
  assert.equal(frostRow2.connectionId,conn.id);
 } finally { await cleanup(); }
});
