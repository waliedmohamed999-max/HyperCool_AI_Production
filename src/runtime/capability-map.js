// Multi-Tenant Phase 4B.1 — Connection Capability Enforcement.
//
// Closes a real gap left open by Phase 4B: `ToolDefinition.capability` (src/runtime/tools.js)
// and `IntegrationDefinition.capabilities` (src/integrations/definitions.js) were both real,
// but nothing ever cross-checked one against the other, or against what a specific
// CONNECTION actually has permission to do. `resolveToolConnection` (tool-assignments.js)
// validated provider match and connection health only — a tool could resolve a connection
// whose real OAuth grant never included the scope it needs, and only discover that from a
// live 403 at the provider.
//
// This module is intentionally the ONLY place that maps a real OAuth scope string to a
// ToolDefinition capability — one small, auditable table, not a second capability-naming
// scheme. It deliberately does NOT rename `TOOL_METADATA.capability` or
// `IntegrationDefinition.capabilities` (a Phase 4B.1 "hardening" pass is not the place for
// a second, disconnected audit of every existing capability string across the codebase);
// it keys directly off the exact strings already in use.
//
// Real OAuth scopes are the only source of truth used here (Part 6/7: "supported by the
// provider" is never treated as "granted to this connection"). Never cached — every check
// reads `connection.scopes` live, so a token refresh, reconnect, or scope reduction is
// reflected on the very next check with no invalidation logic needed (Part 8/9/10).
const CAPABILITY_SCOPES = {
 // Salla's `products.read` scope returns price and stock as fields of the same product
 // resource (see src/connectors.js normalizeSallaProduct — one GET /admin/v2/products call)
 // — there is no separate Salla scope for price or stock, so all three tool capabilities are
 // satisfied by the one real scope actually requested (salla-oauth.js DEFAULT_SCOPES).
 salla:{'commerce.products.read':['products.read'],'commerce.price.read':['products.read'],'commerce.stock.read':['products.read'],'orders.read':['orders.read']},
 whatsapp:{'messaging.send':['whatsapp_business_messaging']},
 // meta-oauth.js's DEFAULT_SCOPES requests instagram_content_publish and
 // pages_manage_metadata but never pages_manage_posts — Meta's own docs list
 // pages_manage_posts as the real requirement for a Facebook Page /feed post. That is a
 // pre-existing scope-request gap, not something this hardening pass invents or hides — see
 // the provider matrix in docs/CONNECTION_AWARE_RUNTIME.md's "Known Limitations" column.
 // 'publishing' is satisfied by any scope this app actually requests today.
 meta:{'publishing':['instagram_content_publish','pages_manage_metadata']},
 x:{'publish':['tweet.write']},
 linkedin:{'organization.publish':['w_organization_social','rw_organization_admin']},
 microsoft365:{'mail.send':['Mail.Send'],'calendar.read':['Calendars.Read','Calendars.ReadWrite'],'calendar.write':['Calendars.ReadWrite']}
};

/**
 * true when `capability` is either not scope-gated for this provider (no entry — an
 * internal/AI capability like crm.read/memory.read, or a provider this table doesn't model
 * at all — resolveToolConnection's existing provider/health checks are the only gate for
 * those, unchanged), OR the connection has no recorded scopes at all (a legacy/manually-
 * seeded connection this app has no real grant data for — never invented as "missing" any
 * more than it would be invented as "present"; see module doc comment), OR at least one of
 * the scopes that grant it is actually present on the connection.
 */
export function connectionGrantsCapability(provider,capability,scopes) {
 if(!capability)return true;
 const required=CAPABILITY_SCOPES[provider]?.[capability];
 if(!required)return true;
 if(!scopes||scopes.length===0)return true;
 return required.some(scope=>scopes.includes(scope));
}
export function requiredScopesFor(provider,capability) {
 return CAPABILITY_SCOPES[provider]?.[capability]||null;
}
