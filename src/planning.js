import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {fail} from './auth.js';
import {isEnabled} from './runtime/feature-flags.js';
import {resolveActiveTenantId} from './tenancy.js';
import {getContentOrNull,listContent} from './content.js';
import {recordAudit} from './audit.js';

// Content Unification: one canonical hash covering both content shapes now stored in the same
// content_items table. `item.hook!==undefined` distinguishes campaign-originated content (from
// the former campaign_content_items table, now a src/marketing.js adapter over this same
// store) from a legacy standalone post — campaign content never had title/englishCopy/url/
// assetUrl, and legacy content never had hook/cta/hashtags, so hashing the wrong field set for
// either shape would make every pre-migration approval/compliance pin permanently invalid.
export function contentHash(item) {
 if(item.hook!==undefined)return createHash('sha256').update(JSON.stringify({platform:item.platform,format:item.format,hook:item.hook||'',body:item.body||'',cta:item.cta||'',hashtags:item.hashtags||[]})).digest('hex');
 return createHash('sha256').update(JSON.stringify({title:item.title,body:item.body,englishCopy:item.englishCopy||'',url:item.url,assetUrl:item.assetUrl||'',platform:item.platform,date:item.date})).digest('hex');
}
export function riyadhDate(now=Date.now()) {return new Date(Number(now)+10800000).toISOString().slice(0,10);}
export function validDate(value) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail(400,'تاريخ غير صالح');
 return value;
}
function dayOfWeek(date){return new Date(date+'T12:00:00Z').getUTCDay();}
// Multi-Tenant Phase 3 (spec Part F, Phase 20-21) — now that content itself is a real
// tenant-scoped table (src/content.js), calendar_slots/schedule_jobs no longer key off a
// global JSON-blob array, so scoping the schedule stopped being a false sense of isolation.
// calendar_slots' old UNIQUE(date,platform) table constraint would let a second tenant's
// calendar collide with the first's, so it needs table recreation (SQLite can't ALTER a
// table-level UNIQUE constraint in place) — same rename/recreate/copy/drop pattern used for
// credentials/crm_leads/products. schedule_jobs has no such table-level constraint (only the
// partial unique index on content_id, and a content_id is already unique to one tenant via
// content_items), so a plain additive ALTER + backfill is enough.
export function installPlanning(db) {
 migrateCalendarSlotsTenant(db);
 migrateScheduleJobsTenant(db);
 migrateDailyBriefs(db);
}
function migrateCalendarSlotsTenant(db) {
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_slots'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(calendar_slots)').all().map(c=>c.name);
  if(!columns.includes('tenant_id')) {
   const tenantId=resolveActiveTenantId(db);
   db.exec('ALTER TABLE calendar_slots RENAME TO calendar_slots_pre_tenant;');
   db.exec('CREATE TABLE calendar_slots (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, date TEXT NOT NULL, platform TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(tenant_id,date,platform));');
   db.prepare('INSERT INTO calendar_slots (id,tenant_id,date,platform,json) SELECT id,?,date,platform,json FROM calendar_slots_pre_tenant').run(tenantId);
   db.exec('DROP TABLE calendar_slots_pre_tenant;');
  }
  return;
 }
 db.exec('CREATE TABLE calendar_slots (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, date TEXT NOT NULL, platform TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(tenant_id,date,platform));');
}
function migrateScheduleJobsTenant(db) {
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schedule_jobs'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(schedule_jobs)').all().map(c=>c.name);
  if(!columns.includes('tenant_id'))db.exec('ALTER TABLE schedule_jobs ADD COLUMN tenant_id TEXT;');
 } else {
  db.exec(`CREATE TABLE schedule_jobs (id TEXT PRIMARY KEY, tenant_id TEXT, content_id TEXT NOT NULL, status TEXT NOT NULL, scheduled_at TEXT NOT NULL, json TEXT NOT NULL);
  CREATE UNIQUE INDEX IF NOT EXISTS active_content_schedule ON schedule_jobs(content_id) WHERE status IN ('SCHEDULED','READY_FOR_CONNECTOR');`);
 }
 db.exec('CREATE INDEX IF NOT EXISTS idx_schedule_jobs_tenant ON schedule_jobs(tenant_id);');
 const unresolved=db.prepare('SELECT COUNT(*) n FROM schedule_jobs WHERE tenant_id IS NULL').get().n;
 if(unresolved>0)db.prepare('UPDATE schedule_jobs SET tenant_id=? WHERE tenant_id IS NULL').run(resolveActiveTenantId(db));
}
function migrateDailyBriefs(db) {
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='daily_briefs'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(daily_briefs)').all().map(c=>c.name);
  if(!columns.includes('tenant_id')) {
   const tenantId=resolveActiveTenantId(db);
   db.exec('ALTER TABLE daily_briefs RENAME TO daily_briefs_pre_tenant;');
   db.exec('CREATE TABLE daily_briefs (tenant_id TEXT NOT NULL, date TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(tenant_id,date));');
   db.prepare('INSERT INTO daily_briefs (tenant_id,date,json) SELECT ?,date,json FROM daily_briefs_pre_tenant').run(tenantId);
   db.exec('DROP TABLE daily_briefs_pre_tenant;');
  }
  return;
 }
 db.exec('CREATE TABLE IF NOT EXISTS daily_briefs (tenant_id TEXT NOT NULL, date TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(tenant_id,date));');
}
export function listSlots(db,tenantId=null){return db.prepare('SELECT json FROM calendar_slots WHERE tenant_id=? ORDER BY date,platform').all(tenantId||resolveActiveTenantId(db)).map(row=>JSON.parse(row.json));}
export function listJobs(db,tenantId=null){return db.prepare('SELECT json FROM schedule_jobs WHERE tenant_id=? ORDER BY scheduled_at DESC').all(tenantId||resolveActiveTenantId(db)).map(row=>JSON.parse(row.json));}
// schedule_jobs is owned by this module — exported so callers elsewhere (src/marketing.js's
// updateCampaignContentItem, guarding against a silent scheduledAt desync) never need their own
// raw SQL against a table they don't own.
export function hasActiveScheduleJob(db,contentId,tenantId=null){return !!db.prepare("SELECT id FROM schedule_jobs WHERE tenant_id=? AND content_id=? AND status IN ('SCHEDULED','READY_FOR_CONNECTOR')").get(tenantId||resolveActiveTenantId(db),contentId);}
function audit(db,action,id,user,tenantId=null){recordAudit(db,{id:randomUUID(),action,itemId:id,actorId:user.id,actorName:user.name,actorRole:user.role,at:new Date().toISOString()},tenantId);}

