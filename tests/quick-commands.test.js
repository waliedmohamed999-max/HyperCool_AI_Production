import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installCRM,createLead} from '../src/crm.js';
import {installIntegrationDefinitions} from '../src/integrations/definitions.js';
import {installIntegrationConnections,createConnection,updateConnection} from '../src/integrations/connections.js';
import {installAuditLog} from '../src/audit.js';
import {deriveQuickCommandKeys} from '../src/runtime/command-health.js';

const user={id:'u',name:'Owner',role:'owner'};
function fixture(){const store=openStore(':memory:');installCRM(store.db);installIntegrationDefinitions(store.db);installIntegrationConnections(store.db);installAuditLog(store.db);return store;}

test('a tenant with a connected e-commerce integration gets commerce-oriented quick commands',()=>{
 const store=fixture();
 try{
  const conn=createConnection(store.db,{integrationDefinitionId:'salla',name:'Salla'},'t1');
  updateConnection(store.db,conn.id,{status:'CONNECTED'},'t1');
  const keys=deriveQuickCommandKeys({db:store.db},'t1');
  assert.deepEqual(keys,['reviewSales','reviewOrders','topCustomers','campaignPerformance','checkIntegrations']);
 }finally{store.close();}
});

test('a tenant whose leads are mostly B2B gets pipeline-oriented quick commands',()=>{
 const store=fixture();
 try{
  const b2b=input=>createLead(store,{name:'x',customerType:'B2B',sourceType:'INBOUND',company:'شركة',...input},user,'t1');
  for(let i=0;i<3;i++)b2b({phone:`+96650000000${i}`});
  const keys=deriveQuickCommandKeys(store,'t1');
  assert.deepEqual(keys,['reviewPipeline','lateLeads','teamWorkload','reviewApprovals','checkIntegrations']);
 }finally{store.close();}
});

test('a tenant with no strong signal yet gets the generic executive quick commands',()=>{
 const store=fixture();
 try{
  const keys=deriveQuickCommandKeys({db:store.db},'t1');
  assert.deepEqual(keys,['executiveReview','findRisks','findOpportunities','checkTasks','checkIntegrations']);
 }finally{store.close();}
});
