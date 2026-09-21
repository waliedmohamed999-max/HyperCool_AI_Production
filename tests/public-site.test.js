import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../src/application.js';

// Public marketing site: launch-readiness contract (SEO/social tags, crawler files, landmarks,
// long-cached assets) - proves nothing is served with an unfilled placeholder or a guessed domain.
async function boot(env = {}) {
 const directory = await mkdtemp(join(tmpdir(), 'frost-public-site-'));
 const app = await createApp({dataDir: directory, env: {PLATFORM_MAIL_TRANSPORT: 'capture', ...env}});
 await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
 const port = app.server.address().port;
 const get = (path, host) => new Promise((resolve, reject) => {
  const req = http.request({host: '127.0.0.1', port, path, method: 'GET', headers: host ? {Host: host} : {}}, res => {
   const chunks = [];
   res.on('data', c => chunks.push(c));
   res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)}));
  });
  req.on('error', reject);
  req.end();
 });
 return {get, cleanup: async () => {await new Promise(resolve => app.server.close(resolve)); app.store.close(); await rm(directory, {recursive: true, force: true});}};
}
const meta = (html, re) => html.match(re)?.[1] ?? null;

test('Public site without PUBLIC_ORIGIN: relative social URLs, no canonical, no leftover placeholders, no sitemap', async () => {
 const {get, cleanup} = await boot();
 try {
  const page = await get('/');
  assert.equal(page.status, 200);
  const html = page.body.toString('utf8');
  assert.ok(!html.includes('{{'), 'no unfilled {{placeholder}} may reach a visitor');
  assert.equal(meta(html, /<meta property="og:image" content="([^"]*)"/), '/assets/og-frost.png');
  assert.equal(meta(html, /<meta name="twitter:card" content="([^"]*)"/), 'summary_large_image');
  assert.ok(!html.includes('rel="canonical"'), 'never invent a canonical domain');

  assert.equal((await get('/sitemap.xml')).status, 404, 'a sitemap needs an absolute URL, so it only exists once PUBLIC_ORIGIN is set');
  const robots = (await get('/robots.txt')).body.toString('utf8');
  assert.match(robots, /Disallow: \/app/);
  assert.match(robots, /Disallow: \/api\//);
  assert.ok(!robots.includes('Sitemap:'));
 } finally {await cleanup();}
});

test('Public site with PUBLIC_ORIGIN: absolute og/twitter/JSON-LD URLs, canonical, sitemap and robots', async () => {
 const {get, cleanup} = await boot({PUBLIC_ORIGIN: 'https://frost.example.com/'});
 try {
  const html = (await get('/', 'frost.example.com')).body.toString('utf8');
  assert.ok(!html.includes('{{'));
  assert.equal(meta(html, /<meta property="og:image" content="([^"]*)"/), 'https://frost.example.com/assets/og-frost.png');
  assert.equal(meta(html, /<meta name="twitter:image" content="([^"]*)"/), 'https://frost.example.com/assets/og-frost.png');
  assert.equal(meta(html, /<link rel="canonical" href="([^"]*)"/), 'https://frost.example.com/');
  const ld = JSON.parse(meta(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/));
  assert.equal(ld['@type'], 'SoftwareApplication');
  assert.equal(ld.url, 'https://frost.example.com/');
  assert.equal(ld.name, 'Frost');

  const sitemap = await get('/sitemap.xml', 'frost.example.com');
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers['content-type'], /xml/);
  assert.match(sitemap.body.toString('utf8'), /<loc>https:\/\/frost\.example\.com\/<\/loc>/);
  assert.match((await get('/robots.txt', 'frost.example.com')).body.toString('utf8'), /Sitemap: https:\/\/frost\.example\.com\/sitemap\.xml/);
 } finally {await cleanup();}
});

test('Public site: one h1, real landmarks, working mobile-menu script, branded assets served', async () => {
 const {get, cleanup} = await boot();
 try {
  const html = (await get('/')).body.toString('utf8');
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
  assert.ok(/<main id="main">/.test(html) && html.includes('</main>'));
  assert.ok(/<header class="site-nav/.test(html) && /<footer/.test(html));
  assert.ok(html.includes('id="nav-toggle"') && html.includes('aria-controls="site-menu"'));
  assert.ok(html.includes('/site-nav.js'));
  assert.ok(!/hyper\s?cool/i.test(html.replace(/hyper-cool\.com/gi, '')), 'no old brand on the public page');

  const script = await get('/site-nav.js');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /javascript/);

  const og = await get('/assets/og-frost.png');
  assert.equal(og.status, 200);
  assert.equal(og.body.readUInt32BE(16), 1200);
  assert.equal(og.body.readUInt32BE(20), 630);

  // Icons are served with a one-year immutable cache, so every reference carries a version query.
  assert.match(html, /apple-touch-icon\.png\?v=frost1/);
  const manifest = JSON.parse((await get('/site.webmanifest')).body.toString('utf8'));
  assert.ok(manifest.icons.every(icon => icon.src.includes('?v=frost1')));
  assert.equal(manifest.short_name, 'Frost');
  const icon = await get('/icons/icon-192.png?v=frost1');
  assert.equal(icon.status, 200, 'the version query must not break the file lookup');
 } finally {await cleanup();}
});
