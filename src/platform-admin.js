import {randomUUID} from 'node:crypto';
import {fail} from './auth.js';
import {getTenant,listActiveMembers,getTrialStatus,tenantOperationalBlockReason} from './tenancy.js';
import {recordPlatformAudit} from './platform-identity.js';
import {buildControlCenterSummary} from './runtime/control-center.js';
import {listAuditLog} from './audit.js';
import {getOnboardingState} from './onboarding.js';

// Multi-Tenant Phase 4C-7 — a minimal Platform Admin foundation, NOT a Super Admin SaaS
// product (Part 19: "لا تبن Super Admin SaaS ضخمة"). Every read here is real and live-derived
// (reuses `buildControlCenterSummary`/`getOnboardingState` — the exact same aggregation the
// tenant's own Control Center already uses — never a second, parallel computation that could
// drift from it) and every write is a minimal, confirmed, audited action: suspend, reactivate,
// extend trial. No delete, ever (Part 24).

/**
 * Part 20 — deliberately NOT "a tenant owner is automatically a platform admin" (a workspace
 * owner has authority over their OWN company only, never every other tenant on the platform).
 * A minimal, explicit, env-configured allowlist of real usernames — no new role/table, since a
 * pilot's platform-admin population is tiny and this is exactly the "env-configured platform
 * admin username" the phase itself suggested. Documented as a deliberate, reviewable decision
 * in docs/PLATFORM_OPERATIONS.md, not a hidden shortcut.
 */
export function isPlatformAdmin(env,user) {
 if(!user)return false;
 const allowlist=String(env.PLATFORM_ADMIN_USERNAMES||'').split(',').map(u=>u.trim().toLowerCase()).filter(Boolean);
 return allowlist.includes(String(user.username||'').toLowerCase());
}
export function requirePlatformAdmin(env,session) {
 if(!session)fail(401,'سجل الدخول أولًا');
 if(!isPlatformAdmin(env,session.user))fail(403,'هذا الإجراء متاح فقط لمسؤول المنصة');
}

const HEALTHY=new Set(['CONNECTED','DEGRADED']);
/** Part 21 — every number here is real, derived live from the actual tables; nothing is a
 * fabricated/rounded metric. Cheap at pilot scale (1-3 tenants) since it iterates the real
 * (tiny) tenant list once — documented in docs/PLATFORM_OPERATIONS.md as an N+1-shaped query
 * that would need revisiting well before this platform ever has dozens of tenants. */
export function buildPlatformOverview(db,env) {
 const tenants=db.prepare('SELECT * FROM tenants ORDER BY created_at').all();
 const counts={total:tenants.length,ACTIVE:0,TRIAL:0,SUSPENDED:0,ARCHIVED:0,expiredTrials:0};
 let connectionsNeedingAttention=0,healthyConnections=0,agentsFailing=0;
 for(const row of tenants) {
  counts[row.status]=(counts[row.status]||0)+1;
  const tenant=getTenant(db,row.id);
  if(getTrialStatus(tenant).status==='EXPIRED')counts.expiredTrials++;
  try {
   const summary=buildControlCenterSummary(db,env,row.id,'owner');
   connectionsNeedingAttention+=summary.integrations.unhealthyConnections;
   healthyConnections+=summary.integrations.healthyConnections;
   agentsFailing+=summary.agents.blocked;
  } catch { /* a genuinely broken tenant row must never take the whole overview down */ }
 }
 const users=db.prepare('SELECT COUNT(*) n FROM users').get().n;
 const verifiedUsers=db.prepare('SELECT COUNT(*) n FROM users WHERE email_verified_at IS NOT NULL').get().n;
 const recentCritical=db.prepare("SELECT COUNT(*) n FROM platform_audit_log WHERE action LIKE '%FAILED%' AND at>=?").get(new Date(Date.now()-86400000).toISOString()).n;
 // Phase 6F, Part 2 — real, platform-wide (cross-tenant) webhook failure count for the
 // Integration Platform dashboard card; reuses the EXISTING webhook_events ledger's own
 // `status` column (Phase 4C-C's real idempotency ledger) — never a second failure tracker.
 // Phase 6H, Part 13-18 — also counts DEAD_LETTER (retries exhausted, genuinely needs a human)
 // alongside plain FAILED; RETRY_SCHEDULED is deliberately excluded — it is already being
 // handled automatically and is not yet something an operator needs to act on.
 const failedWebhooksRow=db.prepare("SELECT COUNT(*) n FROM webhook_events WHERE status IN ('FAILED','DEAD_LETTER')").get();
 return {tenants:counts,users:{total:users,verified:verifiedUsers},connectionsNeedingAttention,healthyConnections,agentsFailing,recentCriticalErrors:recentCritical,failedWebhooks:failedWebhooksRow.n};
}

