// Prints (or, with --write, updates) the route access table inside docs/CLIENT_PORTAL.md from src/security/route-policy.js,
// so the documented review can never drift from what the server enforces. tests/route-policy.test.js checks they match.
//   node scripts/route-policy-table.mjs            print the table
//   node scripts/route-policy-table.mjs --write    replace the block between the route-policy markers in the doc
import {readFileSync, writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {ROUTE_POLICY} from '../src/security/route-policy.js';

export const START = '<!-- route-policy:start -->';
export const END = '<!-- route-policy:end -->';

const PROTECTION = {
 public: 'No session. Abuse controls where relevant: per-IP rate limits, single-use hashed tokens, widget origin allow-list, no account enumeration.',
 webhook: 'Not a session route: the caller is authenticated by its own signature/secret; the tenant is resolved from the verified external id, never from the payload.',
 internal: 'Shared automation token (`x-hypercool-token`); iterates every eligible tenant itself.',
 authenticated_user: 'Session (+ CSRF for writes). Acts on the caller\'s own account or invitation only. The only authenticated routes a merchant-only account may reach.',
 workspace_member: 'Session + CSRF (writes) + active membership of the workspace; the **role held in that workspace** (not the account-wide `users.role`) is checked per method by the handler; every query is scoped by the server-resolved `tenant_id`; another workspace\'s id answers 404. Closed to merchant-only accounts (`MERCHANT_USE_CLIENT_PORTAL`).',
 platform_operator: 'Platform-global state: platform admin (`PLATFORM_ADMIN_USERNAMES`) or the owner of the operator\'s own (default) workspace, checked centrally before the handler, plus the handler\'s own role check.',
 platform_admin: 'Allow-listed platform administrators only (`PLATFORM_ADMIN_USERNAMES`), checked centrally before the handler.',
 partner: 'Own module (`src/partners/routes.js`): public application/config routes, partner session routes, and staff routes under `/admin/`.',
 merchant: 'Own module (`src/client/routes.js`): tenant from `client_members` or a validated support session; permission + plan entitlement + account state per route; support mode read-only server side.'
};
const PROVIDERS = new Set(['salla', 'meta', 'microsoft', 'x', 'linkedin']);
const groupOf = shown => {
 const head = shown.replace(/^\^/, '').replace(/\\\//g, '/').split(/[(\[$]/)[0];
 const parts = head.split('/').filter(Boolean);
 if (parts[0] === 'health') return '/health*';
 if (parts[1] === 'integrations') {
  if (['connections', 'custom-connectors', 'oauth'].includes(parts[2])) return `/api/integrations/${parts[2]}/…`;
  if (PROVIDERS.has(parts[2])) return '/api/integrations/<provider>/… (legacy per-provider OAuth)';
  return '/api/integrations/…';
 }
 return `/${parts.slice(0, 2).join('/')}/…`;
};

export function buildTable() {
 const groups = new Map();
 for (const e of ROUTE_POLICY) {
  const shown = e.matcher.literal ?? e.matcher.regex.source;
  const key = `${groupOf(shown)}|${e.access}`;
  const g = groups.get(key) || {group: groupOf(shown), access: e.access, count: 0, roles: new Set()};
  g.count++; for (const r of e.roles || []) g.roles.add(r);
  groups.set(key, g);
 }
 const rows = [...groups.values()].sort((a, b) => a.group.localeCompare(b.group));
 const lines = ['| Route group | Routes | Access class | Workspace roles accepted (union over methods) |', '|---|---:|---|---|'];
 for (const g of rows) lines.push(`| \`${g.group}\` | ${g.count} | ${g.access} | ${g.roles.size ? [...g.roles].join(', ') : (g.access === 'workspace_member' ? 'any member' : '—')} |`);
 lines.push('', '| Access class | Protection applied |', '|---|---|');
 for (const [cls, text] of Object.entries(PROTECTION)) lines.push(`| ${cls} | ${text} |`);
 return `${START}\n${lines.join('\n')}\n${END}`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
 const table = buildTable();
 if (process.argv.includes('--write')) {
  const path = fileURLToPath(new URL('../docs/CLIENT_PORTAL.md', import.meta.url));
  let doc = readFileSync(path, 'utf8');
  const a = doc.indexOf(START), b = doc.indexOf(END);
  if (a < 0 || b < 0) throw new Error('route-policy markers not found in docs/CLIENT_PORTAL.md');
  doc = doc.slice(0, a) + table + doc.slice(b + END.length);
  writeFileSync(path, doc);
  console.log('docs/CLIENT_PORTAL.md updated');
 } else console.log(table);
}
