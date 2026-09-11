import {randomUUID,createHash} from 'node:crypto';
import {fail} from './auth.js';
import {createEscalation} from './runtime/escalations.js';
import {resolveActiveTenantId} from './tenancy.js';
import {recordAudit} from './audit.js';

export const stages=['NEW','QUALIFIED','QUOTE_SENT','DEMO','POST_PURCHASE','PARKED','WON','LOST'];
export const sequences={
 QUOTE:{name:'بعد عرض السعر',stages:['QUOTE_SENT'],touches:[['هل وصلك عرض السعر؟ هل تحتاج توضيحًا على المواصفات؟','Did you receive the quotation? Would you like clarification on the specifications?'],['هل يوجد تفصيل في العرض تحتاج نوضحه قبل اتخاذ القرار؟','Is there a detail in the quotation you would like us to clarify before deciding?'],['هل تفضل نوقف المتابعة حاليًا ونرجع لك في موعد تختاره؟','Would you prefer us to pause and check back at a time you choose?']]},
 CART:{name:'سلة متروكة',stages:['NEW','QUALIFIED'],touches:[['هل واجهتك صعوبة أثناء إكمال طلبك؟','Did you encounter any difficulty completing your order?'],['هل تحتاج مساعدة في اختيار المنتج المناسب؟','Would you like help choosing the right product?'],['هل نوقف متابعة الطلب حاليًا؟','Would you like us to pause following up on the order?']]},
 POST_DEMO:{name:'بعد العرض التوضيحي',stages:['DEMO'],touches:[['بعد العرض التوضيحي، ما النقطة التي تحتاج تفاصيل أكثر عنها؟','Following the demonstration, which point would you like more detail on?'],['هل تحتاج توضيحًا للمواصفات قبل الخطوة التالية؟','Would you like clarification on the specifications before the next step?'],['هل الوقت مناسب للمتابعة أم تفضل موعدًا لاحقًا؟','Is this a good time to follow up, or would a later date suit you?']]},
 POST_PURCHASE:{name:'فرصة ما بعد الشراء',stages:['POST_PURCHASE'],touches:[['هل تحتاج مساعدة في اختيار ملحق مناسب للمنتج؟','Would you like help choosing a suitable product accessory?'],['ما احتياجك الذي تبحث عن ملحق مناسب له؟','What need are you looking to address with an accessory?'],['هل تفضل نغلق متابعة الملحقات حاليًا؟','Would you prefer us to close the accessory follow-up for now?']]},
 DORMANT:{name:'إعادة تفعيل اهتمام سابق',stages:['QUALIFIED','PARKED'],touches:[['هل ما زال تجهيزكم للمنتج ضمن خططكم الحالية؟','Is this product still part of your current plans?'],['هل تغير احتياجكم أو توقيت التجهيز؟','Have your requirements or purchasing timeline changed?'],['هل نوقف المتابعة إلى وقت أنسب لكم؟','Would you like us to pause until a more suitable time?']]},
 BUDGET_CHECK:{name:'دورة الميزانية القادمة',stages:['QUALIFIED','PARKED'],touches:[['هل يناسبكم نراجع الاحتياج مع دورة الميزانية القادمة؟','Would it suit you to revisit this need during the next budget cycle?'],['هل عندكم موعد مفضل لمراجعة خيارات التجهيز؟','Do you have a preferred time to review equipment options?'],['هل تفضلون إغلاق المتابعة مؤقتًا؟','Would you prefer to close the follow-up temporarily?']]}
};
// Multi-Tenant Control Center, Phase 1: `crm_leads` carries a real `tenant_id` — before
// this, `contact_key` was UNIQUE across the whole database, meaning a phone/email could
// only ever be a lead for ONE company system-wide (see docs/MULTI_TENANT_ARCHITECTURE.md).
// Every reader/writer below takes an OPTIONAL trailing `tenantId` so existing callers
// (agent tools, ~10 test files) don't need to change: omitting it resolves to
// `resolveActiveTenantId(db)`, the one real tenant that exists today. `crm_messages`/
// `crm_followups` deliberately do NOT get their own tenant_id column — they are only ever
// reached through a `lead_id` that a tenant-scoped `getLead()` has already verified, so
// isolating the lead transitively isolates its messages/followups too.
export function installCRM(db){
 const legacy=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_leads'").get();
 if(legacy) {
  const columns=db.prepare('PRAGMA table_info(crm_leads)').all().map(c=>c.name);
  if(!columns.includes('tenant_id')) {
   // SQLite can't ALTER an inline UNIQUE constraint, so this recreates the table and
   // backfills every existing lead to the one real tenant that owns it today (lossless,
   // spec Part 99) — `contact_key`'s uniqueness becomes (tenant_id, contact_key) instead
   // of global, matching the same partial-uniqueness (NULLs still allowed) as before.
   const tenantId=resolveActiveTenantId(db);
   db.exec('ALTER TABLE crm_leads RENAME TO crm_leads_pre_tenant;');
   db.exec(`CREATE TABLE crm_leads (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contact_key TEXT, json TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_leads_tenant_contact ON crm_leads(tenant_id,contact_key) WHERE contact_key IS NOT NULL;`);
   db.prepare('INSERT INTO crm_leads (id,tenant_id,contact_key,json) SELECT id,?,contact_key,json FROM crm_leads_pre_tenant').run(tenantId);
   db.exec('DROP TABLE crm_leads_pre_tenant;');
  }
 } else {
  db.exec(`CREATE TABLE IF NOT EXISTS crm_leads (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, contact_key TEXT, json TEXT NOT NULL);
   CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_leads_tenant_contact ON crm_leads(tenant_id,contact_key) WHERE contact_key IS NOT NULL;`);
 }
 db.exec(`
 CREATE TABLE IF NOT EXISTS crm_messages (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES crm_leads(id), event_key TEXT NOT NULL UNIQUE, json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS crm_followups (id TEXT PRIMARY KEY, lead_id TEXT NOT NULL REFERENCES crm_leads(id), status TEXT NOT NULL, due_at TEXT NOT NULL, json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS crm_requests (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_crm_messages_lead_id ON crm_messages(lead_id);
 CREATE INDEX IF NOT EXISTS idx_crm_followups_lead_id ON crm_followups(lead_id);
 CREATE INDEX IF NOT EXISTS idx_crm_followups_status ON crm_followups(status);
 CREATE INDEX IF NOT EXISTS idx_crm_leads_tenant_id ON crm_leads(tenant_id);
`);
 // Additive, guarded column — see runtime/registry.js for the same pattern. Needed so an
 // inbound webhook message (WhatsApp wamid) or an outbound message's provider-assigned id
 // can be looked up directly when a later delivery-status webhook arrives, without scanning
 // every message's JSON blob.
 const columns=db.prepare("PRAGMA table_info(crm_messages)").all().map(c=>c.name);
 if(!columns.includes('external_message_id')){
  db.exec('ALTER TABLE crm_messages ADD COLUMN external_message_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_crm_messages_external_id ON crm_messages(external_message_id)');
 }
}
const string=(value,max=200)=>typeof value==='string'?value.trim().slice(0,max):'';
function required(value,label,max=200){if(typeof value!=='string'||!value.trim()||value.length>max)fail(400,`الحقل مطلوب أو طويل: ${label}`);return value.trim();}
function iso(value,label){if(typeof value!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))fail(400,`تاريخ غير صالح: ${label}`);return new Date(value).toISOString();}
function link(value,storeOnly=false){let url;try{url=new URL(value);}catch{fail(400,'رابط غير صالح');}if(url.protocol!=='https:'||url.username||url.password||(storeOnly&&url.hostname!=='hyper-cool.com'))fail(400,'استخدم رابط HTTPS صحيحًا'+(storeOnly?' من متجر HyperCool':''));return url.href;}
function audit(db,action,id,user,tenantId=null){recordAudit(db,{id:randomUUID(),action,itemId:id,actorId:user.id,actorName:user.name,actorRole:user.role,at:new Date().toISOString()},tenantId);}
function writeLead(db,lead){db.prepare('UPDATE crm_leads SET json=? WHERE id=?').run(JSON.stringify(lead),lead.id);}
// `tenantId` defaults to the one real tenant that exists today (see installCRM's docblock
// above) — a lead belonging to a DIFFERENT tenant 404s exactly like one that never existed,
// never a distinguishable error that would let a caller detect "it exists but isn't mine".
export function getLead(db,id,tenantId=null){if(typeof id!=='string')fail(400,'معرف العميل مطلوب');const row=db.prepare('SELECT json FROM crm_leads WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));if(!row)fail(404,'العميل غير موجود');return JSON.parse(row.json);}
export function listLeads(db,tenantId=null){return db.prepare('SELECT json FROM crm_leads WHERE tenant_id=? ORDER BY rowid DESC').all(tenantId||resolveActiveTenantId(db)).map(row=>JSON.parse(row.json));}
// `crm_followups`/`crm_messages` deliberately have no `tenant_id` column of their own (see
// the SHARED_SAFE-via-transitive-`lead_id` design note above) — these two list functions
// still need to honor tenant scope for a genuine second tenant, so they join through the
// owning lead rather than adding a redundant column.
export function listFollowups(db,tenantId=null){return db.prepare('SELECT cf.json FROM crm_followups cf JOIN crm_leads cl ON cl.id=cf.lead_id WHERE cl.tenant_id=? ORDER BY cf.due_at').all(tenantId||resolveActiveTenantId(db)).map(row=>JSON.parse(row.json));}
export function listAllMessages(db,limit=500,tenantId=null){return db.prepare('SELECT cm.json FROM crm_messages cm JOIN crm_leads cl ON cl.id=cm.lead_id WHERE cl.tenant_id=? ORDER BY cm.rowid DESC LIMIT ?').all(tenantId||resolveActiveTenantId(db),limit).map(row=>JSON.parse(row.json));}
// Single source of truth for lead search — used by the REST endpoint and by the
// search_crm agent tool alike, so the two never drift apart.
export function searchLeads(db,query,limit=20,tenantId=null){
 const q=string(query,200).toLowerCase();
 if(!q)return [];
 return listLeads(db,tenantId).filter(lead=>[lead.name,lead.company,lead.phone,lead.email,lead.productNeed,lead.id].some(value=>value&&String(value).toLowerCase().includes(q))).slice(0,limit);
}
export function leadDetail(db,id,tenantId=null){const lead=getLead(db,id,tenantId);return {lead,messages:db.prepare('SELECT json FROM crm_messages WHERE lead_id=? ORDER BY rowid').all(id).map(row=>JSON.parse(row.json)),followups:listFollowups(db,tenantId).filter(f=>f.leadId===id),handoff:handoff(lead),quoteIntake:quoteIntake(lead)};}
function quoteIntake(lead){const required=['name','city','productNeed','quantity','timeline',...(lead.customerType==='B2B'?['company']:[])];const missingFields=required.filter(field=>!lead[field]);if(!lead.email&&!lead.phone)missingFields.push('contact');return {status:missingFields.length?'NEEDS_DATA':'READY_FOR_HUMAN_QUOTE',missingFields,pricingVerified:false,quoteCreated:false};}
function handoff(lead){return {leadId:lead.id,company:lead.company||null,need:lead.productNeed||null,city:lead.city||null,quantity:lead.quantity,timeline:lead.timeline||null,assignedTo:lead.assignedTo,temperature:lead.temperature,reason:lead.handoffReason||null,nextAction:lead.humanHold?'HUMAN_REVIEW':lead.temperature==='HOT'?'CONTACT_LEAD':'QUALIFY'};}
function qualification(input){
 const quantity=input.quantity===''||input.quantity===undefined||input.quantity===null?null:Number(input.quantity);
 const valueSAR=input.valueSAR===''||input.valueSAR===undefined||input.valueSAR===null?null:Number(input.valueSAR);
 if(quantity!==null&&(!Number.isInteger(quantity)||quantity<1||quantity>100000))fail(400,'كمية غير صالحة');
 if(valueSAR!==null&&(!Number.isFinite(valueSAR)||valueSAR<0||valueSAR>1e10))fail(400,'قيمة تقديرية غير صالحة');
 return {city:string(input.city),productNeed:string(input.productNeed,1000),productUrl:input.productUrl?link(input.productUrl,true):'',quantity,valueSAR,timeline:string(input.timeline),budgetBand:string(input.budgetBand)};
}
export function createLead(store,input,user,tenantId=null){
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 const name=required(input.name,'اسم العميل');
 if(!['B2C','B2B'].includes(input.customerType))fail(400,'اختر نوع العميل');
 if(!['INBOUND','RESEARCH'].includes(input.sourceType))fail(400,'اختر مصدر العميل');
 const email=string(input.email,254).toLowerCase(),phone=string(input.phone,30).replace(/[\s()-]/g,'');
 if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))fail(400,'البريد غير صالح');
 if(phone&&!/^\+[1-9]\d{7,14}$/.test(phone))fail(400,'الهاتف يجب أن يتضمن رمز الدولة مثل +966');
 const company=input.customerType==='B2B'?required(input.company,'اسم الجهة'):string(input.company);
 let research=null;
 if(input.sourceType==='RESEARCH'){
  if(input.customerType!=='B2B')fail(400,'البحث مخصص لفرص B2B');
  const triggerDate=iso(input.triggerDate,'محفز الشراء');if(Date.parse(triggerDate)>Date.now())fail(400,'محفز الشراء لا يكون بتاريخ مستقبلي');
  const fitScore=Number(input.fitScore);if(!Number.isInteger(fitScore)||fitScore<1||fitScore>5)fail(400,'تقييم الملاءمة من 1 إلى 5');
  if(input.sourceChecked!==true)fail(400,'أكد مراجعة مصدر الفرصة');
  research={sourceUrl:link(input.sourceUrl),trigger:required(input.trigger,'محفز الشراء',1000),triggerDate,fitScore,routeIn:required(input.routeIn,'قناة الوصول'),checkedBy:user.id,checkedAt:new Date().toISOString()};
 }
 return store.mutate(state=>{
  // Detect either contact, not just whichever contact was selected as the index key —
  // scoped to this tenant only: the same phone/email is a perfectly valid, separate lead
  // for a different company.
  const duplicate=listLeads(store.db,resolvedTenantId).find(lead=>(email&&lead.email===email)||(phone&&lead.phone===phone));
  if(duplicate)fail(409,'وسيلة التواصل موجودة في سجل عميل سابق');
  const lead={id:randomUUID(),name,company,customerType:input.customerType,sourceType:input.sourceType,email,phone,research,...qualification(input),stage:'NEW',temperature:'COLD',consent:{Email:null,WhatsApp:null},optOut:false,humanHold:false,replyHold:false,handoffReason:null,assignedTo:null,version:1,createdAt:new Date().toISOString(),createdBy:user.id,nextCheckAt:null};
  if(lead.valueSAR>100000){lead.humanHold=true;lead.handoffReason='HIGH_VALUE_DEAL';}
  store.db.prepare('INSERT INTO crm_leads (id,tenant_id,contact_key,json) VALUES (?,?,?,?)').run(lead.id,resolvedTenantId,email?'email:'+email:phone?'phone:'+phone:null,JSON.stringify(lead));audit(store.db,'CRM_LEAD_CREATED',lead.id,user,resolvedTenantId);return lead;
 });
}
function stopFollowups(db,leadId,reason){
 for(const row of db.prepare("SELECT json FROM crm_followups WHERE lead_id=? AND status IN ('DRAFT','APPROVED','READY_FOR_CHANNEL')").all(leadId)){const item=JSON.parse(row.json);item.status='HOLD';item.holdReason=reason;item.approval=null;db.prepare('UPDATE crm_followups SET status=?,json=? WHERE id=?').run(item.status,JSON.stringify(item),item.id);}
}
function expectedVersion(lead,input){if(input.expectedVersion!==lead.version)fail(409,'تم تحديث العميل؛ حدّث الصفحة ثم حاول مجددًا');}
export function updateLead(store,id,input,user,tenantId=null){return store.mutate(state=>{
 const lead=getLead(store.db,id,tenantId);expectedVersion(lead,input);
 if(!stages.includes(input.stage))fail(400,'مرحلة غير صالحة');
 if(['WON','LOST'].includes(lead.stage)&&input.stage!==lead.stage&&user.role!=='owner')fail(403,'إعادة فتح الفرصة للمالك فقط');
 const reason=required(input.reason,'سبب تحديث المرحلة',1000);
 Object.assign(lead,qualification(input),{stage:input.stage});
 lead.nextCheckAt=input.nextCheckAt?iso(input.nextCheckAt,'المتابعة القادمة'):null;
 if(lead.stage==='PARKED'&&(!lead.nextCheckAt||Date.parse(lead.nextCheckAt)<=Date.now()))fail(400,'الفرصة المؤجلة تحتاج موعدًا مستقبليًا');
 if(!['COLD','WARM','HOT'].includes(input.temperature))fail(400,'درجة اهتمام غير صالحة');lead.temperature=input.temperature;
 if(input.assignedTo){const assigned=store.db.prepare("SELECT id FROM users WHERE id=? AND role IN ('owner','operator')").get(input.assignedTo);if(!assigned)fail(400,'مسؤول المبيعات غير موجود');lead.assignedTo=assigned.id;}else lead.assignedTo=null;
 if(lead.valueSAR>100000){lead.humanHold=true;lead.handoffReason='HIGH_VALUE_DEAL';}
 lead.version++;lead.updatedAt=new Date().toISOString();lead.lastChangeReason=reason;
 writeLead(store.db,lead);stopFollowups(store.db,id,'LEAD_CHANGED');audit(store.db,'CRM_LEAD_UPDATED',id,user,tenantId);return lead;
});}
// Shared with recordChannelMessage below — a webhook-ingested "stop"/"unsubscribe" message
// must be detected by the exact same rule as a manually-entered one, never a second,
// possibly-drifting copy of this pattern.
const OPT_OUT_PATTERN=/^(stop|unsubscribe|إلغاء الاشتراك|الغاء الاشتراك|لا تتواصل معي|لا تراسلني)[.!؟?\s]*$/i;
export function isOptOutText(text){return OPT_OUT_PATTERN.test(text||'');}
export function recordMessage(store,id,input,user){
 const text=required(input.text,'نص المحادثة',4000),eventKey=required(input.eventKey,'معرف الحدث',120);
 if(!['WhatsApp','Email','Instagram','Facebook','X','LinkedIn','Phone'].includes(input.channel))fail(400,'قناة غير مدعومة');
 if(!['general','quote','medical','complaint','legal','discount_exception','opt_out'].includes(input.intent))fail(400,'تصنيف المحادثة غير صالح');
 return store.mutate(state=>{
  const prior=store.db.prepare('SELECT json FROM crm_messages WHERE event_key=?').get(eventKey);
  if(prior){const message=JSON.parse(prior.json);if(message.leadId!==id||message.text!==text||message.channel!==input.channel||message.intent!==input.intent)fail(409,'معرف الحدث مستخدم لمحادثة أخرى');return {...message,replayed:true};}
  const lead=getLead(store.db,id);
  const message={id:randomUUID(),leadId:id,eventKey,channel:input.channel,text,intent:input.intent,direction:'INBOUND',source:'MANUAL_ENTRY',recordedBy:user.id,recordedAt:new Date().toISOString()};
  store.db.prepare('INSERT INTO crm_messages (id,lead_id,event_key,json,external_message_id) VALUES (?,?,?,?,?)').run(message.id,id,eventKey,JSON.stringify(message),null);
  lead.version++;lead.lastInboundAt=message.recordedAt;lead.replyHold=true;
  const optOut=input.intent==='opt_out'||isOptOutText(text);
  if(optOut){lead.optOut=true;lead.optOutAt=message.recordedAt;lead.consent={Email:null,WhatsApp:null};}
  if(input.intent==='quote')lead.temperature='HOT';
  if(['medical','complaint','legal','discount_exception'].includes(input.intent)){lead.humanHold=true;lead.handoffReason=input.intent.toUpperCase();}
  writeLead(store.db,lead);stopFollowups(store.db,id,optOut?'OPT_OUT':'CUSTOMER_REPLIED');audit(store.db,'CRM_INBOUND_RECORDED',id,user);return {...message,optedOut:optOut};
 });
}
// --- Channel/webhook-driven messaging (WhatsApp/Instagram/Facebook) ---------------------
// Separate from recordMessage() above (which is for a human operator manually transcribing
// a conversation that happened elsewhere) because this path: (1) has no human `user` — the
// actor is an automated channel connector or an agent, (2) must find-or-create the lead
// itself since a webhook has no existing lead id to post to, and (3) needs to record real
// OUTBOUND messages the system sends, which recordMessage() never did.
export function findLeadByPhone(db,phone,tenantId=null){
 if(!phone)return null;
 return listLeads(db,tenantId).find(lead=>lead.phone===phone)||null;
}
export function findLeadByEmail(db,email,tenantId=null){
 if(!email)return null;
 const normalized=email.trim().toLowerCase();
 return listLeads(db,tenantId).find(lead=>lead.email && lead.email.toLowerCase()===normalized)||null;
}
/**
 * Customer matching priority per the integration spec: an explicit existing CRM mapping
 * first (email for Email channel, phone for WhatsApp/SMS-style channels), then create if
 * genuinely new. Never merges two existing leads found by different identifiers — if a
 * lookup by email and a lookup by phone would resolve to two DIFFERENT existing leads,
 * this returns the one matched by the channel's own identifier and leaves the conflict for
 * a human to notice and reconcile manually, rather than guessing which record is "right."
 */
