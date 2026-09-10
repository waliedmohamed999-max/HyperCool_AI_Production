import {listProducts,currentMemory} from '../knowledge.js';
import {listLeads,leadDetail,createLead,updateLead,createFollowups,recordMessage,searchLeads} from '../crm.js';
import {createContent} from '../domain.js';
import {buildWeeklyReport,currentWeekStart} from '../reporting.js';
import {createApproval} from './approvals.js';

export function integrationStatus(env) {
 return {
  whatsapp:{configured:!!env.WHATSAPP_ACCESS_TOKEN},
  meta:{configured:!!env.META_ACCESS_TOKEN},
  x:{configured:!!env.X_BEARER_TOKEN},
  linkedin:{configured:!!env.LINKEDIN_ACCESS_TOKEN},
  microsoft365:{configured:!!env.MICROSOFT_ACCESS_TOKEN},
  canva:{configured:!!env.CANVA_API_KEY},
  salla_webhooks:{configured:!!env.SALLA_WEBHOOK_SECRET}
 };
}
// Which integration(s) gate this agent's external actions, for the team-page status line.
// Purely descriptive — the real gate is each tool's own `integration` field above.
export const AGENT_INTEGRATIONS={frost:[],strategy:[],copy:[],creative:['canva'],compliance:[],publishing:['meta','x','linkedin'],leads:[],sales:['whatsapp'],followup:['whatsapp','microsoft365'],intelligence:[],performance:[],memory:[]};
export function agentActor(agentId,nameAr) {
 return {id:'agent:'+agentId,name:nameAr?`وكيل ${nameAr}`:('وكيل '+agentId),role:'agent'};
}
const blocked=(integration,action)=>({status:'INTEGRATION_REQUIRED',integration,action_blocked:action,configuration_required:true});
const string={type:'string'};
const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});

/**
 * AgentToolRegistry. Every tool is {name, description, inputSchema, minLevel, integration, handler}.
 * `handler(input, ctx)` runs server-side only — the model never reaches the network or the
 * database directly. Tools whose `integration` is set and not connected always answer
 * INTEGRATION_REQUIRED, regardless of permission level: the level gate and the integration
 * gate are independent and both must pass.
 */
