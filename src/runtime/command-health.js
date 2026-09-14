import {listApprovals} from './approvals.js';
import {listEscalations} from './escalations.js';
import {listConnections} from '../integrations/connections.js';
import {buildWeeklyReport,currentWeekStart} from '../reporting.js';
import {listLeads} from '../crm.js';

const UNHEALTHY_STATUSES=['ERROR','TOKEN_EXPIRED','PERMISSION_MISSING','DEGRADED'];
/**
 * The one real "company health" aggregation — shared verbatim by the frost_commander chat
 * tool (src/runtime/tools.js's get_company_health) and the direct GET /api/command/health
 * route (src/application.js), so the Executive Overview strip shows the exact same numbers
 * Frost would read in chat, and keeps working even with no AI provider configured at all
 * (spec item 70) since it never touches the LLM.
 */
export function computeCompanyHealth(store,tenantId) {
 const db=store.db;
 const pendingApprovals=listApprovals(db,{status:'PENDING'},tenantId);
 const openEscalations=listEscalations(db,{status:'OPEN'},tenantId);
 const connections=listConnections(db,{},tenantId);
 const unhealthy=connections.filter(c=>UNHEALTHY_STATUSES.includes(c.status));
 const week=buildWeeklyReport(store,currentWeekStart(),tenantId);
 return {
  pendingApprovals:pendingApprovals.length,
  openEscalations:openEscalations.length,
  totalConnections:connections.length,
  unhealthyConnections:unhealthy.map(c=>({id:c.id,name:c.name,status:c.status})),
  contentPlannedThisWeek:week.content.total,
  newLeadsThisWeek:week.crm.leadsCreated,
  weekStart:week.weekStart,weekEnd:week.weekEnd
 };
}

// Frost Command Center Phase 7C — Tenant-Aware Quick Commands (spec Part 48-52). Derived from
// REAL, currently observable tenant signals — a connected e-commerce integration, or a
// leads book that is mostly B2B — never hardcoded to any one named demo tenant. Returns
// stable KEYS (the frontend maps each to a real localized command phrase), so the underlying
// logic can gain more signals later without changing the wire format.
const ECOMMERCE_SLUGS=new Set(['salla','zid']);
export function deriveQuickCommandKeys(store,tenantId) {
 const db=store.db;
 const connections=listConnections(db,{},tenantId);
 const hasCommerce=connections.some(c=>ECOMMERCE_SLUGS.has(c.integrationDefinitionId)&&['CONNECTED','DEGRADED'].includes(c.status));
 if(hasCommerce)return ['reviewSales','reviewOrders','topCustomers','campaignPerformance','checkIntegrations'];
 const leads=listLeads(db,tenantId);
 const b2bRatio=leads.length?leads.filter(l=>l.customerType==='B2B').length/leads.length:0;
 if(b2bRatio>0.5)return ['reviewPipeline','lateLeads','teamWorkload','reviewApprovals','checkIntegrations'];
 return ['executiveReview','findRisks','findOpportunities','checkTasks','checkIntegrations'];
}
