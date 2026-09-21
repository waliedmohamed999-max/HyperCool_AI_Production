import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ACCESS_CLASSES, ROUTE_POLICY, classifyRoute} from '../src/security/route-policy.js';
import {START, END, buildTable} from '../scripts/route-policy-table.mjs';

// Every route declared in src/application.js must have an explicit access class in the policy table: a new route cannot
// ship without someone deciding who may call it (the gate in application.js refuses unlisted /api paths).
const source = readFileSync(new URL('../src/application.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function scanRegexLiteral(text, from) {
 let i = from + 1, inClass = false;
 while (i < text.length) {
  const c = text[i];
  if (c === '\\') { i += 2; continue; }
  if (c === '[') inClass = true; else if (c === ']') inClass = false; else if (c === '/' && !inClass) return i;
  i++;
 }
 return -1;
}
// A representative concrete path for a route regex, so it can be pushed through classifyRoute.
function sampleFromRegex(src) {
 return src.replace(/^\^/, '').replace(/\$$/, '')
  .replace(/\(\?:(?:[^()]|\([^()]*\))*\)\?/g, '')
  .replace(/\(([^()]*\|[^()]*)\)/g, (_, alts) => alts.split('|')[0])
  .replace(/\(\[\\w-\]\+\)/g, 'sample-id')
  .replace(/\\\//g, '/').replace(/\\\./g, '.');
}
function declaredRoutes() {
 const found = new Set();
 for (const line of source.split('\n')) {
  if (!/url\.pathname/.test(line) || !/^\s*(if|const \w+=\s*url\.pathname)/.test(line)) continue;
  for (const m of line.matchAll(/url\.pathname===?'([^']+)'/g)) found.add(m[1]);
  const idx = line.indexOf('url.pathname.match(/');
  if (idx >= 0) {
   const start = idx + 'url.pathname.match('.length, end = scanRegexLiteral(line, start);
   if (end > 0) found.add(sampleFromRegex(line.slice(start + 1, end)));
  }
 }
 // `['/api/setup','/api/login'].includes(url.pathname)` style
 for (const m of source.matchAll(/\[('\/api\/[^\]]+)\]\.includes\(url\.pathname\)/g)) for (const p of m[1].split(',')) found.add(p.trim().replace(/'/g, ''));
 return [...found].filter(p => p.startsWith('/api/') || p.startsWith('/health')).sort();
}

test('every route declared in application.js has an explicit access class', () => {
 const routes = declaredRoutes();
 assert.ok(routes.length > 200, `route extraction found ${routes.length} routes`);
 const missing = routes.filter(p => !classifyRoute(p));
 assert.deepEqual(missing, [], `routes without an entry in src/security/route-policy.js: ${missing.join(', ')}`);
});

test('unknown API paths are refused (default deny)', () => {
 for (const p of ['/api/definitely-not-a-route', '/api/users-export', '/api/internal/dump', '/api/']) assert.equal(classifyRoute(p), null, p);
});

test('access classes are well formed and the sensitive families are classified as intended', () => {
 for (const entry of ROUTE_POLICY) assert.ok(ACCESS_CLASSES.includes(entry.access), `${entry.access} is a known class`);
 const at = p => classifyRoute(p)?.access;
 // platform-global state is never a plain workspace route
 for (const p of ['/api/agents/reseed', '/api/agents/sales/model-config', '/api/frost/pause', '/api/frost/resume', '/api/frost/run-now', '/api/connections']) assert.equal(at(p), 'platform_operator', p);
 for (const p of ['/api/platform/tenants', '/api/platform/connectors', '/api/platform/bulk/operations', '/api/partners/admin/partners', '/api/client-admin/customers']) assert.equal(at(p), 'platform_admin', p);
 for (const p of ['/api/webhooks/salla', '/api/webhooks/meta/whatsapp', '/api/webhooks/microsoft/mail', '/api/webhooks/connectors/abc', '/api/webhooks/partner-billing']) assert.equal(at(p), 'webhook', p);
 for (const p of ['/api/automation/status', '/api/automation/daily-brief']) assert.equal(at(p), 'internal', p);
 assert.equal(at('/api/client/me'), 'merchant');
 assert.equal(at('/api/partners/me'), 'partner');
 // tenant data is workspace-scoped
 for (const p of ['/api/crm', '/api/marketing/campaigns', '/api/integrations/connections', '/api/approvals', '/api/users', '/api/team/dashboard', '/api/memory/usage']) assert.equal(at(p), 'workspace_member', p);
 // only account-level, public and webhook routes stay reachable by a merchant-only account
 const reachable = ROUTE_POLICY.filter(e => e.merchantReachable).map(e => e.access);
 assert.deepEqual([...new Set(reachable)].sort(), ['authenticated_user', 'public', 'webhook']);
});

test('platform_admin routes all live under a platform prefix and no route is both public and tenant data', () => {
 for (const entry of ROUTE_POLICY.filter(e => e.access === 'platform_admin')) {
  const shown = entry.matcher.literal ?? entry.matcher.regex.source;
  assert.match(shown.replace(/\\\//g, '/'), /\/api\/(platform|partners\/admin|client-admin)/, shown);
 }
 const publics = ROUTE_POLICY.filter(e => e.access === 'public').map(e => e.matcher.literal ?? e.matcher.regex.source.replace(/\\\//g, '/'));
 for (const p of publics) assert.doesNotMatch(p, /crm|marketing|memory|integrations|approvals|agents|users|workflows/, p);
});

test('the route table in docs/CLIENT_PORTAL.md is generated from the policy (run: node scripts/route-policy-table.mjs --write)', () => {
 const doc = readFileSync(new URL('../docs/CLIENT_PORTAL.md', import.meta.url), 'utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
 const block = doc.slice(doc.indexOf(START), doc.indexOf(END) + END.length);
 assert.ok(block.startsWith(START), 'markers present');
 assert.equal(block, buildTable(), 'the documented table matches src/security/route-policy.js');
});