export function buildToolRegistry({store,env}) {
 const db=store.db;
 const tools=[
  {name:'get_products',description:'List all Salla-synced products with price/stock snapshot.',inputSchema:obj({}),minLevel:'L0',
   handler:()=>listProducts(db)},
  {name:'get_product',description:'Get one product by id.',inputSchema:obj({productId:string}),minLevel:'L0',
   handler:({productId})=>listProducts(db).find(p=>p.id===productId)||{status:'NO_DATA'}},
  {name:'get_current_price',description:'Get the last-synced price snapshot for a product, with source and sync time.',inputSchema:obj({productId:string}),minLevel:'L0',
   handler:({productId})=>{const p=listProducts(db).find(x=>x.id===productId);return p?{price:p.price,syncedAt:p.syncedAt,source:p.price?.source||null}:{status:'NO_DATA'};}},
  {name:'get_stock',description:'Get the last-synced stock snapshot for a product.',inputSchema:obj({productId:string}),minLevel:'L0',
   handler:({productId})=>{const p=listProducts(db).find(x=>x.id===productId);return p?{stock:p.stock,available:p.available,syncedAt:p.syncedAt}:{status:'NO_DATA'};}},
  {name:'search_crm',description:'Search existing CRM leads by name, company, phone, email or product need.',inputSchema:obj({query:string}),minLevel:'L0',
   handler:({query})=>searchLeads(db,query)},
  {name:'get_lead',description:'Get full lead detail including messages and follow-ups.',inputSchema:obj({leadId:string}),minLevel:'L0',
   handler:({leadId})=>{try{return leadDetail(db,leadId);}catch{return {status:'NO_DATA'};}}},
  {name:'get_conversation',description:'Get the recorded message history for a lead.',inputSchema:obj({leadId:string}),minLevel:'L0',
   handler:({leadId})=>{try{return leadDetail(db,leadId).messages;}catch{return {status:'NO_DATA'};}}},
  {name:'search_brand_memory',description:'Search approved brand memory (voice, product facts, claims, policies, competitor insights).',inputSchema:obj({kind:string},[]),minLevel:'L0',
   handler:({kind}={})=>currentMemory(db).filter(entry=>!kind||entry.kind===kind)},
  {name:'get_competitor_data',description:'Read approved competitor/trend insights from brand memory.',inputSchema:obj({}),minLevel:'L0',
   handler:()=>currentMemory(db).filter(entry=>entry.kind==='competitor_insight')},
  {name:'get_metrics',description:'Get the current live weekly operations report (internal metrics only).',inputSchema:obj({}),minLevel:'L0',
   handler:()=>buildWeeklyReport(store,currentWeekStart())},

  // --- draft/propose tools: create pending, human-reviewable records. Allowed from L0 because
  // nothing here is an external action — it mirrors what an operator can already do by hand.
  {name:'create_lead',description:'Create a new CRM lead record.',inputSchema:obj({name:string,customerType:string,sourceType:string},['name','customerType','sourceType']),minLevel:'L0',
   handler:(input,ctx)=>createLead(store,input,ctx.actor)},
  {name:'update_lead',description:'Update an existing lead qualification/stage.',inputSchema:obj({leadId:string,stage:string,expectedVersion:{type:'integer'}},['leadId']),minLevel:'L0',
   handler:({leadId,...input},ctx)=>updateLead(store,leadId,input,ctx.actor)},
  {name:'save_message',description:'Record an inbound conversation message against a lead.',inputSchema:obj({leadId:string,channel:string,text:string,intent:string,eventKey:string},['leadId','channel','text','intent','eventKey']),minLevel:'L0',
   handler:({leadId,...input},ctx)=>recordMessage(store,leadId,input,ctx.actor)},
  {name:'create_followup',description:'Draft a follow-up sequence for a lead (drafts only; still requires human approval to send).',inputSchema:obj({leadId:string,sequence:string,channel:string,startAt:string,evidence:string,requestKey:string},['leadId','sequence','channel','startAt','evidence','requestKey']),minLevel:'L0',
   handler:({leadId,...input},ctx)=>createFollowups(store,leadId,input,ctx.actor)},
  {name:'create_content',description:'Create a new content draft (still requires human compliance review and owner approval before it can be scheduled).',inputSchema:obj({title:string,body:string,platform:string,date:string,url:string},['title','body','platform','date','url']),minLevel:'L0',
   handler:(input,ctx)=>store.mutate(state=>{const item={...createContent(input),createdBy:ctx.actor.id,origin:'AI'};state.content.unshift(item);state.audit.unshift({id:crypto.randomUUID(),action:'DRAFT_CREATED',itemId:item.id,actorId:ctx.actor.id,actorName:ctx.actor.name,actorRole:ctx.actor.role,at:new Date().toISOString()});return item;})},
  {name:'propose_memory_update',description:'Propose a brand memory change for human approval — never writes memory directly.',inputSchema:obj({type:string,key:string,newValue:string,evidence:string,confidence:{type:'number'}},['type','key','newValue']),minLevel:'L0',
   handler:(input,ctx)=>createApproval(db,{runId:ctx.runId,agentId:ctx.agentId,actionType:'memory_policy_change',proposedOutput:input,riskLevel:'MEDIUM',reason:'Agent-proposed memory update requires human approval before it becomes fact.'})},

  // --- external actions: always integration-gated. Real credentials flip these on later
  // without any agent code changing — only connectionStatus() and these handlers.
  // Names use underscores, not dots: Anthropic tool names must match ^[a-zA-Z0-9_-]{1,128}$.
  {name:'whatsapp_send',description:'Send a WhatsApp message to a customer.',inputSchema:obj({leadId:string,text:string},['leadId','text']),minLevel:'L2',integration:'whatsapp',
   handler:()=>blocked('whatsapp','send_message')},
  {name:'meta_publish',description:'Publish a post to Instagram or Facebook.',inputSchema:obj({contentId:string},['contentId']),minLevel:'L2',integration:'meta',
   handler:()=>blocked('meta','publish_post')},
  {name:'x_publish',description:'Publish a post to X.',inputSchema:obj({contentId:string},['contentId']),minLevel:'L2',integration:'x',
   handler:()=>blocked('x','publish_post')},
  {name:'linkedin_publish',description:'Publish a post to the LinkedIn company page.',inputSchema:obj({contentId:string},['contentId']),minLevel:'L2',integration:'linkedin',
   handler:()=>blocked('linkedin','publish_post')},
  {name:'microsoft_sendEmail',description:'Send an email via Microsoft 365.',inputSchema:obj({leadId:string,subject:string,body:string},['leadId','subject','body']),minLevel:'L2',integration:'microsoft365',
   handler:()=>blocked('microsoft365','send_email')},
  {name:'canva_generateAsset',description:'Generate a visual asset via Canva Connect.',inputSchema:obj({brief:string},['brief']),minLevel:'L1',integration:'canva',
   handler:()=>blocked('canva','generate_asset')},
  {name:'salla_syncOrders',description:'Pull new orders / abandoned carts from Salla.',inputSchema:obj({}),minLevel:'L1',integration:'salla_webhooks',
   handler:()=>blocked('salla_webhooks','sync_orders')}
 ];
 return {
  list:(level)=>tools.filter(tool=>!level||meetsLevel(tool.minLevel,level)),
  get:(name)=>tools.find(tool=>tool.name===name),
  all:tools
 };
}
function meetsLevel(min,level) {
 const order=['L0','L1','L2','L3'];
 return order.indexOf(level)>=order.indexOf(min);
}