/** Part 22 — the directory. One row per tenant, safe fields only. */
export function listTenantDirectory(db,env) {
 const rows=db.prepare('SELECT * FROM tenants ORDER BY created_at DESC').all();
 return rows.map(row=>{
  const tenant=getTenant(db,row.id);
  const owner=db.prepare("SELECT u.name,u.username FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=? AND tm.role='owner' AND tm.status='active' ORDER BY tm.created_at LIMIT 1").get(row.id);
  let onboarding='UNKNOWN',agentsReady=0,agentsTotal=0,healthyConnections=0,unhealthyConnections=0;
  try {
   onboarding=getOnboardingState(db,env,row.id).status;
   const summary=buildControlCenterSummary(db,env,row.id,'owner');
   agentsReady=summary.agents.ready;agentsTotal=summary.agents.total;
   healthyConnections=summary.integrations.healthyConnections;unhealthyConnections=summary.integrations.unhealthyConnections;
  } catch { /* keep the directory row visible even if this one tenant's aggregation errors */ }
  const lastActivity=db.prepare('SELECT created_at FROM audit_logs WHERE tenant_id=? ORDER BY created_at DESC LIMIT 1').get(row.id)?.created_at||row.updated_at;
  return {
   id:row.id,name:row.name,slug:row.slug,status:row.status,trial:getTrialStatus(tenant),
   owner:owner||null,createdAt:row.created_at,lastActivity,onboarding,
   agents:{ready:agentsReady,total:agentsTotal},
   connections:{healthy:healthyConnections,unhealthy:unhealthyConnections},
   pilotStatus:pilotStatusFor({onboarding,agentsReady,unhealthyConnections,tenantStatus:row.status})
  };
 });
}
/** Part 34 — a real, derived READY/NEEDS_ATTENTION/BLOCKED classification per tenant, never a
 * stored flag: BLOCKED for a non-operational tenant, NEEDS_ATTENTION while onboarding isn't
 * finished or a connection is unhealthy, READY only once onboarding is complete, at least one
 * agent is ready, and no connection needs attention. */
function pilotStatusFor({onboarding,agentsReady,unhealthyConnections,tenantStatus}) {
 if(tenantStatus==='SUSPENDED'||tenantStatus==='ARCHIVED')return 'BLOCKED';
 if(onboarding!=='COMPLETED'||unhealthyConnections>0)return 'NEEDS_ATTENTION';
 if(agentsReady===0)return 'NEEDS_ATTENTION';
 return 'READY';
}

/** Part 23 — read-only tenant detail. Never exposes a secret/credential/vault payload — reuses
 * the same Control Center summary that already guarantees that (verified by its own tests). */
export function getTenantDetail(db,env,tenantId) {
 const tenant=getTenant(db,tenantId);
 if(!tenant)fail(404,'المنشأة غير موجودة');
 const summary=buildControlCenterSummary(db,env,tenantId,'owner');
 const members=listActiveMembers(db,tenantId);
 const recentAudit=listAuditLog(db,{tenantId,limit:20});
 let onboarding=null;
 try{onboarding=getOnboardingState(db,env,tenantId);}catch{/* leave null if not derivable */}
 return {
  tenant:{id:tenant.id,name:tenant.name,slug:tenant.slug,status:tenant.status,locale:tenant.defaultLocale,timezone:tenant.timezone,createdAt:tenant.createdAt},
  trial:getTrialStatus(tenant),
  members:members.map(m=>({id:m.id,name:m.name,username:m.username,role:m.role,status:m.status,isOwner:!!m.isOwner})),
  integrations:summary.integrations,
  agents:summary.agents,
  onboarding,
  recentAudit
 };
}

