import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,unlinkSync,existsSync} from 'node:fs';
import path from 'node:path';
import {fail} from '../auth.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {recordAudit} from '../audit.js';

// Command Center Phase 7B (spec Part 15-19) — a minimal, safe, tenant-scoped attachment store.
// Audited before writing: no upload/storage subsystem exists anywhere else in this codebase
// (see Phase 7B report Part L) — this is the one, real, new one, not a duplicate of anything.
// Deliberately base64-in-JSON rather than multipart: the app's shared `body()` reader
// (application.js) hard-caps every JSON POST at 64KB and requires application/json, and no
// multipart-parsing dependency exists in package.json — writing a raw multipart parser for this
// alone would be new, security-sensitive surface for a v1 feature. The route uses its own
// dedicated, larger-but-still-bounded raw body reader (mirroring how webhook signature
// verification already gets its own `rawBody` override next to the shared `body()`).
export const ALLOWED_TYPES={
 'application/pdf':'.pdf','text/csv':'.csv',
 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx',
 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx',
 'text/plain':'.txt','image/png':'.png','image/jpeg':'.jpg'
};
export const MAX_ATTACHMENT_BYTES=8*1024*1024; // 8MB decoded — generous for the allowed types, small enough to keep this a demo/document-context feature, not a file host

export function installAttachments(db) {
 db.exec(`CREATE TABLE IF NOT EXISTS command_attachments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  conversation_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  disk_path TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_by_name TEXT,
  saved_to_brain_context_id TEXT,
  created_at TEXT NOT NULL
 );
 CREATE INDEX IF NOT EXISTS idx_command_attachments_tenant ON command_attachments(tenant_id,created_at);`);
}

function attachmentsDir(env,tenantId) {
 const base=env.ATTACHMENTS_DIR||path.join(process.cwd(),'data','attachments');
 return path.join(base,tenantId);
}
// Strips everything but a safe basename — no path separators, no leading dots (no traversal,
// no hidden files), bounded length. The extension actually written to disk always comes from
// the validated MIME type (ALLOWED_TYPES), never from the client-supplied name, so a renamed
// executable can't ride in on a trusted-looking filename either.
function safeBasename(name) {
 const base=String(name||'file').replace(/[\\/]/g,'_').replace(/^\.+/,'').slice(0,150).trim();
 return base||'file';
}
function hydrate(row) {
 if(!row)return null;
 return {id:row.id,tenantId:row.tenant_id,conversationId:row.conversation_id,filename:row.filename,
  mimeType:row.mime_type,sizeBytes:row.size_bytes,uploadedBy:row.uploaded_by,uploadedByName:row.uploaded_by_name,
  savedToBrainContextId:row.saved_to_brain_context_id,createdAt:row.created_at};
}
/**
 * Validates size + MIME + extension, writes the decoded bytes to a tenant-scoped directory
 * under a random filename (the human-readable name is kept only as DB metadata, never as the
 * on-disk path — spec item 17's "no arbitrary path traversal, safe filenames"), and records
 * real governance metadata (item 19: who/when/which conversation).
 */
