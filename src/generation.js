import {createHash,randomUUID} from 'node:crypto';
import {createContent} from './domain.js';
import {fail} from './auth.js';
import {generationContext} from './knowledge.js';
import {generateCopy,ConnectorError} from './connectors.js';

export function listAiRuns(db,limit=50) {
 return db.prepare('SELECT status,json FROM ai_runs ORDER BY rowid DESC LIMIT ?').all(limit).map(row=>({...JSON.parse(row.json),status:row.status}));
}
// Optional creative-brief fields: purely additive context for the copy agent (see
// connectors.js generateCopy's system suffix). None are required; omitting all of them
// reproduces the exact previous request/response shape.
const BRIEF_FIELDS=['campaign','audience','contentType','language','tone','cta','funnelStage','customerType','seoKeywords','offer','length','referenceContext'];
function briefInput(input) {
 const brief={};
 for(const field of BRIEF_FIELDS){const value=input[field];if(typeof value==='string'&&value.trim())brief[field]=value.trim().slice(0,500);}
 return brief;
}
export function createGenerator(store,env,fetcher) {
 const db=store.db;
 // A process exit may occur after the provider billed the call; never replay automatically.
 db.prepare("UPDATE ai_runs SET status='INTERRUPTED' WHERE status='RUNNING'").run();
 let active=false;
 return async function generate(input,user) {
  if(typeof input.requestKey!=='string'||! /^[a-zA-Z0-9-]{16,100}$/.test(input.requestKey))fail(400,'مفتاح الطلب غير صالح');
  if(typeof input.productId!=='string'||input.productId.length>100)fail(400,'معرف المنتج غير صالح');
  const brief=briefInput(input);
  const request={productId:input.productId,title:input.title,platform:input.platform,date:input.date,brief};
  createContent({...request,body:'validation',url:'https://hyper-cool.com/'});
  const fingerprint=createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const previous=db.prepare('SELECT * FROM ai_runs WHERE request_key=?').get(input.requestKey);
  if(previous) {
   if(previous.actor_id!==user.id || previous.request_hash!==fingerprint)fail(409,'مفتاح الطلب مستخدم لطلب آخر');
   return {...JSON.parse(previous.json),status:previous.status,replayed:true};
  }
  if(active)fail(409,'هناك طلب توليد قيد التنفيذ؛ انتظر اكتماله');
  if(!env.ANTHROPIC_API_KEY||!env.ANTHROPIC_MODEL)fail(409,'أضف مفتاح Anthropic واسم الموديل في إعدادات الخادم');
  const context=generationContext(db,{...input,brief});
  const run={id:randomUUID(),status:'RUNNING',createdAt:new Date().toISOString(),actorId:user.id,productId:input.productId,title:input.title,brief,model:env.ANTHROPIC_MODEL};
  db.prepare('INSERT INTO ai_runs VALUES (?,?,?,?,?,?)').run(run.id,input.requestKey,fingerprint,user.id,run.status,JSON.stringify(run));
  active=true;
  try {
   const result=await generateCopy({env,context,fetcher});
   // Recheck context after the remote call so revoked facts or refreshed products invalidate the draft.
   const latest=generationContext(db,{...input,brief});
   if(JSON.stringify({...latest,current_datetime:''})!==JSON.stringify({...context,current_datetime:''}))throw new ConnectorError('CONTEXT_CHANGED');
   const decision=result.decision;
   if(decision.status!=='OK') {
    Object.assign(run,{status:decision.status,decision,usage:result.usage});
   } else {
    if(decision.escalation_required||decision.risk_level!=='LOW')throw new ConnectorError('HUMAN_REVIEW_REQUIRED');
    if(decision.payload.URL!==context.product.url)throw new ConnectorError('MODEL_LINK_MISMATCH');
    const copy=decision.payload;
    const content=createContent({...request,body:copy.arabic_copy,url:context.product.url});
    // Human review remains mandatory; the model's verification is not human approval.
    Object.assign(content,{createdBy:user.id,origin:'AI',englishCopy:copy.english_copy,aiRunId:run.id,aiDecision:decision,sourceContext:context});
    store.mutate(state=>{
     state.content.unshift(content);
     state.audit.unshift({id:randomUUID(),action:'AI_DRAFT_CREATED',itemId:content.id,actorId:user.id,actorName:user.name,actorRole:user.role,at:new Date().toISOString()});
     Object.assign(run,{status:'COMPLETED',contentId:content.id,usage:result.usage});
     db.prepare('UPDATE ai_runs SET status=?,json=? WHERE id=?').run(run.status,JSON.stringify(run),run.id);
    });
   }
  } catch(error) {
   Object.assign(run,{status:'ERROR',errorCode:error instanceof ConnectorError?error.code:'GENERATION_FAILED'});
  } finally {
   run.finishedAt=new Date().toISOString();
   try{db.prepare('UPDATE ai_runs SET status=?,json=? WHERE id=?').run(run.status,JSON.stringify(run),run.id);}finally{active=false;}
  }
  return run;
 };
}
