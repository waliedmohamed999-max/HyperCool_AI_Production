import test from 'node:test';
import assert from 'node:assert/strict';
import {openStore} from '../src/store.js';
import {installKnowledge,saveMemory,currentMemory,replaceProducts,generationContext} from '../src/knowledge.js';
import {normalizeSallaProduct,importSalla,generateCopy,connectionStatus} from '../src/connectors.js';
import {createGenerator} from '../src/generation.js';

const user={id:'owner-id',name:'Owner',role:'owner'};
const env={ANTHROPIC_API_KEY:'test-secret',ANTHROPIC_MODEL:'test-model',SALLA_ACCESS_TOKEN:'salla-test-secret'};
const input=()=>({requestKey:crypto.randomUUID(),productId:'123',title:'فكرة محتوى',platform:'Instagram',date:'2026-09-10'});
const product=(id=123)=>({id,name:'منتج اختبار',urls:{customer:'https://hyper-cool.com/product/p'+id},taxed_price:{amount:100,currency:'SAR'},quantity:'4',is_available:true,status:'sale'});
const memory=(key,kind,value,more={})=>({key,kind,value,source:'Approved reference',changeReason:'Initial approval',status:'APPROVED',expectedVersion:0,...more});
function fixture(){const store=openStore(':memory:');installKnowledge(store.db);replaceProducts(store.db,[normalizeSallaProduct(product(),new Date().toISOString())]);saveMemory(store.db,memory('voice','brand_voice','لغة واضحة'),user);saveMemory(store.db,memory('product.123','product_fact','مادة المنتج معتمدة',{productId:'123'}),user);return store;}
const decision=()=>({status:'OK',action:'DRAFT',rationale:'Use approved facts',verification:[],risk_level:'LOW',escalation_required:false,missing_data:[],payload:{arabic_copy:'مسودة عربية للمراجعة',english_copy:'English draft',hook:'Hook',body:'Body',CTA:'Explore',URL:'https://hyper-cool.com/product/p123',hashtags:[],factual_dependencies:[],compliance_notes:[],tone_notes:[]}});
const response=value=>new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});
const modelResponse=value=>response({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(value)}],usage:{input_tokens:10,output_tokens:20}});

test('approved memory is versioned, revocation does not resurrect old data, stale writes fail',()=>{
 const store=fixture();try{
  saveMemory(store.db,memory('voice','brand_voice','مسحوب',{expectedVersion:1,status:'REVOKED'}),user);
  assert.equal(currentMemory(store.db).some(entry=>entry.key==='voice'),false);
  assert.throws(()=>saveMemory(store.db,memory('voice','brand_voice','old write',{expectedVersion:1}),user),/تحديث/);
  assert.throws(()=>generationContext(store.db,input()),/نبرة/);
 }finally{store.close();}
});

test('catalog snapshots preserve unknown stock and require configured store domain',()=>{
 const row=normalizeSallaProduct({...product(),quantity:null,taxed_price:null},new Date().toISOString());
 assert.equal(row.stock.value,null);assert.equal(row.price.value,null);
 assert.equal(normalizeSallaProduct({...product(),quantity:0},new Date().toISOString()).stock.value,0);
 assert.equal(normalizeSallaProduct({...product(),unlimited_quantity:true},new Date().toISOString()).stock.value,null);
 assert.throws(()=>normalizeSallaProduct({...product(),urls:{customer:'https://evil.test/p'}},new Date().toISOString()),/DOMAIN/);
});

test('Salla pagination is bounded and ignores provider-supplied pagination URLs',async()=>{
 let calls=0;
 const products=await importSalla({env,fetcher:async(url,options)=>{
  calls++;assert.match(url,/^https:\/\/api.salla.dev\/admin\/v2\/products\?page=/);assert.equal(options.redirect,'error');
  return response({success:true,data:[product(calls)],pagination:{totalPages:2,links:{next:'https://evil.test'}}});
 }});
 assert.equal(calls,2);assert.equal(products.length,2);
 await assert.rejects(()=>importSalla({env:{},fetcher:()=>{throw new Error('must not call');}}),/NOT_CONFIGURED/);
 await assert.rejects(()=>importSalla({env,fetcher:async()=>response({success:true,data:[],pagination:{totalPages:21}})}),/PAGE_LIMIT/);
});

