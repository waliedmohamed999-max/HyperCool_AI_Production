// Investor Demo Data Pack — shared helpers for scripts/demo-seed.mjs / demo-reset.mjs /
// demo-status.mjs. Plain ESM, matching this repo's existing scripts/ conventions
// (backup.mjs/production-check.mjs) — no framework, no classes.
//
// SAFETY CONTRACT for every function in this file and every script that imports it:
//  - never performs an outbound network call
//  - never stores a real-looking secret/credential
//  - only ever touches the two fixed demo tenants below (by slug) plus the investor_demo user
export const DEMO_SLUGS = {
 nova: 'nova-store-demo',
 vertex: 'vertex-solutions-demo'
};
export const DEMO_USERNAME = 'investor_demo';
export const DEMO_MARKER = 'HYPERCOOL_INVESTOR_DEMO_V1'; // stored in tenants.branding_settings.demo

// --- Deterministic pseudo-random generation (Part 45) --------------------------------------
// mulberry32: tiny, fast, seeded PRNG — the SAME seed always produces the SAME sequence, so
// `demo:reset && demo:seed` reproduces identical data every time (never `Math.random()`).
function hashSeed(text) {
 let h = 1779033703 ^ text.length;
 for (let i = 0; i < text.length; i++) {
  h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
  h = (h << 13) | (h >>> 19);
 }
 return h >>> 0;
}
export function makeRng(seedText) {
 let a = hashSeed(seedText);
 return function rng() {
  a |= 0; a = (a + 0x6D2B79F5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
 };
}
export function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
export function pickWeighted(rng, weightedArr) {
 // weightedArr: [[value, weight], ...]
 const total = weightedArr.reduce((s, [, w]) => s + w, 0);
 let r = rng() * total;
 for (const [value, weight] of weightedArr) { if ((r -= weight) <= 0) return value; }
 return weightedArr[weightedArr.length - 1][0];
}
export function randInt(rng, min, max) { return Math.floor(rng() * (max - min + 1)) + min; }
export function randFloat(rng, min, max, decimals = 2) {
 const v = rng() * (max - min) + min;
 const f = Math.pow(10, decimals);
 return Math.round(v * f) / f;
}
export function shuffle(rng, arr) {
 const out = arr.slice();
 for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
 return out;
}

// --- Dynamic, relative dates (Part 44) — never a hardcoded calendar year -------------------
export function daysAgoDate(n) { return new Date(Date.now() - n * 86400000); }
export function daysAgoIso(n) { return daysAgoDate(n).toISOString(); }
export function dateOnly(d) { return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10); }
export function mostRecentSunday(fromDate = new Date()) {
 const d = new Date(fromDate);
 d.setUTCHours(0, 0, 0, 0);
 d.setUTCDate(d.getUTCDate() - d.getUTCDay());
 return d;
}

// --- Raw-SQL backdating helper (Part 44/45) -------------------------------------------------
// A handful of real, validated create functions (createLead, createEscalation) hardcode
// `createdAt`/`at` to "now" with no override parameter (confirmed in this codebase — see
// docs/INVESTOR_DEMO.md's own honest note on this). The ONLY way to make their history look
// organically spread across 90 days is to call the real function first (so every validation
// rule still runs for real), then patch just the timestamp field(s) inside the row's own JSON
// blob directly — never inventing a parallel write path, never touching any other field.
export function patchJsonRow(db, table, idColumn, id, patchFn) {
 const row = db.prepare(`SELECT json FROM ${table} WHERE ${idColumn}=?`).get(id);
 if (!row) return null;
 const obj = JSON.parse(row.json);
 patchFn(obj);
 db.prepare(`UPDATE ${table} SET json=? WHERE ${idColumn}=?`).run(JSON.stringify(obj), id);
 return obj;
}
export function patchEscalationTimestamp(db, id, createdAtIso) {
 db.prepare('UPDATE agent_escalations SET created_at=? WHERE id=?').run(createdAtIso, id);
}

