import { chromium } from 'playwright';
import { createApp } from './src/application.js';
import { createAuth } from './src/auth.js';

const DATA = 'C:\\Users\\USER\\AppData\\Local\\Temp\\claude\\e--xampp-HyperCool-AI-Production\\69edeee0-5da6-4660-b7dc-f70e10b90abb\\scratchpad\\hc_ui_audit\\';
const SHOTDIR = 'C:\\Users\\USER\\AppData\\Local\\Temp\\claude\\e--xampp-HyperCool-AI-Production\\69edeee0-5da6-4660-b7dc-f70e10b90abb\\scratchpad\\';

const app = await createApp({ dataDir: DATA, env: process.env });
const db = app.store.db;
const auth = createAuth(db);
await new Promise(r => app.server.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + app.server.address().port;

const nova = db.prepare("SELECT id FROM tenants WHERE slug='nova-store-demo'").get();
const owner = db.prepare(`SELECT u.username FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=? AND tm.role='owner' LIMIT 1`).get(nova.id);
const user = db.prepare('SELECT * FROM users WHERE username=?').get(owner.username);
const s = auth.session(user);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await context.newPage();
await context.addCookies([{ name: 'hc_session', value: s.token, url: base }]);
await page.goto(base + '/');
await page.waitForSelector('[data-page="overview"]', { state: 'visible', timeout: 15000 });

const routes = [
  ['dashboard', '#overview'],
  ['command_center', '#command-center'],
  ['agents', '#agents'],
  ['integrations', '#integrations'],
  ['crm', '#crm'],
  ['reports', '#reports'],
  ['content', '#content'],
  ['workflows', '#workflows'],
  ['knowledge', '#knowledge'],
  ['control_center', '#control-center']
];

for (const [label, hash] of routes) {
  await page.evaluate(h => { location.hash = h; }, hash);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: SHOTDIR + `before_${label}.png`, fullPage: true });
  console.log('shot:', label);
}

// Platform admin
const platformUser = db.prepare("SELECT * FROM users WHERE username='waleedaboelezz'").get();
if (platformUser) {
  const context2 = await browser.newContext({ viewport: { width: 1440, height: 950 } });
  const page2 = await context2.newPage();
  await context2.addCookies([{ name: 'hc_session', value: auth.session(platformUser).token, url: base }]);
  await page2.goto(base + '/');
  await page2.waitForSelector('[data-page="overview"]', { state: 'visible', timeout: 15000 });
  await page2.evaluate(() => { location.hash = '#platform'; });
  await page2.waitForTimeout(1200);
  await page2.screenshot({ path: SHOTDIR + 'before_platform.png', fullPage: true });
  console.log('shot: platform');
  await context2.close();
}

// English variant of the two investor pages
await page.evaluate(() => { document.querySelector('[data-locale="en"]')?.click(); });
await page.waitForTimeout(800);
await page.evaluate(() => { location.hash = '#overview'; });
await page.waitForTimeout(1000);
await page.screenshot({ path: SHOTDIR + 'before_dashboard_en.png', fullPage: true });
console.log('shot: dashboard_en');

await browser.close();
await new Promise(r => app.server.close(r));
app.store.close();
