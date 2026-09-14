import {resolveActiveTenantId} from '../tenancy.js';

// Frost Command Center Phase 7C — AI Usage View (spec Part 43-45). Every number here is a
// real column already written by runtime.js's own finishRun() on every single agent run
// (tokens_input/tokens_output/estimated_cost/provider/model/latency_ms) — this module adds
// zero new tracking, only real aggregation/read of what already exists. `estimated_cost` is
// only ever non-null when a real PRICING_PER_MILLION_TOKENS entry has been filled in
// (llmProvider.js) — never a fabricated monetary figure (spec item 44).
const PERIOD_DAYS={today:1,'7d':7,'30d':30};
function periodStart(period) {
 const days=PERIOD_DAYS[period]||1;
 const start=new Date();
 if(period==='today')start.setHours(0,0,0,0);else start.setTime(Date.now()-days*86400000);
 return start.toISOString();
}
export function getAiUsageSummary(db,tenantId,{period='today'}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const since=periodStart(period);
 const rows=db.prepare(`SELECT agent_id,provider,model,tokens_input,tokens_output,estimated_cost,latency_ms,started_at
  FROM agent_runs WHERE tenant_id=? AND started_at>=? AND tokens_input IS NOT NULL`).all(resolvedTenantId,since);
 const totals={calls:rows.length,tokensInput:0,tokensOutput:0,estimatedCost:0,hasCostData:false};
 const byAgent={},byProvider={};
 for(const row of rows) {
  totals.tokensInput+=row.tokens_input||0;
  totals.tokensOutput+=row.tokens_output||0;
  if(row.estimated_cost!=null){totals.estimatedCost+=row.estimated_cost;totals.hasCostData=true;}
  byAgent[row.agent_id]??={calls:0,tokensInput:0,tokensOutput:0};
  byAgent[row.agent_id].calls++;byAgent[row.agent_id].tokensInput+=row.tokens_input||0;byAgent[row.agent_id].tokensOutput+=row.tokens_output||0;
  const providerKey=row.provider||'unknown';
  byProvider[providerKey]??={calls:0,tokensInput:0,tokensOutput:0};
  byProvider[providerKey].calls++;byProvider[providerKey].tokensInput+=row.tokens_input||0;byProvider[providerKey].tokensOutput+=row.tokens_output||0;
 }
 return {period,since,totals,byAgent,byProvider};
}
/** Per-command usage (spec Part 43) — the exact real tokens/duration/model for ONE run,
 * shown alongside its chat message. */
export function getRunUsage(db,runId,tenantId) {
 const row=db.prepare('SELECT provider,model,tokens_input,tokens_output,estimated_cost,latency_ms,used_fallback FROM agent_runs WHERE id=? AND tenant_id=?').get(runId,tenantId||resolveActiveTenantId(db));
 if(!row)return null;
 return {provider:row.provider,model:row.model,tokensInput:row.tokens_input,tokensOutput:row.tokens_output,
  totalTokens:(row.tokens_input||0)+(row.tokens_output||0),estimatedCost:row.estimated_cost,durationMs:row.latency_ms,usedFallback:!!row.used_fallback};
}
