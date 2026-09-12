// Universal Integration Platform (Phase 6D, Part 112/113) — resolves a REAL {manifest, adapter}
// pair for ANY connector slug, built-in or dynamic, from the ONE canonical `integration_definitions`
// row. Never a DB-controlled module path/require() (Part 21/112) — BUILT_IN/AI_PROVIDER always
// delegate to the existing, static, code-defined registry (src/connectors/registry.js,
// unchanged since Phase 6A); only a real GENERIC_REST definition is ever hydrated from DB rows.
import {getIntegrationDefinition} from '../../integrations/definitions.js';
import {hydrateAndValidate} from './hydrate.js';
import {getVersionSnapshot} from './store.js';
import {genericRestAdapter} from '../generic-rest/adapter.js';
import {getConnector as getStaticConnector} from '../registry.js';

/**
 * `connectorVersion`, when given (Part 45/108/109 — version policy A, "connections pin
 * published version"), resolves the FROZEN snapshot from that exact publish rather than the
 * live current definition — so an existing connection keeps behaving exactly as it did when
 * created, even after a later draft/publish changes the definition's actions.
 */
export function resolveConnectorDynamic(db,slug,{connectorVersion=null}={}) {
 const definition=getIntegrationDefinition(db,slug);
 if(!definition)return null;
 if(definition.adapterType==='BUILT_IN'||definition.adapterType==='AI_PROVIDER') {
  // The DB row exists for catalog/marketplace listing only (Part 111) — the real manifest and
  // adapter for a built-in provider are still the code-defined ones from Phase 6A, unchanged.
  return getStaticConnector(definition.adapterKey);
 }
 if(definition.adapterType==='GENERIC_REST') {
  if(definition.status==='DISABLED')return null; // Part 41/93 — no new execution once disabled
  let manifest=connectorVersion!=null?getVersionSnapshot(db,definition.id,connectorVersion):null;
  if(!manifest) {
   if(definition.status!=='PUBLISHED')return null; // a DRAFT never executes for a real connection
   manifest=hydrateAndValidate(db,slug).manifest;
  }
  return {manifest,adapter:genericRestAdapter};
 }
 return null;
}