// --- Name / content pools (Arabic, clearly fictional demo identities) ----------------------
// --- Self-contained "design" assets (data: URIs — zero network calls, zero external hosts) ---
// A real content item can carry a real `assetUrl` (see src/domain.js's createContent) that the
// Content page now renders as an actual image preview during review/approval. Rather than
// linking to any real external image host (which would be an outbound network dependency this
// demo pack explicitly must never have), every "design" here is a small, generated SVG encoded
// directly as a data: URI — guaranteed to render with no network access at all, and each one
// visibly stamps its own "DEMO" badge in the corner so it can never be mistaken for real creative.
function escapeXml(text) {
 return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export const DESIGN_THEMES = [
 ['#0f766e', '#134e4a'], ['#b45309', '#78350f'], ['#1d4ed8', '#1e3a8a'],
 ['#be123c', '#7f1d1d'], ['#4338ca', '#312e81'], ['#0369a1', '#0c4a6e']
];
// Five genuinely different layouts (not just a recolored copy of one template) so a reviewer
// scrolling the content list sees real visual variety, matching what an actual creative/design
// review queue would look like. Callers pick one via `template` (0-4) — demo-seed.mjs seeds it
// from the same deterministic rng as everything else, so results stay reproducible.
export const DESIGN_TEMPLATE_COUNT = 5;
const PLATFORM_GLYPHS = { Instagram: 'IG', Facebook: 'FB', X: 'X', LinkedIn: 'in', TikTok: 'TT', Snapchat: 'SC' };

function demoBadge(x, y, colorTo, badge) {
 return `<rect x="${x}" y="${y}" width="100" height="34" rx="17" fill="#ffffff" fill-opacity="0.92"/><text x="${x + 50}" y="${y + 23}" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" font-weight="700" fill="${colorTo}">${escapeXml(badge)}</text>`;
}
function platformBadge(cx, cy, r, platform, colorTo) {
 if (!platform) return '';
 const label = PLATFORM_GLYPHS[platform] || String(platform).slice(0, 2).toUpperCase();
 return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#ffffff"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${colorTo}" stroke-width="3"/><text x="${cx}" y="${cy + r * 0.32}" text-anchor="middle" font-family="Arial, sans-serif" font-size="${Math.round(r * 0.62)}" font-weight="700" fill="${colorTo}">${escapeXml(label)}</text>`;
}
function titleBlock(cx, startY, lines, size, color, anchor, lineHeight) {
 return lines.map((line, i) => `<text x="${cx}" y="${startY + i * lineHeight}" text-anchor="${anchor}" font-family="Tahoma, Arial, sans-serif" font-size="${size}" font-weight="700" fill="${color}" direction="rtl">${escapeXml(line)}</text>`).join('');
}

const DESIGN_TEMPLATES = [
 // 0 — Center Hero: bold centered title over a soft gradient with two translucent orbs.
 function centerHero({ titleLines, subtitle, colorFrom, colorTo, badge, platform }) {
  const startY = titleLines.length > 1 ? 188 : 213;
  return `<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${colorFrom}"/><stop offset="100%" stop-color="${colorTo}"/></linearGradient></defs>
  <rect width="800" height="450" fill="url(#g)"/>
  <circle cx="730" cy="70" r="130" fill="#ffffff" fill-opacity="0.08"/>
  <circle cx="70" cy="400" r="100" fill="#ffffff" fill-opacity="0.06"/>
  ${titleBlock(400, startY, titleLines, 46, '#ffffff', 'middle', 62)}
  ${subtitle ? `<text x="400" y="${startY + titleLines.length * 62 + 16}" text-anchor="middle" font-family="Tahoma, Arial, sans-serif" font-size="21" fill="#ffffffcc" direction="rtl">${escapeXml(subtitle)}</text>` : ''}
  ${demoBadge(24, 24, colorTo, badge)}
  ${platformBadge(730, 392, 34, platform, colorTo)}`;
 },
 // 1 — Diagonal Split: two-tone diagonal banner, right-aligned headline (RTL reading flow).
 function diagonalSplit({ titleLines, subtitle, colorFrom, colorTo, badge, platform }) {
  const startY = titleLines.length > 1 ? 128 : 150;
  const dots = Array.from({ length: 15 }, (_, i) => {
   const col = i % 5, row = Math.floor(i / 5);
   return `<circle cx="${610 + col * 26}" cy="${30 + row * 26}" r="3" fill="#ffffff" fill-opacity="0.35"/>`;
  }).join('');
  return `<rect width="800" height="450" fill="${colorTo}"/>
  <polygon points="0,0 800,0 800,190 0,330" fill="${colorFrom}"/>
  <line x1="0" y1="330" x2="800" y2="190" stroke="#ffffff" stroke-opacity="0.25" stroke-width="3"/>
  ${dots}
  ${titleBlock(740, startY, titleLines, 42, '#ffffff', 'end', 56)}
  ${subtitle ? `<text x="740" y="${startY + titleLines.length * 56 + 14}" text-anchor="end" font-family="Tahoma, Arial, sans-serif" font-size="19" fill="#ffffffcc" direction="rtl">${escapeXml(subtitle)}</text>` : ''}
  ${demoBadge(24, 24, colorFrom, badge)}
  ${platformBadge(730, 392, 34, platform, colorTo)}`;
 },
 // 2 — Bottom Banner: textured light top zone, solid title banner along the bottom edge.
 function bottomBanner({ titleLines, subtitle, colorFrom, colorTo, badge, platform }) {
  const stripes = Array.from({ length: 9 }, (_, i) => `<line x1="${-100 + i * 110}" y1="0" x2="${-100 + i * 110 + 300}" y2="270" stroke="${colorFrom}" stroke-opacity="0.12" stroke-width="26"/>`).join('');
  const bannerTop = 270;
  const startY = titleLines.length > 1 ? bannerTop + 66 : bannerTop + 92;
  return `<rect width="800" height="450" fill="#f8fafc"/>
  <rect width="800" height="${bannerTop}" fill="#eef2f6"/>
  ${stripes}
  <rect x="0" y="${bannerTop}" width="800" height="${450 - bannerTop}" fill="${colorTo}"/>
  ${titleBlock(400, startY, titleLines, 38, '#ffffff', 'middle', 50)}
  ${subtitle ? `<text x="400" y="${startY + titleLines.length * 50 + 14}" text-anchor="middle" font-family="Tahoma, Arial, sans-serif" font-size="18" fill="#ffffffcc" direction="rtl">${escapeXml(subtitle)}</text>` : ''}
  ${platformBadge(400, bannerTop, 38, platform, colorTo)}
  ${demoBadge(676, 24, colorFrom, badge)}`;
 },
 // 3 — Card Frame: gradient backdrop with an inset light "print" card holding the headline.
 function cardFrame({ titleLines, subtitle, colorFrom, colorTo, badge, platform }) {
  const startY = titleLines.length > 1 ? 195 : 220;
  return `<defs><linearGradient id="g" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="${colorFrom}"/><stop offset="100%" stop-color="${colorTo}"/></linearGradient></defs>
  <rect width="800" height="450" fill="url(#g)"/>
  <rect x="60" y="70" width="680" height="310" rx="18" fill="#ffffff" fill-opacity="0.97"/>
  ${titleBlock(400, startY, titleLines, 38, colorTo, 'middle', 52)}
  <rect x="370" y="${startY + titleLines.length * 52 - 28}" width="60" height="4" rx="2" fill="${colorFrom}"/>
  ${subtitle ? `<text x="400" y="${startY + titleLines.length * 52 + 6}" text-anchor="middle" font-family="Tahoma, Arial, sans-serif" font-size="18" fill="#475569" direction="rtl">${escapeXml(subtitle)}</text>` : ''}
  ${demoBadge(24, 24, colorTo, badge)}
  ${platformBadge(740, 380, 34, platform, colorTo)}`;
 },
 // 4 — Wave Footer: gradient with a soft double-wave silhouette anchoring the bottom edge.
 function waveFooter({ titleLines, subtitle, colorFrom, colorTo, badge, platform }) {
  const startY = titleLines.length > 1 ? 150 : 172;
  return `<defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${colorFrom}"/><stop offset="100%" stop-color="${colorTo}"/></linearGradient></defs>
  <rect width="800" height="450" fill="url(#g)"/>
  <path d="M0,340 C150,300 300,380 450,340 C600,300 750,360 800,330 L800,450 L0,450 Z" fill="#ffffff" fill-opacity="0.10"/>
  <path d="M0,380 C200,420 500,340 800,390 L800,450 L0,450 Z" fill="#ffffff" fill-opacity="0.16"/>
  ${titleBlock(400, startY, titleLines, 44, '#ffffff', 'middle', 58)}
  ${subtitle ? `<text x="400" y="${startY + titleLines.length * 58 + 16}" text-anchor="middle" font-family="Tahoma, Arial, sans-serif" font-size="20" fill="#ffffffcc" direction="rtl">${escapeXml(subtitle)}</text>` : ''}
  ${platformBadge(730, 60, 34, platform, colorTo)}
  ${demoBadge(24, 392, colorFrom, badge)}`;
 }
];

export function designAssetDataUri({ lines, subtitle, theme = DESIGN_THEMES[0], badge = 'DEMO', platform, template = 0 }) {
 const titleLines = (Array.isArray(lines) ? lines : [lines]).slice(0, 2);
 const [colorFrom, colorTo] = theme;
 const build = DESIGN_TEMPLATES[((template % DESIGN_TEMPLATES.length) + DESIGN_TEMPLATES.length) % DESIGN_TEMPLATES.length];
 const inner = build({ titleLines, subtitle, colorFrom, colorTo, badge, platform });
 const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">${inner}</svg>`;
 return 'data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64');
}

