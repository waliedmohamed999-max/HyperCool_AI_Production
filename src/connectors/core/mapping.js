// Universal Integration Platform (Phase 6C, Part 27/28) — the ONE canonical, declarative
// mapping engine. Generalizes Phase 6B's `generic-rest/mapping.js` response mapper (which now
// delegates here — see that file) so a webhook payload and a REST response are extracted with
// the exact same safe primitives, never two divergent mappers. No eval, no `new Function`, no
// template engine capable of executing code (Part 29/94) — a small, closed set of reviewable
// operations, each one line in a switch-like if-chain.
export class MappingError extends Error {
 constructor(message){super(message);this.code='WEBHOOK_MAPPING_FAILED';}
}

// Part 36 — bounded, so a malicious/huge payload can never turn a declarative mapping into a
// denial-of-service vector.
const MAX_DEPTH=10;
const MAX_FIELDS=300;
const MAX_ARRAY_ITEMS=500;
// Part 37/38 — prototype pollution: these keys are refused everywhere a path segment or an
// output object key is taken from external, less-trusted data (a mapping definition itself is
// platform-authored and trusted; the DATA a mapping reads is not).
const DANGEROUS_KEYS=new Set(['__proto__','prototype','constructor']);

/** Safe nested lookup — never traverses the prototype chain (Object.prototype.hasOwnProperty
 * guards every step) and refuses a dangerous segment outright rather than silently skipping it. */
export function safeLookup(data,path) {
 if(!path)return data;
 let current=data;
 for(const segment of path.split('.')) {
  if(DANGEROUS_KEYS.has(segment))throw new MappingError(`unsafe path segment: ${segment}`);
  if(current===null||current===undefined)return undefined;
  if(typeof current!=='object')return undefined;
  if(!Object.prototype.hasOwnProperty.call(current,segment))return undefined;
  current=current[segment];
 }
 return current;
}

function budgetCheck(depth,budget) {
 if(depth>MAX_DEPTH)throw new MappingError('mapping exceeds max nesting depth');
 budget.fields++;
 if(budget.fields>MAX_FIELDS)throw new MappingError('mapping exceeds max field count');
}

/**
 * Applies one declarative mapping node against `data`. Supported node shapes (Part 29/32-35):
 * a plain string shorthand for {path:"..."}; {const:value}; {path:"a.b"}/{rename:"a.b"};
 * {string|number|boolean|date:<node>} (coerce the resolved sub-mapping); {fallback:[...]}
 * (first non-null/non-undefined among the listed mappings, each mapping's own error is
 * swallowed so a fallback chain can recover from a missing/invalid earlier option);
 * {array:{from:"path",item:<node>}}; {object:{key:<node>,...}}.
 */
export function applyMapping(mapping,data,{depth=0,budget={fields:0}}={}) {
 budgetCheck(depth,budget);
 if(mapping===null||mapping===undefined)return data;
 if(typeof mapping==='string')return safeLookup(data,mapping);
 if(typeof mapping!=='object')return mapping;
 if('const' in mapping)return mapping.const;
 if('path' in mapping)return safeLookup(data,mapping.path);
 if('rename' in mapping)return safeLookup(data,mapping.rename);
 if('string' in mapping){const v=applyMapping(mapping.string,data,{depth:depth+1,budget});return v===undefined||v===null?v:String(v);}
 if('number' in mapping){
  const v=applyMapping(mapping.number,data,{depth:depth+1,budget});
  if(v===undefined||v===null)return v;
  const n=Number(v);
  if(Number.isNaN(n))throw new MappingError('invalid number coercion');
  return n;
 }
 if('boolean' in mapping){const v=applyMapping(mapping.boolean,data,{depth:depth+1,budget});return v===undefined||v===null?v:Boolean(v);}
 if('date' in mapping){
  const v=applyMapping(mapping.date,data,{depth:depth+1,budget});
  if(v===undefined||v===null)return v;
  const d=new Date(v);
  if(Number.isNaN(d.getTime()))throw new MappingError('invalid date value');
  return d.toISOString();
 }
 if('fallback' in mapping){
  for(const option of mapping.fallback){
   let value;
   try{value=applyMapping(option,data,{depth:depth+1,budget});}catch{value=undefined;}
   if(value!==undefined && value!==null)return value;
  }
  return null;
 }
 if('array' in mapping){
  const source=safeLookup(data,mapping.array.from);
  if(!Array.isArray(source))return [];
  if(source.length>MAX_ARRAY_ITEMS)throw new MappingError('array exceeds max item count');
  // array.item is always a shape map (output key -> sub-mapping), same as `object` below —
  // never a single scalar mapping — matching the Phase 6B manifest authoring convention.
  return source.map(item=>applyObjectShape(mapping.array.item,item,depth+1,budget));
 }
 if('object' in mapping)return applyObjectShape(mapping.object,data,depth+1,budget);
 throw new MappingError('unrecognized mapping node shape');
}
function applyObjectShape(shape,data,depth,budget) {
 return Object.fromEntries(Object.entries(shape).map(([key,sub])=>{
  if(DANGEROUS_KEYS.has(key))throw new MappingError(`unsafe output key: ${key}`);
  return [key,applyMapping(sub,data,{depth,budget})];
 }));
}
