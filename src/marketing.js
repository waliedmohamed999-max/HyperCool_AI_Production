import {randomUUID} from 'node:crypto';
import {fail} from './auth.js';
import {resolveActiveTenantId} from './tenancy.js';
import {recordAudit} from './audit.js';
import {listLeads, listAllMessages} from './crm.js';
import {listContent, getContent, listContentFiltered, insertContent, writeContent, isCampaignShaped} from './content.js';
import {contentHash, scheduleCampaignContent, hasActiveScheduleJob} from './planning.js';
import {buildExecutiveReport, currentWeekStart} from './reporting.js';
import {createWorkflowDraft, activateWorkflow} from './runtime/workflow-engine.js';

// Marketing & Social Operating Module (Phase MKT-1). Per the architectural audit (see
// docs/MARKETING_MODULE.md), this file adds ONLY the two entities that genuinely did not
// already exist anywhere in this codebase: a Campaign (a named container grouping a goal,
// audience, offer, channels and a strategy) and a richer Content Item that can belong to one
// (channel/format/objective/hook/CTA/hashtags/creative brief/schedule — the existing
// `content_items` table only models a single flat post shape for Instagram/Facebook/X/
// LinkedIn). Everything else — leads, messages/conversations, agents, approvals, workflows,
// events, connectors — is the EXISTING system, reused as-is; nothing here duplicates it.
export const CAMPAIGN_STATUSES=['DRAFT','PLANNING','IN_REVIEW','APPROVED','ACTIVE','PAUSED','COMPLETED','FAILED'];
export const CONTENT_STATUSES=['DRAFT','IN_REVIEW','APPROVED','SCHEDULED','PUBLISHED','FAILED'];
export const CONTENT_FORMATS=['post','carousel','reel_script','story','ad','email','whatsapp_message','landing_page_copy','blog_outline'];
// Real channels this platform can actually reach today (matches integration-definitions.js's
// real, OAuth-implemented providers) plus the two always-available internal channels
// (WhatsApp/Email already exist as CRM channels; TikTok/YouTube/Google/Meta-Ads are
// deliberately absent — no real publish path exists for them, see the audit report).
export const CONTENT_CHANNELS=['Instagram','Facebook','X','LinkedIn','WhatsApp','Email','WebsiteChat'];

