import {randomBytes} from 'node:crypto';
import {fail} from './auth.js';
import {createTenant, countSelfCreatedWorkspaces} from './tenancy.js';
import {seedTenantAgentConfigs} from './runtime/agent-config.js';

// Multi-Tenant Phase 4C-6 — Self-Service Signup + New Company Creation + Trial Workspace.
// The ONE place a self-service workspace is actually built, on top of the existing, already-
// tested `createTenant()` + `seedTenantAgentConfigs()` (Part 1/76: extend the real foundation,
// never invent a second tenant-creation path). Every step runs inside one real SQL transaction
// (Part 2) — a failure at any point leaves NO partial tenant, no orphan membership, no half-
// seeded agent config.

const RESERVED_SLUGS=new Set(['admin','api','login','signup','settings','control-center','onboarding','account','app','www','support','help','static','assets','public','new-workspace','invite','verify-email','forgot-password','reset-password','overview','audit','users','integrations','agents','knowledge','crm','planning','reports','content','health']);
const SLUG_RE=/^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Platform-level policy — reads directly from env (Part 12: this happens BEFORE any tenant
 * exists, so it can never be a per-tenant feature flag; those only apply once a tenant already
 * exists to hold one). Both default to a real, usable configuration: self-service creation ON,
 * one self-created workspace per user — a conservative starting cap, not a hardcoded final
 * policy (Part 14), overridable per deployment. */
export function selfServicePolicy(env) {
 return {
  allowed: env.ALLOW_SELF_SERVICE_WORKSPACE_CREATION!=='false',
  maxOwnedWorkspaces: Number.isInteger(Number(env.SELF_SERVICE_MAX_OWNED_WORKSPACES)) && Number(env.SELF_SERVICE_MAX_OWNED_WORKSPACES)>0 ? Number(env.SELF_SERVICE_MAX_OWNED_WORKSPACES) : 1,
  trialDays: Number.isInteger(Number(env.TRIAL_DAYS)) && Number(env.TRIAL_DAYS)>0 ? Number(env.TRIAL_DAYS) : 14
 };
}

function slugify(value) {
 return String(value||'').toLowerCase().trim()
  .replace(/[^a-z0-9\s-]/g,'')
  .replace(/\s+/g,'-')
  .replace(/-+/g,'-')
  .replace(/^-+|-+$/g,'')
  .slice(0,60);
}
/**
 * Part 27-29 — an explicit user-chosen slug must be free (409 `WORKSPACE_SLUG_TAKEN` with a
 * `suggestion`, never silently altered); an auto-generated one (from the company name, no
 * explicit slug given) may append a numeric suffix to reach uniqueness, since nobody chose
 * that exact string on purpose. Reserved words (Part 28, matching this app's real hash-route
 * names — a workspace literally named "settings" would otherwise collide with real UI routes)
 * are rejected the same way whether typed explicitly or derived from the company name.
 */
function resolveSlug(db,{companyName,slug}) {
 const explicit=typeof slug==='string' && slug.trim().length>0;
 let base=slugify(explicit?slug:companyName);
 // Arabic is this product's DEFAULT locale (Part 32) — a company named entirely in Arabic (or
 // any other non-ASCII script) produces an empty slug after stripping to `[a-z0-9-]`, which is
 // expected and fine: a real ASCII slug can't represent that name anyway. Only an EXPLICIT
 // slug attempt failing this is a genuine input error; an auto-generated one falls back to a
 // short random identifier instead of hard-failing the entire signup over an Arabic name.
 if((!base||base.length<2) && explicit)fail(400,'صيغة المعرّف غير صحيحة');
 if(!base||base.length<2)base='company-'+randomBytes(3).toString('hex');
 if(explicit && !SLUG_RE.test(base))fail(400,'صيغة المعرّف غير صحيحة — أحرف إنجليزية صغيرة وأرقام وشرطات فقط');
 const takenBy=slug=>db.prepare('SELECT id FROM tenants WHERE slug=?').get(slug);
 if(RESERVED_SLUGS.has(base)) {
  if(explicit)fail(409,'WORKSPACE_SLUG_RESERVED');
  base=base+'-1';
 }
 if(!takenBy(base))return base;
 if(explicit) {
  let suggestion=base,n=2;
  while(takenBy(suggestion) && n<100)suggestion=`${base}-${n++}`;
  const error=new Error('WORKSPACE_SLUG_TAKEN');
  Object.assign(error,{status:409,code:'WORKSPACE_SLUG_TAKEN',suggestion});
  throw error;
 }
 let candidate=base,n=2;
 while(takenBy(candidate)) {
  candidate=`${base}-${n++}`;
  if(n>100)fail(500,'تعذّر توليد معرّف فريد لهذه المنشأة');
 }
 return candidate;
}

