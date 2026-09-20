// Packages / Plans — real, single source of truth for pricing-tier feature gating.
//
// This is NOT a billing engine (see tenancy.js's own note next to `tenants.plan`: "No billing
// engine: ... never a separate subscription concept"). There is no payment gateway anywhere in
// this codebase, so a plan is assigned directly by an owner/platform-admin via
// `PUT /api/tenant/plan` (src/application.js) — a real, immediate assignment, never a fake
// checkout flow. Every real enforcement point (agent runs, integration connections, team
// invitations, the Frost Command Center API) reads the SAME definition here — never a second,
// competing notion of "what this plan includes".
//
// Grandfather rule: `tenants.plan` predates this module (it already existed as a free TEXT
// column with no gating behind it). A tenant whose `plan` is NULL or not one of PLAN_IDS below
// is treated as UNRESTRICTED (`effectivePlan` returns null) rather than being retroactively
// locked out of agents/integrations it was already using before packages existed. Only a
// tenant explicitly assigned one of the four ids below is ever restricted.
//
// The exact agent/integration/seat split per tier is a real product decision, not something
// derivable from code — this is the breakdown requested when the packages were defined
// (agents + channels + features scaling together across four tiers).

import {getTenant} from './tenancy.js';

export const PLAN_IDS=['starter','growth','professional','enterprise'];

const STARTER_AGENTS=['frost','copy','publishing','leads'];
const GROWTH_AGENTS=[...STARTER_AGENTS,'strategy','creative','compliance','sales','followup'];

export const PLANS={
 starter:{
  id:'starter',nameAr:'الأساسية',nameEn:'Starter',price:990,currency:'SAR',billingPeriod:'monthly',priceIsStartingFrom:false,
  taglineAr:'لأصحاب الأعمال اللي بادئين يبنوا حضورهم الرقمي',taglineEn:'For businesses starting to build their digital presence',
  maxTeamMembers:2,
  allowedAgents:STARTER_AGENTS,
  allowedIntegrations:['whatsapp'],
  features:{automation:false,commandCenter:false,customIntegrations:false,advancedReports:false},
  highlighted:false
 },
 growth:{
  id:'growth',nameAr:'النمو',nameEn:'Growth',price:2490,currency:'SAR',billingPeriod:'monthly',priceIsStartingFrom:false,
  taglineAr:'لفرق التسويق والمبيعات النشطة على أكثر من قناة',taglineEn:'For marketing and sales teams active across multiple channels',
  maxTeamMembers:5,
  allowedAgents:GROWTH_AGENTS,
  allowedIntegrations:['whatsapp','meta','x'],
  features:{automation:true,commandCenter:false,customIntegrations:false,advancedReports:true},
  highlighted:false
 },
 professional:{
  id:'professional',nameAr:'الاحترافية',nameEn:'Professional',price:4990,currency:'SAR',billingPeriod:'monthly',priceIsStartingFrom:false,
  taglineAr:'القسم الاحترافي — كل الوكلاء وكل القنوات في مكان واحد',taglineEn:'The professional tier — every agent and every channel in one place',
  maxTeamMembers:null,
  allowedAgents:'ALL',
  allowedIntegrations:'ALL',
  features:{automation:true,commandCenter:true,customIntegrations:false,advancedReports:true},
  highlighted:true
 },
 enterprise:{
  id:'enterprise',nameAr:'المؤسسات',nameEn:'Enterprise',price:8000,currency:'SAR',billingPeriod:'monthly',priceIsStartingFrom:true,
  taglineAr:'تكاملات مخصصة ودعم مباشر واتفاقية مستوى خدمة',taglineEn:'Custom integrations, direct support, and a service-level agreement',
  maxTeamMembers:null,
  allowedAgents:'ALL',
  allowedIntegrations:'ALL',
  features:{automation:true,commandCenter:true,customIntegrations:true,advancedReports:true},
  highlighted:false
 }
};

export function getPlan(planId) { return PLANS[planId]||null; }

export function listPlans() { return PLAN_IDS.map(id=>PLANS[id]); }

/** null = unrestricted (legacy tenant, or no plan assigned yet). */
export function effectivePlan(tenant) {
 if(tenant && tenant.plan && PLANS[tenant.plan])return PLANS[tenant.plan];
 return null;
}

/**
 * Same as `effectivePlan`, but for call sites (createConnection, createInvitation) that only
 * have a `db`+`tenantId`, not an already-loaded tenant row, and that are also exercised by
 * narrow unit-test fixtures which legitimately never install the `tenants` table at all (they
 * test one feature in isolation, with no tenancy concept in scope). A lookup that fails because
 * tenancy isn't installed in this context means "no plan system applies here" — unrestricted,
 * exactly like a legacy tenant with no plan assigned — never a hard failure.
 */
export function effectivePlanForTenantId(db,tenantId) {
 try {return effectivePlan(getTenant(db,tenantId));}
 catch {return null;}
}

export function planAllowsAgent(plan,agentId) {
 if(!plan)return true;
 if(plan.allowedAgents==='ALL')return true;
 return plan.allowedAgents.includes(agentId);
}

/** `definition` is an integration_definitions row as returned by getIntegrationDefinition. */
export function planAllowsIntegration(plan,definition) {
 if(!plan)return true;
 if(definition.category==='ai')return true; // core infra (Anthropic/OpenAI), never a paid channel
 // Checked before the ALL shortcut below: a tenant-authored GENERIC_REST connector is gated by
 // the customIntegrations feature specifically, even on a plan whose built-in allowedIntegrations
 // is 'ALL' (Professional gets every built-in channel but not custom connectors; only Enterprise does).
 if(definition.adapterType==='GENERIC_REST')return !!plan.features.customIntegrations;
 if(plan.allowedIntegrations==='ALL')return true;
 return plan.allowedIntegrations.includes(definition.slug);
}

export function planAllowsCommandCenter(plan) {
 return !plan||!!plan.features.commandCenter;
}

/** `activeCount` = current active members + PENDING invitations (a pending invite reserves a seat). */
export function planSeatLimitReached(plan,activeCount) {
 if(!plan||plan.maxTeamMembers==null)return false;
 return activeCount>=plan.maxTeamMembers;
}
