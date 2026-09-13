import {contentHash} from './planning.js';
export const agents = [
  ['frost','Frost','إدارة المنظومة وترتيب الأولويات'],
  ['strategy','استراتيجية المحتوى','تخطيط المحتوى وربطه بأهداف المبيعات'],
  ['copy','كتابة المحتوى','صياغة عربية وإنجليزية لكل منصة'],
  ['creative','التصميم','التصور البصري وسيناريوهات الفيديو'],
  ['compliance','مراجعة الامتثال','التحقق من الأسعار والمواصفات والادعاءات'],
  ['publishing','النشر والجدولة','تنفيذ المحتوى المعتمد'],
  ['leads','العملاء المحتملون','فرص بيع بمصادر ومحفز شراء مؤرخ'],
  ['sales','المحادثات والمبيعات','تأهيل العميل وتجهيز عرض السعر'],
  ['followup','المتابعة','متابعات بموافقة العميل'],
  ['intelligence','رصد السوق','المنافسون واتجاهات السوق'],
  ['performance','قياس الأداء','تحليل النتائج واقتراح التحسينات'],
  ['memory','ذاكرة العلامة','المعلومات المعتمدة والدروس المستفادة'],
  ['frost_commander','مساعد غرفة القيادة','يجيب على أسئلة الأداء ويقرأ حالة النظام وينفذ إجراءات محدودة بموافقة بشرية']
].map(([id,name,purpose])=>({id,name,purpose,level:'L0',status:'NOT_CONNECTED'}));

export function initialState() {
  return {version:1,agents,content:[],audit:[],integrations:['Anthropic','Salla','WhatsApp','Meta','X','LinkedIn','Microsoft 365','Canva'].map(name=>({name,status:'NOT_CONNECTED'}))};
}

export function createContent(input) {
  const fields = ['title','body','platform','date'];
  for(const field of fields) if(typeof input[field] !== 'string' || !input[field].trim()) throw new Error(`الحقل مطلوب: ${field}`);
  if(!['Instagram','Facebook','X','LinkedIn'].includes(input.platform)) throw new Error('منصة غير مدعومة');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !Number.isFinite(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0,10)!==input.date) throw new Error('تاريخ غير صالح');
  if(input.body.length>10000 || input.title.length>200) throw new Error('النص أطول من الحد المسموح');
  let url;
  try {url = new URL(input.url);} catch {throw new Error('أضف رابط منتج أو تصنيف صحيح');}
  if(url.protocol!=='https:' || url.hostname!=='hyper-cool.com' || url.username || url.password) throw new Error('الرابط يجب أن يكون من متجر HyperCool عبر HTTPS');
  if(input.englishCopy!==undefined && (typeof input.englishCopy!=='string'||input.englishCopy.length>10000))throw new Error('النص الإنجليزي غير صالح');
  let assetUrl='';
  if(input.assetUrl){let asset;try{asset=new URL(input.assetUrl);}catch{throw new Error('رابط الأصل البصري غير صالح');}if(asset.protocol!=='https:'||asset.username||asset.password)throw new Error('الأصل البصري يتطلب رابط HTTPS بدون بيانات دخول');assetUrl=asset.href;}
  return {id:crypto.randomUUID(),title:input.title.trim(),body:input.body.trim(),englishCopy:input.englishCopy?.trim()||'',assetUrl,platform:input.platform,date:input.date,url:url.href,status:'DRAFT',review:null,createdAt:new Date().toISOString()};
}

export function reviewContent(item, input) {
  if(item.status!=='DRAFT') throw new Error('يمكن مراجعة المسودة فقط');
  if(typeof input.reviewer!=='string' || !input.reviewer.trim()) throw new Error('اسم المراجع مطلوب');
  if(typeof input.evidence!=='string' || !input.evidence.trim()) throw new Error('مصادر التحقق وملاحظات المراجع مطلوبة');
  const checks = ['facts','claims','link'];
  if(!checks.every(key=>input[key]===true)) throw new Error('يجب تأكيد تحقق المعلومات والادعاءات والرابط');
  if(item.assetUrl && input.asset!==true)throw new Error('أكد مراجعة الأصل البصري');
  return {...item,status:'REVIEWED',review:{reviewer:input.reviewer.trim(),evidence:input.evidence.trim(),at:new Date().toISOString(),checks:[...checks,...(item.assetUrl?['asset']:[])],contentHash:contentHash(item)}};
}

export function approveContent(item,input) {
  if(item.status!=='REVIEWED' || !item.review) throw new Error('مراجعة الامتثال مطلوبة قبل الاعتماد');
  if(typeof input.owner!=='string' || !input.owner.trim()) throw new Error('اسم صاحب الاعتماد مطلوب');
  if(item.review.contentHash!==contentHash(item))throw new Error('المحتوى تغير بعد المراجعة؛ أعد المراجعة');
  return {...item,status:'APPROVED',approval:{id:crypto.randomUUID(),owner:input.owner.trim(),at:new Date().toISOString(),contentHash:contentHash(item)}};
}