/**
 * Part 2 — the one real transaction boundary. Order matches the requested bootstrap exactly:
 * tenant → owner membership (both inside `createTenant`, already atomic with each other) →
 * trial timestamps → the real 12 TenantAgentConfig rows (Part 37, safe defaults: no AI
 * connection, L0 autonomy is simply the absence of any `agent_autonomy` row — nothing to
 * insert there at all). No feature-flag table is written here (Part 39/40's actual mechanism,
 * `runtime/feature-flags.js`, is a deployment-wide env setting, not a per-tenant row — see
 * docs/WORKSPACE_CREATION.md for why a new per-tenant flag table was deliberately not built).
 */
export function bootstrapWorkspaceForOwner(db,env,{companyName,slug,defaultLocale,timezone},ownerUserId) {
 const trimmedName=typeof companyName==='string'?companyName.trim():'';
 if(!trimmedName||trimmedName.length<2||trimmedName.length>100)fail(400,'اسم المنشأة مطلوب (2-100 حرف)');
 const locale=['ar','en'].includes(defaultLocale)?defaultLocale:'ar';
 const tz=typeof timezone==='string' && timezone.trim().length>0 && timezone.length<100?timezone.trim():'Asia/Riyadh';
 const finalSlug=resolveSlug(db,{companyName:trimmedName,slug});
 const policy=selfServicePolicy(env);
 const now=new Date();
 const trialExpiresAt=new Date(now.getTime()+policy.trialDays*86400000).toISOString();
 const nowIso=now.toISOString();

 db.exec('BEGIN IMMEDIATE');
 try {
  const tenantId=createTenant(db,{name:trimmedName,slug:finalSlug,createdByUserId:ownerUserId},ownerUserId);
  db.prepare('UPDATE tenants SET default_locale=?,timezone=?,trial_started_at=?,trial_expires_at=?,updated_at=? WHERE id=?')
   .run(locale,tz,nowIso,trialExpiresAt,nowIso,tenantId);
  seedTenantAgentConfigs(db,tenantId);
  db.exec('COMMIT');
  return {tenantId,slug:finalSlug,trialExpiresAt};
 } catch(error) {
  db.exec('ROLLBACK');
  throw error;
 }
}

/** Part 13/48 — the actual gate `POST /api/workspaces` checks before calling the bootstrap
 * above. Kept as a separate, named check (rather than inlined) so the route handler and tests
 * can both reason about it directly, and so the error codes stay exact and stable. */
export function assertCanSelfCreateWorkspace(db,env,user) {
 const policy=selfServicePolicy(env);
 if(!policy.allowed)fail(403,'إنشاء منشأة ذاتيًا غير متاح حاليًا على هذه المنصة');
 if(!user.emailVerifiedAt) {
  const error=new Error('EMAIL_VERIFICATION_REQUIRED');
  Object.assign(error,{status:403,code:'EMAIL_VERIFICATION_REQUIRED'});
  throw error;
 }
 const owned=countSelfCreatedWorkspaces(db,user.id);
 if(owned>=policy.maxOwnedWorkspaces) {
  const error=new Error('WORKSPACE_LIMIT_REACHED');
  Object.assign(error,{status:403,code:'WORKSPACE_LIMIT_REACHED',limit:policy.maxOwnedWorkspaces});
  throw error;
 }
 return policy;
}
