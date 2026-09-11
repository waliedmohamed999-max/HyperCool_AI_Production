import {randomUUID, randomBytes, createHash} from 'node:crypto';
import {fail} from './auth.js';

// Multi-Tenant Phase 4C-5 — Platform Identity + Verified Email Foundation. See
// docs/PLATFORM_IDENTITY.md for the full "User Identity vs TenantMembership" split this phase
// establishes: `email`/`email_verified_at`/`pending_email` live on `users` (GLOBAL, never
// tenant-scoped — Part 57/58), while `role` stays exactly where it already was, on
// `tenant_memberships`. This module never invents an email for an existing user (Part 6) and
// never claims an email is verified before its token round-trip actually completes (Part 9).
const hash=token=>createHash('sha256').update(token).digest('hex');
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const EMAIL_VERIFICATION_EXPIRY_MS=45*60000; // 45 minutes — within the 30-60 min policy range (Part 8)
export const PASSWORD_RESET_EXPIRY_MS=30*60000; // 30 minutes (Part 25)

export function installPlatformIdentity(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  email_normalized TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0
 );
 CREATE INDEX IF NOT EXISTS idx_evt_user ON email_verification_tokens(user_id);
 CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_prt_user ON password_reset_tokens(user_id);
 CREATE TABLE IF NOT EXISTS platform_audit_log (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  item_id TEXT,
  actor_id TEXT,
  actor_name TEXT,
  at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_platform_audit_log_action ON platform_audit_log(action);`);
}

/**
 * Part 28's audit events (USER_EMAIL_ADDED, USER_EMAIL_VERIFIED, ..., PASSWORD_RESET_*) are
 * about GLOBAL user identity, not any one workspace — several of them fire from routes that
 * have no session/tenant context at all (a public password-reset link). Reusing the existing
 * tenant-scoped `recordAudit` (audit.js) here would either force these into whichever
 * workspace the session happens to be in right now (Part 57: wrong — the change applies to the
 * user across every workspace they belong to) or, worse, THROW `TENANT_CONTEXT_REQUIRED` for
 * an unauthenticated request in any deployment with more than one tenant (`recordAudit`'s
 * fallback calls `resolveActiveTenantId`, which rejects ambiguity by design — see
 * tenancy.js). This tiny, separate, non-tenant-scoped log is the honest fix — never logs a
 * raw token (Part 28's own explicit rule).
 */
export function recordPlatformAudit(db,{id,action,itemId=null,actorId=null,actorName=null,at}) {
 db.prepare('INSERT INTO platform_audit_log (id,action,item_id,actor_id,actor_name,at) VALUES (?,?,?,?,?,?)').run(id,action,itemId,actorId,actorName,at);
}

/** The one, canonical normalizer (Part 4) — trim + lowercase the whole address. No fuzzy
 * matching, no plus-addressing collapsing, no provider-specific dot-folding: those are policy
 * decisions this phase deliberately does not make (Part 4: "لا تستخدم fuzzy matching"). Shared
 * by both this module and `invitations.js` so "what counts as the same email" can never drift
 * between the two. */
export function normalizeEmail(email) {
 if(typeof email!=='string')fail(400,'البريد الإلكتروني مطلوب');
 const trimmed=email.trim().toLowerCase();
 if(!trimmed||trimmed.length>254||!EMAIL_RE.test(trimmed))fail(400,'صيغة البريد الإلكتروني غير صحيحة');
 return trimmed;
}
function genToken() { return randomBytes(32).toString('hex'); }

/** Part 19 — safe public identity shape: never the password hash, never a raw token. */
export function getUserIdentity(db,userId) {
 const row=db.prepare('SELECT id,username,name,role,email,email_verified_at,pending_email FROM users WHERE id=?').get(userId);
 if(!row)return null;
 return {id:row.id,username:row.username,name:row.name,role:row.role,email:row.email,emailVerifiedAt:row.email_verified_at,pendingEmail:row.pending_email};
}

/**
 * Part 9/10 — begin (or restart) an email verification round-trip. Never marks anything
 * verified by itself: it only validates + reserves the address and issues a fresh token,
 * exactly like a resend (Part 55: rotating the token invalidates any prior one for this user).
 * Uniqueness (Part 5) is checked against OTHER users' already-VERIFIED `email` only — a
 * pending, not-yet-proven claim by someone else never blocks this (whoever verifies first
 * wins; the UNIQUE(email) index is the final, unbypassable authority at promotion time).
 */
export function requestEmailChange(db,userId,email) {
 const normalized=normalizeEmail(email);
 const currentUser=db.prepare('SELECT email FROM users WHERE id=?').get(userId);
 if(!currentUser)fail(404,'المستخدم غير موجود');
 if(currentUser.email===normalized)fail(409,'هذا هو بريدك الموثّق بالفعل');
 const takenByAnother=db.prepare('SELECT id FROM users WHERE email=? AND id!=?').get(normalized,userId);
 if(takenByAnother)fail(409,'هذا البريد الإلكتروني مستخدم من قبل حساب آخر');
 const now=new Date().toISOString(),token=genToken(),expiresAt=new Date(Date.now()+EMAIL_VERIFICATION_EXPIRY_MS).toISOString();
 db.prepare('DELETE FROM email_verification_tokens WHERE user_id=? AND used_at IS NULL').run(userId); // rotate: invalidate any prior pending token
 db.prepare('INSERT INTO email_verification_tokens (id,user_id,email_normalized,token_hash,expires_at,created_at) VALUES (?,?,?,?,?,?)')
  .run(randomUUID(),userId,normalized,hash(token),expiresAt,now);
 db.prepare('UPDATE users SET pending_email=? WHERE id=?').run(normalized,userId);
 return {token,normalizedEmail:normalized};
}
/** Part 55 — resend rotates the token; requires a pending email to already exist. */
export function resendEmailVerification(db,userId) {
 const user=db.prepare('SELECT pending_email FROM users WHERE id=?').get(userId);
 if(!user)fail(404,'المستخدم غير موجود');
 if(!user.pending_email)fail(409,'لا يوجد بريد إلكتروني بانتظار التحقق');
 return requestEmailChange(db,userId,user.pending_email);
}
/**
 * Part 9 (completion) — single-use, expiry-enforced. The final uniqueness check happens here,
 * atomically, against the real UNIQUE(email) index: if the address was claimed by someone else
 * in the meantime (a genuine, rare race — two people verifying the same address concurrently),
 * the UPDATE itself fails and this reports it honestly rather than silently overwriting.
 */
export function verifyEmailToken(db,token) {
 if(typeof token!=='string'||!token)fail(400,'رمز التحقق غير صالح');
 const row=db.prepare('SELECT * FROM email_verification_tokens WHERE token_hash=?').get(hash(token));
 if(!row)fail(404,'رابط التحقق غير صالح');
 if(row.used_at)fail(410,'تم استخدام رابط التحقق هذا بالفعل');
 if(new Date(row.expires_at).getTime()<Date.now()) {
  db.prepare('UPDATE email_verification_tokens SET attempt_count=attempt_count+1 WHERE id=?').run(row.id);
  fail(410,'انتهت صلاحية رابط التحقق — اطلب رابطًا جديدًا');
 }
 const now=new Date().toISOString();
 try {
  db.prepare("UPDATE users SET email=?,email_verified_at=?,pending_email=NULL WHERE id=?").run(row.email_normalized,now,row.user_id);
 } catch(error) {
  if(String(error.message).includes('UNIQUE'))fail(409,'هذا البريد أصبح مستخدمًا من حساب آخر قبل إتمام التحقق');
  throw error;
 }
 db.prepare('UPDATE email_verification_tokens SET used_at=? WHERE id=?').run(now,row.id);
 return {userId:row.user_id,email:row.email_normalized};
}

// --- Password reset (Part 23-27) — token bookkeeping only; the actual password mutation and
// session-wipe reuse the existing, already-tested `auth.resetPassword()` (it already deletes
// every session for that user — Part 27's requirement is met by code that predates this phase).

/** Part 24 — ALWAYS succeeds with the same shape from the caller's point of view (no
 * user-enumeration signal, Part 41): returns `{token}` only when a real, verified-email
 * account exists for this address; otherwise returns `{token:null}` and the caller must still
 * respond with the identical generic message either way. */
export function requestPasswordReset(db,email) {
 const normalized=normalizeEmail(email);
 const user=db.prepare('SELECT id FROM users WHERE email=?').get(normalized);
 if(!user)return {token:null};
 const now=new Date().toISOString(),token=genToken(),expiresAt=new Date(Date.now()+PASSWORD_RESET_EXPIRY_MS).toISOString();
 db.prepare('DELETE FROM password_reset_tokens WHERE user_id=? AND used_at IS NULL').run(user.id); // Part 56: rotate
 db.prepare('INSERT INTO password_reset_tokens (id,user_id,token_hash,expires_at,created_at) VALUES (?,?,?,?,?)').run(randomUUID(),user.id,hash(token),expiresAt,now);
 return {token,userId:user.id};
}
export function validatePasswordResetToken(db,token) {
 if(typeof token!=='string'||!token)fail(400,'رمز إعادة التعيين غير صالح');
 const row=db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash=?').get(hash(token));
 if(!row)fail(404,'رابط إعادة التعيين غير صالح');
 if(row.used_at)fail(410,'تم استخدام رابط إعادة التعيين هذا بالفعل');
 if(new Date(row.expires_at).getTime()<Date.now())fail(410,'انتهت صلاحية رابط إعادة التعيين');
 return row;
}
export function consumePasswordResetToken(db,token) {
 const row=validatePasswordResetToken(db,token);
 db.prepare('UPDATE password_reset_tokens SET used_at=? WHERE id=?').run(new Date().toISOString(),row.id);
 return row.user_id;
}

// --- Simple, conservative rate limiting (Part 40) — same local-Map shape as auth.js/
// invitations.js's own limiters, applied to every public/self-service identity surface.
function makeLimiter(max,windowMs) {
 const attempts=new Map();
 return address=>{
  const now=Date.now(),entry=attempts.get(address);
  if(entry && entry.until>now && entry.count>=max)fail(429,'محاولات كثيرة؛ حاول لاحقًا');
  attempts.set(address,{count:entry && entry.until>now?entry.count+1:1,until:entry && entry.until>now?entry.until:now+windowMs});
 };
}
// 40/15min per IP: generous enough that a real multi-step account flow (add email, resend
// once or twice, verify, later change it again) never comes remotely close, while still
// meaningfully throttling scripted abuse (a real user has no legitimate reason to trigger
// dozens of these within 15 minutes).
export const checkForgotPasswordRateLimit=makeLimiter(40,900000);
export const checkEmailVerificationRateLimit=makeLimiter(40,900000);
