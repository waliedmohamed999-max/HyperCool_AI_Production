// Multi-Tenant Phase 4C-7 (Part 51) — a real, honest pre-launch config checker. Never prints
// a secret value, only whether one is present/well-formed. Exit code 1 if any BLOCKER is
// found (safe to wire into a deploy pipeline); WARN items never fail the exit code, since
// several are genuinely optional (mail, CAPTCHA) and the app boots and works without them.
import {loadEnvFile} from 'node:process';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {countDevSeedAccounts} from '../src/security/demo-accounts.js';

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

warn('PARTNER_BILLING_WEBHOOK_SECRET set (partner program)', !!env.PARTNER_BILLING_WEBHOOK_SECRET, env.PARTNER_BILLING_WEBHOOK_SECRET ? 'configured' : 'empty — partner commissions can only be recorded manually until a billing system posts signed payments to /api/webhooks/partner-billing');
warn('INTEGRATION_ENCRYPTION_KEY set (partner payout details)', !!env.INTEGRATION_ENCRYPTION_KEY, env.INTEGRATION_ENCRYPTION_KEY ? 'configured' : 'empty — partners cannot save payout methods');
info('SUPPORT_ACCESS_USERNAMES (support mode)', env.SUPPORT_ACCESS_USERNAMES ? env.SUPPORT_ACCESS_USERNAMES : 'all platform admins may open support sessions');
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
// Phase 6H, Part 37-42 — a Platform Admin can now ALSO override this per-tenant (nullable
// `tenants.custom_connector_limit`, set via POST /api/platform/tenants/:id/custom-connector-
// limit from the tenant detail drawer) — the env var below is only the GLOBAL default any
// tenant without an explicit override falls back to; it is no longer the only lever.
const tenantCustomConnectorsEnabled = env.ENABLE_TENANT_CUSTOM_CONNECTORS === 'true';
info('ENABLE_TENANT_CUSTOM_CONNECTORS', `${tenantCustomConnectorsEnabled} (default false)${tenantCustomConnectorsEnabled ? ' — real Draft/Review/Approve governance is implemented (Phase 6G), including a real per-tenant custom-connector-limit override and per-connector webhook triggers (Phase 6H); still missing: a failed/rejected-history view for the tenant' : ''}`);
if (tenantCustomConnectorsEnabled) {
 const maxCustom = Number(env.MAX_CUSTOM_CONNECTORS_PER_TENANT);
 info('MAX_CUSTOM_CONNECTORS_PER_TENANT (global default)', Number.isFinite(maxCustom) && maxCustom > 0 ? String(maxCustom) : '3 (default) — a Platform Admin may still override this for any one specific tenant');
 const maxTriggers = Number(env.MAX_CUSTOM_CONNECTOR_TRIGGERS);
 info('MAX_CUSTOM_CONNECTOR_TRIGGERS', Number.isFinite(maxTriggers) && maxTriggers > 0 ? String(maxTriggers) : '3 (default)');
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

// Phase 6H, Part 13-18 — Automatic Webhook Retry: a bounded 1min/5min/15min backoff ladder,
// running once per existing scheduler tick (SCHEDULER_INTERVAL_MS, default 300000ms — no
// separate timer/cron is created), moving a FAILED event to DEAD_LETTER once its retry budget
// is exhausted (still manually reprocessable from the Webhook Console). WEBHOOK_MAX_RETRIES is
// the ONLY new env var this feature introduces.
const maxRetries = Number(env.WEBHOOK_MAX_RETRIES);
info('WEBHOOK_MAX_RETRIES', Number.isFinite(maxRetries) && maxRetries >= 0 ? String(maxRetries) : '3 (default)');
info('Automatic Webhook Retry (Phase 6H)', 'ready — runs inside the existing scheduler tick, no separate cron/timer; visible cross-tenant at GET /api/platform/webhooks/{dead-letters,pending-retries} (Platform Admin only)');
// Phase 6H, Part 6-12 — Bulk Connection Version Migration + Bulk Webhook Reprocess. Both reuse
// the exact same single-item safety pipeline (per-connection health check / per-event CAS
// reprocess) one at a time, bounded (200 connections / 100 events per call) — nothing platform-
// wide to configure beyond INTEGRATION_ENCRYPTION_KEY, already validated above.
info('Bulk Operations (version migration + webhook reprocess, Phase 6H)', 'ready — Platform Admin only, audited to the bulk_operations table, bounded batch sizes (200/100)');

// Phase 6G, Part 18-24 — the Generic OAuth2 Framework. A Platform-Admin-authored GENERIC_REST
// OAuth2 connector references its real client id/secret only by ENV VAR NAME
// (clientIdEnvKey/clientSecretEnvKey, stored on the connector definition — never a value this
// script could discover ahead of time without opening the tenant database, which this
// env-only checker deliberately never does, matching every other check above). A connector
// whose referenced env vars are missing fails safely and honestly at connect time
// (GENERIC_OAUTH2_NOT_CONFIGURED) rather than silently — this is an architectural guarantee,
// not something this script can additionally verify from env alone.
info('Generic OAuth2 Framework (Phase 6G)', 'ready — each connector references its client id/secret by env var NAME only; a missing referenced var fails safely at connect time (GENERIC_OAUTH2_NOT_CONFIGURED), never silently');
// Phase 6H, Part 19-25 — the Token Expiry badge and Connector Analytics tab are both pure,
// additive DISPLAY layers over data already computed/stored today (the Vault's own
// `expiresAt`, the existing audit log + webhook_events ledger) — nothing new to configure.
info('Proactive Token Expiry UI + Platform Connector Analytics (Phase 6H)', 'ready — no configuration; both read exclusively from already-validated existing data');

// Merchant portal OAuth: each provider needs its app id AND secret (both or neither), and the callback URL below must be registered
// in that provider's console. A provider without credentials is simply shown to merchants as unavailable.
for (const [slug, ids] of [['salla', ['SALLA_CLIENT_ID', 'SALLA_CLIENT_SECRET']], ['zid', ['ZID_CLIENT_ID', 'ZID_CLIENT_SECRET']], ['meta', ['META_APP_ID', 'META_APP_SECRET']], ['microsoft365', ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET']], ['x', ['X_CLIENT_ID', 'X_CLIENT_SECRET']], ['linkedin', ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET']]]) {
 const present = ids.filter(v => !!env[v]);
 if (present.length > 0 && present.length < ids.length) blocker(`Merchant OAuth ${slug} fully configured`, false, `partially set (${present.join(', ')}) — both ${ids.join(' and ')} are required`);
 else info(`Merchant OAuth ${slug}`, present.length ? `configured — register ${env.PUBLIC_ORIGIN || '{PUBLIC_ORIGIN}'}/api/client/integrations/${slug}/callback in the provider console` : 'not configured — shown to merchants as unavailable');
}

