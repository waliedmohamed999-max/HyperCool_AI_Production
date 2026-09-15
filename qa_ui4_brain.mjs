import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
const { createApp } = await import(pathToFileURL('E:/xampp/HyperCool_AI_Production/src/application.js'));

const repoRoot = 'E:/xampp/HyperCool_AI_Production/';
const DEMO_PASSWORD = 'ui4-qa-demo-password-2024';
const directory = await mkdtemp(join(tmpdir(), 'hypercool-ui4-brain-'));
const shotsDir = 'C:/Users/USER/AppData/Local/Temp/claude/e--xampp-HyperCool-AI-Production/69edeee0-5da6-4660-b7dc-f70e10b90abb/scratchpad/hc_ui4/shots';
await mkdir(shotsDir, { recursive: true });

execFileSync(process.execPath, [join(repoRoot, 'scripts', 'demo-seed.mjs')], {
  cwd: repoRoot, env: { ...process.env, DATA_DIR: directory, DEMO_USER_PASSWORD: DEMO_PASSWORD }, stdio: 'ignore'
});

const app = await createApp({ dataDir: directory, env: process.env });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const failures = [];
function check(label, cond) { if (cond) console.log('OK  -', label); else { console.log('FAIL-', label); failures.push(label); } }
page.on('pageerror', err => { console.log('  [page error]', err.message); failures.push('page error: ' + err.message); });

await page.goto(base + '/');
await page.waitForSelector('#auth-form [name=username]', { state: 'visible' });
await page.fill('#auth-form [name=username]', 'investor_demo');
await page.fill('#auth-form [name=password]', DEMO_PASSWORD);
await page.click('#auth-form button');
await page.waitForSelector('#workspace-select-panel', { state: 'visible', timeout: 15000 });
const novaCard = page.locator('.workspace-select-item', { hasText: 'نوفا' });
await novaCard.locator('button').click();
await page.waitForSelector('#session-bar', { state: 'visible', timeout: 15000 });

await page.goto(base + '/#command-center');
await page.waitForSelector('#command-center #cmdc-brain-hero', { state: 'attached', timeout: 10000 });
await page.waitForTimeout(400);

// Click the "Data & Context" tab bar's "Company Brain" tab (3rd tab)
const tabButtons = page.locator('#cmdc-data-context .ui-tabs .tab');
await tabButtons.nth(2).click();
await page.waitForTimeout(300);

check('Brain hero renders with real counts', (await page.locator('#cmdc-brain-hero .cmdc-brain-stat').count()) === 5);
check('Brain nav has 7 categories', (await page.locator('.cmdc-brain-nav-item').count()) === 7);
check('Identity category selected by default shows seeded item', (await page.locator('.cmdc-brain-card').count()) >= 1);

await page.screenshot({ path: join(shotsDir, '01-brain-ar-identity-1440.png'), fullPage: false, clip: { x: 0, y: 0, width: 1440, height: 900 } });

// Switch to "Goals"
await page.locator('.cmdc-brain-nav-item', { hasText: 'الأهداف' }).click();
await page.waitForTimeout(200);
check('Goals category shows seeded goal item', (await page.locator('.cmdc-brain-card').count()) >= 1);
await page.screenshot({ path: join(shotsDir, '02-brain-ar-goals.png') });

// Switch to "Decision" (empty category - never seeded)
await page.locator('.cmdc-brain-nav-item', { hasText: 'قرار' }).click();
await page.waitForTimeout(200);
check('Decision category (empty) shows empty state with CTA', (await page.locator('.cmdc-brain-content .empty [data-brain-add-type]').count()) === 1);
await page.screenshot({ path: join(shotsDir, '03-brain-ar-empty-decision.png') });

// Click the empty-state CTA -> should switch to Add Context tab and prefill type
await page.locator('[data-brain-add-type]').click();
await page.waitForTimeout(200);
const selectedType = await page.locator('#cmdc-context-form [name=type]').inputValue();
check('Empty-state CTA switches to Add Context tab and prefills type=decision', selectedType === 'decision');
await page.screenshot({ path: join(shotsDir, '04-brain-ar-addcontext-prefilled.png') });

