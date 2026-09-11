import {randomUUID} from 'node:crypto';

// Multi-Tenant Control Center — Phase 1 foundation only (deliberately scoped; see
// docs/MULTI_TENANT_ARCHITECTURE.md for what is and is not built yet). This app was, until
// this module existed, genuinely single-tenant: one SQLite file, no company/organization
// concept anywhere, `integration_credentials` keyed by `provider` alone system-wide. This
// module adds the real Tenant + TenantMembership tables and a lossless backfill of the
// current single real company's data into exactly one Tenant row — it does not yet let a
// second tenant be created from the UI (no Control Center exists), but every function here
// is written so that a future one can be added without another data migration.
export function installTenancy(db) {
 db.exec(`
  CREATE TABLE IF NOT EXISTS tenants (
   id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
   status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','SUSPENDED','TRIAL','ARCHIVED')),
   plan TEXT, default_locale TEXT NOT NULL DEFAULT 'ar', timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
   branding_settings TEXT, system_mode TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tenant_memberships (
   id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), user_id TEXT NOT NULL REFERENCES users(id),
   role TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', is_owner INTEGER NOT NULL DEFAULT 0,
   created_at TEXT NOT NULL, UNIQUE(tenant_id,user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_tenant_memberships_user ON tenant_memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_tenant_memberships_tenant ON tenant_memberships(tenant_id);
 `);
 // Multi-Tenant Phase 4B (Part 17/37) — additive, guarded columns, same pattern as
 // registry.js/runtime.js. `default_ai_connection_id`/`default_ai_model` let a tenant set a
 // workspace-wide AI provider connection/model that any TenantAgentConfig without its own
 // override inherits (Part 17). `max_agent_level` is a per-tenant safety ceiling (Part 37) —
 // nullable, meaning "no additional ceiling beyond the system-wide SYSTEM_MODE cap" by
 // default; distinct from an individual agent's own audited autonomy level.
 const columns=db.prepare('PRAGMA table_info(tenants)').all().map(c=>c.name);
 if(!columns.includes('default_ai_connection_id'))db.exec('ALTER TABLE tenants ADD COLUMN default_ai_connection_id TEXT');
 if(!columns.includes('default_ai_model'))db.exec('ALTER TABLE tenants ADD COLUMN default_ai_model TEXT');
 if(!columns.includes('max_agent_level'))db.exec('ALTER TABLE tenants ADD COLUMN max_agent_level TEXT');
}
/**
 * Idempotent, lossless backfill (spec Part 99-101). The very first call on a real database
 * creates exactly one Tenant ("HyperCool") and attaches every EXISTING user to it as a
 * member with their current global role carried over verbatim — no data invented, nothing
 * dropped. Every later call is a cheap indexed lookup that returns the same id. Safe to call
 * from any module that needs "the tenant" and doesn't want to force every caller to thread
 * one through explicitly yet (see credentials.js/crm.js's optional `tenantId` parameters).
 */
