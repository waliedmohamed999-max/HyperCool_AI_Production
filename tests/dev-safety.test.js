import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../src/application.js';
import {countDevSeedAccounts, isDevSeedAccount} from '../src/security/demo-accounts.js';

// The local preview seed and the production gate around it: demo accounts are opt-in, never fixed-password, refused near
// production, and a production database that contains one fails production:check.
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = (script, env, args = []) => spawnSync(process.execPath, [join(root, script), ...args], {env: {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env}, encoding: 'utf8', timeout: 60000});

test('the preview seed refuses to run unless explicitly enabled, and never near production or real data', async () => {
 assert.match(run('scripts/dev-preview.mjs', {}).stderr, /ALLOW_DEV_SEED=1/);
 assert.match(run('scripts/dev-preview.mjs', {ALLOW_DEV_SEED: '1', NODE_ENV: 'production'}).stderr, /NODE_ENV=production/);
 assert.match(run('scripts/dev-preview.mjs', {ALLOW_DEV_SEED: '1', PUBLIC_ORIGIN: 'https://example.com'}).stderr, /PUBLIC_ORIGIN/);
 assert.match(run('scripts/dev-preview.mjs', {ALLOW_DEV_SEED: '1', DEV_PREVIEW_DIR: join(root, 'data')}).stderr, /application data directory/);
 const foreign = await mkdtemp(join(tmpdir(), 'frost-foreign-'));
 try {
  await writeFile(join(foreign, 'important.txt'), 'not a preview directory');
  const res = run('scripts/dev-preview.mjs', {ALLOW_DEV_SEED: '1', DEV_PREVIEW_DIR: foreign});
  assert.equal(res.status, 1);
  assert.match(res.stderr, /not a previous dev preview directory/);
  assert.equal(await readFile(join(foreign, 'important.txt'), 'utf8'), 'not a preview directory', 'nothing was deleted');
 } finally { await rm(foreign, {recursive: true, force: true}); }
});

test('the preview seed carries no fixed password and no real-looking address', async () => {
 const source = await readFile(join(root, 'scripts/dev-preview.mjs'), 'utf8');
 assert.doesNotMatch(source, /password\s*:\s*['"`][^'"`]{3,}['"`]/i, 'no literal password anywhere in the seed script');
 assert.match(source, /randomBytes/);
 assert.doesNotMatch(source, /@(gmail|hotmail|yahoo|outlook|hyper-cool)\./i);
 assert.equal(isDevSeedAccount({username: 'devseed_admin'}), true);
 assert.equal(isDevSeedAccount({email: 'someone@preview.invalid'}), true);
 assert.equal(isDevSeedAccount({username: 'sara', email: 'sara@shop.example'}), false);
});

test('the seed runs, prints fresh random passwords once, and they really work (two runs never share a password)', async () => {
 const passwords = [];
 for (let round = 0; round < 2; round++) {
  const dir = await mkdtemp(join(tmpdir(), 'frost-devprev-'));
  const port = 39000 + Math.floor(Math.random() * 900) + round;
  const child = spawn(process.execPath, [join(root, 'scripts/dev-preview.mjs')], {env: {PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ALLOW_DEV_SEED: '1', DEV_PREVIEW_DIR: dir, DEV_PREVIEW_PORT: String(port)}, stdio: ['ignore', 'pipe', 'pipe']});
  let out = '', err = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { err += d; });
  try {
   await new Promise((ok, bad) => { const t = setTimeout(() => bad(new Error(`timeout\n${out}\n${err}`)), 50000); const poll = setInterval(() => { if (out.includes('Passwords exist only in this terminal')) { clearInterval(poll); clearTimeout(t); ok(); } else if (child.exitCode !== null) { clearInterval(poll); clearTimeout(t); bad(new Error(`exited ${child.exitCode}\n${out}\n${err}`)); } }, 100); });
   const line = out.split('\n').find(l => l.includes('merchant portal'));
   const [username, password] = line.trim().split(/\s+/).slice(-2);
   assert.equal(username, 'devseed_merchant');
   assert.ok(password.length >= 12);
   passwords.push(password);
   const res = await fetch(`http://127.0.0.1:${port}/api/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username, password})});
   assert.equal(res.status, 200, 'the printed password logs in');
   const bad = await fetch(`http://127.0.0.1:${port}/api/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username, password: 'guess-1234567890'})});
   assert.equal(bad.status, 401);
  } finally { child.kill(); await new Promise(r => setTimeout(r, 300)); await rm(dir, {recursive: true, force: true, maxRetries: 5}); }
 }
 assert.notEqual(passwords[0], passwords[1]);
});

test('production:check fails on a database that holds preview accounts, passes that check on a clean one; the server logs it at boot', async () => {
 const dir = await mkdtemp(join(tmpdir(), 'frost-prodcheck-'));
 const env = {PLATFORM_MAIL_TRANSPORT: 'capture', INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32)};
 const boot = async extraEnv => { const app = await createApp({dataDir: dir, env: {...env, ...extraEnv}}); return app; };
 try {
  let app = await boot({});
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body) => fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  assert.equal((await post('/api/signup', {name: 'Real', username: 'real_person', email: 'real@shop.example', password: 'a-real-long-password-1'})).status, 201);
  await new Promise(r => app.server.close(r)); app.store.close();
  const prodEnv = {NODE_ENV: 'production', DATA_DIR: dir, INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32), PUBLIC_ORIGIN: 'https://frost.example.com'};
  const clean = run('scripts/production-check.mjs', prodEnv);
  assert.match(clean.stdout, /✔ \[BLOCKER\] No local-preview accounts in this database/);
  assert.match(clean.stdout, /✔ \[BLOCKER\] No investor-demo data in this database/);
  // a preview account appears in the database
  app = await boot({});
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const base2 = `http://127.0.0.1:${app.server.address().port}`;
  const res = await fetch(base2 + '/api/signup', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({name: 'Seed', username: 'devseed_x', email: 'devseed_x@preview.invalid', password: 'another-long-password-1'})});
  assert.equal(res.status, 201);
  assert.equal(countDevSeedAccounts(app.store.db), 1);
  await new Promise(r => app.server.close(r)); app.store.close();
  const dirty = run('scripts/production-check.mjs', prodEnv);
  assert.equal(dirty.status, 1, 'a blocker fails the exit code');
  assert.match(dirty.stdout, /✖ \[BLOCKER\] No local-preview accounts in this database — 1 account\(s\)/);
  // and the server itself reports it loudly at boot in production
  const lines = []; const original = console.error; console.error = (...a) => { lines.push(a.join(' ')); };
  try { app = await boot({NODE_ENV: 'production'}); } finally { console.error = original; }
  assert.ok(lines.some(l => l.includes('DEV_PREVIEW_ACCOUNTS_PRESENT_IN_PRODUCTION')), lines.join('\n'));
  app.store.close(); if (app.server.listening) await new Promise(r => app.server.close(r));
 } finally { await rm(dir, {recursive: true, force: true, maxRetries: 5}); }
});