export function installMarketing(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  goal TEXT,
  product TEXT,
  audience TEXT,
  market TEXT,
  offer TEXT,
  channels_json TEXT NOT NULL DEFAULT '[]',
  budget REAL,
  start_date TEXT,
  end_date TEXT,
  tone TEXT,
  cta TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  strategy_json TEXT,
  intelligence_json TEXT,
  created_by TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
 );
 CREATE INDEX IF NOT EXISTS idx_marketing_campaigns_tenant ON marketing_campaigns(tenant_id,archived_at);`);
 // Phase MKT-2, Part B — links a campaign to its OPTIONAL real orchestration Workflow
 // (workflow_definitions.id) — the existing workflow engine owns everything about running it;
 // this is just the pointer.
 const campaignColumns=db.prepare('PRAGMA table_info(marketing_campaigns)').all().map(c=>c.name);
 if(!campaignColumns.includes('orchestration_workflow_id'))db.exec('ALTER TABLE marketing_campaigns ADD COLUMN orchestration_workflow_id TEXT');
 // Content Unification: campaign_content_items is no longer created here — it's now a legacy
 // table content.js's migrateUnifyContentItems() renames to campaign_content_items_pre_unify
 // (real pre-existing data) the moment content_items/planning.js are installed, before this
 // function ever runs. Campaign content lives in content_items now (see this file's
 // createCampaignContentItem/etc. adapters) — recreating this table here would only produce a
 // permanent empty orphan (and, worse, collide with migrateUnifyContentItems' own rename on a
 // later restart), so it's simply not done anymore.
 db.exec(`
 CREATE TABLE IF NOT EXISTS marketing_assets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  campaign_id TEXT,
  content_item_id TEXT,
  file_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  approved INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_by_name TEXT,
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_marketing_assets_tenant ON marketing_assets(tenant_id,campaign_id);`);
}

function hydrateCampaign(row) {
 if(!row)return null;
 return {
  id:row.id,tenantId:row.tenant_id,name:row.name,goal:row.goal,product:row.product,audience:row.audience,
  market:row.market,offer:row.offer,channels:JSON.parse(row.channels_json||'[]'),budget:row.budget,
  startDate:row.start_date,endDate:row.end_date,tone:row.tone,cta:row.cta,status:row.status,
  strategy:row.strategy_json?JSON.parse(row.strategy_json):null,
  intelligence:row.intelligence_json?JSON.parse(row.intelligence_json):null,
  orchestrationWorkflowId:row.orchestration_workflow_id||null,
  createdBy:row.created_by,createdByName:row.created_by_name,createdAt:row.created_at,updatedAt:row.updated_at
 };
}
// Content Unification: `item` here is now the canonical content.js item object (already a
// full JS object, not a raw SQL row) — this maps it back to the external campaign-content
// shape every existing caller (application.js routes, public/pages/marketing.js) already
// expects, translating the one renamed field (platform -> channel) at this boundary.
function hydrateContentItem(item) {
 if(!item)return null;
 const external={
  id:item.id,tenantId:item.tenantId,campaignId:item.campaignId||null,channel:item.platform,format:item.format,
  objective:item.objective||null,audience:item.audience||null,hook:item.hook,body:item.body||'',cta:item.cta||null,
  hashtags:item.hashtags||[],creativeBrief:item.creativeBrief||null,
  status:item.status,approvalId:item.approvalId||null,scheduledAt:item.scheduledAt||null,publishedAt:item.publishedAt||null,
  createdBy:item.createdBy||null,createdByName:item.createdByName||null,createdAt:item.createdAt,updatedAt:item.updatedAt||item.createdAt,
  complianceRunId:item.complianceRunId||null,complianceClassification:item.complianceClassification||null,
  compliance:item.compliance||null,complianceCheckedAt:item.complianceCheckedAt||null,
  creativeRunId:item.creativeRunId||null
 };
 // Part C — a compliance result only counts if it was run against the content EXACTLY as it
 // reads right now; any edit since (hook/body/cta/hashtags) silently invalidates it rather than
 // letting a stale PASS approve different text. Computed at read time, never trusted from a
 // cached "isValid" flag that could itself drift.
 external.complianceValid=!!(item.complianceContentHash && item.complianceContentHash===campaignContentHash(external));
 return external;
}
function cleanText(value,max) {
 return typeof value==='string'?value.trim().slice(0,max):null;
}
// Content Unification: delegates to the one canonical contentHash (src/planning.js) via a
// channel->platform field-name translation at this exact boundary — every internal call site
// in this file keeps passing {channel,...} exactly as before; contentHash itself never knew
// "channel" was ever a name used for this field.
export function campaignContentHash(item) {
 return contentHash({platform:item.channel,format:item.format,hook:item.hook,body:item.body,cta:item.cta,hashtags:item.hashtags});
}

// -----------------------------------------------------------------------------------------
// Campaigns
// -----------------------------------------------------------------------------------------
export function createCampaign(db,input,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const name=cleanText(input.name,200);
 if(!name)fail(400,'اسم الحملة مطلوب');
 const channels=Array.isArray(input.channels)?input.channels.filter(c=>CONTENT_CHANNELS.includes(c)):[];
 const now=new Date().toISOString();
 const row={
  id:randomUUID(),tenantId:resolvedTenantId,name,goal:cleanText(input.goal,500),product:cleanText(input.product,200),
  audience:cleanText(input.audience,500),market:cleanText(input.market,200),offer:cleanText(input.offer,500),
  channels,budget:typeof input.budget==='number'&&input.budget>=0?input.budget:null,
  startDate:input.startDate||null,endDate:input.endDate||null,tone:cleanText(input.tone,100),cta:cleanText(input.cta,200),
  createdBy:user?.id||null,createdByName:user?.name||null
 };
 db.prepare(`INSERT INTO marketing_campaigns (id,tenant_id,name,goal,product,audience,market,offer,channels_json,budget,start_date,end_date,tone,cta,status,created_by,created_by_name,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT',?,?,?,?)`)
  .run(row.id,row.tenantId,row.name,row.goal,row.product,row.audience,row.market,row.offer,JSON.stringify(row.channels),
   row.budget,row.startDate,row.endDate,row.tone,row.cta,row.createdBy,row.createdByName,now,now);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_CAMPAIGN_CREATED',itemId:row.id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getCampaign(db,row.id,resolvedTenantId);
}
export function getCampaign(db,id,tenantId=null) {
 const row=db.prepare('SELECT * FROM marketing_campaigns WHERE id=? AND tenant_id=? AND archived_at IS NULL').get(id,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'الحملة غير موجودة');
 return hydrateCampaign(row);
}
export function listCampaigns(db,tenantId=null,{status}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=status
  ?db.prepare('SELECT * FROM marketing_campaigns WHERE tenant_id=? AND status=? AND archived_at IS NULL ORDER BY created_at DESC').all(resolvedTenantId,status)
  :db.prepare('SELECT * FROM marketing_campaigns WHERE tenant_id=? AND archived_at IS NULL ORDER BY created_at DESC').all(resolvedTenantId);
 return rows.map(hydrateCampaign);
}
export function updateCampaign(db,id,patch,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const existing=getCampaign(db,id,resolvedTenantId);
 if(patch.status!==undefined && !CAMPAIGN_STATUSES.includes(patch.status))fail(400,'حالة حملة غير صالحة');
 const next={
  name:patch.name!==undefined?(cleanText(patch.name,200)||existing.name):existing.name,
  goal:patch.goal!==undefined?cleanText(patch.goal,500):existing.goal,
  product:patch.product!==undefined?cleanText(patch.product,200):existing.product,
  audience:patch.audience!==undefined?cleanText(patch.audience,500):existing.audience,
  market:patch.market!==undefined?cleanText(patch.market,200):existing.market,
  offer:patch.offer!==undefined?cleanText(patch.offer,500):existing.offer,
  channels:patch.channels!==undefined?(Array.isArray(patch.channels)?patch.channels.filter(c=>CONTENT_CHANNELS.includes(c)):existing.channels):existing.channels,
  budget:patch.budget!==undefined?(typeof patch.budget==='number'&&patch.budget>=0?patch.budget:null):existing.budget,
  startDate:patch.startDate!==undefined?patch.startDate:existing.startDate,
  endDate:patch.endDate!==undefined?patch.endDate:existing.endDate,
  tone:patch.tone!==undefined?cleanText(patch.tone,100):existing.tone,
  cta:patch.cta!==undefined?cleanText(patch.cta,200):existing.cta,
  status:patch.status!==undefined?patch.status:existing.status
 };
 const now=new Date().toISOString();
 db.prepare(`UPDATE marketing_campaigns SET name=?,goal=?,product=?,audience=?,market=?,offer=?,channels_json=?,budget=?,start_date=?,end_date=?,tone=?,cta=?,status=?,updated_at=? WHERE id=? AND tenant_id=?`)
  .run(next.name,next.goal,next.product,next.audience,next.market,next.offer,JSON.stringify(next.channels),next.budget,next.startDate,next.endDate,next.tone,next.cta,next.status,now,id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_CAMPAIGN_UPDATED',itemId:id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getCampaign(db,id,resolvedTenantId);
}
export function archiveCampaign(db,id,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getCampaign(db,id,resolvedTenantId);
 const now=new Date().toISOString();
 db.prepare('UPDATE marketing_campaigns SET archived_at=?,updated_at=? WHERE id=? AND tenant_id=?').run(now,now,id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_CAMPAIGN_ARCHIVED',itemId:id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return {archived:true};
}
// Saves the Strategy agent's real decision payload onto the campaign — called by the route
// AFTER a real agentRuntime.run('strategy', …) call returns (see application.js). Never
// invents a plan itself; if the agent run failed or AI is not configured, the caller simply
// does not call this and the campaign's strategy stays null (shown honestly in the UI).
export function saveCampaignStrategy(db,id,strategy,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getCampaign(db,id,resolvedTenantId);
 const now=new Date().toISOString();
 db.prepare('UPDATE marketing_campaigns SET strategy_json=?,status=CASE WHEN status=\'DRAFT\' THEN \'PLANNING\' ELSE status END,updated_at=? WHERE id=? AND tenant_id=?').run(JSON.stringify(strategy),now,id,resolvedTenantId);
 return getCampaign(db,id,resolvedTenantId);
}
export function saveCampaignIntelligence(db,id,intelligence,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getCampaign(db,id,resolvedTenantId);
 const now=new Date().toISOString();
 db.prepare('UPDATE marketing_campaigns SET intelligence_json=?,updated_at=? WHERE id=? AND tenant_id=?').run(JSON.stringify(intelligence),now,id,resolvedTenantId);
 return getCampaign(db,id,resolvedTenantId);
}

// -----------------------------------------------------------------------------------------
// Part B — OPTIONAL automated campaign orchestration, built entirely on the EXISTING workflow
// engine (src/runtime/workflow-engine.js) — never a second engine. Manual mode (the
// generate-strategy/generate-intelligence routes above, unchanged) keeps working exactly as
// before; this is an ADDITIONAL, opt-in path a campaign owner can pick instead. Every stage is
// a real AGENT step (intelligence/strategy/copy/creative/compliance — the exact 12 existing
// agents, zero new ones), the human gate is the workflow engine's own native APPROVAL step
// type, and "publishing" is the existing publishing agent's own step — it still goes through
// that agent's own tool-level approval gates (meta_publish/x_publish/etc. already require
// approval below a level), so this can never silently publish externally without the existing
// rules. Each AGENT step gets the real campaign brief via the workflow engine's own
// {{trigger.field}} templating (Part B's one small, backward-compatible extension to
// executeStep's AGENT branch — see workflow-engine.js) — `context.trigger` is the exact
// triggerContext this run was started with (see startCampaignOrchestrationRun below).
export function buildCampaignOrchestrationSteps() {
 const brief={
  campaignName:'{{trigger.name}}',goal:'{{trigger.goal}}',product:'{{trigger.product}}',
  audience:'{{trigger.audience}}',market:'{{trigger.market}}',offer:'{{trigger.offer}}',
  channels:'{{trigger.channels}}',tone:'{{trigger.tone}}',cta:'{{trigger.cta}}'
 };
 return [
  {id:'intelligence',type:'AGENT',agentId:'intelligence',objective:'رصد السوق للحملة {{trigger.name}}',input:{task:'marketing_campaign_intelligence',...brief},next:['strategy']},
  {id:'strategy',type:'AGENT',agentId:'strategy',objective:'استراتيجية الحملة {{trigger.name}}',input:{task:'marketing_campaign_strategy',...brief},next:['copy']},
  {id:'copy',type:'AGENT',agentId:'copy',objective:'صياغة نصوص الحملة {{trigger.name}}',input:{task:'marketing_campaign_copy',...brief},next:['creative']},
  {id:'creative',type:'AGENT',agentId:'creative',objective:'موجز إبداعي للحملة {{trigger.name}}',input:{task:'marketing_campaign_creative',...brief},next:['compliance']},
  {id:'compliance',type:'AGENT',agentId:'compliance',objective:'مراجعة امتثال الحملة {{trigger.name}}',input:{task:'marketing_campaign_compliance',...brief},next:['approval']},
  {id:'approval',type:'APPROVAL',riskLevel:'MEDIUM',reason:`اعتماد بشري مطلوب قبل جدولة/نشر محتوى الحملة {{trigger.name}}`,next:['publishing']},
  {id:'publishing',type:'AGENT',agentId:'publishing',objective:'خطة جدولة/نشر محتوى الحملة {{trigger.name}} بعد الاعتماد',input:{task:'marketing_campaign_publishing_plan',...brief},next:[]}
 ];
}
// Creates + immediately activates a REAL workflow (never left as an inert draft — a campaign
// owner choosing "automated mode" expects it runnable right away). Readiness only requires
// every AGENT step's target agent to be enabled (computeWorkflowReadiness) — it does NOT
// require AI to be configured (that is checked honestly at RUN time, same as every other
// agent call in this system), so this activates cleanly even before AI is set up.
export function createCampaignOrchestrationWorkflow(db,env,campaign,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 if(campaign.orchestrationWorkflowId)fail(409,'يوجد مسار تنسيق تلقائي لهذه الحملة بالفعل');
 const draft=createWorkflowDraft(db,env,resolvedTenantId,{
  nameAr:`تنسيق حملة: ${campaign.name}`,nameEn:`Campaign Orchestration: ${campaign.name}`,
  description:'مسار تلقائي اختياري: رصد سوق ← استراتيجية ← نصوص ← إبداع ← امتثال ← اعتماد بشري ← نشر',
  trigger:{type:'MANUAL'},conditions:null,steps:buildCampaignOrchestrationSteps()
 },user);
 const activated=activateWorkflow(db,env,draft.id,user,resolvedTenantId);
 const now=new Date().toISOString();
 db.prepare('UPDATE marketing_campaigns SET orchestration_workflow_id=?,updated_at=? WHERE id=? AND tenant_id=?').run(activated.id,now,campaign.id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_CAMPAIGN_ORCHESTRATION_CREATED',itemId:campaign.id,detail:{workflowId:activated.id},actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getCampaign(db,campaign.id,resolvedTenantId);
}
// The real triggerContext a run needs — every AGENT step's {{trigger.field}} resolves against
// exactly this object. Channels is joined to a plain string since renderTemplate does a plain
// String() conversion on whatever it finds at the path.
export function campaignOrchestrationTriggerContext(campaign) {
 return {
  name:campaign.name,goal:campaign.goal||'',product:campaign.product||'',audience:campaign.audience||'',
  market:campaign.market||'',offer:campaign.offer||'',channels:(campaign.channels||[]).join('، '),
  tone:campaign.tone||'',cta:campaign.cta||''
 };
}

// -----------------------------------------------------------------------------------------
// Campaign content items — Content Unification (see plan doc): these are now thin ADAPTERS
// over content.js's canonical content_items store (formerly a separate campaign_content_items
// table, renamed to campaign_content_items_pre_unify and retained as an inert historical
// backup by content.js's migration). External signatures/return shapes are preserved exactly
// so application.js's routes and public/pages/marketing.js's/whatsapp.js's UI code need zero
// changes. New campaign-content logic belongs in content.js/planning.js, not here — this file
// only keeps its own CONTENT_TRANSITIONS/compliance-gate validation, a real, distinct
// invariant from the legacy review/approval hash-pin that is not being merged into one state
// machine in this pass (see the plan's "compatibility decisions").
// -----------------------------------------------------------------------------------------
export function createCampaignContentItem(db,input,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 if(!CONTENT_CHANNELS.includes(input.channel))fail(400,'قناة غير مدعومة');
 if(!CONTENT_FORMATS.includes(input.format))fail(400,'نوع محتوى غير معروف');
 if(input.campaignId)getCampaign(db,input.campaignId,resolvedTenantId);
 const now=new Date().toISOString();
 const hashtags=Array.isArray(input.hashtags)?input.hashtags.slice(0,30).map(h=>String(h).trim()).filter(Boolean):[];
 const hook=cleanText(input.hook,300),body=cleanText(input.body,8000)||'';
 const item={
  id:randomUUID(),status:'DRAFT',platform:input.channel,format:input.format,date:now.slice(0,10),
  title:hook||body.slice(0,80),body,englishCopy:null,url:null,assetUrl:null,
  campaignId:input.campaignId||null,scheduledAt:null,connectionId:null,
  objective:cleanText(input.objective,300),audience:cleanText(input.audience,300),hook,cta:cleanText(input.cta,200),
  hashtags,creativeBrief:input.creativeBrief||null,approvalId:null,
  complianceRunId:null,complianceClassification:null,compliance:null,complianceCheckedAt:null,complianceContentHash:null,
  creativeRunId:null,externalPostId:null,liveUrl:null,publishedAt:null,
  createdBy:user?.id||null,createdByName:user?.name||null,createdAt:now,updatedAt:now
 };
 insertContent(db,item,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_CONTENT_CREATED',itemId:item.id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getCampaignContentItem(db,item.id,resolvedTenantId);
}
export function getCampaignContentItem(db,id,tenantId=null) {
 const item=getContent(db,id,tenantId);
 if(!isCampaignShaped(item))fail(404,'عنصر المحتوى غير موجود');
 return hydrateContentItem(item);
}
export function listCampaignContentItems(db,tenantId=null,{campaignId,status}={}) {
 return listContentFiltered(db,tenantId,{campaignId,status}).filter(isCampaignShaped).map(hydrateContentItem);
}
const CONTENT_TRANSITIONS={DRAFT:['IN_REVIEW','FAILED'],IN_REVIEW:['APPROVED','DRAFT','FAILED'],APPROVED:['SCHEDULED','PUBLISHED','FAILED'],SCHEDULED:['PUBLISHED','FAILED','APPROVED'],PUBLISHED:[],FAILED:['DRAFT']};
export function updateCampaignContentItem(db,id,patch,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const existingRaw=getContent(db,id,resolvedTenantId);
 if(!isCampaignShaped(existingRaw))fail(404,'عنصر المحتوى غير موجود');
 const existing=hydrateContentItem(existingRaw);
 const next={
  hook:patch.hook!==undefined?cleanText(patch.hook,300):existing.hook,
  body:patch.body!==undefined?(cleanText(patch.body,8000)||''):existing.body,
  cta:patch.cta!==undefined?cleanText(patch.cta,200):existing.cta,
  hashtags:patch.hashtags!==undefined?(Array.isArray(patch.hashtags)?patch.hashtags.slice(0,30).map(h=>String(h).trim()).filter(Boolean):existing.hashtags):existing.hashtags,
  creativeBrief:patch.creativeBrief!==undefined?patch.creativeBrief:existing.creativeBrief,
  scheduledAt:patch.scheduledAt!==undefined?patch.scheduledAt:existing.scheduledAt,
  approvalId:patch.approvalId!==undefined?patch.approvalId:existing.approvalId
 };
 // Production-readiness gate item 5 (duplicate-job protection): changing scheduledAt while a
 // real schedule_jobs row is still active for this content must never be accepted silently —
 // the content record would then disagree with the job the publishing worker actually executes
 // (the job keeps firing at the OLD time). Checked against the ACTUAL schedule_jobs table (via
 // planning.js, which owns it), not existing.status, since cancelJobs() never resets campaign
 // content.status back to APPROVED — relying on status alone would permanently lock out a
 // legitimate reschedule-after-cancel.
 if(patch.scheduledAt!==undefined && next.scheduledAt!==existing.scheduledAt && hasActiveScheduleJob(db,id,resolvedTenantId)) {
  fail(409,'المحتوى مجدول بالفعل بموعد قائم؛ ألغِ الجدولة الحالية عبر /api/schedule/cancel أولًا ثم أعد الجدولة');
 }
 let status=existing.status;
 if(patch.status!==undefined && patch.status!==existing.status) {
  if(!CONTENT_STATUSES.includes(patch.status))fail(400,'حالة غير صالحة');
  if(!CONTENT_TRANSITIONS[existing.status].includes(patch.status))fail(400,`لا يمكن الانتقال من ${existing.status} إلى ${patch.status} مباشرة`);
  // Part C — the real compliance gate. Checked against the CONTENT AS IT WILL READ after this
  // very patch (never the stale pre-edit version) — editing hook/body/cta/hashtags in the same
  // call that tries to approve must NOT sneak past a compliance result that reviewed different
  // text. A BLOCK classification can never be approved past regardless of hash freshness.
  if(existing.status==='IN_REVIEW' && patch.status==='APPROVED') {
   const wouldBeHash=campaignContentHash({channel:existing.channel,format:existing.format,hook:next.hook,body:next.body,cta:next.cta,hashtags:next.hashtags});
   if(!existingRaw.complianceClassification)fail(409,'يتطلب الاعتماد فحص امتثال حقيقي أولاً (compliance) — لا يوجد فحص مسجّل لهذا العنصر');
   if(existingRaw.complianceContentHash!==wouldBeHash)fail(409,'تغيّر المحتوى بعد آخر فحص امتثال — أعد الفحص قبل الاعتماد');
   if(existingRaw.complianceClassification==='BLOCK')fail(409,'فحص الامتثال رفض هذا المحتوى (BLOCK) — لا يمكن اعتماده');
  }
  status=patch.status;
 }
 const publishedAt=status==='PUBLISHED'&&!existing.publishedAt?new Date().toISOString():existing.publishedAt;
 const now=new Date().toISOString();
 const updated={...existingRaw,hook:next.hook,body:next.body,cta:next.cta,hashtags:next.hashtags,creativeBrief:next.creativeBrief,
  status,approvalId:next.approvalId,scheduledAt:next.scheduledAt,publishedAt,updatedAt:now,
  title:next.hook||next.body.slice(0,80)||existingRaw.title};
 // Content Unification: a real transition into SCHEDULED with a real scheduledAt now actually
 // creates a schedule_jobs row (src/planning.js's scheduleCampaignContent) — the fix for the
 // previously self-documented gap (marketing-analytics.js) where campaign content could reach
 // status SCHEDULED/PUBLISHED with zero real scheduling/publishing execution behind it. Must
 // run BEFORE writeContent below: scheduleCampaignContent re-reads the content row itself and
 // requires it to still be APPROVED (the pre-patch state), matching legacy scheduleContent's
 // own "content stays APPROVED, the job carries the SCHEDULED state" invariant.
 if(status==='SCHEDULED' && next.scheduledAt && existing.status!=='SCHEDULED')scheduleCampaignContent(db,id,next.scheduledAt,user,resolvedTenantId);
 writeContent(db,updated);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_CONTENT_UPDATED',itemId:id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getCampaignContentItem(db,id,resolvedTenantId);
}
// Part C — persists a real compliance agent decision against this exact content (hash-pinned).
// Called by the route AFTER a real agentRuntime.run('compliance', …) call returns; never
// invents a result itself. Storing here (rather than only in agent_runs) is what lets the
// APPROVE gate check classification+hash without re-querying agent_runs on every attempt.
export function saveComplianceResult(db,contentId,{runId,decision},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const existingRaw=getContent(db,contentId,resolvedTenantId);
 if(!isCampaignShaped(existingRaw))fail(404,'عنصر المحتوى غير موجود');
 const hash=campaignContentHash({channel:existingRaw.platform,format:existingRaw.format,hook:existingRaw.hook,body:existingRaw.body,cta:existingRaw.cta,hashtags:existingRaw.hashtags});
 const now=new Date().toISOString();
 const updated={...existingRaw,complianceRunId:runId,complianceClassification:decision?.classification||null,compliance:decision||null,complianceCheckedAt:now,complianceContentHash:hash,updatedAt:now};
 writeContent(db,updated);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_CONTENT_COMPLIANCE_CHECKED',itemId:contentId,detail:{runId,classification:decision?.classification||null},at:now},resolvedTenantId);
 return getCampaignContentItem(db,contentId,resolvedTenantId);
}
// Part D — persists a real creative agent decision (structured creative brief) against this
// content item. Populates the existing `creativeBrief` field — no new field/table.
export function saveCreativeBrief(db,contentId,{runId,payload},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const existingRaw=getContent(db,contentId,resolvedTenantId);
 if(!isCampaignShaped(existingRaw))fail(404,'عنصر المحتوى غير موجود');
 const now=new Date().toISOString();
 const updated={...existingRaw,creativeBrief:payload||null,creativeRunId:runId,updatedAt:now};
 writeContent(db,updated);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_CONTENT_CREATIVE_GENERATED',itemId:contentId,detail:{runId},at:now},resolvedTenantId);
 return getCampaignContentItem(db,contentId,resolvedTenantId);
}

// -----------------------------------------------------------------------------------------
// Marketing Assets (Phase MKT-2, Part K) — wires the EXISTING `marketing_assets` table
// (created in installMarketing above since MKT-1) to real CRUD. `fileRef` means different
// things per `source`, and each is validated accordingly, never trusted as opaque:
//  - 'upload': the id of a real row in `command_attachments` (src/runtime/attachments.js) —
//    the ONE real file-storage system this codebase has (per the MKT-2 brief: reuse, don't
//    build a second one). application.js validates the referenced attachment actually exists
//    and belongs to this tenant before ever accepting it here.
//  - 'external_url': an HTTPS URL only (a CDN/Drive/Canva share link etc.) — metadata/
//    reference only, no fetch, no re-hosting.
//  - 'creative_reference': a free-text pointer into a content item's own creativeBrief (no
//    binary asset exists yet — this is what Part D's "planning/instructions only" creative
//    agent output actually produces).
// -----------------------------------------------------------------------------------------
export const MARKETING_ASSET_TYPES=['image','video','document','external_url','creative_reference'];
export const MARKETING_ASSET_SOURCES=['upload','external_url','creative_reference'];
function hydrateAsset(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,type:row.type,source:row.source,campaignId:row.campaign_id,
  contentItemId:row.content_item_id,fileRef:row.file_ref,status:row.status,approved:!!row.approved,
  createdBy:row.created_by,createdByName:row.created_by_name,createdAt:row.created_at};
}
export function createMarketingAsset(db,{type,source,campaignId,contentItemId,fileRef},user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 if(!MARKETING_ASSET_TYPES.includes(type))fail(400,'نوع الأصل غير صالح');
 if(!MARKETING_ASSET_SOURCES.includes(source))fail(400,'مصدر الأصل غير صالح');
 if(typeof fileRef!=='string'||!fileRef.trim())fail(400,'مرجع الملف مطلوب');
 if(source==='external_url') {
  let parsed;try{parsed=new URL(fileRef);}catch{fail(400,'رابط خارجي غير صالح');}
  if(parsed.protocol!=='https:')fail(400,'الرابط الخارجي يجب أن يكون HTTPS');
 }
 if(campaignId)getCampaign(db,campaignId,resolvedTenantId);
 if(contentItemId)getCampaignContentItem(db,contentItemId,resolvedTenantId);
 const now=new Date().toISOString();
 const row={id:randomUUID(),tenantId:resolvedTenantId,type,source,campaignId:campaignId||null,contentItemId:contentItemId||null,fileRef:fileRef.trim(),status:'ACTIVE',approved:0,createdBy:user?.id||null,createdByName:user?.name||null,createdAt:now};
 db.prepare(`INSERT INTO marketing_assets (id,tenant_id,type,source,campaign_id,content_item_id,file_ref,status,approved,created_by,created_by_name,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id,resolvedTenantId,type,source,row.campaignId,row.contentItemId,row.fileRef,'ACTIVE',0,row.createdBy,row.createdByName,now);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_ASSET_CREATED',itemId:row.id,detail:{type,source,campaignId:row.campaignId,contentItemId:row.contentItemId},actorId:row.createdBy,actorName:row.createdByName,at:now},resolvedTenantId);
 return hydrateAsset(db.prepare('SELECT * FROM marketing_assets WHERE id=? AND tenant_id=?').get(row.id,resolvedTenantId));
}
export function listMarketingAssets(db,tenantId=null,{campaignId,contentItemId}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 let sql="SELECT * FROM marketing_assets WHERE tenant_id=? AND status='ACTIVE'";
 const params=[resolvedTenantId];
 if(campaignId){sql+=' AND campaign_id=?';params.push(campaignId);}
 if(contentItemId){sql+=' AND content_item_id=?';params.push(contentItemId);}
 sql+=' ORDER BY created_at DESC';
 return db.prepare(sql).all(...params).map(hydrateAsset);
}
export function getMarketingAsset(db,id,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const row=db.prepare('SELECT * FROM marketing_assets WHERE id=? AND tenant_id=?').get(id,resolvedTenantId);
 if(!row)fail(404,'الأصل غير موجود');
 return hydrateAsset(row);
}
export function setMarketingAssetApproval(db,id,approved,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getMarketingAsset(db,id,resolvedTenantId);
 db.prepare('UPDATE marketing_assets SET approved=? WHERE id=? AND tenant_id=?').run(approved?1:0,id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_ASSET_APPROVAL_CHANGED',itemId:id,detail:{approved:!!approved},actorId:user?.id||null,actorName:user?.name||null,at:new Date().toISOString()},resolvedTenantId);
 return getMarketingAsset(db,id,resolvedTenantId);
}
export function deleteMarketingAsset(db,id,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 getMarketingAsset(db,id,resolvedTenantId);
 db.prepare("UPDATE marketing_assets SET status='ARCHIVED' WHERE id=? AND tenant_id=?").run(id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'MARKETING_ASSET_ARCHIVED',itemId:id,actorId:user?.id||null,actorName:user?.name||null,at:new Date().toISOString()},resolvedTenantId);
 return {archived:true};
}

// -----------------------------------------------------------------------------------------
// Marketing Overview — reuses buildExecutiveReport (CRM/content/approvals numbers already
// computed there) and adds only the genuinely new marketing-specific counts. Reach/Engagement
// stay explicitly null/unavailable (reporting.js's own documented rule: never guess social
// analytics that no connector actually provides — see src/reporting.js:46).
// -----------------------------------------------------------------------------------------
export function buildMarketingOverview(store,env,{agents=[],agentRuns=[],escalations=[],approvals=[]}={},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 const exec=buildExecutiveReport(store,currentWeekStart(),{agents,agentRuns,escalations,approvals,env,tenantId:resolvedTenantId});
 const campaigns=listCampaigns(store.db,resolvedTenantId);
 const contentItems=listCampaignContentItems(store.db,resolvedTenantId);
 const messages=listAllMessages(store.db,2000,resolvedTenantId);
 const messagesByChannel={};
 for(const m of messages)messagesByChannel[m.channel]=(messagesByChannel[m.channel]||0)+1;
 const scheduledContent=contentItems.filter(c=>c.status==='SCHEDULED').length;
 const pendingApprovalContent=contentItems.filter(c=>c.status==='IN_REVIEW').length;
 return {
  ...exec,
  marketing:{
   campaigns:{total:campaigns.length,active:campaigns.filter(c=>c.status==='ACTIVE').length,draft:campaigns.filter(c=>c.status==='DRAFT'||c.status==='PLANNING').length},
   content:{total:contentItems.length,scheduled:scheduledContent,pendingApproval:pendingApprovalContent,published:contentItems.filter(c=>c.status==='PUBLISHED').length},
   inboxVolume:messages.length,
   messagesByChannel,
   // Honest per section 93/59 — no fake attribution or connected analytics.
   reach:null,engagement:null,socialAnalyticsAvailable:false,
   topChannels:Object.entries(messagesByChannel).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([channel,count])=>({channel,count}))
  }
 };
}
