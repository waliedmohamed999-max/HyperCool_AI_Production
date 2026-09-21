// Multi-Tenant Phase 4C-5 — Platform Mail Service. Deliberately SEPARATE from every tenant's
// own Microsoft 365 connection (`runtime/microsoft-graph.js`'s `sendMail`, used only for a
// tenant's own outbound customer email): this is PLATFORM infrastructure, sending on behalf of
// HyperCool itself (account verification, password recovery, workspace invitations) — using a
// tenant's mailbox for that would be both a category error (whose email address would it send
// from?) and a real security problem (a tenant's own OAuth token now sending platform mail to
// arbitrary other tenants' users). See docs/PLATFORM_EMAIL.md.
//
// Same idiom as every other external call in this codebase (connectors.js's Anthropic/OpenAI
// test calls): a raw `fetch` to a real REST API, no SDK dependency. Real transport: Resend
// (https://resend.com) — a plain HTTPS JSON API, nothing more than an API key. A second,
// explicit "capture" transport exists ONLY for local development and the automated test suite
// (Part 14): it never touches the network and records the full rendered message (including any
// verification/reset link) into `platform_mail_outbox` for a test to read back — this is the
// ONE place a raw token's resulting link is ever allowed to be persisted, and it must never be
// selected in a real deployment (see `platformMailStatus`).
import {randomUUID} from 'node:crypto';

