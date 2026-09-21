// Local development preview: starts the app on a THROWAWAY database and creates one demo account per surface (platform admin, partner,
// merchant, referred customer) so the dashboards can be looked at with real data.
//
// It is refused anywhere near production, it never touches ./data or any existing database, and it contains no fixed passwords:
// every password is generated when the script starts and printed once to this terminal only.
//
//   ALLOW_DEV_SEED=1 node scripts/dev-preview.mjs        (or: ALLOW_DEV_SEED=1 npm run dev:preview)
//
// Optional: DEV_PREVIEW_PORT (default 3100), DEV_PREVIEW_DIR (must be empty or a previous preview directory).
import {createHmac, randomBytes} from 'node:crypto';
import {existsSync, readdirSync, writeFileSync} from 'node:fs';
import {mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DEV_SEED_EMAIL_DOMAIN, DEV_SEED_USERNAME_PREFIX} from '../src/security/demo-accounts.js';

const refuse = message => { console.error(`[dev-preview] Refusing to run: ${message}`); process.exit(1); };
if (process.env.ALLOW_DEV_SEED !== '1') refuse('set ALLOW_DEV_SEED=1 to confirm this is a local development machine.');
if (process.env.NODE_ENV === 'production') refuse('NODE_ENV=production.');
if (process.env.PUBLIC_ORIGIN) refuse('PUBLIC_ORIGIN is set (this looks like a deployed environment).');

const repoData = resolve(fileURLToPath(new URL('../data/', import.meta.url)));
const dir = resolve(process.env.DEV_PREVIEW_DIR || join(tmpdir(), 'frost-dev-preview'));
const MARKER = '.frost-dev-preview';
if (dir === repoData || dir.startsWith(repoData)) refuse('the preview directory must not be the application data directory.');
if (existsSync(dir) && readdirSync(dir).length && !existsSync(join(dir, MARKER))) refuse(`${dir} is not empty and is not a previous dev preview directory.`);
await rm(dir, {recursive: true, force: true});
await mkdir(dir, {recursive: true});
writeFileSync(join(dir, MARKER), 'throwaway database created by scripts/dev-preview.mjs\n');

const {createApp} = await import('../src/application.js');
const password = () => `${randomBytes(9).toString('base64url')}-Aa1!`;
const secret = randomBytes(16).toString('hex');
const accounts = {
 admin: {username: `${DEV_SEED_USERNAME_PREFIX}admin`, password: password()},
 partner: {username: `${DEV_SEED_USERNAME_PREFIX}partner`, password: password()},
 merchant: {username: `${DEV_SEED_USERNAME_PREFIX}merchant`, password: password()},
 customer: {username: `${DEV_SEED_USERNAME_PREFIX}customer`, password: password()}
};
const email = name => `${name}@${DEV_SEED_EMAIL_DOMAIN}`;
const app = await createApp({dataDir: dir, env: {PLATFORM_MAIL_TRANSPORT: 'capture', PLATFORM_ADMIN_USERNAMES: accounts.admin.username, INTEGRATION_ENCRYPTION_KEY: randomBytes(32).toString('hex'), PARTNER_BILLING_WEBHOOK_SECRET: secret}});
const port = Number(process.env.DEV_PREVIEW_PORT) || 3100;
await new Promise(r => app.server.listen(port, '127.0.0.1', r));
const base = `http://127.0.0.1:${port}`;
const db = app.store.db;
const post = async (path, body, session, headers = {}) => {
 const res = await fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json', ...(session ? {cookie: session.cookie, 'x-csrf-token': session.csrf} : {}), ...headers}, body: JSON.stringify(body)});
 const data = await res.json().catch(() => ({}));
 return {status: res.status, data, cookie: res.headers.get('set-cookie')?.split(';')[0]};
};
async function verify(address) {
 const row = db.prepare("SELECT captured_body FROM platform_mail_outbox WHERE to_email=? AND kind='VERIFY_EMAIL' ORDER BY created_at DESC LIMIT 1").get(address);
 const body = JSON.parse(row.captured_body);
 await post('/api/account/email/verify', {token: (body.html + body.text).match(/verify-email\/([a-f0-9]+)/)[1]});
}

const a = await post('/api/signup', {name: 'Preview Admin', username: accounts.admin.username, email: email('admin'), password: accounts.admin.password});
await verify(email('admin'));
const admin = {cookie: a.cookie, csrf: a.data.csrf};
await post('/api/workspaces', {companyName: 'Preview Workspace'}, admin);

const reg = await post('/api/partners/register', {name: 'Preview Partner', username: accounts.partner.username, email: email('partner'), password: accounts.partner.password, fullName: 'Preview Partner', phone: '+966500000001', country: 'SA', partnerType: 'agency', marketingMethod: 'Instagram campaigns and an e-commerce newsletter.', expectedCustomers: 20, acceptTerms: true});
await verify(email('partner'));
const plan = db.prepare("SELECT id FROM partner_plans WHERE slug='professional'").get().id;
await post(`/api/partners/admin/applications/${reg.data.application.id}/decision`, {decision: 'approve', planId: plan}, admin);
await fetch(base + '/api/partners/admin/settings', {method: 'PUT', headers: {'Content-Type': 'application/json', cookie: admin.cookie, 'x-csrf-token': admin.csrf}, body: JSON.stringify({commission_hold_days: 0, min_payout: '10.00'})});
const code = db.prepare('SELECT referral_code FROM partner_profiles').get().referral_code;
const click = await fetch(`${base}/r/${code}`, {redirect: 'manual'});
await post('/api/signup', {name: 'Preview Customer', username: accounts.customer.username, email: email('customer'), password: accounts.customer.password}, null, {cookie: click.headers.get('set-cookie').split(';')[0]});
await verify(email('customer'));
const payload = JSON.stringify({id: 'preview-pay-1', type: 'payment_succeeded', customer: {email: email('customer')}, planRef: 'pro', amountMinor: 30000, currency: 'SAR', occurredAt: new Date().toISOString()});
await fetch(base + '/api/webhooks/partner-billing', {method: 'POST', headers: {'Content-Type': 'application/json', 'x-frost-signature': 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex')}, body: payload});

const m = await post('/api/client/register', {name: 'Preview Merchant', username: accounts.merchant.username, email: email('merchant'), password: accounts.merchant.password, businessName: 'Preview Store', phone: '+966500000100', country: 'SA', businessType: 'retail', businessSize: 'small', ecommercePlatform: 'salla', teamSize: 3, goals: ['content', 'grow_sales'], planSlug: 'growth', acceptTerms: true, locale: 'en'});
if (m.status !== 201) refuse(`merchant registration failed (${m.status}).`);
await verify(email('merchant'));

console.log(`\n[dev-preview] throwaway database: ${dir}\n[dev-preview] ready on ${base}\n`);
console.log('  surface                       address                         username                     password');
console.log(`  platform admin (dashboard)    ${base}/app                 ${accounts.admin.username.padEnd(28)} ${accounts.admin.password}`);
console.log(`  partner portal                ${base}/partners/login        ${accounts.partner.username.padEnd(28)} ${accounts.partner.password}`);
console.log(`  merchant portal               ${base}/client/login          ${accounts.merchant.username.padEnd(28)} ${accounts.merchant.password}`);
console.log(`  referred customer (dashboard) ${base}/app                 ${accounts.customer.username.padEnd(28)} ${accounts.customer.password}`);
console.log('\nPasswords exist only in this terminal. Stop the script to discard everything.\n');