// Go back to Company Brain, Identity category — test Pin toggle
await tabButtons.nth(2).click();
await page.waitForTimeout(200);
await page.locator('.cmdc-brain-nav-item', { hasText: 'الهوية' }).click();
await page.waitForTimeout(200);
const firstCard = page.locator('.cmdc-brain-card').first();
const alreadyPinned = (await firstCard.locator('[data-brain-pin]').innerText()).includes('إلغاء');
check('Identity item starts pinned (seeded pinned:true)', alreadyPinned);

// Test Edit
await firstCard.locator('[data-brain-edit]').click();
await page.waitForSelector('dialog.confirmation[open]', { timeout: 5000 });
await page.fill('dialog.confirmation [name=title]', 'هوية المتجر (محدّثة QA)');
await page.locator('dialog.confirmation button.button.primary, dialog.confirmation button', { hasText: 'حفظ' }).first().click();
await page.waitForTimeout(400);
const updatedTitle = await page.locator('.cmdc-brain-card h5').first().innerText();
check('Edit drawer updates the real title via PATCH', updatedTitle.includes('محدّثة QA'));
await page.screenshot({ path: join(shotsDir, '05-brain-ar-edited.png') });

// Test conflict: create a second ACTIVE brain_identity item via the real Add Context form
await tabButtons.nth(1).click();
await page.waitForTimeout(200);
await page.fill('#cmdc-context-form [name=title]', 'هوية بديلة (اختبار تعارض)');
await page.selectOption('#cmdc-context-form [name=type]', 'brain_identity');
await page.fill('#cmdc-context-form [name=description]', 'سجل هوية ثانٍ نشط لاختبار تعارض عقل الشركة.');
await page.click('#cmdc-context-form button[type=submit]');
await page.waitForTimeout(400);
await tabButtons.nth(2).click();
await page.waitForTimeout(300);
check('Conflict flag appears on Identity nav item after 2 active identity records', (await page.locator('.cmdc-brain-nav-item', { hasText: 'الهوية' }).locator('.cmdc-brain-nav-flag').count()) === 1);
await page.locator('.cmdc-brain-nav-item', { hasText: 'الهوية' }).click();
await page.waitForTimeout(200);
check('Conflict banner shown in Identity category content', (await page.locator('.cmdc-brain-conflict').count()) === 1);
await page.screenshot({ path: join(shotsDir, '06-brain-ar-conflict.png') });

// Test archive to resolve the conflict
const cards = page.locator('.cmdc-brain-card');
const secondCard = cards.nth(await cards.count() - 1);
await secondCard.locator('[data-brain-archive]').click();
await page.waitForSelector('dialog.confirmation[open]', { timeout: 5000 });
await page.locator('dialog.confirmation button', { hasText: 'تأكيد' }).first().click();
await page.waitForTimeout(400);
check('Conflict resolved after archiving the duplicate', (await page.locator('.cmdc-brain-conflict').count()) === 0);
await page.screenshot({ path: join(shotsDir, '07-brain-ar-conflict-resolved.png') });

// Mobile check (390px) - no horizontal overflow
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const overflowInfo = await page.evaluate(() => {
  const el = document.querySelector('#command-center');
  return { scrollWidth: el.scrollWidth, clientWidth: document.documentElement.clientWidth };
});
check('No horizontal overflow at 390px on Company Brain tab', overflowInfo.scrollWidth <= overflowInfo.clientWidth + 2);
await page.screenshot({ path: join(shotsDir, '08-brain-ar-mobile-390.png') });

// 1280 check
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(300);
await page.screenshot({ path: join(shotsDir, '09-brain-ar-1280.png') });

// English check
await page.setViewportSize({ width: 1440, height: 900 });
await page.evaluate(() => localStorage.setItem('hc_locale', 'en'));
await page.reload();
await page.waitForSelector('#session-bar', { timeout: 10000 });
await page.goto(base + '/#command-center');
await page.waitForSelector('#command-center #cmdc-brain-hero', { state: 'attached', timeout: 10000 });
await page.waitForTimeout(400);
await tabButtons.nth(2).click();
await page.waitForTimeout(300);
check('English hero renders', (await page.locator('#cmdc-brain-hero h4').innerText()) === 'Company Brain');
await page.screenshot({ path: join(shotsDir, '10-brain-en-1440.png') });

await browser.close();
app.server.close();

console.log('\n=== BRAIN QA SUMMARY ===');
console.log(failures.length === 0 ? 'ALL CHECKS PASSED' : `FAILURES: ${failures.length}`);
for (const f of failures) console.log(' -', f);
process.exit(failures.length === 0 ? 0 : 1);
