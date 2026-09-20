import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {fail} from './auth.js';
import {getTenant,listActiveMembers} from './tenancy.js';
import {normalizeEmail} from './platform-identity.js';
import {effectivePlanForTenantId,planSeatLimitReached} from './plans.js';

// Multi-Tenant Phase 4C-3 — Workspace Invitations. A minimal, honest invitation model built
// on the REAL constraints of this app's existing auth (server-side sessions, no JWT — Part
// "reuse current auth") and its REAL user model (`users` had no email column at all at the
// time — only `username`, validated `[a-zA-Z0-9_.-]{3,40}`; see src/store.js). This module
// never invents an email-matching identity check it cannot actually perform (Part 15's "if
// identity mismatch: reject" only makes sense where an email/identity field exists to check
// against); see docs/WORKSPACE_INVITATIONS.md's "Identity model" section for the full
// reasoning. The security model actually used: possession of the real, hashed-at-rest,
// single-use, expiring token is the sole authority to accept — the same trust model most real
// invite-link products use once no verified email exists to bind against, applied honestly
// rather than faked.
//
// Multi-Tenant Phase 4C-5 update — now that a real, global, verified User email identity
// exists (`platform-identity.js`), every invitation created from this point on is
// `EMAIL_BOUND` (Part 32): accepting it as an EXISTING user requires that user's own verified
// email to equal the invitation's target address (Part 34) — token possession is no longer
// the SOLE authority for a new invitation, only the entry ticket. Every invitation created
// BEFORE this phase (and therefore never actually delivered by a real mail service, since none
// existed) is honestly kept as `TOKEN_ONLY_LEGACY` and keeps working exactly as before —
// this phase never revokes or reinterprets a pre-existing invitation's trust model
// retroactively (Part 31).
const hash=token=>createHash('sha256').update(token).digest('hex');
const VALID_ROLES=['owner','reviewer','operator'];
export const INVITATION_EXPIRY_MS=7*24*3600000; // 7 days — Part 4's "clear duration", documented in docs/WORKSPACE_INVITATIONS.md