export function installPlatformMail(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS platform_mail_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('VERIFY_EMAIL','PASSWORD_RESET','INVITATION','SECURITY_NOTICE','PARTNER_NOTICE')),
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('SENT','FAILED')),
  sent_at TEXT,
  last_send_error_code TEXT,
  captured_body TEXT,
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_platform_mail_outbox_to ON platform_mail_outbox(to_email);`);
}

/** Real, honest capability status (Part 51) — never a secret value, just whether a working
 * transport is configured right now and which one. `capture` counts as CONFIGURED: it is a
 * real, working, intentionally-chosen transport for non-production use, not a missing one. */
export function platformMailStatus(env) {
 if(env.PLATFORM_MAIL_TRANSPORT==='capture')return {status:'CONFIGURED',transport:'capture'};
 if(env.PLATFORM_RESEND_API_KEY && env.PLATFORM_MAIL_FROM)return {status:'CONFIGURED',transport:'resend'};
 return {status:'UNCONFIGURED',transport:null};
}

async function sendViaResend({env,fetcher=fetch},{to,subject,html,text}) {
 const response=await fetcher('https://api.resend.com/emails',{
  method:'POST',
  headers:{'content-type':'application/json',authorization:`Bearer ${env.PLATFORM_RESEND_API_KEY}`},
  body:JSON.stringify({from:env.PLATFORM_MAIL_FROM,to:[to],subject,html,text}),
  signal:AbortSignal.timeout(15000)
 });
 if(!response.ok){
  const code=response.status===401||response.status===403?'PLATFORM_MAIL_AUTH_FAILED':response.status===429?'PLATFORM_MAIL_RATE_LIMITED':'PLATFORM_MAIL_PROVIDER_ERROR';
  return {delivered:false,errorCode:code};
 }
 return {delivered:true};
}

/**
 * The single real send path every helper below funnels through (Part 12/15/54). Never claims
 * `delivered:true` unless the chosen transport actually accepted the message; a caller (e.g.
 * the email-verification route) must treat `delivered:false` as "do not tell the user
 * verification mail was sent" — see `docs/EMAIL_VERIFICATION.md`.
 */
export async function sendPlatformMail({db,env,fetcher=fetch},{kind,to,subject,html,text}) {
 const now=new Date().toISOString();
 const status=platformMailStatus(env);
 let result;
 if(status.status==='UNCONFIGURED')result={delivered:false,errorCode:'PLATFORM_MAIL_UNCONFIGURED'};
 else if(status.transport==='capture')result={delivered:true};
 else result=await sendViaResend({env,fetcher},{to,subject,html,text});
 db.prepare('INSERT INTO platform_mail_outbox (id,kind,to_email,subject,status,sent_at,last_send_error_code,captured_body,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
  .run(randomUUID(),kind,to,subject,result.delivered?'SENT':'FAILED',result.delivered?now:null,result.errorCode||null,status.transport==='capture'?JSON.stringify({subject,html,text}):null,now);
 return result;
}

// --- Minimal transactional templates (Part 44) — no marketing copy, bilingual by locale -----

const L=(locale,ar,en)=>locale==='en'?en:ar;

export function renderVerificationEmail(locale,{verifyUrl}) {
 return {
  subject:L(locale,'تأكيد بريدك الإلكتروني — Frost','Verify your email — Frost'),
  text:L(locale,`لتأكيد بريدك الإلكتروني، افتح هذا الرابط خلال 45 دقيقة:\n${verifyUrl}\n\nإن لم تطلب هذا فتجاهل هذه الرسالة.`,`To verify your email, open this link within 45 minutes:\n${verifyUrl}\n\nIf you did not request this, ignore this message.`),
  html:`<p>${L(locale,'لتأكيد بريدك الإلكتروني، افتح هذا الرابط خلال 45 دقيقة:','To verify your email, open this link within 45 minutes:')}</p><p><a href="${verifyUrl}">${verifyUrl}</a></p><p>${L(locale,'إن لم تطلب هذا فتجاهل هذه الرسالة.','If you did not request this, ignore this message.')}</p>`
 };
}
export function renderPasswordResetEmail(locale,{resetUrl}) {
 return {
  subject:L(locale,'إعادة تعيين كلمة المرور — Frost','Reset your password — Frost'),
  text:L(locale,`لإعادة تعيين كلمة المرور، افتح هذا الرابط خلال 30 دقيقة:\n${resetUrl}\n\nإن لم تطلب هذا فتجاهل هذه الرسالة — كلمة مرورك لن تتغيّر.`,`To reset your password, open this link within 30 minutes:\n${resetUrl}\n\nIf you did not request this, ignore this message — your password will not change.`),
  html:`<p>${L(locale,'لإعادة تعيين كلمة المرور، افتح هذا الرابط خلال 30 دقيقة:','To reset your password, open this link within 30 minutes:')}</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>${L(locale,'إن لم تطلب هذا فتجاهل هذه الرسالة — كلمة مرورك لن تتغيّر.','If you did not request this, ignore this message — your password will not change.')}</p>`
 };
}
export function renderInvitationEmail(locale,{workspaceName,acceptUrl,role}) {
 return {
  subject:L(locale,`دعوة للانضمام إلى ${workspaceName} على Frost`,`Invitation to join ${workspaceName} on Frost`),
  text:L(locale,`تمت دعوتك للانضمام إلى "${workspaceName}" بدور ${role}. افتح هذا الرابط لقبول الدعوة:\n${acceptUrl}`,`You have been invited to join "${workspaceName}" as ${role}. Open this link to accept:\n${acceptUrl}`),
  html:`<p>${L(locale,`تمت دعوتك للانضمام إلى "${workspaceName}" بدور ${role}.`,`You have been invited to join "${workspaceName}" as ${role}.`)}</p><p><a href="${acceptUrl}">${acceptUrl}</a></p>`
 };
}
export function renderSecurityNoticeEmail(locale,{message}) {
 return {
  subject:L(locale,'تنبيه أمني على حسابك — Frost','Security notice for your account — Frost'),
  text:message,
  html:`<p>${message}</p>`
 };
}

export async function sendVerificationEmail(ctx,{to,locale,verifyUrl}) {
 const {subject,html,text}=renderVerificationEmail(locale,{verifyUrl});
 return sendPlatformMail(ctx,{kind:'VERIFY_EMAIL',to,subject,html,text});
}
export async function sendPasswordResetEmail(ctx,{to,locale,resetUrl}) {
 const {subject,html,text}=renderPasswordResetEmail(locale,{resetUrl});
 return sendPlatformMail(ctx,{kind:'PASSWORD_RESET',to,subject,html,text});
}
export async function sendInvitationEmail(ctx,{to,locale,workspaceName,acceptUrl,role}) {
 const {subject,html,text}=renderInvitationEmail(locale,{workspaceName,acceptUrl,role});
 return sendPlatformMail(ctx,{kind:'INVITATION',to,subject,html,text});
}
export async function sendSecurityNotice(ctx,{to,locale,message}) {
 const {subject,html,text}=renderSecurityNoticeEmail(locale,{message});
 return sendPlatformMail(ctx,{kind:'SECURITY_NOTICE',to,subject,html,text});
}
