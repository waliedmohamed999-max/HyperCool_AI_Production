import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {fail} from './auth.js';

export function contentHash(item) {
 return createHash('sha256').update(JSON.stringify({title:item.title,body:item.body,englishCopy:item.englishCopy||'',url:item.url,assetUrl:item.assetUrl||'',platform:item.platform,date:item.date})).digest('hex');
}
export function riyadhDate(now=Date.now()) {return new Date(Number(now)+10800000).toISOString().slice(0,10);}
export function validDate(value) {
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)fail(400,'تاريخ غير صالح');
 return value;
}
function dayOfWeek(date){return new Date(date+'T12:00:00Z').getUTCDay();}
export function installPlanning(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS calendar_slots (id TEXT PRIMARY KEY, date TEXT NOT NULL, platform TEXT NOT NULL, json TEXT NOT NULL, UNIQUE(date,platform));
 CREATE TABLE IF NOT EXISTS schedule_jobs (id TEXT PRIMARY KEY, content_id TEXT NOT NULL, status TEXT NOT NULL, scheduled_at TEXT NOT NULL, json TEXT NOT NULL);
 CREATE UNIQUE INDEX IF NOT EXISTS active_content_schedule ON schedule_jobs(content_id) WHERE status IN ('SCHEDULED','READY_FOR_CONNECTOR');
 CREATE TABLE IF NOT EXISTS daily_briefs (date TEXT PRIMARY KEY, json TEXT NOT NULL);`);
}
export function listSlots(db){return db.prepare('SELECT json FROM calendar_slots ORDER BY date,platform').all().map(row=>JSON.parse(row.json));}
export function listJobs(db){return db.prepare('SELECT json FROM schedule_jobs ORDER BY scheduled_at DESC').all().map(row=>JSON.parse(row.json));}
function audit(state,action,id,user){state.audit.unshift({id:randomUUID(),action,itemId:id,actorId:user.id,actorName:user.name,actorRole:user.role,at:new Date().toISOString()});}

export function createCalendar(store,startDate,user) {
 validDate(startDate);
 const pillars=['تعليمي','منتج أو عرض معتمد','تعليمي','إثبات اجتماعي موثق','منتج أو عرض معتمد','تعليمي','تفاعل أو ريل'];
 const linkedin={0:'رؤية قطاعية',2:'تركيب أو دراسة حالة موثقة',4:'خبرة تقنية'};
 return store.mutate(state=>{
  let created=0;
  const insert=store.db.prepare('INSERT OR IGNORE INTO calendar_slots VALUES (?,?,?,?)');
  for(let offset=0;offset<30;offset++) {
   const date=new Date(Date.parse(startDate)+offset*86400000).toISOString().slice(0,10),day=dayOfWeek(date);
   for(const platform of ['Instagram','X','Facebook',...([0,2,4].includes(day)?['LinkedIn']:[])]) {
    const slot={id:randomUUID(),date,platform,pillar:platform==='LinkedIn'?linkedin[day]:pillars[day],audience:platform==='LinkedIn'?'B2B':'B2C',themeKey:date,status:'PLANNED',contentId:null,createdBy:user.id};
    created+=Number(insert.run(slot.id,date,platform,JSON.stringify(slot)).changes);
   }
  }
  audit(state,'CALENDAR_CREATED',startDate,user);
  return {created,startDate,days:30};
 });
}

export function scheduleContent(store,input,user,now=Date.now()) {
 if(typeof input.contentId!=='string')fail(400,'اختر المحتوى');
 if(typeof input.scheduledAt!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(input.scheduledAt)||!Number.isFinite(Date.parse(input.scheduledAt)))fail(400,'موعد الجدولة يجب أن يتضمن المنطقة الزمنية');
 const time=Date.parse(input.scheduledAt),scheduledAt=new Date(time).toISOString();
 if(time<=now)fail(400,'اختر موعدًا في المستقبل');
 return store.mutate(state=>{
  const item=state.content.find(item=>item.id===input.contentId);
  if(!item)fail(404,'المحتوى غير موجود');
  if(item.status!=='APPROVED'||!item.approval?.userId||!item.review?.userId||item.legacyUnauthenticated)fail(409,'المحتوى يحتاج مراجعة واعتمادًا بحساب موثق');
  const hash=contentHash(item);
  if(item.approval.contentHash!==hash||item.review.contentHash!==hash||!item.approval.id)fail(409,'الاعتماد لا يطابق نسخة المحتوى؛ أعد المراجعة والاعتماد');
  if(riyadhDate(time)!==item.date)fail(409,'موعد الجدولة لا يطابق تاريخ المحتوى بتوقيت الرياض');
  if(item.platform==='LinkedIn' && ![0,2,4].includes(dayOfWeek(item.date)))fail(409,'أيام LinkedIn: الأحد والثلاثاء والخميس');
  if(item.platform==='LinkedIn' && !item.englishCopy?.trim())fail(409,'محتوى LinkedIn يحتاج نسخة إنجليزية معتمدة');
  if(item.platform==='Instagram' && !item.assetUrl)fail(409,'أضف رابط الأصل البصري ثم أعد المراجعة والاعتماد');
  const prior=store.db.prepare("SELECT json FROM schedule_jobs WHERE content_id=? AND status IN ('SCHEDULED','READY_FOR_CONNECTOR')").get(item.id);
  if(prior){const job=JSON.parse(prior.json);if(job.scheduledAt===scheduledAt&&job.contentHash===hash)return {...job,replayed:true};fail(409,'المحتوى مجدول بالفعل؛ ألغِ الجدولة القديمة أولًا');}
  const slotRow=store.db.prepare('SELECT json FROM calendar_slots WHERE date=? AND platform=?').get(item.date,item.platform);
  if(!slotRow)fail(409,'أنشئ تقويمًا يشمل تاريخ المحتوى أولًا');
  const slot=JSON.parse(slotRow.json);
  if(slot.contentId && slot.contentId!==item.id)fail(409,'هذه المنصة لها محتوى مجدول بالفعل في اليوم نفسه');
  const job={id:randomUUID(),contentId:item.id,slotId:slot.id,status:'SCHEDULED',scheduledAt,contentHash:hash,idempotencyKey:randomUUID(),approvalId:item.approval.id,snapshot:{title:item.title,body:item.body,englishCopy:item.englishCopy||'',url:item.url,assetUrl:item.assetUrl||null,platform:item.platform},scheduledBy:user.id,createdAt:new Date(now).toISOString(),blockReason:null};
  store.db.prepare('INSERT INTO schedule_jobs VALUES (?,?,?,?,?)').run(job.id,item.id,job.status,scheduledAt,JSON.stringify(job));
  slot.contentId=item.id;slot.status='SCHEDULED';store.db.prepare('UPDATE calendar_slots SET json=? WHERE id=?').run(JSON.stringify(slot),slot.id);
  audit(state,'CONTENT_SCHEDULED',item.id,user);
  return job;
 });
}

export function cancelJobs(store,state,contentId,user) {
 const rows=store.db.prepare("SELECT json FROM schedule_jobs WHERE content_id=? AND status IN ('SCHEDULED','READY_FOR_CONNECTOR','BLOCKED')").all(contentId);
 for(const row of rows) {
  const job=JSON.parse(row.json);job.status='CANCELLED';job.cancelledAt=new Date().toISOString();
  store.db.prepare('UPDATE schedule_jobs SET status=?,json=? WHERE id=?').run(job.status,JSON.stringify(job),job.id);
  const slotRow=store.db.prepare('SELECT json FROM calendar_slots WHERE id=?').get(job.slotId);
  if(slotRow){const slot=JSON.parse(slotRow.json);if(slot.contentId===contentId){slot.contentId=null;slot.status='PLANNED';store.db.prepare('UPDATE calendar_slots SET json=? WHERE id=?').run(JSON.stringify(slot),slot.id);}}
  audit(state,'SCHEDULE_CANCELLED',contentId,user);
 }
 return {cancelled:rows.length};
}

export function prepareDue(store,user,now=Date.now()) {
 return store.mutate(state=>{
  const rows=store.db.prepare("SELECT json FROM schedule_jobs WHERE status IN ('SCHEDULED','READY_FOR_CONNECTOR') AND scheduled_at<=?").all(new Date(now).toISOString());
  let ready=0,blocked=0;
  for(const row of rows) {
   const job=JSON.parse(row.json),item=state.content.find(item=>item.id===job.contentId);
   const valid=item?.status==='APPROVED' && item.approval?.contentHash===job.contentHash && item.review?.contentHash===job.contentHash && item.review?.userId && item.approval?.userId && item.approval?.id===job.approvalId && !item.legacyUnauthenticated && contentHash(item)===job.contentHash;
   const status=valid?'READY_FOR_CONNECTOR':'BLOCKED';
   if(valid)ready++;else blocked++;
   if(job.status!==status){job.status=status;job.blockReason=valid?'PUBLISHING_NOT_CONNECTED':'APPROVAL_CHANGED';job.preparedAt=new Date(now).toISOString();store.db.prepare('UPDATE schedule_jobs SET status=?,json=? WHERE id=?').run(status,JSON.stringify(job),job.id);audit(state,status==='BLOCKED'?'SCHEDULE_BLOCKED':'SCHEDULE_PREPARED',job.contentId,user);}
  }
  return {ready,blocked,externalActions:0};
 });
}

export function buildBrief(store,date=riyadhDate()) {
 validDate(date);
 const state=store.read(),tomorrow=new Date(Date.parse(date)+86400000).toISOString().slice(0,10);
 const items=state.content.filter(item=>item.date<=tomorrow);
 const jobs=listJobs(store.db),slots=listSlots(store.db).filter(slot=>slot.date===tomorrow);
 return {date,timezone:'Asia/Riyadh',generatedAt:new Date().toISOString(),targetDate:tomorrow,
  decisionsNeeded:items.filter(item=>['DRAFT','REVIEWED'].includes(item.status)).map(item=>({id:item.id,title:item.title,platform:item.platform,date:item.date,action:item.status==='DRAFT'?'COMPLIANCE_REVIEW':'OWNER_APPROVAL'})),
  tomorrowContent:state.content.filter(item=>item.date===tomorrow&&!['SUPERSEDED','REJECTED'].includes(item.status)).map(item=>({id:item.id,title:item.title,platform:item.platform,status:item.status,arabicCopy:item.body,englishCopy:item.englishCopy||'',url:item.url,assetUrl:item.assetUrl||null,contentHash:contentHash(item),reviewer:item.review?.reviewer||null,approvalId:item.approval?.id||null})),
  gaps:slots.filter(slot=>!slot.contentId).map(slot=>({date:slot.date,platform:slot.platform,pillar:slot.pillar})),
  calendarMissing:slots.length===0,
  blockedJobs:jobs.filter(job=>job.status==='BLOCKED').map(job=>({id:job.id,contentId:job.contentId,reason:job.blockReason})),
  waitingForConnector:jobs.filter(job=>job.status==='READY_FOR_CONNECTOR').length,
  metrics:{published:null,leads:null,revenue:null,reason:'مصادر الأداء والمبيعات غير متصلة'},
  deliveryStatus:'LOCAL_ONLY'};
}
export function saveDailyBrief(store,date,user) {
 return store.mutate(state=>{
  validDate(date);
  const prior=store.db.prepare('SELECT json FROM daily_briefs WHERE date=?').get(date);
  if(prior)return {...JSON.parse(prior.json),replayed:true};
  const brief=buildBrief(store,date);store.db.prepare('INSERT INTO daily_briefs VALUES (?,?)').run(date,JSON.stringify(brief));audit(state,'DAILY_BRIEF_CREATED',date,user);return brief;
 });
}
export function authorizeAutomation(req,env) {
 const expected=env.AUTOMATION_TOKEN;
 const supplied=req.headers['x-hypercool-token'];
 if(typeof expected!=='string'||expected.length<32)fail(503,'Automation is not configured');
 if(typeof supplied!=='string'||Buffer.byteLength(supplied)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))fail(401,'Invalid automation credentials');
}
