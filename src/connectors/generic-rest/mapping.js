// Universal Integration Platform (Phase 6B, Part 18/19) — the minimal declarative mapping
// engine a REST action needs. Deliberately NOT the full Phase 6C Data Mapping Engine (no
// arrays-of-transforms, no cross-provider event normalization) — just enough to build a query
// string / request body from `input`, and to extract a normalized result from a real response.
// NO eval, NO `new Function`, NO template engine capable of executing code (Part 19) — every
// operation here is a plain, enumerable, reviewable case in a switch statement.
import {resolveTemplate} from './headers.js';

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

/**
 * Response mapping (Part 18) — one declarative node type per real, safe primitive:
 * {path:"a.b.c"}          -> nested lookup on the parsed JSON response
 * {const:value}           -> a literal constant
 * {rename:"a.b", as:...}  -> same as path (kept for manifest authors' clarity)
 * {string:node}/{number:node}/{boolean:node} -> coerce a resolved sub-mapping
 * {array:node}            -> maps `node` over each element of an array found by an inner path
 * {fallback:[a,b,...]}    -> first non-null/non-undefined result among the listed mappings
 * A plain string shorthand is treated as {path:"..."}.
 */
export function applyResponseMapping(mapping,data) {
 if(mapping===null||mapping===undefined)return data;
 if(typeof mapping==='string')return lookupPath(data,mapping);
 if(typeof mapping!=='object')return mapping;
 if('const' in mapping)return mapping.const;
 if('path' in mapping)return lookupPath(data,mapping.path);
 if('rename' in mapping)return lookupPath(data,mapping.rename);
 if('string' in mapping){const v=applyResponseMapping(mapping.string,data);return v===undefined||v===null?v:String(v);}
 if('number' in mapping){const v=applyResponseMapping(mapping.number,data);return v===undefined||v===null?v:Number(v);}
 if('boolean' in mapping){const v=applyResponseMapping(mapping.boolean,data);return v===undefined||v===null?v:Boolean(v);}
 if('fallback' in mapping){for(const option of mapping.fallback){const v=applyResponseMapping(option,data);if(v!==undefined&&v!==null)return v;}return null;}
 if('array' in mapping){
  const source=lookupPath(data,mapping.array.from);
  if(!Array.isArray(source))return [];
  return source.map(item=>applyMappingObject(mapping.array.item,item));
 }
 if('object' in mapping)return applyMappingObject(mapping.object,data);
 return null;
}
function applyMappingObject(shape,data) {
 return Object.fromEntries(Object.entries(shape).map(([key,sub])=>[key,applyResponseMapping(sub,data)]));
}
function lookupPath(data,path) {
 if(!path)return data;
 return path.split('.').reduce((acc,key)=>acc==null?undefined:acc[key],data);
}
