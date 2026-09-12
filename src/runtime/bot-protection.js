// Multi-Tenant Phase 4C-7 — Bot Protection abstraction. `DISABLED` by default (no provider
// configured — nothing here changes behavior for a deployment that never asked for it).
// Deliberately not hard-coupled to one vendor: `verifyBotProtection` is the only entry point
// every gated route calls, and it never leaks which provider (or why exactly) a check failed
// beyond a safe, generic code. Real, production-friendly provider: Cloudflare Turnstile — a
// plain HTTPS siteverify API, no SDK dependency, the same idiom as every other external call
// in this codebase (connectors.js's Anthropic/OpenAI test calls).
const REQUIRE_ENV_KEY={signup:'CAPTCHA_REQUIRE_SIGNUP',forgotPassword:'CAPTCHA_REQUIRE_FORGOT_PASSWORD',workspaceCreation:'CAPTCHA_REQUIRE_WORKSPACE_CREATION'};
// Signup defaults to required the moment a provider IS configured (Part 7: the primary bot
// target); the two "optionally" surfaces default OFF until explicitly turned on per Part 7.
const DEFAULT_ON={signup:true};

export function botProtectionStatus(env) {
 if(!env.CAPTCHA_PROVIDER)return {status:'DISABLED',provider:null};
 if(env.CAPTCHA_PROVIDER==='turnstile' && env.TURNSTILE_SECRET_KEY)return {status:'CONFIGURED',provider:'turnstile'};
 return {status:'ERROR',provider:env.CAPTCHA_PROVIDER}; // a provider was named but its secret is missing — a real, honest misconfiguration, not silently treated as disabled
}
/** Part 7 — per-surface, independently configurable; never required from an already-
 * authenticated user on every action (this is only ever called from public/self-service
 * routes). */
export function captchaRequiredFor(env,surface) {
 if(botProtectionStatus(env).status!=='CONFIGURED')return false;
 const key=REQUIRE_ENV_KEY[surface];
 if(!key)return false;
 const raw=env[key];
 if(raw==='true')return true;
 if(raw==='false')return false;
 return !!DEFAULT_ON[surface];
}

async function verifyTurnstile({env,fetcher=fetch},token,remoteIp) {
 try {
  const response=await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify',{
   method:'POST',
   headers:{'content-type':'application/x-www-form-urlencoded'},
   body:new URLSearchParams({secret:env.TURNSTILE_SECRET_KEY,response:token,...(remoteIp?{remoteip:remoteIp}:{})}),
   signal:AbortSignal.timeout(10000)
  });
  if(!response.ok)return {success:false,errorCode:'CAPTCHA_PROVIDER_ERROR'};
  const data=await response.json().catch(()=>({success:false}));
  return {success:!!data.success,errorCode:data.success?null:(Array.isArray(data['error-codes'])?data['error-codes'][0]:'CAPTCHA_VERIFICATION_FAILED')};
 } catch {
  return {success:false,errorCode:'CAPTCHA_PROVIDER_ERROR'};
 }
}

/**
 * The one real entry point every gated route calls (Part 8) — never throws; callers decide
 * their own status code. Missing/invalid token is rejected BEFORE any user/workspace mutation
 * happens (the caller must check this first). Never exposes provider internals — only the
 * safe generic codes above ever reach the client.
 *
 * Part 9 — development/test bypass: only reachable when `env.NODE_ENV!=='production'` AND the
 * literal token `'DEV_BYPASS'` is sent. No bypass secret is shipped to the frontend or stored
 * anywhere; a real deployment simply never sets `NODE_ENV` to anything but `'production'`
 * (enforced by the production config checker, `scripts/production-check.mjs`), which closes
 * this path completely there — there is no separate "prod bypass" flag to accidentally leave on.
 */
export async function verifyBotProtection({env,fetcher=fetch},token,remoteIp) {
 const status=botProtectionStatus(env);
 if(status.status==='DISABLED')return {ok:true};
 if(status.status==='ERROR')return {ok:false,errorCode:'CAPTCHA_MISCONFIGURED'};
 if(env.NODE_ENV!=='production' && token==='DEV_BYPASS')return {ok:true};
 if(typeof token!=='string' || !token)return {ok:false,errorCode:'CAPTCHA_REQUIRED'};
 const result=await verifyTurnstile({env,fetcher},token,remoteIp);
 return result.success?{ok:true}:{ok:false,errorCode:result.errorCode};
}
