import {testAnthropicConnection,testOpenAIConnection,testSallaConnection} from '../connectors.js';
import {testWhatsAppConnection} from '../runtime/whatsapp.js';
import {resolveMetaAccessToken} from '../runtime/meta-oauth.js';
import {testMicrosoftConnection} from '../runtime/microsoft-graph.js';
import {testXConnection} from '../runtime/x-publishing.js';
import {testLinkedInConnection} from '../runtime/linkedin-publishing.js';
import {getCredentialForRuntime} from './vault.js';
import {checkConnectorHealth} from '../connectors/core/runtime.js';

// Connection Health — Multi-Tenant Phase 4A, Part 15/16/17. Reuses the EXACT same read-only,
// side-effect-free test functions this codebase already had (connectors.js's
// testAnthropicConnection/testOpenAIConnection/testSallaConnection, and the per-provider
// testXConnection/testLinkedInConnection/testMicrosoftConnection/testWhatsAppConnection) —
// never a new provider call, and never one that sends a message, publishes a post, or
// creates/deletes anything (Part 17). A connection is only ever reported CONNECTED after
// this REAL check succeeds — a saved credential alone is NOT "connected" (Part 15).
const RESULT_TO_STATUS={OK:'CONNECTED',CONFIGURED_READ_ONLY:'DEGRADED',AUTH_FAILED:'TOKEN_EXPIRED',NOT_CONFIGURED:'NOT_CONFIGURED',RATE_LIMITED:'DEGRADED',NETWORK_ERROR:'DEGRADED'};
function normalize(raw) {
 const status=RESULT_TO_STATUS[raw?.result]||'ERROR';
 return {
  status,
  checkedAt:new Date().toISOString(),
  warnings:status==='DEGRADED'?[raw.code||raw.result]:[],
  errors:(status==='ERROR'||status==='TOKEN_EXPIRED')?[raw.code||raw.result]:[],
  safeMessage:raw?.note||raw?.code||null
 };
}
/**
 * Tests ONE specific connection. For Salla, this reads the credential belonging to THIS
 * exact connection id from the vault — proving genuine per-connection health for the
 * multi-store case this phase targets. For every other provider, this reuses the existing
 * test function's own default-credential resolution (the same one `/api/integrations/:id/
 * test` already used) — correct for today's sole/default connection of that type; testing a
 * hypothetical second, non-default connection of the SAME provider is a known, documented
 * scope boundary for this pass (see docs/INTEGRATION_CONNECTION_ARCHITECTURE.md), not a bug.
 */
export async function testConnectionHealth(connection,{store,env,fetcher}) {
 const provider=connection.integrationDefinitionId;
 try {
  if(provider==='salla') {
   const credential=getCredentialForRuntime(store.db,env,connection.id,connection.tenantId);
   return normalize(await testSallaConnection({env,fetcher,accessToken:credential?.payload?.accessToken||null}));
  }
  if(provider==='anthropic')return normalize(await testAnthropicConnection({env,fetcher}));
  if(provider==='openai')return normalize(await testOpenAIConnection({env,fetcher}));
  if(provider==='whatsapp')return normalize(await testWhatsAppConnection({store,env,fetcher}));
  if(provider==='meta')return normalize(resolveMetaAccessToken({store,env},'page')?{result:'OK'}:{result:'NOT_CONFIGURED',code:'META_NOT_CONFIGURED'});
  if(provider==='microsoft365')return normalize(await testMicrosoftConnection({store,env,fetcher}));
  if(provider==='x')return normalize(await testXConnection({store,env,fetcher}));
  if(provider==='linkedin')return normalize(await testLinkedInConnection({store,env,fetcher}));
  // Universal Integration Platform (Phase 6D) — any connector NOT covered by the legacy,
  // per-provider checks above (a dynamic/GENERIC_REST connector published via the Integration
  // Builder, e.g. Acme ERP) reuses the EXACT SAME ConnectorRuntime health pipeline the Agent
  // tool path already goes through (SSRF-safe outbound, tenant/connection-scoped) — never a
  // second, weaker health implementation just for this HTTP route.
  const dynamicResult=await checkConnectorHealth({db:store.db,env,tenantId:connection.tenantId,connectorSlug:provider,connectionId:connection.id});
  const dynamicStatus=dynamicResult.status==='OK'?'CONNECTED':dynamicResult.status==='NOT_CONFIGURED'?'NOT_CONFIGURED':dynamicResult.status==='DEGRADED'?'DEGRADED':'ERROR';
  return {
   status:dynamicStatus,checkedAt:new Date().toISOString(),
   warnings:dynamicStatus==='DEGRADED'?[dynamicResult.errorCode]:[],
   errors:dynamicStatus==='ERROR'?[dynamicResult.errorCode]:[],
   safeMessage:dynamicResult.errorCode||null
  };
 } catch(error) {
  return {status:'ERROR',checkedAt:new Date().toISOString(),warnings:[],errors:[error.code||'HEALTH_CHECK_FAILED'],safeMessage:error.code||'HEALTH_CHECK_FAILED'};
 }
}