export function createCalendar(store,startDate,user,tenantId=null) {
 validDate(startDate);
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 const pillars=['تعليمي','منتج أو عرض معتمد','تعليمي','إثبات اجتماعي موثق','منتج أو عرض معتمد','تعليمي','تفاعل أو ريل'];
 const linkedin={0:'رؤية قطاعية',2:'تركيب أو دراسة حالة موثقة',4:'خبرة تقنية'};
 return store.mutate(state=>{
  let created=0;
  const insert=store.db.prepare('INSERT OR IGNORE INTO calendar_slots (id,tenant_id,date,platform,json) VALUES (?,?,?,?,?)');
  for(let offset=0;offset<30;offset++) {
   const date=new Date(Date.parse(startDate)+offset*86400000).toISOString().slice(0,10),day=dayOfWeek(date);
   for(const platform of ['Instagram','X','Facebook',...([0,2,4].includes(day)?['LinkedIn']:[])]) {
    const slot={id:randomUUID(),date,platform,pillar:platform==='LinkedIn'?linkedin[day]:pillars[day],audience:platform==='LinkedIn'?'B2B':'B2C',themeKey:date,status:'PLANNED',contentId:null,createdBy:user.id};
    created+=Number(insert.run(slot.id,resolvedTenantId,date,platform,JSON.stringify(slot)).changes);
   }
  }
  audit(store.db,'CALENDAR_CREATED',startDate,user,resolvedTenantId);
  return {created,startDate,days:30};
 });
}