export function findOrCreateLeadFromChannel(store,{phone,email,name,channel},actor,tenantId=null){
 const resolvedTenantId=tenantId||resolveActiveTenantId(store.db);
 const normalizedEmail=email?email.trim().toLowerCase():null;
 const findExisting=()=>(normalizedEmail&&findLeadByEmail(store.db,normalizedEmail,resolvedTenantId))||(phone&&findLeadByPhone(store.db,phone,resolvedTenantId))||null;
 const existing=findExisting();
 if(existing)return {lead:existing,created:false};
 return store.mutate(state=>{
  const again=findExisting();if(again)return {lead:again,created:false};
  const contactKey=normalizedEmail?'email:'+normalizedEmail:phone?'phone:'+phone:null;
  const lead={id:randomUUID(),name:string(name,200)||normalizedEmail||phone||'عميل جديد',company:'',customerType:'B2C',sourceType:'INBOUND',email:normalizedEmail||'',phone:phone||'',research:null,city:'',productNeed:'',productUrl:'',quantity:null,valueSAR:null,timeline:'',budgetBand:'',stage:'NEW',temperature:'COLD',consent:{Email:null,WhatsApp:null},optOut:false,humanHold:false,replyHold:false,handoffReason:null,assignedTo:null,version:1,createdAt:new Date().toISOString(),createdBy:actor.id,channelOrigin:channel,nextCheckAt:null};
  store.db.prepare('INSERT INTO crm_leads (id,tenant_id,contact_key,json) VALUES (?,?,?,?)').run(lead.id,resolvedTenantId,contactKey,JSON.stringify(lead));
  audit(store.db,'CRM_LEAD_CREATED',lead.id,actor,resolvedTenantId);
  return {lead,created:true};
 });
}
/**
 * Records one real inbound-or-outbound channel message. `externalMessageId` is the
 * provider's own message id (WhatsApp wamid) — used both as the idempotency key (a
 * redelivered webhook for the same message is a no-op replay, matching the crm_requests/
 * crm_messages idempotency pattern used everywhere else in this file) and, for OUTBOUND
 * messages, as the lookup key a later delivery-status webhook updates in place rather than
 * inserting a second row for the same message.
 */
