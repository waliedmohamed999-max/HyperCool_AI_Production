// Universal Integration Platform (Phase 6B, Part 2/72) — the minimal extension point over
// Phase 6A's `validateManifest`. This module adds ONLY the REST-specific fields a Generic REST
// connector needs (base URL policy, per-action HTTP method/path/mapping) — it never
// reimplements 6A's own category/availability/connectionMode/auth/capability/risk validation,
// it delegates to it and layers REST config on top by array index (6A's validateAction returns
// a NEW object per action in the same order, so re-attaching by index is safe and simple —
// no change to src/connectors/core/manifest.js was needed).
import {validateManifest} from '../core/manifest.js';
import {AUTH_TYPE,RISK_LEVEL,ACTION_TYPE} from '../core/enums.js';
import {isKnownCapability} from '../core/capability-registry.js';

const ALLOWED_METHODS=new Set(['GET','POST','PUT','PATCH','DELETE','HEAD']);
// Phase 6G, Part 18 — OAUTH2 joined this set once the Generic OAuth2 Framework
// (src/runtime/generic-oauth2.js) existed to actually drive it; core `validateManifest` itself
// already requires `auth.authorizeUrl`/`auth.tokenUrl` to be real https:// URLs for this type.
const REST_AUTH_TYPES=new Set([AUTH_TYPE.NONE,AUTH_TYPE.API_KEY,AUTH_TYPE.BEARER_TOKEN,AUTH_TYPE.BASIC,AUTH_TYPE.OAUTH2]);

function fail(message){const e=new Error(message);e.status=400;throw e;}

// Part 12 — a write-shaped HTTP method NEVER silently defaults to LOW risk.
const METHOD_DEFAULTS={
 GET:{actionType:ACTION_TYPE.READ,riskLevel:RISK_LEVEL.LOW},
 HEAD:{actionType:ACTION_TYPE.READ,riskLevel:RISK_LEVEL.LOW},
 POST:{actionType:ACTION_TYPE.EXTERNAL_WRITE,riskLevel:RISK_LEVEL.MEDIUM},
 PUT:{actionType:ACTION_TYPE.EXTERNAL_WRITE,riskLevel:RISK_LEVEL.HIGH},
 PATCH:{actionType:ACTION_TYPE.EXTERNAL_WRITE,riskLevel:RISK_LEVEL.HIGH},
 DELETE:{actionType:ACTION_TYPE.DESTRUCTIVE,riskLevel:RISK_LEVEL.HIGH}
};

export function validateRestManifest(raw) {
 if(!REST_AUTH_TYPES.has(raw.auth?.type))fail(`Generic REST connector ${raw.slug}: auth.type must be one of NONE/API_KEY/BEARER_TOKEN/BASIC/OAUTH2 (got ${raw.auth?.type})`);
 // Part 9 — NONE is only real when the definition explicitly says so; never inferred from an
 // absent credential at connection time (that is checked separately, at execution time).
 if(raw.auth.type===AUTH_TYPE.NONE && raw.auth.allowNone!==true)fail(`Generic REST connector ${raw.slug}: auth.type NONE requires an explicit auth.allowNone:true`);
 const rest=raw.rest||{};
 if(typeof rest.baseUrl!=='string'||!rest.baseUrl.startsWith('https://'))
  if(!(rest.baseUrl?.startsWith('http://')&&rest.allowHttp===true))
   fail(`Generic REST connector ${raw.slug}: rest.baseUrl must be a real https:// URL (http:// only with explicit rest.allowHttp:true)`);
 if(rest.tenantConfigurableHost && rest.allowedHosts?.length)
  fail(`Generic REST connector ${raw.slug}: rest.tenantConfigurableHost and rest.allowedHosts are mutually exclusive (Part 32/33)`);

 const rawActions=raw.actions||[];
 const preprocessed=rawActions.map(action=>{
  const method=(action.rest?.httpMethod||'').toUpperCase();
  if(!ALLOWED_METHODS.has(method))fail(`Generic REST connector ${raw.slug}: action ${action.slug} has an unsupported httpMethod (${action.rest?.httpMethod})`);
  const defaults=METHOD_DEFAULTS[method];
  return {...action,method,actionType:action.actionType||defaults.actionType,riskLevel:action.riskLevel||defaults.riskLevel};
 });
 const manifest=validateManifest({...raw,actions:preprocessed});
 // Part 53 — unlike 6A's base validateManifest (trusted, platform-authored built-in adapters),
 // a Generic REST connector definition can NEVER declare a capability outside the canonical
 // registry — this is exactly what stops a tenant/Builder-authored definition from inventing
 // `system.admin`/`security.write`/`permissions.manage` or any other unrecognized string.
 for(const capability of manifest.capabilities)
  if(!isKnownCapability(capability))fail(`Generic REST connector ${raw.slug}: capability "${capability}" is not in the canonical Capability Registry — unknown/invented capabilities are rejected`);

 const restActions=manifest.actions.map((action,i)=>{
  const src=rawActions[i].rest||{};
  if(!src.pathTemplate||typeof src.pathTemplate!=='string'||!src.pathTemplate.startsWith('/'))
   fail(`Generic REST connector ${raw.slug}: action ${action.slug} needs a real rest.pathTemplate starting with "/"`);
  // Part 14 — never a full-URL override; a path template can never smuggle a scheme/host.
  if(/^[a-z]+:\/\//i.test(src.pathTemplate)||src.pathTemplate.includes('//'))
   fail(`Generic REST connector ${raw.slug}: action ${action.slug}'s pathTemplate must be a path only, never a full URL`);
  return {
   ...action,
   rest:{
    httpMethod:preprocessed[i].method,
    pathTemplate:src.pathTemplate,
    queryMapping:src.queryMapping||{},
    headerMapping:src.headerMapping||{},
    bodyMapping:src.bodyMapping||null,
    responseMapping:src.responseMapping||null,
    maxResponseBytes:Math.min(src.maxResponseBytes||2*1024*1024,5*1024*1024), // Part 36 platform ceiling
    maxRequestBytes:Math.min(src.maxRequestBytes||256*1024,1024*1024) // Part 37
   }
  };
 });

 return {
  ...manifest,
  actions:restActions,
  rest:{
   baseUrl:rest.baseUrl,allowHttp:rest.allowHttp===true,
   allowedHosts:rest.allowedHosts||[new URL(rest.baseUrl).hostname],
   tenantConfigurableHost:rest.tenantConfigurableHost===true,
   health:rest.health||null
  }
 };
}