export function createAttachment(db,env,{filename,mimeType,contentBase64,conversationId=null},user,tenantId=null) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 if(!ALLOWED_TYPES[mimeType])fail(415,'نوع الملف غير مسموح — الأنواع المسموحة: PDF, CSV, XLSX, DOCX, TXT, PNG, JPG');
 if(typeof contentBase64!=='string'||!contentBase64.length)fail(400,'محتوى الملف مطلوب');
 let bytes;
 try{bytes=Buffer.from(contentBase64,'base64');}catch{fail(400,'محتوى الملف غير صالح (base64)');}
 if(!bytes.length)fail(400,'الملف فارغ');
 if(bytes.length>MAX_ATTACHMENT_BYTES)fail(413,`الملف كبير جدًا (الحد الأقصى ${MAX_ATTACHMENT_BYTES/1024/1024}MB)`);
 const dir=attachmentsDir(env,resolvedTenantId);
 mkdirSync(dir,{recursive:true});
 const id=randomUUID();
 const diskName=id+ALLOWED_TYPES[mimeType];
 const diskPath=path.join(dir,diskName);
 writeFileSync(diskPath,bytes);
 const now=new Date().toISOString();
 const row={id,tenantId:resolvedTenantId,conversationId,filename:safeBasename(filename),mimeType,sizeBytes:bytes.length,diskPath,uploadedBy:user?.id||null,uploadedByName:user?.name||null,createdAt:now};
 db.prepare(`INSERT INTO command_attachments (id,tenant_id,conversation_id,filename,mime_type,size_bytes,disk_path,uploaded_by,uploaded_by_name,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(row.id,row.tenantId,row.conversationId,row.filename,row.mimeType,row.sizeBytes,row.diskPath,row.uploadedBy,row.uploadedByName,row.createdAt);
 recordAudit(db,{id:randomUUID(),action:'COMMAND_ATTACHMENT_UPLOADED',itemId:id,actorId:user?.id||null,actorName:user?.name||null,actorRole:user?.role||null,at:now},resolvedTenantId);
 return getAttachment(db,id,resolvedTenantId);
}
export function getAttachment(db,id,tenantId=null) {
 const row=db.prepare('SELECT * FROM command_attachments WHERE id=? AND tenant_id=?').get(id,tenantId||resolveActiveTenantId(db));
 if(!row)fail(404,'المرفق غير موجود');
 return hydrate(row);
}
export function listAttachments(db,tenantId=null,{conversationId}={}) {
 const resolvedTenantId=tenantId||resolveActiveTenantId(db);
 const rows=conversationId
  ?db.prepare('SELECT * FROM command_attachments WHERE tenant_id=? AND conversation_id=? ORDER BY created_at DESC').all(resolvedTenantId,conversationId)
  :db.prepare('SELECT * FROM command_attachments WHERE tenant_id=? ORDER BY created_at DESC LIMIT 50').all(resolvedTenantId);
 return rows.map(hydrate);
}
// Real, size-bounded text extraction — only for the types Frost can actually reason about as
// text (txt/csv verbatim). PDF/DOCX/XLSX/images are tracked with real metadata (name, size,
// uploader) but their binary content is never blindly dumped into an LLM prompt as "text";
// parsing those formats for real content extraction is a distinct, larger feature this v1
// does not claim to provide (kept honest rather than silently sending garbled bytes).
const TEXT_READABLE_MIME=new Set(['text/plain','text/csv']);
export function readAttachmentTextForChat(db,env,id,tenantId) {
 const attachment=getAttachment(db,id,tenantId);
 if(!TEXT_READABLE_MIME.has(attachment.mimeType))return {attachment,text:null,note:'هذا نوع الملف (غير نصي) غير قابل للقراءة المباشرة حاليًا — الاسم والبيانات الوصفية فقط متاحة لـFrost.'};
 const row=db.prepare('SELECT disk_path FROM command_attachments WHERE id=? AND tenant_id=?').get(id,tenantId);
 if(!row||!existsSync(row.disk_path))return {attachment,text:null,note:'الملف غير موجود على القرص.'};
 const text=readFileSync(row.disk_path,'utf8').slice(0,20000);
 return {attachment,text,note:null};
}
/**
 * Spec item 18 — an attachment does NOT automatically become permanent Company Brain; only an
 * explicit human action ("حفظ في عقل الشركة") creates a real, governed context_items row
 * (source='attachment', so it's traceable back to the file it came from) and links it back
 * onto the attachment row for traceability (item 19).
 */
export function pinAttachmentToBrain(db,attachmentId,contextItemId,tenantId) {
 db.prepare('UPDATE command_attachments SET saved_to_brain_context_id=? WHERE id=? AND tenant_id=?').run(contextItemId,attachmentId,tenantId);
 return getAttachment(db,attachmentId,tenantId);
}
export function deleteAttachmentFile(db,id,tenantId) {
 const row=db.prepare('SELECT disk_path FROM command_attachments WHERE id=? AND tenant_id=?').get(id,tenantId);
 if(row?.disk_path && existsSync(row.disk_path)){try{unlinkSync(row.disk_path);}catch{/* best-effort */}}
}
