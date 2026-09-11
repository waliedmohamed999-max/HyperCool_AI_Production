import {createConnection,getDefaultConnection,updateConnection} from './connections.js';
import {storeCredential,removeCredential} from './vault.js';

// Multi-Tenant Phase 4A, Part 40 — the compatibility bridge. `src/runtime/credentials.js`'s
// five functions (saveCredentials/getCredentials/getCredentialsMeta/
// updateCredentialsMetadata/clearCredentials) are UNCHANGED in this phase — every existing
// OAuth module (meta-oauth.js, salla-oauth.js, microsoft-oauth.js, x-oauth.js,
// linkedin-oauth.js) and every existing route/test that calls them keeps working exactly as
// before, with zero risk to the 297 tests that already prove they work. This module is
// called from those same three credentials.js functions as a best-effort SIDE EFFECT: it
// mirrors every legacy write into a real `integration_connections` + vault row, so
// `integration_connections` stays the authoritative, up-to-date source for webhook routing
// and the scheduler's connection jobs (Phase 19/45) without requiring every existing
// provider module to be rewritten in this same pass. A sync failure here NEVER breaks the
// legacy operation that called it — see the try/catch at every call site in credentials.js.
//
// There is no separate 'whatsapp' mirrored connection: WhatsApp's real credential in this
// codebase has always been the same OAuth connection as Meta's (one Business Login grant
// resolves Page + Instagram + WhatsApp assets together — see meta-oauth.js's
// exchangeCodeAndResolveAssets) — mirroring it under a second, duplicate 'whatsapp'
// definition would misrepresent the actual architecture. `whatsapp` capability is read from
// the same mirrored `meta` connection's metadata (`whatsapp.phoneNumberId` etc.), exactly as
// runtime/whatsapp.js already does via getCredentialsMeta(db,'meta').
const NAME_BY_PROVIDER={salla:'سلة',meta:'ميتا',microsoft365:'مايكروسوفت 365',x:'إكس',linkedin:'لينكدإن'};
function externalAccountName(provider,metadata) {
 if(provider==='meta')return metadata?.page?.name||null;
 if(provider==='microsoft365')return metadata?.displayName||metadata?.email||null;
 if(provider==='x')return metadata?.username||metadata?.name||null;
 if(provider==='linkedin')return metadata?.organization?.name||metadata?.profile?.name||null;
 return null;
}
export function syncConnectionFromLegacyCredential(db,env,tenantId,provider,{accessToken,refreshToken,expiresAt,scopes,externalAccountId,extra,metadata},user) {
 if(!(provider in NAME_BY_PROVIDER))return; // an unmapped provider (should not happen — every real legacy provider is listed above) is skipped, never guessed at
 let connection=getDefaultConnection(db,provider,tenantId);
 if(!connection)connection=createConnection(db,{integrationDefinitionId:provider,name:'الاتصال الرئيسي',connectedBy:user?.id||null},tenantId);
 updateConnection(db,connection.id,{
  status:'CONNECTED',externalAccountId:externalAccountId||connection.externalAccountId||null,
  externalAccountType:provider,externalAccountName:externalAccountName(provider,metadata)||connection.externalAccountName||null,
  externalAccountMetadata:metadata||connection.externalAccountMetadata||null,scopes:scopes||connection.scopes||[],
  connectedBy:user?.id||connection.connectedBy||null,connectedAt:connection.connectedAt||new Date().toISOString(),
  lastSuccessAt:new Date().toISOString(),lastErrorAt:null,lastErrorCode:null,lastErrorMessageSafe:null
 },tenantId);
 storeCredential(db,env,{connectionId:connection.id,credentialType:'oauth_tokens',payload:{accessToken,refreshToken:refreshToken||null,expiresAt:expiresAt||null,extra:extra||null}},tenantId);
}
export function markLegacyCredentialDisconnected(db,tenantId,provider) {
 if(!(provider in NAME_BY_PROVIDER))return;
 const connection=getDefaultConnection(db,provider,tenantId);
 if(!connection)return;
 updateConnection(db,connection.id,{status:'DISCONNECTED'},tenantId);
 removeCredential(db,connection.id,tenantId);
}
