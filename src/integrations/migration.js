import {getCredentials} from '../runtime/credentials.js';
import {syncConnectionFromLegacyCredential} from './legacy-sync.js';
import {encryptionConfigured} from '../runtime/crypto.js';

// Multi-Tenant Phase 4A, Part 7/77/78 — one-time, idempotent copy of every EXISTING
// `integration_credentials` row into a real `integration_connections` + vault row, run once
// at boot. This is a COPY, not a move (Part 39: `integration_credentials` is never dropped
// or altered) — every existing OAuth module keeps reading/writing it exactly as before (see
// docs/INTEGRATION_CONNECTION_ARCHITECTURE.md's compatibility-bridge note); this function
// just makes sure a credential that was already connected BEFORE this phase shipped shows
// up in the new model immediately, rather than waiting for its next organic token refresh
// (which is what keeps it in sync going forward — see legacy-sync.js).
//
// Guarded by nothing re-runnable-unsafe: `syncConnectionFromLegacyCredential` is itself an
// idempotent upsert (same connection_id reused on every call for a given tenant+provider),
// so calling this at every boot is always safe and never duplicates a row.
export function migrateLegacyIntegrationCredentials(db,env) {
 if(!encryptionConfigured(env))return {migrated:0,skipped:'NO_ENCRYPTION_KEY'};
 let rows=[];
 try{rows=db.prepare('SELECT tenant_id AS tenantId,provider FROM integration_credentials').all();}
 catch{return {migrated:0,skipped:'NO_LEGACY_TABLE'};}
 let migrated=0,errors=0;
 for(const {tenantId,provider} of rows) {
  try {
   const full=getCredentials(db,env,provider,tenantId);
   if(!full)continue;
   syncConnectionFromLegacyCredential(db,env,tenantId,provider,full,null);
   migrated++;
  } catch { errors++; } // a single row's decrypt/sync failure never stops the rest (Phase 76-style isolation)
 }
 return {migrated,errors,skipped:null};
}