export function recordChannelMessage(store,{leadId,channel,direction,text,externalMessageId,messageType='text',media=null,intent='general',subject=null,cc=null,bcc=null,externalThreadId=null,internetMessageId=null,attachments=null},actor){
 if(!['INBOUND','OUTBOUND'].includes(direction))fail(400,'اتجاه رسالة غير صالح');
 if(!['WhatsApp','Email','Instagram','Facebook','X','LinkedIn','Phone'].includes(channel))fail(400,'قناة غير مدعومة');
 const eventKey=externalMessageId?`${channel}:${externalMessageId}`:`${channel}:${direction}:${randomUUID()}`;
 return store.mutate(state=>{
  if(externalMessageId){
   const prior=store.db.prepare('SELECT json FROM crm_messages WHERE external_message_id=?').get(externalMessageId);
   if(prior)return {...JSON.parse(prior.json),replayed:true};
  }
  const lead=getLead(store.db,leadId);
  const message={id:randomUUID(),leadId,eventKey,channel,text:string(text,4000),intent,direction,messageType,media,externalMessageId:externalMessageId||null,
   // Email-specific fields — always present (null when not applicable) so every message
   // row has a stable, predictable shape regardless of channel.
   subject:subject||null,cc:cc||null,bcc:bcc||null,externalThreadId:externalThreadId||null,internetMessageId:internetMessageId||null,attachments:attachments||null,
   status:direction==='OUTBOUND'?'SENT':'RECEIVED',source:direction==='INBOUND'?'CHANNEL_WEBHOOK':'AGENT_OR_SYSTEM',recordedBy:actor.id,recordedAt:new Date().toISOString(),deliveredAt:null,readAt:null};
  store.db.prepare('INSERT INTO crm_messages (id,lead_id,event_key,json,external_message_id) VALUES (?,?,?,?,?)').run(message.id,leadId,eventKey,JSON.stringify(message),externalMessageId||null);
  let optedOut=false;
  if(direction==='INBOUND'){
   lead.version++;lead.lastInboundAt=message.recordedAt;lead.replyHold=true;
   if(isOptOutText(text)){lead.optOut=true;lead.optOutAt=message.recordedAt;lead.consent={Email:null,WhatsApp:null};optedOut=true;}
   writeLead(store.db,lead);stopFollowups(store.db,leadId,optedOut?'OPT_OUT':'CUSTOMER_REPLIED');audit(store.db,'CRM_INBOUND_RECORDED',leadId,actor);
  } else {
   lead.lastOutboundAt=message.recordedAt;writeLead(store.db,lead);
  }
  return {...message,optedOut};
 });
}
// Delivery-status webhooks (sent/delivered/read/failed) update the ORIGINAL message row in
// place — never a new row per status, per the integration spec ("لا تخلق رسالة جديدة لكل status").
export function updateMessageStatus(store,externalMessageId,status,{errorCode=null}={}){
 if(!['SENT','DELIVERED','READ','FAILED'].includes(status))fail(400,'حالة رسالة غير صالحة');
 return store.mutate(()=>{
  const row=store.db.prepare('SELECT json FROM crm_messages WHERE external_message_id=?').get(externalMessageId);
  if(!row)return {found:false};
  const message=JSON.parse(row.json);
  // Never move status backwards (a delayed "sent" arriving after "read" must not regress it).
  const order=['SENT','DELIVERED','READ','FAILED'];
  if(status!=='FAILED' && order.indexOf(status)<order.indexOf(message.status))return {found:true,ignored:true};
  message.status=status;
  if(status==='DELIVERED')message.deliveredAt=new Date().toISOString();
  if(status==='READ')message.readAt=new Date().toISOString();
  if(status==='FAILED')message.errorCode=errorCode;
  store.db.prepare('UPDATE crm_messages SET json=? WHERE external_message_id=?').run(JSON.stringify(message),externalMessageId);
  return {found:true,message};
 });
}
/**
 * Mechanical, not judgmental: whoever actually flips a lead's temperature to HOT (a human
 * via the UI, or an agent via its own update_lead tool call) gets the exact same real
 * escalation/notification — this never second-guesses the temperature decision itself.
 */