export function installInvitations(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS workspace_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('owner','reviewer','operator')),
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','ACCEPTED','EXPIRED','REVOKED')),
  invited_by_user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_workspace_invitations_tenant ON workspace_invitations(tenant_id);
 CREATE INDEX IF NOT EXISTS idx_workspace_invitations_status ON workspace_invitations(status);
 CREATE INDEX IF NOT EXISTS idx_workspace_invitations_expires ON workspace_invitations(expires_at);
 CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invitations_active_email ON workspace_invitations(tenant_id,email) WHERE status='PENDING';`);
 // Phase 4C-5 (Part 29-32) — additive only. Existing rows (created before Platform Identity
 // existed, and therefore never actually delivered by a real mail service) default to the
 // honest `TOKEN_ONLY_LEGACY` classification and keep accepting on token possession alone,
 // unchanged. `createInvitation` marks every NEW row `EMAIL_BOUND` going forward.
 const columns=db.prepare("SELECT name FROM pragma_table_info('workspace_invitations')").all().map(r=>r.name);
 if(!columns.includes('invitation_mode'))db.exec("ALTER TABLE workspace_invitations ADD COLUMN invitation_mode TEXT NOT NULL DEFAULT 'TOKEN_ONLY_LEGACY' CHECK(invitation_mode IN ('TOKEN_ONLY_LEGACY','EMAIL_BOUND'))");
}
function genToken() { return randomBytes(32).toString('hex'); }
// A PENDING row past its own expires_at is EXPIRED — derived live, at read time, from a
// single indexed column (Part 75: "no heavy scheduler required; status can be derived from
// expires_at") — never a stored value a background job would need to keep in sync.
function effectiveStatus(row) { return row.status==='PENDING' && new Date(row.expires_at).getTime()<Date.now() ? 'EXPIRED' : row.status; }
function hydrate(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,email:row.email,role:row.role,status:effectiveStatus(row),invitationMode:row.invitation_mode,invitedByUserId:row.invited_by_user_id,expiresAt:row.expires_at,acceptedAt:row.accepted_at,revokedAt:row.revoked_at,createdAt:row.created_at,updatedAt:row.updated_at};
}
function getRawById(db,tenantId,id) { return db.prepare('SELECT * FROM workspace_invitations WHERE id=? AND tenant_id=?').get(id,tenantId); }
function findByToken(db,token) {
 if(typeof token!=='string'||!token)return null;
 return db.prepare('SELECT * FROM workspace_invitations WHERE token_hash=?').get(hash(token))||null;
}

/**
 * `POST /api/workspaces/invitations` — Part 5's duplicate-pending rule is enforced by a real
 * DB constraint (the partial unique index above on `(tenant_id,email) WHERE status='PENDING'`)
 * rather than a race-prone check-then-insert: a second create attempt against an existing
 * PENDING row is treated as an implicit resend (new token, fresh 7-day expiry, same row) —
 * matching "pending invitation exists → resend/update expiry" exactly, and matching real
 * `INSERT ... ON CONFLICT` semantics elsewhere in this codebase (tool-definitions.js, etc.)
 * rather than a hand-rolled duplicate check that could race under concurrent requests.
 *
 * `MEMBER_ALREADY_EXISTS` (Part 5's other branch) is honestly NOT checked here: this app's
 * `users` table has no email column, so there is no reliable way to tell "this email already
 * has an active membership" from the email alone — see the module doc comment and
 * docs/WORKSPACE_INVITATIONS.md. Inviting someone already a member is harmless: acceptance is
 * idempotent (see `completeAcceptance` below) and simply confirms their existing membership.
 */
export function createInvitation(db,tenantId,{email,role},invitedByUserId) {
 const normalizedEmail=normalizeEmail(email);
 if(!VALID_ROLES.includes(role))fail(400,'دور غير صالح');
 const now=new Date().toISOString(),token=genToken(),expiresAt=new Date(Date.now()+INVITATION_EXPIRY_MS).toISOString();
 const existing=db.prepare("SELECT id FROM workspace_invitations WHERE tenant_id=? AND email=? AND status='PENDING'").get(tenantId,normalizedEmail);
 if(!existing) {
  // Packages (src/plans.js) — a NEW invitation reserves a seat; resending an existing PENDING
  // one (the branch below) does not, since it doesn't grow the tenant's member count. A tenant
  // with no assigned plan is unrestricted (grandfather rule).
  const plan=effectivePlanForTenantId(db,tenantId);
  const pendingCount=db.prepare("SELECT COUNT(*) n FROM workspace_invitations WHERE tenant_id=? AND status='PENDING'").get(tenantId).n;
  const activeCount=listActiveMembers(db,tenantId).length+pendingCount;
  if(planSeatLimitReached(plan,activeCount))fail(403,'وصلت للحد الأقصى لعدد أعضاء الفريق في باقتك الحالية — يمكنك الترقية من صفحة الباقات');
 }
 if(existing) {
  // Part 32 — a fresh invite action always intends the new, binding policy, even if it
  // happens to reuse an existing PENDING row for the same address.
  db.prepare("UPDATE workspace_invitations SET token_hash=?,role=?,invited_by_user_id=?,expires_at=?,invitation_mode='EMAIL_BOUND',updated_at=? WHERE id=?").run(hash(token),role,invitedByUserId,expiresAt,now,existing.id);
  return {invitation:hydrate(getRawById(db,tenantId,existing.id)),token};
 }
 const id=randomUUID();
 db.prepare("INSERT INTO workspace_invitations (id,tenant_id,email,role,token_hash,status,invitation_mode,invited_by_user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,'PENDING','EMAIL_BOUND',?,?,?,?)")
  .run(id,tenantId,normalizedEmail,role,hash(token),invitedByUserId,expiresAt,now,now);
 return {invitation:hydrate(getRawById(db,tenantId,id)),token};
}
export function listInvitations(db,tenantId) {
 return db.prepare('SELECT * FROM workspace_invitations WHERE tenant_id=? ORDER BY created_at DESC').all(tenantId).map(hydrate);
}
/** Tenant-scoped by construction — a foreign invitation id never matches `tenant_id=?`, same 404-for-wrong-or-nonexistent principle as every other tenant-scoped getter here (Part 29). */
export function getInvitation(db,tenantId,id) {
 return hydrate(getRawById(db,tenantId,id));
}
export function resendInvitation(db,tenantId,id) {
 const row=getRawById(db,tenantId,id);
 if(!row)fail(404,'الدعوة غير موجودة');
 const status=effectiveStatus(row);
 if(status==='ACCEPTED')fail(409,'الدعوة مقبولة بالفعل');
 if(status==='REVOKED')fail(409,'لا يمكن إعادة إرسال دعوة ملغاة — أنشئ دعوة جديدة');
 const token=genToken(),now=new Date().toISOString();
 db.prepare("UPDATE workspace_invitations SET token_hash=?,status='PENDING',expires_at=?,updated_at=? WHERE id=?").run(hash(token),new Date(Date.now()+INVITATION_EXPIRY_MS).toISOString(),now,row.id);
 return {invitation:hydrate(getRawById(db,tenantId,row.id)),token};
}
export function revokeInvitation(db,tenantId,id) {
 const row=getRawById(db,tenantId,id);
 if(!row)fail(404,'الدعوة غير موجودة');
 if(effectiveStatus(row)==='ACCEPTED')fail(409,'لا يمكن إلغاء دعوة مقبولة بالفعل');
 const now=new Date().toISOString();
 db.prepare("UPDATE workspace_invitations SET status='REVOKED',revoked_at=?,updated_at=? WHERE id=?").run(now,now,row.id);
 return hydrate(getRawById(db,tenantId,row.id));
}

// --- Token-authenticated flows (no tenant context from the caller — the token IS the context)

/** Safe, minimal, unauthenticated preview (Part 20) — deliberately never reveals whether any
 * account exists for this email (Part 48: no user enumeration). Same 404 for "no such token"
 * as for a garbage guess — never distinguishes a real-but-expired token from a random string
 * at this layer (the status field itself, once found, is the only thing revealed). */
export function previewInvitation(db,token) {
 const row=findByToken(db,token);
 if(!row)fail(404,'رابط الدعوة غير صالح');
 const tenant=getTenant(db,row.tenant_id);
 return {workspaceName:tenant?.name||null,role:row.role,status:effectiveStatus(row)};
}
function validateForAcceptance(db,token) {
 const row=findByToken(db,token);
 if(!row)fail(404,'رابط الدعوة غير صالح');
 const status=effectiveStatus(row);
 if(status==='EXPIRED')fail(410,'انتهت صلاحية الدعوة');
 if(status==='REVOKED')fail(410,'تم إلغاء هذه الدعوة');
 if(status==='ACCEPTED')fail(409,'تم قبول هذه الدعوة بالفعل — استخدم تسجيل الدخول العادي');
 const tenant=getTenant(db,row.tenant_id);
 if(!tenant||!['ACTIVE','TRIAL'].includes(tenant.status))fail(409,'منشأة هذه الدعوة غير متاحة حاليًا');
 return row;
}
/** The role a brand-new account should be created with (Part 55: "latest stored invitation
 * role, not stale frontend value") — re-validated fully, never trusted from a prior read. */
export function roleForValidToken(db,token) { return validateForAcceptance(db,token).role; }
/**
 * Shared acceptance core (Part 14/15/16 — used by BOTH the existing-user accept route and the
 * new-user register route, since once a real `userId` exists the rest is identical). Re-
 * validates the token fully again (cheap; closes any TOCTOU gap between an earlier peek and
 * this call). Idempotent (Part 50): a pre-existing membership row for this exact
 * (tenant, user) — even a previously 'removed'/'suspended' one — is reactivated with the
 * invitation's role rather than duplicated; `UNIQUE(tenant_id,user_id)` makes a duplicate row
 * impossible at the schema level regardless. Marks the invitation ACCEPTED and therefore
 * single-use: `validateForAcceptance` rejects a second call with the same token outright.
 */
/**
 * Phase 4C-5 (Part 30/34/35/47/48) identity gate — only for `EMAIL_BOUND` invitations (a
 * legacy `TOKEN_ONLY_LEGACY` row skips this entirely, unchanged from before this phase, Part
 * 31).
 *
 * `isNewAccount:true` (the `/register` route, called immediately after `createUser` with no
 * prior identity of its own) treats having received this exact invitation link as the same
 * kind of proof email verification itself relies on — receipt of a link at that address — and
 * promotes the brand-new account's email straight to verified (Part 35: "email already implied
 * by invite").
 *
 * `isNewAccount:false` (an existing, already-authenticated user hitting `/accept`) rejects only
 * a PROVABLE mismatch: a user who already has a DIFFERENT verified email is refused (Part 34 —
 * "لا يكفي امتلاك token وحده" for a genuinely wrong identity). A user with NO verified email
 * yet is deliberately NOT blocked here — Part 47/48's own transition rule ("current legacy
 * users can continue" / "do not block app usage immediately") applies just as much to
 * accepting a colleague's invitation as it does to using the rest of the app; requiring every
 * existing HyperCool user to verify an email before they could accept ANY invitation would be
 * a hard new blocker this phase explicitly says not to introduce yet. This still closes the
 * real gap Part 34 is about (a DIFFERENT verified person accepting someone else's invite) while
 * a full "verified email required to accept" policy is deferred to whenever Part 48's gate
 * before Phase 4C-6 actually makes verified email mandatory platform-wide.
 */
function enforceEmailBinding(db,row,userId,{isNewAccount}) {
 if(row.invitation_mode!=='EMAIL_BOUND')return;
 if(isNewAccount) {
  const now=new Date().toISOString();
  try{db.prepare('UPDATE users SET email=?,email_verified_at=?,pending_email=NULL WHERE id=?').run(row.email,now,userId);}
  catch(error){if(String(error.message).includes('UNIQUE'))fail(409,'هذا البريد مستخدم من حساب آخر بالفعل');throw error;}
  return;
 }
 const user=db.prepare('SELECT email,email_verified_at FROM users WHERE id=?').get(userId);
 if(user?.email_verified_at && user.email!==row.email)fail(403,'هذه الدعوة مخصّصة لبريد إلكتروني موثّق مختلف — سجّل الدخول بالحساب الذي يحمل ذلك البريد الموثّق');
}
export function acceptInvitation(db,token,userId,{isNewAccount=false}={}) {
 const row=validateForAcceptance(db,token);
 enforceEmailBinding(db,row,userId,{isNewAccount});
 const tenant=getTenant(db,row.tenant_id);
 const now=new Date().toISOString();
 const existingMembership=db.prepare('SELECT id FROM tenant_memberships WHERE tenant_id=? AND user_id=?').get(row.tenant_id,userId);
 if(existingMembership)db.prepare("UPDATE tenant_memberships SET status='active',role=?,is_owner=? WHERE id=?").run(row.role,row.role==='owner'?1:0,existingMembership.id);
 else db.prepare('INSERT INTO tenant_memberships (id,tenant_id,user_id,role,status,is_owner,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(),row.tenant_id,userId,row.role,'active',row.role==='owner'?1:0,now);
 db.prepare("UPDATE workspace_invitations SET status='ACCEPTED',accepted_at=?,updated_at=? WHERE id=?").run(now,now,row.id);
 return {tenantId:row.tenant_id,tenantName:tenant.name,role:row.role};
}

// --- Simple, conservative rate limiting (Part 46/47) — identical shape to auth.js's own
// login limiter, applied to the unauthenticated token-guessing surface (preview/accept/
// register): 20 attempts per 15 minutes per IP. Authenticated create/resend/revoke are
// already behind session+CSRF+owner-role, a materially higher bar than a bare IP.
const tokenAttempts=new Map();
export function checkInvitationRateLimit(address) {
 const now=Date.now(),entry=tokenAttempts.get(address);
 if(entry && entry.until>now && entry.count>=20)fail(429,'محاولات كثيرة؛ حاول لاحقًا');
 tokenAttempts.set(address,{count:entry && entry.until>now?entry.count+1:1,until:entry && entry.until>now?entry.until:now+900000});
}
