// Universal Integration Platform (Phase 6B) — request-side helpers (query/body/path
// construction from `input`) specific to outbound REST calls. Response EXTRACTION now
// delegates to the Phase 6C canonical engine (`../core/mapping.js`'s `applyMapping`) — see that
// file for the full mapping language; `applyResponseMapping` below is kept as this module's own
// export name for backward compatibility with existing Phase 6B call sites (adapter.js).
import {resolveTemplate} from './headers.js';
import {applyMapping} from '../core/mapping.js';

export function buildQueryMapping(queryMapping={},input={}) {
 const params=new URLSearchParams();
 for(const [key,template] of Object.entries(queryMapping)) {
  const value=resolveTemplate(template,input);
  if(value!==undefined && value!==null)params.set(key,String(value));
 }
 return params.toString();
}

export function buildBodyMapping(bodyMapping=null,input={}) {
 if(!bodyMapping)return null;
 const build=node=>{
  if(Array.isArray(node))return node.map(build);
  if(node && typeof node==='object')return Object.fromEntries(Object.entries(node).map(([k,v])=>[k,build(v)]));
  if(typeof node==='string')return resolveTemplate(node,input);
  return node;
 };
 return JSON.stringify(build(bodyMapping));
}

/**
 * Fills a path template like `/orders/{orderId}` from `input` (Part 13) — every substituted
 * segment is percent-encoded, and the result can never introduce a new path separator, query
 * string, or fragment (Part 14 — never a full-URL override, only a path).
 */
export function fillPathTemplate(pathTemplate,input={}) {
 return pathTemplate.replace(/\{([a-zA-Z0-9_]+)\}/g,(_,key)=>{
  const value=input[key];
  if(value===undefined||value===null)throw new Error(`Missing required path variable: ${key}`);
  return encodeURIComponent(String(value));
 });
}

/** Response mapping — thin alias over the canonical engine (see `../core/mapping.js`). */
export function applyResponseMapping(mapping,data) {
 return applyMapping(mapping,data);
}