export const NOVA_TEAM = [
 { name: 'أحمد التجريبي', username: 'ahmed_demo_nova', role: 'owner' },
 { name: 'سارة التجريبية', username: 'sara_demo_nova', role: 'reviewer' },
 { name: 'خالد التجريبي', username: 'khaled_demo_nova', role: 'operator' },
 { name: 'نورة التجريبية', username: 'noura_demo_nova', role: 'operator' },
 { name: 'فيصل التجريبي', username: 'faisal_demo_nova', role: 'operator' },
 { name: 'ريم التجريبية', username: 'reem_demo_nova', role: 'operator' }
];
export const VERTEX_TEAM = [
 { name: 'عبدالله التجريبي', username: 'abdullah_demo_vertex', role: 'owner' },
 { name: 'منيرة التجريبية', username: 'muneera_demo_vertex', role: 'reviewer' },
 { name: 'ياسر التجريبي', username: 'yasser_demo_vertex', role: 'operator' },
 { name: 'هند التجريبية', username: 'hind_demo_vertex', role: 'operator' },
 { name: 'ماجد التجريبي', username: 'majed_demo_vertex', role: 'operator' },
 { name: 'لمى التجريبية', username: 'lama_demo_vertex', role: 'operator' },
 { name: 'سلطان التجريبي', username: 'sultan_demo_vertex', role: 'operator' },
 { name: 'دانة التجريبية', username: 'dana_demo_vertex', role: 'operator' }
];

