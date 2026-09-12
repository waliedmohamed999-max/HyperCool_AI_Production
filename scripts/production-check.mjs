// Multi-Tenant Phase 4C-7 (Part 51) — a real, honest pre-launch config checker. Never prints
// a secret value, only whether one is present/well-formed. Exit code 1 if any BLOCKER is
// found (safe to wire into a deploy pipeline); WARN items never fail the exit code, since
// several are genuinely optional (mail, CAPTCHA) and the app boots and works without them.
import {loadEnvFile} from 'node:process';
import {fileURLToPath} from 'node:url';

try { loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url))); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const env = process.env;
const results = [];
const blocker = (name, ok, detail) => results.push({ level: 'BLOCKER', name, ok, detail });
const warn = (name, ok, detail) => results.push({ level: 'WARN', name, ok, detail });
const info = (name, detail) => results.push({ level: 'INFO', name, ok: true, detail });

blocker('NODE_ENV=production', env.NODE_ENV === 'production', env.NODE_ENV === 'production' ? 'ok' : `NODE_ENV is '${env.NODE_ENV || '(unset)'}' — CAPTCHA dev-bypass and other dev-only paths stay open until this is exactly 'production'`);

const key = env.INTEGRATION_ENCRYPTION_KEY || '';
const validKey = /^[0-9a-fA-F]{64}$/.test(key) || (() => { try { return Buffer.from(key, 'base64').length === 32; } catch { return false; } })();
blocker('INTEGRATION_ENCRYPTION_KEY', !!key && validKey, key ? (validKey ? 'ok' : 'set but not 32 bytes hex/base64 — every OAuth-connected integration will fail to store credentials') : 'not set — required the moment any tenant connects an OAuth integration (Salla/Meta/Microsoft/X/LinkedIn)');

blocker('PUBLIC_ORIGIN', !!env.PUBLIC_ORIGIN, env.PUBLIC_ORIGIN ? `${env.PUBLIC_ORIGIN} — used for cookie Secure flag and every emailed link` : 'not set — session cookies will NOT get the Secure flag, and localhost-only Host validation stays active');
if (env.PUBLIC_ORIGIN) {
 let parsed = null; try { parsed = new URL(env.PUBLIC_ORIGIN); } catch {}
 blocker('PUBLIC_ORIGIN is a clean HTTPS origin', !!parsed && parsed.protocol === 'https:' && parsed.pathname === '/' && !parsed.search && !parsed.hash, parsed ? (parsed.protocol === 'https:' ? 'ok' : 'must be https://') : 'not a valid URL');
}

const mailConfigured = env.PLATFORM_MAIL_TRANSPORT === 'capture' || (!!env.PLATFORM_RESEND_API_KEY && !!env.PLATFORM_MAIL_FROM);
warn('Platform Mail', mailConfigured, mailConfigured ? (env.PLATFORM_MAIL_TRANSPORT === 'capture' ? 'transport=capture — NEVER use this in a real deployment, dev/test only' : 'ok (resend)') : 'unconfigured — verification/reset/invitation emails will not actually send; every send attempt is safely reported as not delivered, never a crash');
if (env.PLATFORM_MAIL_TRANSPORT === 'capture') blocker('PLATFORM_MAIL_TRANSPORT != capture in production', false, 'capture stores full email bodies (including real links) in the database — must never be set in a real deployment');

warn('AI provider configured', !!(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY), (env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY) ? 'at least one of Anthropic/OpenAI is set at the platform level (a tenant can still add its own)' : 'no platform-level AI key — every tenant must configure their own via Control Center before any agent can run');

const captchaProvider = env.CAPTCHA_PROVIDER;
if (captchaProvider) {
 blocker('CAPTCHA secret present for configured provider', captchaProvider === 'turnstile' ? !!env.TURNSTILE_SECRET_KEY : false, captchaProvider === 'turnstile' ? (env.TURNSTILE_SECRET_KEY ? 'ok' : 'CAPTCHA_PROVIDER=turnstile but TURNSTILE_SECRET_KEY is missing — every gated request will be rejected as CAPTCHA_MISCONFIGURED') : `unknown provider '${captchaProvider}'`);
} else {
 warn('Bot protection (CAPTCHA)', false, 'DISABLED — no provider configured; acceptable for a small, known pilot audience, a real risk for open public signup at scale');
}

const platformAdmins = String(env.PLATFORM_ADMIN_USERNAMES || '').split(',').map(s => s.trim()).filter(Boolean);
warn('PLATFORM_ADMIN_USERNAMES set', platformAdmins.length > 0, platformAdmins.length ? `${platformAdmins.length} configured` : 'empty — #platform is unreachable for everyone; intentional only if this deployment does not need the platform dashboard yet');

info('ALLOW_PUBLIC_SIGNUP', env.ALLOW_PUBLIC_SIGNUP === 'false' ? 'false (invite-only accounts)' : 'true/default (open public signup)');
info('ALLOW_SELF_SERVICE_WORKSPACE_CREATION', env.ALLOW_SELF_SERVICE_WORKSPACE_CREATION === 'false' ? 'false (no self-service workspace creation)' : 'true/default');
info('TRIAL_DAYS', env.TRIAL_DAYS || '14 (default)');
info('SELF_SERVICE_MAX_OWNED_WORKSPACES', env.SELF_SERVICE_MAX_OWNED_WORKSPACES || '1 (default)');
info('MAX_TOTAL_TRIAL_WORKSPACES', env.MAX_TOTAL_TRIAL_WORKSPACES || '(no cap)');
info('MAX_SIGNUPS_PER_HOUR', env.MAX_SIGNUPS_PER_HOUR || '(no cap beyond per-IP limiter)');
info('MAX_WORKSPACES_PER_IP_PER_DAY', env.MAX_WORKSPACES_PER_IP_PER_DAY || '(no cap)');

