import {randomUUID} from 'node:crypto';
import {fail} from './auth.js';
import {resolveActiveTenantId} from './tenancy.js';
import {recordAudit} from './audit.js';
import {listContent} from './content.js';
import {getInstagramMediaInsights, getFacebookPostInsights, getMetaFollowerCounts} from './runtime/meta-publishing.js';
import {getLinkedInPostMetrics, getLinkedInFollowerCount} from './runtime/linkedin-publishing.js';
import {getXPostMetrics, getXFollowerCount} from './runtime/x-publishing.js';

// Phase MKT-2, Part F — a single normalized, tenant-scoped metrics table, extensible to any
// future provider (TikTok/YouTube) without a schema replacement: (provider, external account,
// external content/post id, metric, value, period, retrievedAt, tenant_id) exactly as the
// brief specifies. `available=0`/`value=NULL` is a first-class, honest outcome — a provider
// that genuinely doesn't expose a metric (or a permission scope that isn't granted) is
// recorded as NOT AVAILABLE, never estimated or zero-filled.
//
// Known, deliberate scope limit: only content published through the EXISTING real publish
// path (the legacy `content_items` table + meta_publish/x_publish/linkedin_publish tools,
// which store a genuine externalPostId) has anything to sync. The newer `campaign_content_items`
// table (Phase MKT-2, Part B's orchestration pipeline) has no real external publish execution
// wired yet — its PUBLISHED status is a logical/manual state only, with no external post id —
// so campaign-orchestrated content has no per-post analytics until a future phase adds real
// publish execution for that table. This is reported honestly in docs/MKT_2_REPORT.md rather
// than silently working around it.
export function installMarketingAnalytics(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS marketing_analytics_metrics (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_account_id TEXT,
  external_content_id TEXT,
  content_id TEXT,
  metric TEXT NOT NULL,
  value REAL,
  available INTEGER NOT NULL DEFAULT 1,
  period TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_marketing_analytics_tenant ON marketing_analytics_metrics(tenant_id,provider,retrieved_at);
 CREATE INDEX IF NOT EXISTS idx_marketing_analytics_content ON marketing_analytics_metrics(tenant_id,content_id);`);
 // Phase MKT-2, Part G — a real record of every time the EXISTING `performance` agent
 // (agent #11, see agents/performance.md) actually reviewed real analytics data, with the
 // exact evidence it was given and its full structured recommendation. `campaign_id` is
 // nullable and purely a human-facing tag: real analytics today are account/provider-level
 // (see the module note above on campaign_content_items having no real publish path yet),
 // not genuinely attributable to one campaign, so this never pretends otherwise.
 db.exec(`CREATE TABLE IF NOT EXISTS marketing_performance_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  campaign_id TEXT,
  run_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  result_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'NEW',
  created_by TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_marketing_perf_reviews_tenant ON marketing_performance_reviews(tenant_id,created_at);
 CREATE INDEX IF NOT EXISTS idx_marketing_perf_reviews_campaign ON marketing_performance_reviews(tenant_id,campaign_id);`);
}
export const PERFORMANCE_REVIEW_STATUSES=['NEW','ACKNOWLEDGED','DISMISSED'];
function hydratePerformanceReview(row) {
 if(!row)return null;
 return {
  id:row.id,tenantId:row.tenant_id,campaignId:row.campaign_id,runId:row.run_id,
  evidence:JSON.parse(row.evidence_json),result:JSON.parse(row.result_json),status:row.status,
  createdBy:row.created_by,createdByName:row.created_by_name,createdAt:row.created_at
 };
}
/**
 * Persists exactly what the performance agent was shown (evidence — a snapshot of
 * getMarketingAnalyticsSummary at review time) and exactly what it concluded (result — the
 * full validated `performance` payload). Never mutated after the fact: a later re-review is a
 * NEW row, so the evidence trail for any past recommendation stays intact even as more
 * analytics accumulate (spec Part G: "Store with evidence linking to performance data and run
 * record").
 */
export function recordPerformanceReview(db,{campaignId,runId,evidence,result},user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const now=new Date().toISOString();
 const row={id:randomUUID(),tenantId:resolvedTenantId,campaignId:campaignId||null,runId,evidence,result,status:'NEW',createdBy:user?.id||null,createdByName:user?.name||null,createdAt:now};
 db.prepare(`INSERT INTO marketing_performance_reviews (id,tenant_id,campaign_id,run_id,evidence_json,result_json,status,created_by,created_by_name,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`)
  .run(row.id,resolvedTenantId,row.campaignId,runId,JSON.stringify(evidence),JSON.stringify(result),'NEW',row.createdBy,row.createdByName,now);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_PERFORMANCE_REVIEW_CREATED',itemId:row.id,detail:{runId,campaignId:row.campaignId},actorId:row.createdBy,actorName:row.createdByName,at:now},resolvedTenantId);
 return hydratePerformanceReview(db.prepare('SELECT * FROM marketing_performance_reviews WHERE id=? AND tenant_id=?').get(row.id,resolvedTenantId));
}
export function listPerformanceReviews(db,tenantId=null,{campaignId}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 let sql='SELECT * FROM marketing_performance_reviews WHERE tenant_id=?';
 const params=[resolvedTenantId];
 if(campaignId){sql+=' AND campaign_id=?';params.push(campaignId);}
 sql+=' ORDER BY created_at DESC';
 return db.prepare(sql).all(...params).map(hydratePerformanceReview);
}
export function getPerformanceReview(db,id,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const row=db.prepare('SELECT * FROM marketing_performance_reviews WHERE id=? AND tenant_id=?').get(id,resolvedTenantId);
 if(!row)fail(404,'مراجعة الأداء غير موجودة');
 return hydratePerformanceReview(row);
}
/**
 * A human acknowledging or dismissing a recommendation — never an automatic transition, and
 * never itself a content change (spec Part G: "Recommendations must NOT auto-modify or
 * publish content"). Acting on a recommendation happens through the ordinary, unrelated
 * campaign-content-item creation path (Part H), which still goes through the full real
 * compliance/approval gate before anything could ever publish.
 */
export function setPerformanceReviewStatus(db,id,status,user,tenantId=null) {
 if(!PERFORMANCE_REVIEW_STATUSES.includes(status))fail(400,'حالة غير صالحة');
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const existing=getPerformanceReview(db,id,resolvedTenantId);
 const now=new Date().toISOString();
 db.prepare('UPDATE marketing_performance_reviews SET status=? WHERE id=? AND tenant_id=?').run(status,id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_PERFORMANCE_REVIEW_STATUS_CHANGED',itemId:id,detail:{from:existing.status,to:status},actorId:user?.id||null,actorName:user?.name||null,at:now},resolvedTenantId);
 return getPerformanceReview(db,id,resolvedTenantId);
}

export const PROVIDER_BY_PLATFORM={Instagram:'meta',Facebook:'meta',LinkedIn:'linkedin',X:'x'};
export const ANALYTICS_METRICS=['impressions','reach','engagements','likes','comments','shares','clicks','followers','engagement_rate'];

function insertMetricRow(db,{tenantId,provider,externalAccountId,externalContentId,contentId,metric,value,period}) {
 const now=new Date().toISOString();
 db.prepare(`INSERT INTO marketing_analytics_metrics
  (id,tenant_id,provider,external_account_id,external_content_id,content_id,metric,value,available,period,retrieved_at,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run(randomUUID(),tenantId,provider,externalAccountId||null,externalContentId||null,contentId||null,metric,
   value===null||value===undefined?null:value, value===null||value===undefined?0:1, period, now, now);
}

function recordMetricSet(db,{tenantId,provider,externalAccountId,externalContentId,contentId,period},metrics) {
 for(const metric of ['impressions','reach','engagements','likes','comments','shares','clicks'])
  if(metrics[metric]!==undefined)insertMetricRow(db,{tenantId,provider,externalAccountId,externalContentId,contentId,metric,value:metrics[metric],period});
 if(Number.isFinite(metrics.impressions)&&metrics.impressions>0&&Number.isFinite(metrics.engagements))
  insertMetricRow(db,{tenantId,provider,externalAccountId,externalContentId,contentId,metric:'engagement_rate',value:metrics.engagements/metrics.impressions,period});
}

/**
 * Syncs per-post metrics for every genuinely PUBLISHED content item (legacy content_items
 * table — see the module-level note on campaign_content_items) that has a real externalPostId,
 * plus one account-level follower snapshot per configured provider. Never throws on a single
 * item/provider failure — each is isolated so one bad token doesn't block the rest of the sync.
 */
export async function syncAllMarketingAnalytics(deps,tenantId=null) {
 const {store,env,fetcher}=deps;
 const db=store.db;
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const period=new Date().toISOString().slice(0,10);
 const results={syncedPosts:0,unavailablePosts:0,skippedPosts:0,followers:{}};
 const items=listContent(db,resolvedTenantId).filter(item=>item.status==='PUBLISHED'&&item.externalPostId);
 for(const item of items) {
  const provider=PROVIDER_BY_PLATFORM[item.platform];
  if(!provider) {results.skippedPosts++;continue;}
  let metrics;
  try {
   if(item.platform==='Instagram')metrics=await getInstagramMediaInsights({store,env,fetcher},item.externalPostId,resolvedTenantId);
   else if(item.platform==='Facebook')metrics=await getFacebookPostInsights({store,env,fetcher},item.externalPostId,resolvedTenantId);
   else if(item.platform==='LinkedIn')metrics=await getLinkedInPostMetrics({store,env,fetcher},item.externalPostId,resolvedTenantId);
   else if(item.platform==='X')metrics=await getXPostMetrics({store,env,fetcher},item.externalPostId,resolvedTenantId);
  } catch(error) {metrics={status:'NOT_AVAILABLE',reason:error?.message||'UNKNOWN_ERROR'};}
  if(metrics?.status==='OK') {
   recordMetricSet(db,{tenantId:resolvedTenantId,provider,externalContentId:item.externalPostId,contentId:item.id,period},metrics);
   results.syncedPosts++;
  } else {
   recordAudit(db,{id:randomUUID(),action:'MARKETING_ANALYTICS_SYNC_UNAVAILABLE',itemId:item.id,
    detail:{platform:item.platform,reason:metrics?.reason||metrics?.status||'UNKNOWN'},at:new Date().toISOString()},resolvedTenantId);
   results.unavailablePosts++;
  }
 }
 const followerFetchers=[
  ['meta',()=>getMetaFollowerCounts({store,env,fetcher},resolvedTenantId).then(r=>r.status==='OK'?[
   r.facebookFollowers!=null?{accountId:r.pageId,value:r.facebookFollowers}:null,
   r.instagramFollowers!=null?{accountId:r.instagramAccountId,value:r.instagramFollowers}:null
  ].filter(Boolean):[])],
  ['linkedin',()=>getLinkedInFollowerCount({store,env,fetcher},resolvedTenantId).then(r=>r.status==='OK'?[{accountId:r.organizationId,value:r.followers}]:[])],
  ['x',()=>getXFollowerCount({store,env,fetcher},resolvedTenantId).then(r=>r.status==='OK'?[{accountId:r.userId,value:r.followers}]:[])]
 ];
 for(const [provider,fetchFollowers] of followerFetchers) {
  let snapshots=[];
  try {snapshots=await fetchFollowers();} catch {snapshots=[];}
  for(const snapshot of snapshots)insertMetricRow(db,{tenantId:resolvedTenantId,provider,externalAccountId:snapshot.accountId,metric:'followers',value:snapshot.value,period});
  results.followers[provider]=snapshots.length?snapshots.reduce((sum,s)=>sum+s.value,0):null;
 }
 recordAudit(db,{id:randomUUID(),action:'MARKETING_ANALYTICS_SYNC_COMPLETED',detail:results,at:new Date().toISOString()},resolvedTenantId);
 return results;
}

/**
 * Reads back the LATEST value per (provider, metric) within an optional lookback window —
 * the dashboard-facing summary. A provider with zero rows ever recorded (never synced, or
 * never configured) is distinguished from one that WAS synced but returned NOT_AVAILABLE for
 * every metric, matching Part N's "No analytics data connected" vs "0 followers" requirement.
 */
export function getMarketingAnalyticsSummary(db,tenantId=null,{sinceDays=30}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const since=new Date(Date.now()-sinceDays*86400000).toISOString();
 const rows=db.prepare(`SELECT provider,metric,value,available,retrieved_at FROM marketing_analytics_metrics
  WHERE tenant_id=? AND retrieved_at>=? ORDER BY retrieved_at DESC`).all(resolvedTenantId,since);
 const byProvider={};
 for(const row of rows) {
  byProvider[row.provider]=byProvider[row.provider]||{connected:true,metrics:{},lastSyncedAt:row.retrieved_at};
  const bucket=byProvider[row.provider];
  if(!(row.metric in bucket.metrics)) bucket.metrics[row.metric]=row.available?row.value:null;
 }
 return {
  tenantId:resolvedTenantId,
  providers:['meta','linkedin','x'].map(provider=>({
   provider,
   connected:!!byProvider[provider],
   lastSyncedAt:byProvider[provider]?.lastSyncedAt||null,
   metrics:byProvider[provider]?.metrics||null
  })),
  hasAnyData:rows.length>0
 };
}