export function scheduleContent(store,input,user,now=Date.now(),tenantId=null) {
 if(typeof input.contentId!=='string')fail(400,'اختر المحتوى');
 if(typeof input.scheduledAt!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(input.scheduledAt)||!Number.isFinite(Date.parse(input.scheduledAt)))fail(400,'موعد الجدولة يجب أن يتضمن المنطقة الزمنية');
 const time=Date.parse(input.scheduledAt),scheduledAt=new Date(time).toISOString();
 if(time<=now)fail(400,'اختر موعدًا في المستقبل');
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 return store.mutate(state=>{
  const item=getContentOrNull(store.db,input.contentId,resolvedTenantId);
  if(!item)fail(404,'المحتوى غير موجود');
  if(item.status!=='APPROVED'||!item.approval?.userId||!item.review?.userId||item.legacyUnauthenticated)fail(409,'المحتوى يحتاج مراجعة واعتمادًا بحساب موثق');
  const hash=contentHash(item);
  if(item.approval.contentHash!==hash||item.review.contentHash!==hash||!item.approval.id)fail(409,'الاعتماد لا يطابق نسخة المحتوى؛ أعد المراجعة والاعتماد');
  if(riyadhDate(time)!==item.date)fail(409,'موعد الجدولة لا يطابق تاريخ المحتوى بتوقيت الرياض');
  if(item.platform==='LinkedIn' && ![0,2,4].includes(dayOfWeek(item.date)))fail(409,'أيام LinkedIn: الأحد والثلاثاء والخميس');
  if(item.platform==='LinkedIn' && !item.englishCopy?.trim())fail(409,'محتوى LinkedIn يحتاج نسخة إنجليزية معتمدة');
  if(item.platform==='Instagram' && !item.assetUrl)fail(409,'أضف رابط الأصل البصري ثم أعد المراجعة والاعتماد');
  const prior=store.db.prepare("SELECT json FROM schedule_jobs WHERE tenant_id=? AND content_id=? AND status IN ('SCHEDULED','READY_FOR_CONNECTOR')").get(resolvedTenantId,item.id);
  if(prior){const job=JSON.parse(prior.json);if(job.scheduledAt===scheduledAt&&job.contentHash===hash)return {...job,replayed:true};fail(409,'المحتوى مجدول بالفعل؛ ألغِ الجدولة القديمة أولًا');}
  const slotRow=store.db.prepare('SELECT json FROM calendar_slots WHERE tenant_id=? AND date=? AND platform=?').get(resolvedTenantId,item.date,item.platform);
  if(!slotRow)fail(409,'أنشئ تقويمًا يشمل تاريخ المحتوى أولًا');
  const slot=JSON.parse(slotRow.json);
  if(slot.contentId && slot.contentId!==item.id)fail(409,'هذه المنصة لها محتوى مجدول بالفعل في اليوم نفسه');
  const job={id:randomUUID(),contentId:item.id,slotId:slot.id,status:'SCHEDULED',scheduledAt,contentHash:hash,idempotencyKey:randomUUID(),approvalId:item.approval.id,snapshot:{title:item.title,body:item.body,englishCopy:item.englishCopy||'',url:item.url,assetUrl:item.assetUrl||null,platform:item.platform},scheduledBy:user.id,createdAt:new Date(now).toISOString(),blockReason:null};
  store.db.prepare('INSERT INTO schedule_jobs (id,tenant_id,content_id,status,scheduled_at,json) VALUES (?,?,?,?,?,?)').run(job.id,resolvedTenantId,item.id,job.status,scheduledAt,JSON.stringify(job));
  slot.contentId=item.id;slot.status='SCHEDULED';store.db.prepare('UPDATE calendar_slots SET json=? WHERE id=?').run(JSON.stringify(slot),slot.id);
  audit(store.db,'CONTENT_SCHEDULED',item.id,user,resolvedTenantId);
  return job;
 });
}

// Content Unification — the campaign-content counterpart to scheduleContent() above, reusing
// the exact same schedule_jobs mechanism (so prepareDue/cancelJobs treat both identically) but
// gated on campaign content's OWN existing invariant (a real, hash-pinned, non-BLOCK compliance
// result — see src/marketing.js's updateCampaignContentItem) instead of the legacy
// review{}/approval{} object shape campaign content never had. This is what makes campaign
// content actually schedulable/publishable for the first time (see marketing-analytics.js's own
// prior "no external post id" note) rather than a second copy of scheduleContent's logic —
// slotId stays null since campaign content has no calendar_slots day/platform seeding
// requirement (a legacy-only UX affordance, not a scheduling invariant).
// Takes `db` directly (not `store`) — matching src/marketing.js's own existing non-
// transactional convention for campaign content (its functions never wrap writes in
// store.mutate() today), rather than introducing a new calling convention just for this path.
export function scheduleCampaignContent(db,contentId,scheduledAt,user,tenantId=null) {
 if(typeof scheduledAt!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(scheduledAt)||!Number.isFinite(Date.parse(scheduledAt)))fail(400,'موعد الجدولة يجب أن يتضمن المنطقة الزمنية');
 const normalizedScheduledAt=new Date(Date.parse(scheduledAt)).toISOString();
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const item=getContentOrNull(db,contentId,resolvedTenantId);
 if(!item)fail(404,'المحتوى غير موجود');
 if(item.status!=='APPROVED')fail(409,'المحتوى يحتاج اعتمادًا أولاً');
 if(!item.complianceClassification||item.complianceClassification==='BLOCK')fail(409,'يتطلب فحص امتثال ناجح قبل الجدولة');
 const hash=contentHash(item);
 if(item.complianceCheckedAt && item.complianceContentHash && item.complianceContentHash!==hash)fail(409,'تغيّر المحتوى بعد آخر فحص امتثال — أعد الفحص قبل الجدولة');
 const prior=db.prepare("SELECT json FROM schedule_jobs WHERE tenant_id=? AND content_id=? AND status IN ('SCHEDULED','READY_FOR_CONNECTOR')").get(resolvedTenantId,item.id);
 if(prior){const job=JSON.parse(prior.json);if(job.scheduledAt===normalizedScheduledAt&&job.contentHash===hash)return {...job,replayed:true};fail(409,'المحتوى مجدول بالفعل؛ ألغِ الجدولة القديمة أولًا');}
 const job={id:randomUUID(),contentId:item.id,slotId:null,status:'SCHEDULED',scheduledAt:normalizedScheduledAt,contentHash:hash,idempotencyKey:randomUUID(),approvalId:null,snapshot:{platform:item.platform,format:item.format,hook:item.hook,body:item.body,cta:item.cta},scheduledBy:user.id,createdAt:new Date().toISOString(),blockReason:null};
 db.prepare('INSERT INTO schedule_jobs (id,tenant_id,content_id,status,scheduled_at,json) VALUES (?,?,?,?,?,?)').run(job.id,resolvedTenantId,item.id,job.status,normalizedScheduledAt,JSON.stringify(job));
 audit(db,'CONTENT_SCHEDULED',item.id,user,resolvedTenantId);
 return job;
}

