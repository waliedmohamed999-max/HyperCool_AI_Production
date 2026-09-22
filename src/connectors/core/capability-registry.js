// Universal Integration Platform (Phase 6A, Part 9/10) — the ONE canonical capability
// taxonomy for the whole platform, so no future connector invents its own naming for a
// concept that already exists (Part 9: "منع كل Provider من اختراع naming مختلف").
//
// This module is purely ADDITIVE — it never renames or removes anything the existing
// tool/capability machinery (src/runtime/tools.js, src/runtime/capability-map.js) already
// relies on. `tool_definitions`, `agent_tool_assignments`, and every one of the 471 pre-Phase-6
// tests keep using the exact legacy strings they always have. `canonicalizeCapability()` is a
// pure, read-only lookup NEW code (the Connector SDK, and any future capability-aware UI) can
// call to normalize a legacy string, or to recognize that two differently-spelled legacy
// capabilities actually mean the same real-world thing (Part 10 — the "products.read ->
// commerce.products.read" example, applied to this codebase's own real, already-audited gaps).

/**
 * Canonical capability ids this platform actually has real code for today, grouped by the
 * provider/tool that backs them (Phase 6A's own integration audit — see docs/CAPABILITY_REGISTRY.md).
 * Adding a new canonical capability here does NOT itself grant anything — it only makes the id
 * a recognized, non-`CUSTOM` value a future ConnectorManifest can declare.
 */
export const CANONICAL_CAPABILITIES=Object.freeze([
 {id:'commerce.products.read',category:'COMMERCE',descriptionEn:'Read product catalog data',descriptionAr:'قراءة بيانات كتالوج المنتجات'},
 {id:'commerce.products.write',category:'COMMERCE',descriptionEn:'Create or update products',descriptionAr:'إنشاء أو تعديل المنتجات'},
 {id:'commerce.pricing.read',category:'COMMERCE',descriptionEn:'Read current pricing',descriptionAr:'قراءة الأسعار الحالية'},
 {id:'commerce.inventory.read',category:'COMMERCE',descriptionEn:'Read stock/inventory levels',descriptionAr:'قراءة مستويات المخزون'},
 {id:'commerce.inventory.write',category:'COMMERCE',descriptionEn:'Update stock/inventory levels',descriptionAr:'تحديث مستويات المخزون'},
 {id:'commerce.orders.read',category:'COMMERCE',descriptionEn:'Read orders',descriptionAr:'قراءة الطلبات'},
 {id:'commerce.orders.write',category:'COMMERCE',descriptionEn:'Create or update orders',descriptionAr:'إنشاء أو تعديل الطلبات'},
 {id:'commerce.customers.read',category:'COMMERCE',descriptionEn:'Read store customers',descriptionAr:'قراءة عملاء المتجر'},
 {id:'messaging.read',category:'MESSAGING',descriptionEn:'Read inbound messages',descriptionAr:'قراءة الرسائل الواردة'},
 {id:'messaging.send',category:'MESSAGING',descriptionEn:'Send an outbound message',descriptionAr:'إرسال رسالة صادرة'},
 {id:'messaging.campaign_send',category:'MESSAGING',descriptionEn:'Send a bulk campaign message to multiple contacts',descriptionAr:'إرسال رسالة حملة جماعية لعدة جهات اتصال'},
 {id:'mail.read',category:'PRODUCTIVITY',descriptionEn:'Read mailbox items',descriptionAr:'قراءة عناصر البريد'},
 {id:'mail.send',category:'PRODUCTIVITY',descriptionEn:'Send an email',descriptionAr:'إرسال بريد إلكتروني'},
 {id:'calendar.read',category:'PRODUCTIVITY',descriptionEn:'Read calendar availability/events',descriptionAr:'قراءة التقويم/المواعيد'},
 {id:'calendar.write',category:'PRODUCTIVITY',descriptionEn:'Create calendar events',descriptionAr:'إنشاء مواعيد في التقويم'},
 {id:'social.publish',category:'SOCIAL',descriptionEn:'Publish content to a social/organization channel',descriptionAr:'نشر محتوى على قناة اجتماعية/مؤسسية'},
 {id:'social.analytics.read',category:'SOCIAL',descriptionEn:'Read post/publishing analytics',descriptionAr:'قراءة تحليلات المنشورات'},
 {id:'design.generate',category:'CUSTOM',descriptionEn:'Generate a design asset',descriptionAr:'توليد تصميم/أصل بصري'},
 {id:'ai.generate',category:'AI',descriptionEn:'Generate a free-form model response',descriptionAr:'توليد رد نموذج حر'},
 {id:'ai.structured',category:'AI',descriptionEn:'Generate a schema-validated structured response',descriptionAr:'توليد رد بنيوي مطابق لمخطط'},
 {id:'ai.tools',category:'AI',descriptionEn:'Run a tool-augmented model turn',descriptionAr:'تشغيل جولة نموذج مع أدوات'},
 {id:'crm.read',category:'CRM',descriptionEn:'Read CRM leads/contacts',descriptionAr:'قراءة العملاء المحتملين/جهات الاتصال'},
 {id:'crm.write',category:'CRM',descriptionEn:'Create or update CRM leads/contacts',descriptionAr:'إنشاء أو تعديل عملاء محتملين/جهات اتصال'},
 {id:'memory.read',category:'CUSTOM',descriptionEn:'Read agent memory',descriptionAr:'قراءة ذاكرة الوكيل'},
 {id:'memory.propose',category:'CUSTOM',descriptionEn:'Propose a memory write for review',descriptionAr:'اقتراح كتابة ذاكرة للمراجعة'},
 {id:'analytics.read',category:'ANALYTICS',descriptionEn:'Read platform analytics',descriptionAr:'قراءة تحليلات المنصة'},
 {id:'content.write',category:'CUSTOM',descriptionEn:'Draft internal content',descriptionAr:'كتابة محتوى داخلي مسوّدة'},
 // Phase 6D, Part 51 — added centrally (not invented ad-hoc for a demo) to back the real
 // Acme ERP Builder proof connector's GET /invoices action and invoice.created trigger.
 {id:'accounting.invoices.read',category:'ACCOUNTING',descriptionEn:'Read invoices',descriptionAr:'قراءة الفواتير'}
]);