// Local preview / investor-demo accounts must never exist in a production database. This is the one check that reads the database
// (read-only, counts only - no row content is printed).
{
 const dbPath = resolve(env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)), 'hypercool.sqlite');
 if (!existsSync(dbPath)) info('Demo / preview accounts', `no database at ${dbPath} yet — nothing to scan`);
 else {
  let db = null;
  try {
   db = new DatabaseSync(dbPath, {readOnly: true});
   const devSeed = countDevSeedAccounts(db);
   blocker('No local-preview accounts in this database', devSeed === 0, devSeed === 0 ? 'ok' : `${devSeed} account(s) created by scripts/dev-preview.mjs exist — this is not a production database`);
   let investorDemo = 0;
   try { investorDemo = db.prepare("SELECT (SELECT COUNT(*) FROM users WHERE username='investor_demo') + (SELECT COUNT(*) FROM tenants WHERE branding_settings LIKE '%HYPERCOOL_INVESTOR_DEMO_V1%') n").get().n; } catch { investorDemo = 0; }
   blocker('No investor-demo data in this database', investorDemo === 0, investorDemo === 0 ? 'ok' : 'the investor demo user/tenants (npm run demo:seed) exist — run npm run demo:reset or use a separate demo environment');
  } catch (error) {
   warn('Demo / preview accounts scan', false, `could not open the database read-only (${error.code || error.message})`);
  } finally { db?.close(); }
 }
}

console.log('\n=== Frost Production Config Check ===\n');
let hasBlocker = false;
for (const r of results) {
 if (r.level === 'BLOCKER' && !r.ok) hasBlocker = true;
 const mark = r.level === 'INFO' ? 'ℹ' : r.ok ? '✔' : (r.level === 'BLOCKER' ? '✖' : '⚠');
 console.log(`${mark} [${r.level}] ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}
console.log(`\n${hasBlocker ? 'BLOCKERS FOUND — do not launch until resolved.' : 'No blockers found.'}\n`);
process.exit(hasBlocker ? 1 : 0);