test('generation saves only drafts, keeps provenance, deduplicates and excludes secrets/prices from prompt',async()=>{
 const store=fixture();let calls=0;
 try{
 const generate=createGenerator(store,env,async(url,options)=>{
  calls++;assert.equal(url,'https://api.anthropic.com/v1/messages');
  assert.equal(options.headers['x-api-key'],env.ANTHROPIC_API_KEY);
  assert.equal(options.body.includes('test-secret'),false);
  const context=JSON.parse(JSON.parse(options.body).messages[0].content);
  assert.equal('price' in context.product,false);assert.equal('stock' in context.product,false);
  return modelResponse(decision());
 });
 const request=input();const first=await generate(request,user),second=await generate(request,user);
 assert.equal(first.status,'COMPLETED');assert.equal(second.replayed,true);assert.equal(calls,1);
 assert.equal(store.read().content.length,1);assert.equal(store.read().content[0].status,'DRAFT');
 assert.equal(store.read().content[0].sourceContext.product_facts[0].version,1);
 await assert.rejects(()=>generate({...request,title:'changed'},user),/مستخدم/);
 await assert.rejects(()=>generate(request,{...user,id:'another-user'}),/مستخدم/);
 }finally{store.close();}
});

test('invalid model output and changed context never create drafts',async()=>{
 for(const mode of ['invalid','changed','url','truncated']){
 const store=fixture();try{
  const generate=createGenerator(store,env,async()=>{
   if(mode==='changed')saveMemory(store.db,memory('voice','brand_voice','new voice',{expectedVersion:1}),user);
   if(mode==='invalid')return modelResponse({status:'OK'});
   if(mode==='truncated')return response({stop_reason:'max_tokens',content:[]});
   const value=decision();if(mode==='url')value.payload.URL='https://evil.test/';return modelResponse(value);
  });
  const result=await generate(input(),user);assert.equal(result.status,'ERROR');assert.equal(store.read().content.length,0);
 }finally{store.close();}}
});

test('missing config, stale products and missing facts prevent provider calls',async()=>{
 const store=fixture();try{
 const generate=createGenerator(store,{},async()=>{throw new Error('must not call');});
 await assert.rejects(()=>generate(input(),user),/Anthropic/);
 replaceProducts(store.db,[normalizeSallaProduct(product(),'2020-01-01T00:00:00Z')]);
 assert.throws(()=>generationContext(store.db,input()),/قديمة/);
 replaceProducts(store.db,[normalizeSallaProduct({...product(),quantity:0},new Date().toISOString())]);
 assert.throws(()=>generationContext(store.db,input()),/غير متاح/);
 replaceProducts(store.db,[normalizeSallaProduct(product(),new Date().toISOString())]);
 saveMemory(store.db,memory('product.123','product_fact','revoked',{productId:'123',status:'REVOKED',expectedVersion:1}),user);
 assert.throws(()=>generationContext(store.db,input()),/مواصفة/);
 assert.equal(connectionStatus(env).anthropic.configured,true);
 assert.equal(JSON.stringify(connectionStatus(env)).includes('test-secret'),false);
 }finally{store.close();}
});

test('provider errors never expose response bodies or credentials',async()=>{
 await assert.rejects(()=>generateCopy({env,context:{},fetcher:async()=>new Response('test-secret provider dump',{status:401})}),error=>error.message==='CREDENTIALS_REJECTED');
 await assert.rejects(()=>generateCopy({env,context:{},fetcher:async()=>{throw new Error('test-secret');}}),error=>error.message==='NETWORK_OR_TIMEOUT');
});
