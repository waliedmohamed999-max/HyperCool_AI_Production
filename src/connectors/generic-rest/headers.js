// Universal Integration Platform (Phase 6B, Part 16) — dangerous/infrastructure header
// filtering for the Generic REST Connector's declarative headerMapping.
const DANGEROUS_HEADERS=new Set([
 'host','content-length','connection','transfer-encoding','proxy-authorization','proxy-authenticate',
 'forwarded','via','upgrade',
 // Part 16 — Authorization is ALWAYS owned by the connector's own auth strategy (buildAuthHeaders
 // in adapter.js), never by a manifest's declarative headerMapping — even when the real auth
 // strategy happens to use a different header (e.g. API_KEY's own custom header name). A
 // headerMapping entry named Authorization could otherwise inject an attacker-controlled value
 // the real API might honor over/alongside the intended credential.
 'authorization'
]);
function isDangerous(name) {
 const lower=name.toLowerCase();
 return DANGEROUS_HEADERS.has(lower)||lower.startsWith('proxy-')||lower.startsWith('x-forwarded-');
}

/**
 * Builds the real outbound header set: safe custom headers from the manifest's declarative
 * headerMapping, plus the one auth header the connector's auth strategy owns (Part 16's
 * "prevent overriding Authorization unless manifest explicitly uses custom auth behavior") —
 * a custom header named `authorization` is always dropped when an auth strategy supplies its
 * own, never silently overwritten by a lower-priority source.
 */
export function buildSafeHeaders({headerMapping={},input={},authHeaders={}}) {
 const headers={};
 for(const [name,template] of Object.entries(headerMapping)) {
  if(isDangerous(name))continue;
  const lower=name.toLowerCase();
  if(authHeaders[lower]!==undefined)continue; // the auth strategy owns this header
  const value=resolveTemplate(template,input);
  // Header names are normalized to lowercase throughout (matching Node's own response-header
  // convention) so a manifest author's header name and the auth strategy's own header can
  // never silently coexist as two different-cased entries.
  if(value!==undefined && value!==null)headers[lower]=String(value);
 }
 return {...headers,...authHeaders};
}

/** Minimal, safe `$input.foo` template resolution — Part 15/19: declarative only, never eval. */
export function resolveTemplate(template,input) {
 if(typeof template!=='string')return template;
 const match=template.match(/^\$input\.([a-zA-Z0-9_.]+)$/);
 if(!match)return template; // a literal constant string, not a template
 return match[1].split('.').reduce((acc,key)=>acc==null?undefined:acc[key],input);
}
export {isDangerous};