export function cancelJobs(store,state,contentId,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 const rows=store.db.prepare("SELECT json FROM schedule_jobs WHERE tenant_id=? AND content_id=? AND status IN ('SCHEDULED','READY_FOR_CONNECTOR','BLOCKED')").all(resolvedTenantId,contentId);
 for(const row of rows) {
  const job=JSON.parse(row.json);job.status='CANCELLED';job.cancelledAt=new Date().toISOString();
  store.db.prepare('UPDATE schedule_jobs SET status=?,json=? WHERE id=?').run(job.status,JSON.stringify(job),job.id);
  const slotRow=store.db.prepare('SELECT json FROM calendar_slots WHERE id=?').get(job.slotId);
  if(slotRow){const slot=JSON.parse(slotRow.json);if(slot.contentId===contentId){slot.contentId=null;slot.status='PLANNED';store.db.prepare('UPDATE calendar_slots SET json=? WHERE id=?').run(JSON.stringify(slot),slot.id);}}
  audit(store.db,'SCHEDULE_CANCELLED',contentId,user,resolvedTenantId);
 }
 return {cancelled:rows.length};
}

// `eventBus` is optional so existing callers (manual `/api/schedule/prepare`,
// `/api/automation/prepare-due`) keep working unchanged; the internal scheduler tick
// (src/runtime/scheduler.js) passes a real one so a job becoming READY_FOR_CONNECTOR
// actually triggers the Publishing & Scheduling agent instead of sitting inert until
// someone opens the calendar — see CONTENT_PUBLISH_REQUESTED in orchestrator.js. Fired
// exactly once per SCHEDULED→READY_FOR_CONNECTOR transition (the `job.status!==status`
// guard below), never re-fired for a job already sitting in READY_FOR_CONNECTOR — a
// stalled/unknown publish outcome is a reconciliation concern, not a re-trigger loop.
export function prepareDue(store,user,now=Date.now(),eventBus=null,env={},tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 return store.mutate(state=>{
  const rows=store.db.prepare("SELECT json FROM schedule_jobs WHERE tenant_id=? AND status IN ('SCHEDULED','READY_FOR_CONNECTOR') AND scheduled_at<=?").all(resolvedTenantId,new Date(now).toISOString());
  let ready=0,blocked=0;
  for(const row of rows) {
   const job=JSON.parse(row.json),item=getContentOrNull(store.db,job.contentId,resolvedTenantId);
   // Content Unification: campaign-originated content (item.hook!==undefined) never had the
   // legacy review{}/approval{} hash-pin objects — it re-validates against its OWN existing
   // invariant instead (a real, hash-pinned, non-BLOCK compliance result), matching the exact
   // gate src/marketing.js's updateCampaignContentItem already enforces at approval time.
   // Status must be SCHEDULED here, not APPROVED: updateCampaignContentItem() writes
   // status:'SCHEDULED' (a real, externally-visible campaign status, unlike legacy content
   // which never surfaces a SCHEDULED content status at all) the moment it creates this job —
   // requiring APPROVED here would mark every genuinely-scheduled campaign job BLOCKED forever.
   const valid=item?.hook!==undefined
    ?item?.status==='SCHEDULED' && !!item.complianceClassification && item.complianceClassification!=='BLOCK' && contentHash(item)===job.contentHash
    :item?.status==='APPROVED' && item.approval?.contentHash===job.contentHash && item.review?.contentHash===job.contentHash && item.review?.userId && item.approval?.userId && item.approval?.id===job.approvalId && !item.legacyUnauthenticated && contentHash(item)===job.contentHash;
   const status=valid?'READY_FOR_CONNECTOR':'BLOCKED';
   if(valid)ready++;else blocked++;
   if(job.status!==status){
    job.status=status;job.blockReason=valid?null:'APPROVAL_CHANGED';job.preparedAt=new Date(now).toISOString();
    store.db.prepare('UPDATE schedule_jobs SET status=?,json=? WHERE id=?').run(status,JSON.stringify(job),job.id);
    audit(store.db,status==='BLOCKED'?'SCHEDULE_BLOCKED':'SCHEDULE_PREPARED',job.contentId,user,resolvedTenantId);
    if(valid&&eventBus&&isEnabled(env,'ENABLE_SCHEDULED_PUBLISHING'))eventBus.emit('CONTENT_PUBLISH_REQUESTED',{contentId:job.contentId,jobId:job.id,platform:item.platform,idempotencyKey:job.idempotencyKey,scheduledAt:job.scheduledAt,current_datetime:new Date(now).toISOString(),timezone:'Asia/Riyadh',tenantId:resolvedTenantId});
   }
  }
  return {ready,blocked,externalActions:0};
 });
}

