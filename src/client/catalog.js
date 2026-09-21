import {agents as registryAgents} from '../domain.js';
import {requiredToolsFor, optionalToolsFor} from '../runtime/agent-readiness.js';

// The merchant-facing Agent catalog. The identities (ids, Arabic names) come from the platform's own
// agent registry (src/domain.js -> agent_registry); this file only adds presentation metadata
// (category, description, risk, default approval policy) and never invents an agent.
//
// The registry holds 13 rows: 12 delegated business agents plus `frost_commander`, the Command Center
// chat assistant. The assistant is a platform component (chat UI in the main dashboard), not a sellable
// task agent, so the merchant catalog - and every plan entitlement `agent.<id>` - covers the 12.

const META = {
 frost: {category: 'operations', icon: 'agent', risk: 'medium', approval: 'approval_required',
  descAr: 'المنسّق العام: يحدد الأولويات ويوزع العمل على باقي الوكلاء ويراجع نتائجهم.', descEn: 'The orchestrator: sets priorities, delegates work to the other agents and reviews their output.', nameEn: 'Frost Orchestrator'},
 strategy: {category: 'content', icon: 'chart', risk: 'low', approval: 'limited_autonomy',
  descAr: 'يبني خطط المحتوى المرتبطة بأهداف المبيعات والحملات.', descEn: 'Builds content plans tied to sales goals and campaigns.', nameEn: 'Content Strategy'},
 copy: {category: 'content', icon: 'file', risk: 'low', approval: 'limited_autonomy',
  descAr: 'يكتب نصوصًا تسويقية بالعربية والإنجليزية حسب المنصة والنبرة.', descEn: 'Writes marketing copy in Arabic and English for each platform and tone.', nameEn: 'Copywriting'},
 creative: {category: 'content', icon: 'grid', risk: 'low', approval: 'limited_autonomy',
  descAr: 'يقترح أفكارًا بصرية وسيناريوهات فيديو وتصاميم للمنشورات.', descEn: 'Proposes visual concepts, video scenarios and post designs.', nameEn: 'Creative'},
 compliance: {category: 'governance', icon: 'check', risk: 'medium', approval: 'approval_required',
  descAr: 'يراجع الأسعار والمواصفات والادعاءات قبل النشر.', descEn: 'Reviews prices, specifications and claims before anything is published.', nameEn: 'Compliance Review'},
 publishing: {category: 'social', icon: 'calendar', risk: 'high', approval: 'approval_required',
  descAr: 'يجدول المحتوى المعتمد وينشره على القنوات المتصلة.', descEn: 'Schedules approved content and publishes it to connected channels.', nameEn: 'Publishing & Scheduling'},
 leads: {category: 'sales', icon: 'users', risk: 'medium', approval: 'approval_required',
  descAr: 'يجد العملاء المحتملين ويسجلهم في CRM بمصدرهم.', descEn: 'Finds prospects and records them in the CRM with their source.', nameEn: 'Lead Generation'},
 sales: {category: 'sales', icon: 'users', risk: 'high', approval: 'approval_required',
  descAr: 'يؤهل العملاء ويجهز عروض الأسعار ويقترح تحديثات الصفقات.', descEn: 'Qualifies customers, prepares quotes and proposes deal updates.', nameEn: 'Sales Conversations'},
 followup: {category: 'sales', icon: 'clock', risk: 'medium', approval: 'approval_required',
  descAr: 'يتابع العملاء بعد المحادثات بموافقتهم وضمن قواعد التواصل.', descEn: 'Follows up with customers after conversations, with consent and contact rules.', nameEn: 'Follow-up'},
 intelligence: {category: 'analytics', icon: 'search', risk: 'low', approval: 'limited_autonomy',
  descAr: 'يرصد المنافسين واتجاهات السوق ويلخصها.', descEn: 'Monitors competitors and market trends and summarizes them.', nameEn: 'Market Intelligence'},
 performance: {category: 'analytics', icon: 'chart', risk: 'low', approval: 'limited_autonomy',
  descAr: 'يحلل نتائج الحملات ويقترح تحسينات.', descEn: 'Analyzes campaign results and suggests improvements.', nameEn: 'Performance Analysis'},
 memory: {category: 'operations', icon: 'book', risk: 'medium', approval: 'approval_required',
  descAr: 'يحفظ معلومات العلامة المعتمدة والدروس المستفادة ويقترح تحديثاتها.', descEn: 'Keeps approved brand information and lessons learned, proposing updates to them.', nameEn: 'Brand Memory'}
};

export const AGENT_IDS = Object.keys(META);
export const RISK_ORDER = {low: 1, medium: 2, high: 3};
export const isCatalogAgent = id => Object.prototype.hasOwnProperty.call(META, id);

/** Static + registry-derived description of one agent (no tenant state). */
export function describeAgent(id) {
 const meta = META[id];
 if (!meta) return null;
 const reg = registryAgents.find(a => a.id === id);
 return {
  key: id, nameAr: reg?.name || meta.nameEn, nameEn: meta.nameEn, descriptionAr: meta.descAr, descriptionEn: meta.descEn, category: meta.category, icon: meta.icon,
  riskLevel: meta.risk, approvalPolicy: meta.approval, requiredEntitlements: [`agent.${id}`],
  requiredTools: requiredToolsFor(id), optionalTools: optionalToolsFor(id), supportedActions: [...requiredToolsFor(id), ...optionalToolsFor(id)],
  version: 1
 };
}
export const listCatalog = () => AGENT_IDS.map(describeAgent);
export const agentEntitlements = () => AGENT_IDS.map(id => `agent.${id}`);