const CANONICAL_IDS=new Set(CANONICAL_CAPABILITIES.map(c=>c.id));

/**
 * Legacy → canonical aliases (Part 10). Every entry here is a REAL string already used
 * somewhere in src/runtime/tools.js's TOOL_METADATA today (verified by the Phase 6 integration
 * audit) that means the exact same real-world capability as an already-canonical id — never a
 * guess. Nothing reads this map to REPLACE the legacy string in the DB; it exists purely so
 * new, capability-aware code can treat both spellings as the same thing.
 */
export const CAPABILITY_ALIASES=Object.freeze({
 // Meta's Instagram/Facebook publish tool
 'publishing':'social.publish',
 // X's publish tool
 'publish':'social.publish',
 // LinkedIn's Company Page publish tool
 'organization.publish':'social.publish',
 // salla_syncOrders's TOOL_METADATA.capability string (kept for capability-map.js's existing
 // scope table, unrelated to this rename) canonicalized to the manifest's real capability id.
 'orders.read':'commerce.orders.read',
 // Salla's get_stock tool used the narrower legacy name before this canonical registry existed
 'commerce.stock.read':'commerce.inventory.read',
 // Salla's get_current_price tool
 'commerce.price.read':'commerce.pricing.read'
});

/** Returns the canonical id for a raw (possibly legacy) capability string — itself unchanged
 * if it is already canonical or genuinely unknown (never throws; an unknown string is a real,
 * valid CUSTOM capability a connector manifest may still declare, see validateManifest). */
export function canonicalizeCapability(raw) {
 if(typeof raw!=='string'||!raw)return raw;
 return CAPABILITY_ALIASES[raw]||raw;
}

/** True only for a capability id this registry actually recognizes (after alias resolution) —
 * a manifest may still declare an unrecognized capability (treated as CUSTOM), this just tells
 * a caller whether it round-trips to a documented, shared taxonomy entry. */
export function isKnownCapability(raw) {
 return CANONICAL_IDS.has(canonicalizeCapability(raw));
}

export function describeCapability(raw) {
 const id=canonicalizeCapability(raw);
 return CANONICAL_CAPABILITIES.find(c=>c.id===id)||null;
}