export function buildBrief(store,date=riyadhDate(),tenantId=null) {
 validDate(date);
 const tomorrow=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
 const content=listContent(store.db,tenantId);
 const items=content.filter(item=>item.date<=tomorrow);
 const jobs=listJobs(store.db,tenantId),slots=listSlots(store.db,tenantId).filter(slot=>slot.date===tomorrow);
 return {date,timezone:'Asia/Riyadh',generatedAt:new Date().toISOString(),targetDate:tomorrow,
  decisionsNeeded:items.filter(item=>['DRAFT','REVIEWED'].includes(item.status)).map(item=>({id:item.id,title:item.title,platform:item.platform,date:item.date,action:item.status==='DRAFT'?'COMPLIANCE_REVIEW':'OWNER_APPROVAL'})),
  tomorrowContent:content.filter(item=>item.date===tomorrow&&!['SUPERSEDED','REJECTED'].includes(item.status)).map(item=>({id:item.id,title:item.title,platform:item.platform,status:item.status,arabicCopy:item.body,englishCopy:item.englishCopy||'',url:item.url,assetUrl:item.assetUrl||null,contentHash:contentHash(item),reviewer:item.review?.reviewer||null,approvalId:item.approval?.id||null})),
  gaps:slots.filter(slot=>!slot.contentId).map(slot=>({date:slot.date,platform:slot.platform,pillar:slot.pillar})),
  calendarMissing:slots.length===0,
  blockedJobs:jobs.filter(job=>job.status==='BLOCKED').map(job=>({id:job.id,contentId:job.contentId,reason:job.blockReason})),
  waitingForConnector:jobs.filter(job=>job.status==='READY_FOR_CONNECTOR').length,
  metrics:{published:null,leads:null,revenue:null,reason:'مصادر الأداء والمبيعات غير متصلة'},
  deliveryStatus:'LOCAL_ONLY'};
}
export function saveDailyBrief(store,date,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 return store.mutate(()=>{
  validDate(date);
  const prior=store.db.prepare('SELECT json FROM daily_briefs WHERE tenant_id=? AND date=?').get(resolvedTenantId,date);
  if(prior)return {...JSON.parse(prior.json),replayed:true};
  const brief=buildBrief(store,date,resolvedTenantId);store.db.prepare('INSERT INTO daily_briefs (tenant_id,date,json) VALUES (?,?,?)').run(resolvedTenantId,date,JSON.stringify(brief));audit(store.db,'DAILY_BRIEF_CREATED',date,user,resolvedTenantId);return brief;
 });
}
export function authorizeAutomation(req,env) {
 const expected=env.AUTOMATION_TOKEN;
 const supplied=req.headers['x-hypercool-token'];
 if(typeof expected!=='string'||expected.length<32)fail(503,'Automation is not configured');
 if(typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))fail(401,'Invalid automation credentials');
}
