// Regenerates the raster brand assets from public/favicon.svg with Playwright (already a
// devDependency): the four PWA/touch icons and the 1200x630 social preview (Open Graph / X).
// Usage: node scripts/generate-brand-assets.mjs
import {chromium} from 'playwright';
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const svg = readFileSync('public/favicon.svg', 'utf8');
const fontUrl = weight => pathToFileURL(resolve(`public/fonts/ibm-plex-sans-arabic-${weight}-arabic.woff2`)).href;
const latinFontUrl = weight => pathToFileURL(resolve(`public/fonts/ibm-plex-sans-arabic-${weight}-latin.woff2`)).href;

const icons = [
  {file: 'public/icons/apple-touch-icon.png', size: 180},
  {file: 'public/icons/icon-192.png', size: 192},
  {file: 'public/icons/icon-512.png', size: 512},
  {file: 'public/icons/icon-maskable-512.png', size: 512}
];

const ogHtml = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>
@font-face{font-family:P;font-weight:500;src:url(${fontUrl(500)}) format('woff2');unicode-range:U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF}
@font-face{font-family:P;font-weight:700;src:url(${fontUrl(700)}) format('woff2');unicode-range:U+0600-06FF,U+0750-077F,U+FB50-FDFF,U+FE70-FEFF}
@font-face{font-family:P;font-weight:500;src:url(${latinFontUrl(500)}) format('woff2');unicode-range:U+0000-00FF,U+2000-206F}
@font-face{font-family:P;font-weight:700;src:url(${latinFontUrl(700)}) format('woff2');unicode-range:U+0000-00FF,U+2000-206F}
*{box-sizing:border-box;margin:0}
body{width:1200px;height:630px;font-family:P,system-ui,sans-serif;color:#fff;overflow:hidden;position:relative;background:linear-gradient(120deg,#1F2A3D 0%,#2d1b69 55%,#4a1fb8 100%)}
.glow{position:absolute;width:640px;height:640px;border-radius:50%;background:radial-gradient(circle,rgba(124,58,237,.55),transparent 65%);inset-block-start:-180px;inset-inline-start:-140px}
.glow.b{width:520px;height:520px;inset:auto -120px -220px auto;background:radial-gradient(circle,rgba(22,205,199,.35),transparent 65%)}
.frame{position:relative;height:100%;padding:72px 84px;display:flex;flex-direction:column;justify-content:space-between}
.brand{display:flex;align-items:center;gap:20px;direction:ltr}
.mark{width:84px;height:84px;border-radius:24px;overflow:hidden;box-shadow:0 20px 50px -14px rgba(99,91,255,.9)}
.mark svg{width:100%;height:100%;display:block}
.word{font-size:56px;font-weight:700;letter-spacing:6px}
h1{font-size:76px;line-height:1.3;font-weight:700;max-width:960px}
h1 em{font-style:normal;color:#b99aff}
.sub{display:flex;align-items:center;justify-content:space-between;font-size:30px;font-weight:500;color:#d7d3ff}
.chips{display:flex;gap:14px}
.chip{padding:10px 22px;border-radius:999px;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.22);font-size:24px}
</style></head><body><div class="glow"></div><div class="glow b"></div>
<div class="frame">
 <div class="brand"><div class="mark">${svg}</div><span class="word">FROST</span></div>
 <h1>فريقك الذكي لإدارة العمل،<br>بقيادة <em>Frost</em></h1>
 <div class="sub"><span dir="ltr">Your AI Workforce</span><div class="chips"><span class="chip">12 وكيلًا</span><span class="chip">تسويق</span><span class="chip">مبيعات</span><span class="chip">تشغيل</span></div></div>
</div></body></html>`;

const browser = await chromium.launch();
try {
  for (const {file, size} of icons) {
    const page = await browser.newPage({viewport: {width: size, height: size}, deviceScaleFactor: 1});
    await page.setContent(`<!doctype html><html><head><style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`);
    writeFileSync(file, await page.screenshot({omitBackground: false}));
    await page.close();
    console.log('wrote', file, `${size}x${size}`);
  }
  const og = await browser.newPage({viewport: {width: 1200, height: 630}, deviceScaleFactor: 1});
  await og.setContent(ogHtml, {waitUntil: 'load'});
  await og.evaluate(() => document.fonts.ready);
  writeFileSync('public/assets/og-frost.png', await og.screenshot());
  console.log('wrote public/assets/og-frost.png 1200x630');
} finally {
  await browser.close();
}
