import {fail} from '../auth.js';
import {audit, clean, cleanMultiline, newId, now, tx} from './core.js';
import {validWebsite} from './partners.js';

const FILE_TYPES = {
 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'application/pdf': [0x25, 0x50, 0x44, 0x46], 'image/webp': [0x52, 0x49, 0x46, 0x46]
};
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const ASSET_CATEGORIES = ['logo', 'banner', 'copy', 'social', 'guide', 'presentation', 'other'];

const hydrate = r => r && ({
 id: r.id, category: r.category, kind: r.kind, titleAr: r.title_ar, titleEn: r.title_en, descriptionAr: r.description_ar, descriptionEn: r.description_en,
 textAr: r.text_ar, textEn: r.text_en, url: r.url, fileName: r.file_name, mimeType: r.mime_type, sizeBytes: r.size_bytes, hasFile: !!r.size_bytes,
 planIds: r.plan_ids_json ? JSON.parse(r.plan_ids_json) : [], status: r.status, createdAt: r.created_at, updatedAt: r.updated_at
});
const COLS = 'id,category,kind,title_ar,title_en,description_ar,description_en,text_ar,text_en,url,file_name,mime_type,size_bytes,plan_ids_json,status,created_at,updated_at';

function validate(input, partial) {
 const out = {};
 if (!partial || input.category !== undefined) { if (!ASSET_CATEGORIES.includes(input.category)) fail(400, 'category is invalid'); out.category = input.category; }
 if (!partial || input.kind !== undefined) { if (!['file', 'text', 'link'].includes(input.kind)) fail(400, 'kind must be file, text or link'); out.kind = input.kind; }
 for (const k of ['titleAr', 'titleEn']) if (!partial || input[k] !== undefined) { const v = clean(input[k], 120); if (!v) fail(400, `${k} is required`); out[k] = v; }
 for (const k of ['descriptionAr', 'descriptionEn']) if (input[k] !== undefined) out[k] = cleanMultiline(input[k], 1000);
 for (const k of ['textAr', 'textEn']) if (input[k] !== undefined) out[k] = cleanMultiline(input[k], 4000) || null;
 if (input.url !== undefined) out.url = validWebsite(input.url);
 if (input.planIds !== undefined) { if (!Array.isArray(input.planIds) || input.planIds.some(p => typeof p !== 'string')) fail(400, 'planIds must be an array'); out.planIds = input.planIds; }
 if (input.status !== undefined) { if (!['active', 'archived'].includes(input.status)) fail(400, 'status is invalid'); out.status = input.status; }
 return out;
}

export function createAsset(db, actor, input) {
 const v = validate(input, false);
 if (v.kind === 'link' && !v.url) fail(400, 'url is required for a link asset');
 if (v.kind === 'text' && !(v.textAr || v.textEn)) fail(400, 'text is required for a text asset');
 const id = newId(), t = now();
 db.prepare('INSERT INTO partner_marketing_assets (id,category,kind,title_ar,title_en,description_ar,description_en,text_ar,text_en,url,plan_ids_json,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(id, v.category, v.kind, v.titleAr, v.titleEn, v.descriptionAr || '', v.descriptionEn || '', v.textAr || null, v.textEn || null, v.url || null, v.planIds?.length ? JSON.stringify(v.planIds) : null, v.status || 'active', actor.id, t, t);
 audit(db, {actor, action: 'PARTNER_ASSET_CREATED', entityType: 'asset', entityId: id});
 return getAsset(db, id);
}
export function updateAsset(db, actor, id, input) {
 const v = validate(input, true);
 return tx(db, () => {
  getAsset(db, id);
  const map = {category: 'category', kind: 'kind', titleAr: 'title_ar', titleEn: 'title_en', descriptionAr: 'description_ar', descriptionEn: 'description_en', textAr: 'text_ar', textEn: 'text_en', url: 'url', status: 'status'};
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(map)) if (v[k] !== undefined) { sets.push(`${col}=?`); vals.push(v[k]); }
  if (v.planIds !== undefined) { sets.push('plan_ids_json=?'); vals.push(v.planIds.length ? JSON.stringify(v.planIds) : null); }
  if (sets.length) db.prepare(`UPDATE partner_marketing_assets SET ${sets.join(',')},updated_at=? WHERE id=?`).run(...vals, now(), id);
  audit(db, {actor, action: 'PARTNER_ASSET_UPDATED', entityType: 'asset', entityId: id});
  return getAsset(db, id);
 });
}
export function getAsset(db, id) {
 const r = db.prepare(`SELECT ${COLS} FROM partner_marketing_assets WHERE id=?`).get(id);
 if (!r) fail(404, 'Asset not found');
 return hydrate(r);
}
export const listAssetsAdmin = db => db.prepare(`SELECT ${COLS} FROM partner_marketing_assets ORDER BY created_at DESC`).all().map(hydrate);
/** Only assets whose plan restriction (if any) includes the partner's plan. */
export function listAssetsForPartner(db, profile) {
 return db.prepare(`SELECT ${COLS} FROM partner_marketing_assets WHERE status='active' ORDER BY category, created_at DESC`).all().map(hydrate)
  .filter(a => !a.planIds.length || a.planIds.includes(profile.plan_id));
}
export function saveAssetFile(db, actor, id, {mimeType, fileName, data}) {
 const magic = FILE_TYPES[mimeType];
 if (!magic) fail(415, 'file must be PNG, JPEG, WebP or PDF');
 if (!data.length || data.length > MAX_ASSET_BYTES) fail(413, 'file must be 1 byte - 5 MB');
 if (!magic.every((b, i) => data[i] === b)) fail(400, 'file content does not match its type');
 const a = getAsset(db, id);
 if (a.kind !== 'file') fail(409, 'this asset is not a file asset');
 const safe = clean(fileName, 100).replace(/[^\w.\- ]/g, '_') || 'asset';
 db.prepare('UPDATE partner_marketing_assets SET file_name=?,mime_type=?,size_bytes=?,file_data=?,updated_at=? WHERE id=?').run(safe, mimeType, data.length, data, now(), id);
 audit(db, {actor, action: 'PARTNER_ASSET_FILE_UPLOADED', entityType: 'asset', entityId: id});
 return getAsset(db, id);
}
export function getAssetFile(db, id, profile = null) {
 const r = db.prepare("SELECT * FROM partner_marketing_assets WHERE id=?").get(id);
 if (!r || !r.file_data) fail(404, 'File not found');
 if (profile) {
  if (r.status !== 'active') fail(404, 'File not found');
  const planIds = r.plan_ids_json ? JSON.parse(r.plan_ids_json) : [];
  if (planIds.length && !planIds.includes(profile.plan_id)) fail(403, 'ENTITLEMENT_REQUIRED');
 }
 return {name: r.file_name, mime: r.mime_type, data: Buffer.from(r.file_data)};
}