export function ensureDefaultTenant(db) {
 installTenancy(db);
 const existing=db.prepare('SELECT id FROM tenants ORDER BY created_at LIMIT 1').get();
 if(existing)return existing.id;
 const id=randomUUID(),now=new Date().toISOString();
 db.prepare('INSERT INTO tenants (id,name,slug,status,default_locale,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id,'HyperCool','hypercool','ACTIVE','ar','Asia/Riyadh',now,now);
 let users=[];
 try{users=db.prepare('SELECT id,role FROM users').all();}catch{users=[];} // users table may not exist yet in a bare fixture
 const insertMembership=db.prepare('INSERT OR IGNORE INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)');
 for(const user of users)insertMembership.run(randomUUID(),id,user.id,user.role,'active',user.role==='owner'?1:0,now);
 return id;
}
// The single real entry point every tenant-scoped module resolves "which tenant" through
// when no explicit tenant context was threaded in from a request. Multi-Tenant Phase 3
// (spec Part B, "fail-closed conversion"): this used to unconditionally return "the first
// tenant that exists" — correct behavior while there is genuinely only one tenant, but a
// real cross-tenant leak the moment a second one is created and some call site still hasn't
// been updated to pass an explicit tenantId. Rather than rewrite the ~40 call sites that
// rely on this default (which would be indistinguishable from doing nothing today, since
// there is only one tenant to fall into), this function now checks tenant COUNT: with
// exactly one tenant it stays byte-for-byte the same fail-open default as before (zero
// behavior change, zero risk to the current single-tenant deployment); the instant a second
// tenant exists, it throws `TENANT_CONTEXT_REQUIRED` instead of silently guessing which one
// — turning every one of those ~40 call sites into a real fail-closed guard for free,
// without having to find and fix them individually first. A caller that legitimately wants
// this exact "guess if there's only one" behavior even with multiple tenants (there is no
// such caller today) would need a separate, explicitly-named function — this one no longer
// offers that once it would actually matter.
export function resolveActiveTenantId(db) {
 const tenantId=ensureDefaultTenant(db);
 const {n}=db.prepare('SELECT COUNT(*) n FROM tenants').get();
 if(n>1)throw Object.assign(new Error('TENANT_CONTEXT_REQUIRED'),{code:'TENANT_CONTEXT_REQUIRED',status:400});
 return tenantId;
}
/**
 * Resolves the tenant a specific logged-in user belongs to — this is what a real
 * TenantContext.resolveTenant() will call once a session is available (spec Part 4). A user
 * with no membership row yet (created before this module existed, or any edge case) is
 * attached to the default tenant on first resolution rather than left tenant-less.
 *
 * Multi-Tenant Phase 3.5 (Part E): a user with exactly one membership resolves it safely, as
 * always. A user with MORE than one membership (not reachable from any route today —
 * createTenant() has no invite/onboarding flow yet — but the schema has always allowed it)
 * now throws `TENANT_SELECTION_REQUIRED` instead of silently picking one via `LIMIT 1`,
 * which used to return whichever row SQLite happened to return first — a real, if currently
 * unreachable, fail-open gap. There is deliberately no "active tenant" selection endpoint or
 * UI built yet (the spec explicitly scopes that out until a real multi-membership path
 * exists to test it against) — this only closes the unsafe-guess side of the gap.
 */
export function resolveTenantForUser(db,userId) {
 const tenantId=ensureDefaultTenant(db);
 const memberships=db.prepare('SELECT tenant_id AS tenantId FROM tenant_memberships WHERE user_id=?').all(userId);
 if(memberships.length>1)throw Object.assign(new Error('TENANT_SELECTION_REQUIRED'),{code:'TENANT_SELECTION_REQUIRED',status:409});
 if(memberships.length===1)return memberships[0].tenantId;
 const user=db.prepare('SELECT role FROM users WHERE id=?').get(userId);
 if(user)db.prepare('INSERT OR IGNORE INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)')
  .run(randomUUID(),tenantId,userId,user.role,'active',user.role==='owner'?1:0,new Date().toISOString());
 return tenantId;
}
export function getTenant(db,tenantId) {
 const row=db.prepare('SELECT * FROM tenants WHERE id=?').get(tenantId);
 if(!row)return null;
 return {id:row.id,name:row.name,slug:row.slug,status:row.status,plan:row.plan,defaultLocale:row.default_locale,timezone:row.timezone,brandingSettings:row.branding_settings?JSON.parse(row.branding_settings):null,systemMode:row.system_mode,
  defaultAiConnectionId:row.default_ai_connection_id,defaultAiModel:row.default_ai_model,maxAgentLevel:row.max_agent_level,createdAt:row.created_at,updatedAt:row.updated_at};
}
// Multi-Tenant Phase 4B (Part 17/37) — the workspace-level AI default and safety ceiling.
// `setWorkspaceAiDefault`'s `connectionId` is validated by the caller (application.js route)
// to actually belong to this tenant and be an anthropic/openai connection before this is
// called — this function itself only persists, matching every other setter in this codebase.
export function setWorkspaceAiDefault(db,tenantId,{connectionId=null,model=null}) {
 db.prepare('UPDATE tenants SET default_ai_connection_id=?,default_ai_model=?,updated_at=? WHERE id=?').run(connectionId,model,new Date().toISOString(),tenantId);
 return getTenant(db,tenantId);
}
export function setMaxAgentLevel(db,tenantId,level) {
 db.prepare('UPDATE tenants SET max_agent_level=?,updated_at=? WHERE id=?').run(level,new Date().toISOString(),tenantId);
 return getTenant(db,tenantId);
}
export function listTenantMembers(db,tenantId) {
 return db.prepare('SELECT tm.id,tm.user_id AS userId,u.name,u.username,tm.role,tm.status,tm.is_owner AS isOwner,tm.created_at AS createdAt FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=? ORDER BY tm.created_at').all(tenantId);
}
/**
 * Creates a brand-new, empty tenant — no credentials, no CRM data, no memory, no logs (spec
 * Part 53: "cloning" a customer must never copy another tenant's data). Not yet reachable
 * from any UI (no Control Center exists in this pass) — exposed here so the next phase's
 * onboarding route has a real, tested function to call rather than inventing one blind.
 */
export function createTenant(db,{name,slug},ownerUserId) {
 const id=randomUUID(),now=new Date().toISOString();
 db.prepare('INSERT INTO tenants (id,name,slug,status,default_locale,timezone,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
  .run(id,name,slug,'TRIAL','ar','Asia/Riyadh',now,now);
 if(ownerUserId)db.prepare('INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)')
  .run(randomUUID(),id,ownerUserId,'owner','active',1,now);
 return id;
}
/**
 * Multi-Tenant Phase 3.5 (Part A4) — the enumeration function the scheduler needs to loop
 * "once per tenant" instead of once globally. Only ACTIVE and TRIAL tenants are eligible for
 * automated background work by default — a TRIAL tenant is actively evaluating the product
 * and its automation (daily brief, follow-up sweep, scheduled publishing) is exactly what it
 * is here to try, so it is included, not excluded. SUSPENDED and ARCHIVED are deliberately
 * never eligible: a suspended tenant's data must not be touched by any automated job while
 * its access is revoked, and an archived tenant is closed. Callers that need every tenant
 * regardless of status (an admin listing, a migration) pass an explicit `statuses` covering
 * all four values rather than relying on this default.
 */
export function listTenants(db,{statuses=['ACTIVE','TRIAL']}={}) {
 if(!statuses.length)return [];
 const placeholders=statuses.map(()=>'?').join(',');
 return db.prepare(`SELECT id,name,slug,status FROM tenants WHERE status IN (${placeholders}) ORDER BY created_at`).all(...statuses);
}
