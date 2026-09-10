import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const base = resolve('docs/handoff/HyperCool_Developer_Handoff_AR');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  await page.goto(pathToFileURL(`${base}.html`).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'artifacts/handoff/report-preview.png' });
  await page.pdf({ path: `${base}.pdf`, format: 'A4', printBackground: true, preferCSSPageSize: true });
  console.log(JSON.stringify({ title: await page.title(), sections: await page.locator('h2').count(), pdf: `${base}.pdf` }));
} finally {
  await browser.close();
}