export const NOVA_CUSTOMER_FIRST = ['محمد', 'عبدالعزيز', 'فهد', 'تركي', 'بندر', 'سعود', 'ناصر', 'عبدالرحمن', 'وليد', 'ماجد', 'هيفاء', 'العنود', 'شهد', 'جواهر', 'أمل', 'لجين', 'غلا', 'رغد', 'دلال', 'أروى'];
export const NOVA_CUSTOMER_LAST = ['التجريبي', 'التجريبية'];

export const NOVA_PRODUCTS = [
 { nameAr: 'تيشيرت اليوم الوطني', nameEn: 'National Day T-Shirt', category: 'ملابس', priceRange: [69, 99] },
 { nameAr: 'شماغ فاخر', nameEn: 'Premium Shemagh', category: 'ملابس', priceRange: [180, 320] },
 { nameAr: 'بشت كلاسيكي', nameEn: 'Classic Bisht', category: 'ملابس', priceRange: [650, 1200] },
 { nameAr: 'باقة هدية وطنية', nameEn: 'National Day Gift Bundle', category: 'هدايا', priceRange: [150, 250] },
 { nameAr: 'عطر شرقي', nameEn: 'Oriental Perfume', category: 'عطور', priceRange: [220, 480] },
 { nameAr: 'غترة قطنية', nameEn: 'Cotton Ghutra', category: 'ملابس', priceRange: [45, 85] },
 { nameAr: 'عقال فاخر', nameEn: 'Premium Agal', category: 'إكسسوارات', priceRange: [60, 140] },
 { nameAr: 'محفظة جلد طبيعي', nameEn: 'Genuine Leather Wallet', category: 'إكسسوارات', priceRange: [95, 210] },
 { nameAr: 'ساعة رجالية كلاسيكية', nameEn: 'Classic Men\'s Watch', category: 'إكسسوارات', priceRange: [340, 890] },
 { nameAr: 'طقم قهوة عربية', nameEn: 'Arabic Coffee Set', category: 'منزل', priceRange: [120, 260] },
 { nameAr: 'مبخرة نحاسية', nameEn: 'Brass Incense Burner', category: 'منزل', priceRange: [80, 175] },
 { nameAr: 'عود معطر فاخر', nameEn: 'Premium Oud', category: 'عطور', priceRange: [300, 750] },
 { nameAr: 'حقيبة يد نسائية', nameEn: 'Women\'s Handbag', category: 'إكسسوارات', priceRange: [190, 420] },
 { nameAr: 'عباية تطريز يدوي', nameEn: 'Hand-Embroidered Abaya', category: 'ملابس', priceRange: [280, 560] },
 { nameAr: 'طقم شماغ وعقال', nameEn: 'Shemagh & Agal Set', category: 'ملابس', priceRange: [220, 380] },
 { nameAr: 'دلة قهوة تراثية', nameEn: 'Heritage Coffee Pot', category: 'منزل', priceRange: [140, 300] },
 { nameAr: 'مسبحة كهرمان', nameEn: 'Amber Prayer Beads', category: 'إكسسوارات', priceRange: [55, 130] },
 { nameAr: 'شال حريري', nameEn: 'Silk Shawl', category: 'ملابس', priceRange: [110, 240] }
];