/** Part 24/26 — an immediate block: the existing tenant-membership resolution already
 * excludes any non-ACTIVE/TRIAL tenant entirely (`tenancy.js`'s `VALID_MEMBERSHIP_JOIN`), so
 * every member of a just-suspended tenant loses access on their very next request — no
 * separate invalidation mechanism needed, matching Phase 4C-3's own already-tested behavior
 * for owner-driven suspension. */
export function suspendTenantByPlatform(db,tenantId,actor,reason) {
 const tenant=getTenant(db,tenantId);
 if(!tenant)fail(404,'المنشأة غير موجودة');
 const now=new Date().toISOString();
 db.prepare("UPDATE tenants SET status='SUSPENDED',updated_at=? WHERE id=?").run(now,tenantId);
 recordPlatformAudit(db,{id:randomUUID(),action:'PLATFORM_TENANT_SUSPENDED',itemId:tenantId,actorId:actor.id,actorName:actor.name,at:now});
 return getTenant(db,tenantId);
}
/** Part 27 — reactivation is a genuine platform override: it lifts the SUSPENDED status
 * outright by moving the tenant to `ACTIVE` (never silently back to `TRIAL` with a
 * still-past `trial_expires_at`, which the real, timestamp-based `tenantOperationalBlockReason`
 * would just re-block on the very next check). Extending the trial instead is a separate,
 * explicit action (`extendTrialByPlatform`) for when that is genuinely what's wanted. No data
 * is touched either way. */
export function reactivateTenantByPlatform(db,tenantId,actor) {
 const tenant=getTenant(db,tenantId);
 if(!tenant)fail(404,'المنشأة غير موجودة');
 const now=new Date().toISOString();
 db.prepare("UPDATE tenants SET status='ACTIVE',updated_at=? WHERE id=?").run(now,tenantId);
 recordPlatformAudit(db,{id:randomUUID(),action:'PLATFORM_TENANT_REACTIVATED',itemId:tenantId,actorId:actor.id,actorName:actor.name,at:now});
 return getTenant(db,tenantId);
}
/** Part 25/61 — extends from `max(now, current expiry)` so extending a still-active trial
 * pushes the same baseline forward, while extending an already-expired one starts counting
 * fresh from now; always restores `status='TRIAL'` (Part 61: "extend trial → active/
 * operational"), since extending is itself the explicit intent to make the tenant operational
 * again regardless of why it was previously blocked. */
export function extendTrialByPlatform(db,tenantId,{days},actor) {
 if(!Number.isInteger(days)||days<=0||days>365)fail(400,'عدد أيام التمديد يجب أن يكون رقمًا صحيحًا موجبًا (حتى 365)');
 const tenant=getTenant(db,tenantId);
 if(!tenant)fail(404,'المنشأة غير موجودة');
 const now=new Date();
 const base=tenant.trialExpiresAt && new Date(tenant.trialExpiresAt).getTime()>now.getTime()?new Date(tenant.trialExpiresAt).getTime():now.getTime();
 const newExpiresAt=new Date(base+days*86400000).toISOString();
 db.prepare("UPDATE tenants SET status='TRIAL',trial_expires_at=?,updated_at=? WHERE id=?").run(newExpiresAt,now.toISOString(),tenantId);
 recordPlatformAudit(db,{id:randomUUID(),action:'TRIAL_EXTENDED',itemId:tenantId,actorId:actor.id,actorName:actor.name,at:now.toISOString()});
 return getTenant(db,tenantId);
}
