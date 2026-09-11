import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
export function fail(status,message) { throw Object.assign(new Error(message),{status}); }
const hash = value => createHash('sha256').update(value).digest('hex');
// Phase 4C-5 — `email`/`emailVerifiedAt`/`pendingEmail` added: safe to expose to the user
// themselves on every `/api/auth` call (their own identity, never another user's), and lets
// the lightweight "add your email" banner (Part 47/69) render without a second round-trip.
const publicUser = user => ({id:user.id,username:user.username,name:user.name,role:user.role,preferredLocale:user.preferred_locale||null,email:user.email||null,emailVerifiedAt:user.email_verified_at||null,pendingEmail:user.pending_email||null});
function encodePassword(password) {
  const salt=randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password,salt,64).toString('hex')}`;
}
function matches(password,encoded) {
  const [salt,digest]=encoded.split(':');
  return timingSafeEqual(scryptSync(password,salt,64),Buffer.from(digest,'hex'));
}
export function createAuth(db) {
  const attempts=new Map();
  const dummy=encodePassword(randomBytes(24).toString('hex'));
  return {
    needsSetup:()=>!db.prepare('SELECT id FROM users LIMIT 1').get(),
    createUser(input,role=input.role) {
      if(typeof input.username!=='string' || !/^[a-zA-Z0-9_.-]{3,40}$/.test(input.username)) fail(400,'اسم الدخول: 3–40 حرفًا إنجليزيًا أو رقمًا');
      if(typeof input.name!=='string' || !input.name.trim() || input.name.length>100) fail(400,'الاسم مطلوب وبحد أقصى 100 حرف');
      if(typeof input.password!=='string' || input.password.length<12 || input.password.length>256) fail(400,'كلمة المرور يجب أن تكون بين 12 و256 حرفًا');
      if(!['owner','reviewer','operator'].includes(role)) fail(400,'دور غير صالح');
      const user={id:randomUUID(),username:input.username.toLowerCase(),name:input.name.trim(),role};
      if(db.prepare('SELECT id FROM users WHERE username=?').get(user.username)) fail(409,'اسم الدخول مستخدم');
      db.prepare('INSERT INTO users (id,username,name,role,password,status,created_at) VALUES (?,?,?,?,?,?,?)')
        .run(user.id,user.username,user.name,user.role,encodePassword(input.password),'active',new Date().toISOString());
      return user;
    },
    login(input,address) {
      const now=Date.now(),entry=attempts.get(address);
      if(entry && entry.until>now && entry.count>=10) fail(429,'محاولات كثيرة؛ حاول بعد 15 دقيقة');
      attempts.set(address,{count:entry && entry.until>now?entry.count+1:1,until:entry && entry.until>now?entry.until:now+900000});
      if(typeof input.password!=='string' || input.password.length>256 || typeof input.username!=='string') fail(401,'بيانات الدخول غير صحيحة');
      // Phase 4C-5 (Part 20-22) — the SAME identity field also accepts a verified email: a
      // real username can never contain '@' (createUser's own pattern forbids it), so this is
      // unambiguous. Only a VERIFIED email is ever accepted here — Part 22's explicit policy
      // ("لا تستخدم unverified email كlogin identity") — an unverified `pending_email` never
      // matches this lookup at all, it is only ever checked against `email` post-verification.
      const identity=input.username.trim().toLowerCase();
      const user=identity.includes('@')
        ? db.prepare('SELECT * FROM users WHERE email=? AND email_verified_at IS NOT NULL').get(identity)
        : db.prepare('SELECT * FROM users WHERE username=?').get(identity);
      const valid=matches(input.password,user?.password||dummy);
      if(!user || !valid) fail(401,'بيانات الدخول غير صحيحة');
      attempts.delete(address);
      if(user.status==='suspended') fail(403,'هذا الحساب موقوف؛ تواصل مع مالك النظام');
      db.prepare('UPDATE users SET last_login_at=? WHERE id=?').run(new Date().toISOString(),user.id);
      return this.session(user);
    },
    session(user) {
      const token=randomBytes(32).toString('hex'), csrf=randomBytes(32).toString('hex');
      db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
      db.prepare('INSERT INTO sessions (token,user_id,csrf,expires) VALUES (?,?,?,?)').run(hash(token),user.id,csrf,Date.now()+8*3600000);
      return {token,csrf,user:publicUser(user)};
    },
    current(req) {
      const token=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('hc_session='))?.slice(11);
      if(!token) return null;
      const result=db.prepare("SELECT users.*, sessions.csrf, sessions.active_tenant_id AS activeTenantId FROM sessions JOIN users ON users.id=sessions.user_id WHERE token=? AND expires>? AND users.status='active'").get(hash(token),Date.now());
      return result?{user:publicUser(result),csrf:result.csrf,tokenHash:hash(token),activeTenantId:result.activeTenantId||null}:null;
    },
    logout(session) {db.prepare('DELETE FROM sessions WHERE token=?').run(session.tokenHash);},
    // Phase 4C-1 — the only writer of the server-side "which workspace is this session
    // currently acting in" hint (see store.js's migration comment). `tokenHash` is what
    // `current()` already returns — never the raw cookie token re-hashed a second time by a
    // caller, and never a value this function trusts as already-validated: the caller
    // (tenancy.js's activateWorkspaceForUser, via the /api/workspaces/active route) must have
    // already confirmed real membership before this is ever called.
    setActiveTenant(tokenHash,tenantId) {
      db.prepare('UPDATE sessions SET active_tenant_id=? WHERE token=?').run(tenantId,tokenHash);
    },
    list:()=>db.prepare('SELECT id,username,name,role,status,created_at,last_login_at FROM users ORDER BY name').all(),
    get:id=>db.prepare('SELECT id,username,name,role,status,created_at,last_login_at FROM users WHERE id=?').get(id),
    // Minimal additive primitives for Team Management — each does exactly one column
    // update. Owner-protection, audit logging and response shaping live in team-ops.js,
    // one layer up, so this core file stays a thin, stable set of DB operations.
    setRole(id,role) {
      if(!['owner','reviewer','operator'].includes(role)) fail(400,'دور غير صالح');
      db.prepare('UPDATE users SET role=? WHERE id=?').run(role,id);
    },
    setStatus(id,status) {
      if(!['active','suspended'].includes(status)) fail(400,'حالة غير صالحة');
      db.prepare('UPDATE users SET status=? WHERE id=?').run(status,id);
      if(status==='suspended')db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    },
    removeUser(id) {
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
      db.prepare('DELETE FROM users WHERE id=?').run(id);
    },
    resetPassword(id,newPassword) {
      if(typeof newPassword!=='string' || newPassword.length<12 || newPassword.length>256) fail(400,'كلمة المرور يجب أن تكون بين 12 و256 حرفًا');
      db.prepare('UPDATE users SET password=? WHERE id=?').run(encodePassword(newPassword),id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    },
    activeSessionUserIds:()=>db.prepare('SELECT DISTINCT user_id FROM sessions WHERE expires>?').all(Date.now()).map(r=>r.user_id),
    revokeSessions(id) {db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);},
    setPreferredLocale(id,locale) {
      if(!['ar','en'].includes(locale)) fail(400,'لغة غير صالحة');
      db.prepare('UPDATE users SET preferred_locale=? WHERE id=?').run(locale,id);
    }
  };
}
export function authorize(session,roles) {
  if(!session) fail(401,'سجل الدخول أولًا');
  if(!roles.includes(session.user.role)) fail(403,'حسابك لا يملك صلاحية هذا الإجراء');
}
