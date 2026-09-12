// Universal Integration Platform (Phase 6D, Part 35/59) — generic, capability-based connection
// discovery for a Tool that declares NO fixed `integrationSlug` (unlike every pre-6D tool,
// which is still pinned to one real provider slug and completely unaffected by this file).
// This is the real mechanism behind "a Tool needing accounting.invoices.read discovers ANY
// compatible connection automatically" — with zero per-connector branch anywhere here.
import {listConnections} from '../../integrations/connections.js';
import {resolveConnectorDynamic} from './registry.js';

const DEGRADED_OK_STATUSES=new Set(['CONNECTED','DEGRADED']);

/** Every one of this tenant's healthy connections whose connector manifest actually declares
 * `capability` — regardless of provider/adapter type. Never guesses; the caller decides what
 * to do with zero/one/many results (mirroring `resolveProviderAccount`'s own contract). */
export function listCompatibleConnections(db,tenantId,capability) {
 const connections=listConnections(db,{},tenantId).filter(c=>DEGRADED_OK_STATUSES.has(c.status));
 const matches=[];
 for(const connection of connections) {
  const entry=resolveConnectorDynamic(db,connection.integrationDefinitionId);
  if(entry?.manifest?.capabilities?.includes(capability))matches.push(connection);
 }
 return matches;
}