export function maybeEscalateHotLead(store,eventBus,before,after,{agentId='human',runId=null,tenantId=null}={}){
 if(after.temperature!=='HOT'||before.temperature==='HOT')return null;
 const eventId=eventBus?.emit('LEAD_HOT',{leadId:after.id,agentId,tenantId});
 const reason=`فرصة ساخنة: ${after.name}${after.company?' — '+after.company:''} — ${after.productNeed||'بدون تفاصيل احتياج'}`;
 const escalation=createEscalation(store.db,{runId,agentId,priority:'P1',reason,tenantId,
  context:{leadId:after.id,company:after.company||null,productNeed:after.productNeed||null,city:after.city||null,quantity:after.quantity,timeline:after.timeline||null,customerType:after.customerType,recommendedAction:'CONTACT_LEAD'}});
 return {eventId,escalation};
}
export function contactControl(store,id,input,user){return store.mutate(state=>{
 const lead=getLead(store.db,id);expectedVersion(lead,input);const evidence=required(input.evidence,'دليل القرار',1000);
 if(input.action==='OPT_OUT'){lead.optOut=true;lead.consent={Email:null,WhatsApp:null};stopFollowups(store.db,id,'OPT_OUT');}
 else {
  if(user.role!=='owner')fail(403,'اعتماد التواصل ورفع الإيقاف للمالك فقط');
  if(input.action==='CONSENT'){
   if(!['Email','WhatsApp'].includes(input.channel))fail(400,'اختر قناة الموافقة');
   if(input.confirmed!==true)fail(400,'أكد وجود موافقة صريحة جديدة');
   const at=iso(input.obtainedAt,'تاريخ الموافقة');if(Date.parse(at)>Date.now())fail(400,'تاريخ الموافقة لا يكون في المستقبل');
   if(lead.optOut && (!lead.optOutAt||Date.parse(at)<=Date.parse(lead.optOutAt)))fail(400,'الموافقة الجديدة يجب أن تكون بعد رفض التواصل');
   if(lead.optOut)lead.consent={Email:null,WhatsApp:null};lead.optOut=false;lead.consent[input.channel]={evidence,obtainedAt:at,recordedBy:user.id};
  }else if(input.action==='RESOLVE_HOLD'){
   if(lead.valueSAR>100000)fail(409,'الصفقة فوق الحد؛ تستمر المتابعة البشرية');
   lead.humanHold=false;lead.replyHold=false;lead.handoffReason=null;
  }else fail(400,'إجراء غير صالح');
  stopFollowups(store.db,id,'CONTACT_POLICY_CHANGED');
 }
 if(input.action==='OPT_OUT')lead.optOutAt=new Date().toISOString();
 lead.version++;writeLead(store.db,lead);audit(store.db,'CRM_CONTACT_POLICY_CHANGED',id,user);return lead;
});}
function eligibility(lead,channel,sequence){
 if(lead.optOut)return 'OPT_OUT';if(!lead.consent[channel])return 'NO_CONSENT';
 if(lead.humanHold)return 'HUMAN_HOLD';if(lead.replyHold)return 'CUSTOMER_REPLIED';
 if(['WON','LOST'].includes(lead.stage))return 'DEAL_CLOSED';
 if(!sequences[sequence]?.stages.includes(lead.stage))return 'STAGE_MISMATCH';
 if(channel==='Email'&&!lead.email||channel==='WhatsApp'&&!lead.phone)return 'NO_CONTACT';
 if(!lead.productUrl)return 'NO_PRODUCT_LINK';return null;
}
export function createFollowups(store,id,input,user){
 const key=required(input.requestKey,'مفتاح الطلب',120),sequence=input.sequence,channel=input.channel;
 if(!sequences[sequence]||!['Email','WhatsApp'].includes(channel))fail(400,'نوع المتابعة أو القناة غير صالح');
 const start=iso(input.startAt,'بداية المتابعة'),evidence=required(input.evidence,'سياق المتابعة ودليل الحدث',1000);
 const fingerprint=createHash('sha256').update(JSON.stringify({id,sequence,channel,start,evidence,user:user.id})).digest('hex');
 return store.mutate(state=>{
  const prior=store.db.prepare('SELECT * FROM crm_requests WHERE key=?').get(key);if(prior){if(prior.fingerprint!==fingerprint)fail(409,'مفتاح الطلب مستخدم');return {...JSON.parse(prior.json),replayed:true};}
  if(Date.parse(start)<Date.now()+48*3600000)fail(400,'ابدأ بعد 48 ساعة على الأقل');
  const lead=getLead(store.db,id),blocked=eligibility(lead,channel,sequence);if(blocked)fail(409,'المتابعة موقوفة: '+blocked);
  if(lead.stage==='PARKED'&&lead.nextCheckAt&&Date.parse(start)<Date.parse(lead.nextCheckAt))fail(409,'الموعد قبل تاريخ مراجعة الفرصة المؤجلة');
  if(store.db.prepare("SELECT id FROM crm_followups WHERE lead_id=? AND status IN ('DRAFT','APPROVED','READY_FOR_CHANNEL') LIMIT 1").get(id))fail(409,'توجد سلسلة متابعة نشطة لهذا العميل');
  const items=sequences[sequence].touches.map(([ar,en],i)=>({id:randomUUID(),leadId:id,sequence,channel,touch:i+1,maxTouches:3,dueAt:new Date(Date.parse(start)+[0,48,120][i]*3600000).toISOString(),messageAr:ar+'\n'+lead.productUrl,messageEn:en+'\n'+lead.productUrl,evidence,leadVersion:lead.version,status:'DRAFT',approval:null,holdReason:null,createdBy:user.id,createdAt:new Date().toISOString()}));
  for(const item of items)store.db.prepare('INSERT INTO crm_followups VALUES (?,?,?,?,?)').run(item.id,id,item.status,item.dueAt,JSON.stringify(item));
  const result={items};store.db.prepare('INSERT INTO crm_requests VALUES (?,?,?)').run(key,fingerprint,JSON.stringify(result));audit(store.db,'CRM_FOLLOWUPS_DRAFTED',id,user);return result;
 });
}
function followupHash(item){return createHash('sha256').update(JSON.stringify([item.messageAr,item.messageEn,item.dueAt,item.channel,item.leadVersion,item.sequence,item.touch])).digest('hex');}
export function approveFollowup(store,id,user){return store.mutate(state=>{
 const row=store.db.prepare('SELECT json FROM crm_followups WHERE id=?').get(id);if(!row)fail(404,'المتابعة غير موجودة');const item=JSON.parse(row.json),lead=getLead(store.db,item.leadId);
 if(item.status!=='DRAFT')fail(409,'يمكن اعتماد مسودة متابعة فقط');
 const reason=eligibility(lead,item.channel,item.sequence);if(reason||lead.version!==item.leadVersion)fail(409,'السياق تغير أو المتابعة موقوفة: '+(reason||'LEAD_CHANGED'));
 item.status='APPROVED';item.approval={userId:user.id,at:new Date().toISOString(),hash:followupHash(item)};
 store.db.prepare('UPDATE crm_followups SET status=?,json=? WHERE id=?').run(item.status,JSON.stringify(item),id);audit(store.db,'CRM_FOLLOWUP_APPROVED',id,user);return item;
});}
export function prepareFollowups(store,user,now=Date.now()){return store.mutate(state=>{
 let ready=0,held=0;
 for(const row of store.db.prepare("SELECT json FROM crm_followups WHERE status IN ('APPROVED','READY_FOR_CHANNEL') AND due_at<=?").all(new Date(now).toISOString())){
  const item=JSON.parse(row.json),lead=getLead(store.db,item.leadId);
  const reason=eligibility(lead,item.channel,item.sequence)||(lead.version!==item.leadVersion?'LEAD_CHANGED':null)||(!item.approval?.userId||item.approval.hash!==followupHash(item)?'APPROVAL_CHANGED':null);
  const status=reason?'HOLD':'READY_FOR_CHANNEL';if(reason)held++;else ready++;
  if(status!==item.status){item.status=status;item.holdReason=reason||'CHANNEL_NOT_CONNECTED';if(reason)item.approval=null;store.db.prepare('UPDATE crm_followups SET status=?,json=? WHERE id=?').run(status,JSON.stringify(item),item.id);audit(store.db,'CRM_FOLLOWUP_PREPARED',item.id,user);}
 }
 return {ready,held,sent:0};
});}
export function cancelFollowups(store,id,user){return store.mutate(()=>{getLead(store.db,id);stopFollowups(store.db,id,'HUMAN_CANCELLED');audit(store.db,'CRM_FOLLOWUPS_STOPPED',id,user);return {stopped:true};});}
