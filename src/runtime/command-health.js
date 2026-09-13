import {listApprovals} from './approvals.js';
import {listEscalations} from './escalations.js';
import {listConnections} from '../integrations/connections.js';
import {buildWeeklyReport,currentWeekStart} from '../reporting.js';

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
