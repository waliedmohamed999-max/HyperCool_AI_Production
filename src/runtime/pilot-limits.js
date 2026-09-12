// Multi-Tenant Phase 4C-7 (Part 4) — conservative, configurable pilot-scale abuse limits.
// Simple in-memory counters, matching every rate limiter already in this codebase (auth.js's
// login limiter, invitations.js's token limiter, platform-identity.js's signup/verification
// limiters) — no Redis, no persistence. A process restart clears them, which is acceptable at
// pilot scale (1-3 real companies) and explicitly documented as a limitation in
// docs/PILOT_RUNBOOK.md rather than hidden. Every limit is OFF unless explicitly configured
// (an unset/invalid env value never silently caps anything) — these are additive pilot
// safety valves on top of the per-IP rate limiters that already exist, not a replacement.
import {fail} from '../auth.js';

function positiveIntEnv(value) {
 const n=Number(value);
 return Number.isInteger(n) && n>0 ? n : null;
}

let signupWindow={count:0,windowStart:Date.now()};
/** A GLOBAL (not per-IP) cap on total signups per hour across the whole platform — a distinct
 * safety valve from `checkSignupRateLimit`'s per-IP throttle, meant to catch a burst spread
 * across many different source IPs during a pilot. */
export function checkGlobalSignupLimit(env) {
 const max=positiveIntEnv(env.MAX_SIGNUPS_PER_HOUR);
 if(!max)return;
 const now=Date.now();
 if(now-signupWindow.windowStart>3600000)signupWindow={count:0,windowStart:now};
 if(signupWindow.count>=max)fail(429,'تم الوصول للحد الأقصى من التسجيلات هذه الساعة على مستوى المنصة');
 signupWindow.count++;
}

const workspacesPerIpPerDay=new Map();
/** Per-IP daily cap on workspace CREATION specifically — separate from
 * `SELF_SERVICE_MAX_OWNED_WORKSPACES` (a per-USER, permanent cap): this guards against one
 * source repeatedly registering fresh accounts to keep creating workspaces. */
export function checkWorkspaceCreationIpLimit(env,ip) {
 const max=positiveIntEnv(env.MAX_WORKSPACES_PER_IP_PER_DAY);
 if(!max)return;
 const now=Date.now();
 const entry=workspacesPerIpPerDay.get(ip);
 if(entry && now-entry.windowStart>86400000)workspacesPerIpPerDay.delete(ip);
 const current=workspacesPerIpPerDay.get(ip);
 if(current && current.count>=max)fail(429,'تم الوصول للحد الأقصى من المنشآت المُنشأة من هذا العنوان اليوم');
 workspacesPerIpPerDay.set(ip,{count:(current?.count||0)+1,windowStart:current?.windowStart||now});
}

/** A platform-wide ceiling on how many TRIAL tenants may exist at once — the real, direct
 * enforcement of "run 1-3 real companies" during a pilot, checked against the live table
 * rather than a counter that could drift. */
export function checkTotalTrialWorkspacesLimit(db,env) {
 const max=positiveIntEnv(env.MAX_TOTAL_TRIAL_WORKSPACES);
 if(!max)return;
 const {n}=db.prepare("SELECT COUNT(*) n FROM tenants WHERE status='TRIAL'").get();
 if(n>=max)fail(403,'تم الوصول للحد الأقصى من المنشآت التجريبية المسموح بها على هذه المنصة حاليًا');
}
