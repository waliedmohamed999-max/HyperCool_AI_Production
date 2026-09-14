#!/usr/bin/env node
// One-off backfill (Release Hardening pass): the two demo tenants were seeded before Company
// Brain (Phase 7A) existed, so context_items was empty for both. demo-seed.mjs is idempotent
// per-tenant (skips a tenant that already exists), so it will never add these to the two
// already-seeded tenants on its own — this script adds them once, directly, using the same
// real createContextItem() function. Safe to re-run: skips a tenant that already has brain_* rows.
import { createApp } from '../src/application.js';
import { createContextItem } from '../src/runtime/context-items.js';

const app = await createApp({ env: process.env });
const db = app.store.db;

function ownerFor(tenantId) {
  const row = db.prepare(`SELECT u.id,u.name FROM tenant_memberships tm JOIN users u ON u.id=tm.user_id WHERE tm.tenant_id=? AND tm.role='owner' LIMIT 1`).get(tenantId);
  return { id: row.id, name: row.name, role: 'owner' };
}
function alreadySeeded(tenantId) {
  return db.prepare("SELECT COUNT(*) n FROM context_items WHERE tenant_id=? AND type LIKE 'brain_%'").get(tenantId).n > 0;
}

const nova = db.prepare("SELECT id FROM tenants WHERE slug='nova-store-demo'").get();
const vertex = db.prepare("SELECT id FROM tenants WHERE slug='vertex-solutions-demo'").get();

if (nova && !alreadySeeded(nova.id)) {
  const owner = ownerFor(nova.id);
  const items = [
    { type: 'brain_identity', title: 'هوية المتجر', description: 'متجر نوفا — متجر إلكتروني سعودي متخصص في العناية الشخصية والعطور، يخدم عملاء التجزئة (B2C) عبر سلة وزد.', pinned: true },
    { type: 'brain_goals', title: 'هدف الربع الحالي', description: 'زيادة المبيعات 20% هذا الربع عبر تحسين معدل تحويل الحملات الإعلانية وتقليل فجوات متابعة العملاء المتأخرين.' },
    { type: 'brain_customers', title: 'شريحة العملاء الأساسية', description: 'عملاء أفراد (B2C) في المدن الرئيسية (الرياض، جدة، الدمام)، يصلون غالبًا عبر إنستقرام وتيك توك، وحساسون تجاه العروض المحدودة.' },
    { type: 'brain_products', title: 'التشكيلة الأساسية', description: '18 منتجًا نشطًا ضمن العناية الشخصية والعطور، مع تركيز تسويقي على التشكيلات الموسمية والعروض الحصرية لفترة محدودة.' },
    { type: 'brain_brand', title: 'نبرة العلامة', description: 'ودّي وقريب من العميل، بلهجة سعودية بيضاء، مع تجنب المبالغة في الوعود التسويقية.', pinned: true },
    { type: 'brain_rules', title: 'قاعدة التعامل مع العملاء المتأخرين', description: 'أي عميل بلا متابعة لأكثر من 3 أيام يُعتبر متأخرًا ويجب تصعيده كمهمة (Task) لفريق المبيعات.' }
  ];
  for (const item of items) createContextItem(db, { ...item, source: 'manual' }, owner, nova.id);
  console.log('[demo:backfill-brain] Nova: seeded', items.length, 'Company Brain items');
} else console.log('[demo:backfill-brain] Nova: skip (already has brain items or tenant missing)');

if (vertex && !alreadySeeded(vertex.id)) {
  const owner = ownerFor(vertex.id);
  const items = [
    { type: 'brain_identity', title: 'هوية الشركة', description: 'فيرتكس سوليوشنز — شركة استشارات وحلول تقنية B2B تخدم عملاء مؤسسيين عبر مشاريع ودورة مبيعات طويلة نسبيًا.', pinned: true },
    { type: 'brain_goals', title: 'هدف الربع الحالي', description: 'رفع معدل تحويل العملاء المحتملين المؤهلين (Qualified) إلى عقود موقعة، وتقليل زمن الاستجابة الأولى للعملاء الجدد.' },
    { type: 'brain_customers', title: 'شريحة العملاء الأساسية', description: 'عملاء شركات (B2B) في قطاعات متعددة، بدورة قرار أطول تتطلب متابعة منظمة ومتعددة نقاط الاتصال.' },
    { type: 'brain_products', title: 'نطاق الخدمات', description: 'استشارات تقنية وتنفيذ مشاريع حسب الطلب — لا يوجد كتالوج منتجات جاهزة (نموذج خدمات وليس تجارة إلكترونية).' },
    { type: 'brain_brand', title: 'نبرة العلامة', description: 'مهني ومباشر، يعتمد على الأرقام والنتائج القابلة للقياس في كل تواصل مع العميل.', pinned: true },
    { type: 'brain_rules', title: 'قاعدة تصعيد العميل المحتمل الساخن', description: 'أي عميل محتمل مصنّف HOT بلا تعيين مسؤول خلال 24 ساعة يجب تصعيده كمهمة (Task) لمدير الحسابات.' }
  ];
  for (const item of items) createContextItem(db, { ...item, source: 'manual' }, owner, vertex.id);
  console.log('[demo:backfill-brain] Vertex: seeded', items.length, 'Company Brain items');
} else console.log('[demo:backfill-brain] Vertex: skip (already has brain items or tenant missing)');

app.store.close();
