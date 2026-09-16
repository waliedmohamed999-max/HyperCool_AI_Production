import {randomUUID} from 'node:crypto';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {recordAudit} from '../audit.js';
import {findOrCreateLeadFromChannel, recordChannelMessage} from '../crm.js';

// Website AI Chat Widget (Phase MKT-1, spec Part 28-29). A public, unauthenticated, tenant-
// isolated embed: the visitor never sees a tenant secret, the frontend never carries one, and
// every AI call happens server-side through the SAME agent runtime every other channel
// already goes through (agentRuntime.run('sales', …) — see application.js's widget chat
// route) — this file only owns the widget's own config, the public-facing lookup, and a
// simple per-IP+widget rate limit. No new orchestrator, no new lead/message model: an inbound
// widget message becomes a real CRM lead (channel='WebsiteChat') through the exact same
// findOrCreateLeadFromChannel/recordChannelMessage functions WhatsApp/Email already use.
export function installWebsiteWidgets(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS website_widgets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  public_widget_id TEXT NOT NULL UNIQUE,
  allowed_domains_json TEXT NOT NULL DEFAULT '[]',
  greeting TEXT,
  lead_fields_json TEXT NOT NULL DEFAULT '["name","phone"]',
  business_hours_note TEXT,
  status TEXT NOT NULL DEFAULT 'DISABLED',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_website_widgets_tenant ON website_widgets(tenant_id);`);
}
function hydrate(row) {
 if(!row)return null;
 return {
  id:row.id,tenantId:row.tenant_id,publicWidgetId:row.public_widget_id,
  allowedDomains:JSON.parse(row.allowed_domains_json||'[]'),greeting:row.greeting,
  leadFields:JSON.parse(row.lead_fields_json||'["name","phone"]'),businessHoursNote:row.business_hours_note,
  status:row.status,createdAt:row.created_at,updatedAt:row.updated_at
 };
}
// One widget per tenant today (matches the simplicity of every other SINGLE-mode built-in
// integration in this app) — created lazily on first config fetch, never auto-enabled.
export function getOrCreateWidget(db,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const existing=db.prepare('SELECT * FROM website_widgets WHERE tenant_id=?').get(resolvedTenantId);
 if(existing)return hydrate(existing);
 const now=new Date().toISOString();
 const row={id:randomUUID(),tenantId:resolvedTenantId,publicWidgetId:randomUUID().replace(/-/g,'')};
 db.prepare('INSERT INTO website_widgets (id,tenant_id,public_widget_id,greeting,created_at,updated_at) VALUES (?,?,?,?,?,?)')
  .run(row.id,row.tenantId,row.publicWidgetId,'مرحبًا! كيف يمكنني مساعدتك اليوم؟',now,now);
 return hydrate(db.prepare('SELECT * FROM website_widgets WHERE id=?').get(row.id));
}
export function updateWidgetConfig(db,patch,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const existing=getOrCreateWidget(db,resolvedTenantId);
 const domains=Array.isArray(patch.allowedDomains)?patch.allowedDomains.slice(0,20).map(d=>String(d).trim().toLowerCase()).filter(Boolean):existing.allowedDomains;
 const status=patch.status!==undefined?(patch.status==='ACTIVE'?'ACTIVE':'DISABLED'):existing.status;
 if(status==='ACTIVE' && domains.length===0)fail(400,'أضف نطاقًا واحدًا مسموحًا على الأقل قبل تفعيل الودجت');
 const next={
  allowedDomains:domains,
  greeting:patch.greeting!==undefined?String(patch.greeting).trim().slice(0,500):existing.greeting,
  leadFields:Array.isArray(patch.leadFields)?patch.leadFields.filter(f=>['name','phone','email'].includes(f)):existing.leadFields,
  businessHoursNote:patch.businessHoursNote!==undefined?String(patch.businessHoursNote).trim().slice(0,300):existing.businessHoursNote,
  status
 };
 const now=new Date().toISOString();
 db.prepare('UPDATE website_widgets SET allowed_domains_json=?,greeting=?,lead_fields_json=?,business_hours_note=?,status=?,updated_at=? WHERE id=? AND tenant_id=?')
  .run(JSON.stringify(next.allowedDomains),next.greeting,JSON.stringify(next.leadFields),next.businessHoursNote,next.status,now,existing.id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'WEBSITE_WIDGET_UPDATED',itemId:existing.id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getOrCreateWidget(db,resolvedTenantId);
}
export function regenerateWidgetId(db,user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const existing=getOrCreateWidget(db,resolvedTenantId);
 const newPublicId=randomUUID().replace(/-/g,'');
 const now=new Date().toISOString();
 db.prepare('UPDATE website_widgets SET public_widget_id=?,updated_at=? WHERE id=? AND tenant_id=?').run(newPublicId,now,existing.id,resolvedTenantId);
 recordAudit(db,{id:randomUUID(),action:'WEBSITE_WIDGET_ID_ROTATED',itemId:existing.id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getOrCreateWidget(db,resolvedTenantId);
}
// Public, unauthenticated lookup — used by the widget's own chat endpoint. Returns null for
// any unknown/disabled widget rather than distinguishing "wrong id" from "disabled" (never
// leak which is the case to an anonymous caller).
export function resolveActiveWidgetByPublicId(db,publicWidgetId) {
 if(typeof publicWidgetId!=='string')return null;
 const row=db.prepare("SELECT * FROM website_widgets WHERE public_widget_id=? AND status='ACTIVE'").get(publicWidgetId);
 return row?hydrate(row):null;
}
// Origin/domain allowlist check (spec Part 29) — compares the request's real Origin header
// host against the widget's configured domains; a bare hostname in config matches both
// "example.com" and "www.example.com" for convenience, never a wildcard/regex (predictable,
// auditable matching only).
export function isOriginAllowed(widget,originHeader) {
 if(!originHeader)return false;
 let host;
 try {host=new URL(originHeader).hostname.toLowerCase();} catch {return false;}
 return widget.allowedDomains.some(domain=>host===domain||host==='www.'+domain||domain==='www.'+host);
}
// Simple in-memory per-(widget,ip) token bucket — same pattern as pilot-limits.js's other
// limiters in this codebase (no Redis, no persistence, acceptable for a public chat surface
// at this scale; resets on process restart).
const buckets=new Map();
export function checkWidgetRateLimit(publicWidgetId,ip,{maxPerMinute=8}={}) {
 const key=publicWidgetId+':'+ip;
 const now=Date.now();
 const entry=buckets.get(key);
 if(!entry||now-entry.windowStart>60000){buckets.set(key,{count:1,windowStart:now});return;}
 if(entry.count>=maxPerMinute)fail(429,'محاولات كثيرة جدًا — حاول بعد قليل');
 entry.count++;
}
// Finds/creates the real CRM lead for this widget visitor and records the real inbound
// message — exactly the same two calls the WhatsApp/Email webhook routes already make. If
// `existingLeadId` is given (the widget already told the visitor's browser which lead it is,
// from a prior message in the same page session) it is used directly instead of running
// find-or-create again — without this, an anonymous visitor with no phone/email yet (nothing
// for findOrCreateLeadFromChannel to match on) would get a brand NEW lead on every message.
export function recordWidgetInboundMessage(store,{tenantId,name,phone,email,text,existingLeadId=null}) {
 const actor={id:'connector:website_widget',name:'ودجت الدردشة',role:'automation'};
 let lead;
 if(existingLeadId) {
  const row=store.db.prepare('SELECT json FROM crm_leads WHERE id=? AND tenant_id=?').get(existingLeadId,tenantId);
  lead=row?JSON.parse(row.json):null;
 }
 if(!lead)({lead}=findOrCreateLeadFromChannel(store,{phone:phone||null,email:email||null,name:name||null,channel:'WebsiteChat'},actor,tenantId));
 const message=recordChannelMessage(store,{leadId:lead.id,channel:'WebsiteChat',direction:'INBOUND',text,messageType:'text'},actor,tenantId);
 return {lead,message};
}
export function recordWidgetOutboundReply(store,{tenantId,leadId,text}) {
 const actor={id:'connector:website_widget',name:'ودجت الدردشة',role:'automation'};
 return recordChannelMessage(store,{leadId,channel:'WebsiteChat',direction:'OUTBOUND',text,messageType:'text'},actor,tenantId);
}
// Direct, tenant-scoped query by lead — never a slice of the tenant's broader message feed,
// so a conversation's full history is always returned regardless of how much other traffic
// (other channels, other leads) the tenant has.
export function listWidgetConversationMessages(db,leadId,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const lead=db.prepare('SELECT id FROM crm_leads WHERE id=? AND tenant_id=?').get(leadId,resolvedTenantId);
 if(!lead)return [];
 return db.prepare('SELECT json FROM crm_messages WHERE lead_id=? ORDER BY rowid').all(leadId).map(row=>JSON.parse(row.json)).filter(m=>m.channel==='WebsiteChat');
}