for (const flag of ['ENABLE_EXTERNAL_MESSAGING', 'ENABLE_EXTERNAL_PUBLISHING', 'ENABLE_AUTOMATED_FOLLOWUPS', 'ENABLE_SCHEDULED_PUBLISHING', 'ENABLE_L2_AUTONOMY', 'ENABLE_L3_AUTONOMY']) {
 const defaultOff = flag === 'ENABLE_L2_AUTONOMY' || flag === 'ENABLE_L3_AUTONOMY';
 const effective = env[flag] === 'true' ? true : env[flag] === 'false' ? false : !defaultOff;
 info(flag, `${effective} ${env[flag] ? '(explicit)' : '(default)'}`);
}
warn('DATA_DIR set explicitly', !!env.DATA_DIR, env.DATA_DIR ? env.DATA_DIR : 'unset — defaults to a path inside the repo itself; must be outside any deploy/release folder that gets wiped on redeploy (see hostinger-deployment.md)');

// Phase 6F, Part 81 — Universal Integration Platform production readiness. Never a secret
// VALUE, only presence/completeness — same discipline as every other check above.
//
// Phase 6G update: the Draft->Submit->Review->Approve/Reject/Request-Changes workflow, per-
// tenant limits, forbidden-capability/SSRF/write-approval policy are now REAL (see
// src/connectors/dynamic/tenant-custom.js, docs/TENANT_CUSTOM_CONNECTORS.md) — the flag
// genuinely gates a real code path today, unlike Phase 6F's own honest "gates nothing" note.
const tenantCustomConnectorsEnabled = env.ENABLE_TENANT_CUSTOM_CONNECTORS === 'true';
info('ENABLE_TENANT_CUSTOM_CONNECTORS', `${tenantCustomConnectorsEnabled} (default false)${tenantCustomConnectorsEnabled ? ' — real Draft/Review/Approve governance is implemented (Phase 6G); still missing: a Platform-Admin UI to change MAX_CUSTOM_CONNECTORS_PER_TENANT per-tenant (env-wide only today) and a failed/rejected-history view for the tenant' : ''}`);
if (tenantCustomConnectorsEnabled) {
 const maxCustom = Number(env.MAX_CUSTOM_CONNECTORS_PER_TENANT);
 info('MAX_CUSTOM_CONNECTORS_PER_TENANT', Number.isFinite(maxCustom) && maxCustom > 0 ? String(maxCustom) : '3 (default)');
}

const zidVars = ['ZID_CLIENT_ID', 'ZID_CLIENT_SECRET', 'ZID_REDIRECT_URI'];
const zidPresent = zidVars.filter(v => !!env[v]);
if (zidPresent.length > 0 && zidPresent.length < zidVars.length) blocker('Zid OAuth fully configured', false, `partially set (${zidPresent.join(', ')}) — all three of ${zidVars.join('/')} are required together or Zid connect will fail for every tenant`);
else info('Zid OAuth', zidPresent.length === zidVars.length ? 'fully configured' : 'not configured — Zid tools stay INTEGRATION_REQUIRED until a tenant connects');

// Every generic/dynamic connector's webhook auth (HMAC/header-token/shared-secret) is stored
// per-CONNECTION in the Vault (never in an env var) — there is deliberately nothing platform-
// wide to validate here beyond INTEGRATION_ENCRYPTION_KEY (already checked above), which is
// what protects every one of those per-connection secrets at rest.
info('Dynamic connector webhook security', 'per-connection, Vault-encrypted (no platform-wide webhook secret env var exists or is needed)');
// Phase 6G — Webhook Console operational readiness: URL/secret rotation and Safe Reprocess all
// reuse INTEGRATION_ENCRYPTION_KEY (already validated above) and the same per-connection Vault
// row; nothing platform-wide to configure beyond that.
info('Webhook Console operations (rotation/reprocess)', 'ready — reuses INTEGRATION_ENCRYPTION_KEY and the per-connection Vault, no separate configuration');

// Phase 6G, Part 18-24 — the Generic OAuth2 Framework. A Platform-Admin-authored GENERIC_REST
// OAuth2 connector references its real client id/secret only by ENV VAR NAME
// (clientIdEnvKey/clientSecretEnvKey, stored on the connector definition — never a value this
// script could discover ahead of time without opening the tenant database, which this
// env-only checker deliberately never does, matching every other check above). A connector
// whose referenced env vars are missing fails safely and honestly at connect time
// (GENERIC_OAUTH2_NOT_CONFIGURED) rather than silently — this is an architectural guarantee,
// not something this script can additionally verify from env alone.
info('Generic OAuth2 Framework (Phase 6G)', 'ready — each connector references its client id/secret by env var NAME only; a missing referenced var fails safely at connect time (GENERIC_OAUTH2_NOT_CONFIGURED), never silently');

console.log('\n=== HyperCool Production Config Check ===\n');
let hasBlocker = false;
for (const r of results) {
 if (r.level === 'BLOCKER' && !r.ok) hasBlocker = true;
 const mark = r.level === 'INFO' ? 'ℹ' : r.ok ? '✔' : (r.level === 'BLOCKER' ? '✖' : '⚠');
 console.log(`${mark} [${r.level}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}
console.log(`\n${hasBlocker ? 'BLOCKERS FOUND — do not launch until resolved.' : 'No blockers found.'}\n`);
process.exit(hasBlocker ? 1 : 0);