export const VERTEX_CLIENT_NAMES = [
 'شركة الأفق التجريبية', 'شركة مدار النمو التجريبية', 'مجموعة الريادة التجريبية', 'شركة نقطة التحول التجريبية',
 'مؤسسة الأثر الرقمي التجريبية', 'شركة البوصلة التجريبية', 'مجموعة القمة التجريبية', 'شركة المسار التجريبية',
 'مؤسسة الانطلاقة التجريبية', 'شركة الواحة التجريبية', 'Demo Horizon LLC', 'Demo Growth Partners',
 'Demo Vantage Group', 'Demo Nexus Holdings', 'Demo Skyline Ventures', 'شركة الرؤية الذكية التجريبية',
 'شركة التمكين الرقمي التجريبية', 'مجموعة الابتكار التجريبية', 'شركة الطريق الأمثل التجريبية', 'Demo Pinnacle Co'
];

export const VERTEX_PROJECT_THEMES = [
 'تحويل الموقع الإلكتروني', 'إعداد نظام CRM', 'أتمتة الذكاء الاصطناعي', 'إطلاق متجر إلكتروني', 'باقة تسويق شهرية'
];

// --- Business-narrative activity strings (audit trail / "agent activity") ------------------
export const NOVA_ACTIVITY_NARRATIVES = [
 { action: 'AGENT_WEEKLY_SUMMARY_GENERATED', detail: 'تم إعداد ملخص الأداء الأسبوعي تلقائيًا' },
 { action: 'AGENT_LOW_INVENTORY_DETECTED', detail: 'تنبيه: مخزون منخفض على أحد المنتجات الأكثر مبيعًا' },
 { action: 'AGENT_CAMPAIGN_UNDERPERFORMANCE_FLAGGED', detail: 'تم رصد أداء أقل من المتوقع لإحدى الحملات' },
 { action: 'AGENT_VIP_CUSTOMERS_IDENTIFIED', detail: 'تم تحديد مجموعة عملاء بقيمة شراء عالية' },
 { action: 'AGENT_CONTENT_DRAFT_PREPARED', detail: 'تم تجهيز مسودة محتوى جديدة لمراجعة الفريق' },
 { action: 'AGENT_BUDGET_SHIFT_RECOMMENDED', detail: 'توصية بإعادة توزيع ميزانية الحملات بين المنصات' },
 { action: 'AGENT_PENDING_LEADS_DETECTED', detail: 'تم رصد عملاء محتملين بانتظار المتابعة' },
 { action: 'CONNECTION_HEALTH_CHANGED', detail: 'تغيّرت حالة أحد الاتصالات المرتبطة' }
];
export const VERTEX_ACTIVITY_NARRATIVES = [
 { action: 'AGENT_PIPELINE_SUMMARY_GENERATED', detail: 'تم إعداد ملخص مسار المبيعات الأسبوعي' },
 { action: 'AGENT_PROPOSAL_FOLLOWUP_RECOMMENDED', detail: 'توصية بمتابعة عرض سعر لم يُرد عليه العميل' },
 { action: 'AGENT_OVERDUE_TASK_FLAGGED', detail: 'تم رصد مهمة متأخرة عن الموعد المحدد' },
 { action: 'AGENT_HIGH_RISK_CLIENT_DETECTED', detail: 'تنبيه: عميل مصنّف بمخاطرة مرتفعة يحتاج متابعة' },
 { action: 'AGENT_FOLLOWUP_RECOMMENDATION_PREPARED', detail: 'تم تجهيز توصية متابعة لعميل محتمل' },
 { action: 'CONNECTION_HEALTH_CHANGED', detail: 'تغيّرت حالة أحد الاتصالات المرتبطة' }
];
