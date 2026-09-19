import {listProducts,currentMemory} from '../knowledge.js';
import {listLeads,listFollowups,leadDetail,getLead,createLead,updateLead,createFollowups,recordMessage,recordChannelMessage,maybeEscalateHotLead,searchLeads} from '../crm.js';
import {createContent} from '../domain.js';
import {getContent,getContentOrNull,insertContent,writeContent} from '../content.js';
import {resolveActiveTenantId} from '../tenancy.js';
import {recordAudit} from '../audit.js';
import {buildWeeklyReport,currentWeekStart} from '../reporting.js';
import {createApproval} from './approvals.js';
import {sendWhatsAppMessage,whatsappConfigured,sendWhatsAppCampaign} from './whatsapp.js';
import {publishToInstagram,publishToFacebook,alreadyPublished,sendMetaMessage} from './meta-publishing.js';
import {resolveMetaAccessToken} from './meta-oauth.js';
import {sendMail,findRecentSentMessage,createCalendarEvent,getCalendarAvailability} from './microsoft-graph.js';
import {resolveMicrosoftAccessToken} from './microsoft-oauth.js';
import {publishTweet} from './x-publishing.js';
import {resolveXAccessToken} from './x-oauth.js';
import {publishLinkedInPost} from './linkedin-publishing.js';
import {resolveLinkedInAccessToken} from './linkedin-oauth.js';
import {createEscalation} from './escalations.js';
import {isEnabled,featureDisabled} from './feature-flags.js';
import {getConnectionOrNull,listConnections} from '../integrations/connections.js';
import {executeConnectorAction} from '../connectors/core/runtime.js';
import {buildAgentConnectionMap} from './agent-connection-map.js';
import {getAssignment,upsertAssignment} from './tool-assignments.js';
import {searchContextItems} from './context-items.js';
import {sweepFollowupGaps} from './scheduler.js';
import {computeCompanyHealth} from './command-health.js';
import {recordConfigurationChange} from './configuration-history.js';
import {listJobs,cancelJobs} from '../planning.js';
import {createWorkflowDraft,listWorkflows,activateWorkflow,pauseWorkflow,startWorkflowRun,listWorkflowRuns,getRunWithSteps} from './workflow-engine.js';

export function integrationStatus(env,db=null) {
 // A Meta/WhatsApp OAuth connection (see runtime/meta-oauth.js) counts as configured too —
 // otherwise an agent that only needs whatsapp/meta would show WAITING_INTEGRATION forever
 // for anyone who connected via OAuth instead of the legacy static-token env vars.
 let metaConnected=false,microsoftConnected=false,xConnected=false,linkedinConnected=false;
 if(db){
  try{metaConnected=!!db.prepare('SELECT 1 FROM integration_credentials WHERE provider=?').get('meta');}catch{metaConnected=false;}
  try{microsoftConnected=!!db.prepare('SELECT 1 FROM integration_credentials WHERE provider=?').get('microsoft365');}catch{microsoftConnected=false;}
  try{xConnected=!!db.prepare('SELECT 1 FROM integration_credentials WHERE provider=?').get('x');}catch{xConnected=false;}
  try{linkedinConnected=!!db.prepare('SELECT 1 FROM integration_credentials WHERE provider=?').get('linkedin');}catch{linkedinConnected=false;}
 }
 return {
  whatsapp:{configured:!!env.WHATSAPP_ACCESS_TOKEN||metaConnected},
  meta:{configured:!!env.META_ACCESS_TOKEN||metaConnected},
  // X can only actually PUBLISH via the OAuth connection — the static X_BEARER_TOKEN is
  // app-only and read-only (see x-oauth.js), so it alone does not count as "configured" for
  // the publishing tool's purposes, only for read/metrics use.
  x:{configured:xConnected},
  linkedin:{configured:linkedinConnected||!!(env.LINKEDIN_ACCESS_TOKEN&&env.LINKEDIN_ORGANIZATION_ID)},
  microsoft365:{configured:!!env.MICROSOFT_ACCESS_TOKEN||microsoftConnected},
  canva:{configured:!!env.CANVA_API_KEY},
  salla_webhooks:{configured:!!env.SALLA_WEBHOOK_SECRET}
 };
}
// Which integration(s) gate this agent's external actions, for the team-page status line.
// Purely descriptive — the real gate is each tool's own `integration` field above.
export const AGENT_INTEGRATIONS={frost:[],strategy:[],copy:[],creative:['canva'],compliance:[],publishing:['meta','x','linkedin'],leads:[],sales:['whatsapp'],followup:['whatsapp','microsoft365'],intelligence:[],performance:[],memory:[],frost_commander:[]};
export function agentActor(agentId,nameAr) {
 return {id:'agent:'+agentId,name:nameAr?`وكيل ${nameAr}`:('وكيل '+agentId),role:'agent'};
}
const blocked=(integration,action)=>({status:'INTEGRATION_REQUIRED',integration,action_blocked:action,configuration_required:true});
const string={type:'string'};
const obj=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});

/**
 * ToolDefinition source of truth — Multi-Tenant Phase 4B (Part 3/4). Every REAL tool this
 * runtime executes gets exactly one metadata entry here, seeded verbatim into the
 * `tool_definitions` table (src/runtime/tool-definitions.js) at boot — never a hand-typed
 * second copy. `integrationSlug` matches an `integration_definitions.slug` from Phase 4A
 * where the tool genuinely calls that provider LIVE; a null slug means the tool has no
 * external dependency at all (pure internal read/write).
 *
 * `requiresConnection` is deliberately FALSE for get_products/get_current_price/get_stock
 * and whatsapp_send/meta_publish/x_publish/linkedin_publish/microsoft_sendEmail/
 * create_calendar_event/get_calendar_availability even though they depend on a real
 * provider: every one of those providers ALSO supports this codebase's long-standing static
 * env-token fallback (SALLA_ACCESS_TOKEN, WHATSAPP_ACCESS_TOKEN/META_ACCESS_TOKEN,
 * MICROSOFT_ACCESS_TOKEN, LINKEDIN_ACCESS_TOKEN+ORGANIZATION_ID) that never creates a formal
 * `integration_connections` row — marking these `requiresConnection:true` at the DB
 * enforcement level would incorrectly BLOCK every tenant still using a static token, a real
 * regression. `integrationSlug` is still set (for categorization, and so an EXPLICIT tool
 * assignment can still pin a specific connection and have it validated/provider-matched —
 * see tool-assignments.js's `resolveToolConnection`); the hard "is this actually configured"
 * decision stays exactly where it already correctly lives: inside each handler's own
 * resolve*AccessToken/whatsappConfigured check, which already accounts for both paths.
 * `salla_syncOrders`/`canva_generateAsset` are the one exception — real stubs with zero
 * actual provider call (always `blocked()`), so `requiresConnection:true` there is inert
 * (never actually reached) rather than misleading.
 */
const TOOL_METADATA={
 get_products:{description:'List all Salla-synced products with price/stock snapshot.',inputSchema:obj({}),minLevel:'L0',
  category:'Commerce',riskLevel:'LOW',actionType:'READ',integrationSlug:'salla',requiresConnection:false,isReadOnly:true,capability:'commerce.products.read'},
 get_product:{description:'Get one product by id.',inputSchema:obj({productId:string}),minLevel:'L0',
  category:'Commerce',riskLevel:'LOW',actionType:'READ',integrationSlug:'salla',requiresConnection:false,isReadOnly:true,capability:'commerce.products.read'},
 get_current_price:{description:'Get the last-synced price snapshot for a product, with source and sync time.',inputSchema:obj({productId:string}),minLevel:'L0',
  category:'Commerce',riskLevel:'LOW',actionType:'READ',integrationSlug:'salla',requiresConnection:false,isReadOnly:true,capability:'commerce.price.read'},
 get_stock:{description:'Get the last-synced stock snapshot for a product.',inputSchema:obj({productId:string}),minLevel:'L0',
  category:'Commerce',riskLevel:'LOW',actionType:'READ',integrationSlug:'salla',requiresConnection:false,isReadOnly:true,capability:'commerce.stock.read'},
 search_crm:{description:'Search existing CRM leads by name, company, phone, email or product need.',inputSchema:obj({query:string}),minLevel:'L0',
  category:'CRM',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'crm.read'},
 get_lead:{description:'Get full lead detail including messages and follow-ups.',inputSchema:obj({leadId:string}),minLevel:'L0',
  category:'CRM',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'crm.read'},
 get_conversation:{description:'Get the recorded message history for a lead.',inputSchema:obj({leadId:string}),minLevel:'L0',
  category:'CRM',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'crm.read'},
 search_brand_memory:{description:'Search approved brand memory (voice, product facts, claims, policies, competitor insights).',inputSchema:obj({kind:string},[]),minLevel:'L0',
  category:'Memory',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'memory.read'},
 get_competitor_data:{description:'Read approved competitor/trend insights from brand memory.',inputSchema:obj({}),minLevel:'L0',
  category:'Memory',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'memory.read'},
 get_metrics:{description:'Get the current live weekly operations report (internal metrics only).',inputSchema:obj({}),minLevel:'L0',
  category:'Analytics',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'analytics.read'},
 create_lead:{description:'Create a new CRM lead record.',inputSchema:obj({name:string,customerType:string,sourceType:string},['name','customerType','sourceType']),minLevel:'L0',
  category:'CRM',riskLevel:'LOW',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'crm.write'},
 update_lead:{description:'Update an existing lead qualification/stage.',inputSchema:obj({leadId:string,stage:string,expectedVersion:{type:'integer'}},['leadId']),minLevel:'L0',
  category:'CRM',riskLevel:'MEDIUM',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'crm.write'},
 save_message:{description:'Record an inbound conversation message against a lead.',inputSchema:obj({leadId:string,channel:string,text:string,intent:string,eventKey:string},['leadId','channel','text','intent','eventKey']),minLevel:'L0',
  category:'CRM',riskLevel:'LOW',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'crm.write'},
 create_followup:{description:'Draft a follow-up sequence for a lead (drafts only; still requires human approval to send).',inputSchema:obj({leadId:string,sequence:string,channel:string,startAt:string,evidence:string,requestKey:string},['leadId','sequence','channel','startAt','evidence','requestKey']),minLevel:'L0',
  category:'CRM',riskLevel:'LOW',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'crm.write'},
 create_content:{description:'Create a new content draft (still requires human compliance review and owner approval before it can be scheduled).',inputSchema:obj({title:string,body:string,platform:string,date:string,url:string},['title','body','platform','date','url']),minLevel:'L0',
  category:'Content',riskLevel:'LOW',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'content.write'},
 propose_memory_update:{description:'Propose a brand memory change for human approval — never writes memory directly.',inputSchema:obj({type:string,key:string,newValue:string,evidence:string,confidence:{type:'number'}},['type','key','newValue']),minLevel:'L0',
  category:'Memory',riskLevel:'LOW',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'memory.propose'},
 // Requires approval below L2 (Part 70/71): usable starting L1, but L1 always produces
 // WAITING_APPROVAL instead of sending — only L2+ sends immediately. Matches the same
 // supervised-then-autonomous ladder the three publish tools already sit at (L2).
 whatsapp_send:{description:'Send a WhatsApp message to a customer. Free text only within 24h of their last message; a templateName is required outside that window.',inputSchema:obj({leadId:string,text:string,templateName:string,templateLanguage:string},['leadId']),minLevel:'L1',requiresApprovalBelowLevel:'L2',
  category:'Messaging',riskLevel:'MEDIUM',actionType:'EXTERNAL_SEND',integrationSlug:'whatsapp',requiresConnection:false,isReadOnly:false,capability:'messaging.send'},
 // Campaign blast — deliberately bounded (max 50 recipients, see runtime/whatsapp.js's
 // CAMPAIGN_AUDIENCE_CAP) rather than a real bulk/queue engine, matching this codebase's
 // existing aversion to inventing infrastructure it doesn't need yet (see
 // prepare_bulk_followup_plan above for the same discipline applied to follow-ups). dryRun
 // previews per-recipient eligibility with zero sends, exactly like a real preview must.
 whatsapp_campaign_send:{description:'Send a WhatsApp message to a bounded list of leads (max 50) as a campaign blast — either an explicit leadIds array or a CRM stageFilter. dryRun previews resolved audience eligibility without sending anything.',
  inputSchema:obj({campaignId:string,leadIds:{type:'array',items:string,maxItems:50},stageFilter:string,text:string,templateName:string,templateLanguage:string,dryRun:{type:'boolean'}},[]),minLevel:'L1',requiresApprovalBelowLevel:'L2',
  category:'Messaging',riskLevel:'MEDIUM',actionType:'EXTERNAL_SEND',integrationSlug:'whatsapp',requiresConnection:false,isReadOnly:false,capability:'messaging.campaign_send'},
 // Phase MKT-2, Part I/J — real Facebook Messenger/Instagram DM reply, gated exactly like
 // whatsapp_send (L1 usable, requires approval below L2) since it is the same class of
 // action: an outbound message to a real customer on a real channel.
 meta_message_send:{description:'Reply to a customer on Facebook Messenger or Instagram DM. leadId must have a real externalContactId captured from an inbound message on that channel.',inputSchema:obj({leadId:string,text:string},['leadId','text']),minLevel:'L1',requiresApprovalBelowLevel:'L2',
  category:'Messaging',riskLevel:'MEDIUM',actionType:'EXTERNAL_SEND',integrationSlug:'meta',requiresConnection:false,isReadOnly:false,capability:'messaging.send'},
 meta_publish:{description:'Publish an approved content item to Instagram or Facebook (platform decided by the content item itself). Refuses anything not APPROVED, already published, or missing a required asset.',inputSchema:obj({contentId:string},['contentId']),minLevel:'L2',allowedAgents:['publishing'],
  category:'Social',riskLevel:'HIGH',actionType:'EXTERNAL_PUBLISH',integrationSlug:'meta',requiresConnection:false,isReadOnly:false,capability:'publishing'},
 x_publish:{description:'Publish an approved content item to X. Refuses anything not APPROVED, already published, or unsupported for this platform.',inputSchema:obj({contentId:string},['contentId']),minLevel:'L2',allowedAgents:['publishing'],
  category:'Social',riskLevel:'HIGH',actionType:'EXTERNAL_PUBLISH',integrationSlug:'x',requiresConnection:false,isReadOnly:false,capability:'publish'},
 linkedin_publish:{description:'Publish an approved content item to the connected LinkedIn Company Page (never a personal profile). Refuses anything not APPROVED, already published, or without a resolved organization.',inputSchema:obj({contentId:string},['contentId']),minLevel:'L2',allowedAgents:['publishing'],
  category:'Social',riskLevel:'HIGH',actionType:'EXTERNAL_PUBLISH',integrationSlug:'linkedin',requiresConnection:false,isReadOnly:false,capability:'organization.publish'},
 microsoft_sendEmail:{description:'Send an email via Microsoft 365. category in [quote,discount,large_b2b,legal,general] — the first four always require owner approval before sending.',inputSchema:obj({leadId:string,subject:string,bodyHtml:string,category:string,cc:{type:'array',items:string}},['leadId','subject','bodyHtml']),minLevel:'L1',
  category:'Email',riskLevel:'MEDIUM',actionType:'EXTERNAL_SEND',integrationSlug:'microsoft365',requiresConnection:false,isReadOnly:false,capability:'mail.send'},
 search_email_conversation:{description:'Search this lead\'s email history by keyword.',inputSchema:obj({leadId:string,query:string},['leadId']),minLevel:'L0',
  category:'Email',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'crm.read'},
 get_email_thread:{description:'Get all messages in one email thread (by externalThreadId) for a lead.',inputSchema:obj({leadId:string,externalThreadId:string},['leadId','externalThreadId']),minLevel:'L0',
  category:'Email',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'crm.read'},
 get_recent_replies:{description:'Get the most recent inbound messages (any channel) for a lead, to check whether they replied since a given point.',inputSchema:obj({leadId:string,sinceIso:string},['leadId']),minLevel:'L0',
  category:'CRM',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'crm.read'},
 create_calendar_event:{description:'Create a Microsoft 365 calendar event (call, demo, follow-up meeting). Asia/Riyadh timezone unless specified.',inputSchema:obj({title:string,start:string,end:string,timezone:string,participants:{type:'array',items:string},location:string,notes:string},['title','start','end']),minLevel:'L1',allowedAgents:['frost','sales','followup'],
  category:'Calendar',riskLevel:'MEDIUM',actionType:'EXTERNAL_SEND',integrationSlug:'microsoft365',requiresConnection:false,isReadOnly:false,capability:'calendar.write'},
 get_calendar_availability:{description:'Check free/busy for one or more Microsoft 365 mailboxes to propose a meeting time.',inputSchema:obj({emails:{type:'array',items:string},start:string,end:string,timezone:string},['emails','start','end']),minLevel:'L0',allowedAgents:['frost','sales','followup'],
  category:'Calendar',riskLevel:'LOW',actionType:'READ',integrationSlug:'microsoft365',requiresConnection:false,isReadOnly:true,capability:'calendar.read'},
 canva_generateAsset:{description:'Generate a visual asset via Canva Connect.',inputSchema:obj({brief:string},['brief']),minLevel:'L1',
  category:'Content',riskLevel:'LOW',actionType:'EXTERNAL_SEND',integrationSlug:'canva',requiresConnection:true,isReadOnly:false,capability:'design.generate',isAvailable:false},
 salla_syncOrders:{description:'Pull new orders / abandoned carts from Salla.',inputSchema:obj({}),minLevel:'L1',
  category:'Commerce',riskLevel:'LOW',actionType:'READ',integrationSlug:'salla',requiresConnection:true,isReadOnly:true,capability:'orders.read',isAvailable:false},
 // Universal Integration Platform (Phase 6D, Part 59) — the real proof that a Tool can be
 // GENERIC (no fixed `integrationSlug`, resolved purely by capability — see
 // tool-assignments.js's resolveGenericCapabilityTool) and still discover ANY compatible
 // connection automatically, built-in or Builder-published alike, with zero per-connector
 // branch anywhere in this file or the Agent Runtime.
 get_invoices:{description:'List invoices from whichever accounting system this tenant has connected.',inputSchema:obj({}),minLevel:'L0',
  category:'Accounting',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:true,isReadOnly:true,capability:'accounting.invoices.read'},
 // Phase 6E — the SAME generic, capability-only pattern get_invoices already proved in Phase
 // 6D, now with a real second provider (Zid) behind it: whichever connected commerce platform
 // grants `commerce.orders.read`/`commerce.customers.read` is auto-discovered, never a
 // hardcoded `integrationSlug`.
 get_orders:{description:'List orders from whichever commerce platform this tenant has connected.',inputSchema:obj({page:{type:'number'},perPage:{type:'number'}},[]),minLevel:'L0',
  category:'Commerce',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:true,isReadOnly:true,capability:'commerce.orders.read'},
 get_customers:{description:'List customers from whichever commerce platform this tenant has connected.',inputSchema:obj({page:{type:'number'},perPage:{type:'number'}},[]),minLevel:'L0',
  category:'Commerce',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:true,isReadOnly:true,capability:'commerce.customers.read'},

 // --- Frost Command Center (Phase 7A) — internal read/aggregate tools with zero external
 // dependency (integrationSlug:null, requiresConnection:false), reusing existing list/read
 // functions verbatim rather than a second data-access layer. `allowedAgents` deliberately
 // omitted (like get_metrics/search_crm above) so any future agent could use them too, not
 // just frost_commander — there is nothing commander-specific about reading real state.
 get_company_health:{description:'Aggregate real operational health: pending approvals, open escalations/tasks, connection health, and a basic weekly snapshot.',inputSchema:obj({}),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.health.read'},
 get_followups_needing_attention:{description:'List real overdue follow-ups (draft, past due date) and hot leads in a follow-up-eligible stage with no active sequence.',inputSchema:obj({}),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.crm.followups.read'},
 get_integrations_health:{description:'List every real integration connection for this tenant with its current status.',inputSchema:obj({}),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.integrations.read'},
 get_agent_tool_status:{description:'Real Agent -> Tool -> Capability -> Connection map for this tenant (the same data behind the Control Center Agent Map).',inputSchema:obj({}),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.agents.read'},
 search_context:{description:'Search manually-recorded company context/Company Brain items (facts, decisions, rules the team recorded) by free-text query and/or type.',inputSchema:obj({query:string,type:string},[]),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.context.read'},
 // Configuration/automation actions: usable starting L1, but requiresApprovalBelowLevel:'L2'
 // means L1 (frost_commander's likely level for a while, per the same one-step-at-a-time
 // promotion ladder every other agent follows) always pauses for a real human approval before
 // ever reaching the handler — identical mechanism to whatsapp_send above, not a new gate.
 update_agent_tool_connection:{description:'Change which real connection a specific tool is pinned to for a specific agent. Always requires human approval.',inputSchema:obj({targetAgentId:string,toolSlug:string,connectionId:string},['targetAgentId','toolSlug','connectionId']),minLevel:'L1',requiresApprovalBelowLevel:'L2',
  category:'Command',riskLevel:'MEDIUM',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'command.config.write'},
 run_followup_sweep:{description:'Run the existing automated follow-up gap sweep now (finds leads needing a follow-up and lets the real Follow-up agent decide what to do — never sends anything itself). Always requires human approval.',inputSchema:obj({}),minLevel:'L1',requiresApprovalBelowLevel:'L2',
  category:'Command',riskLevel:'MEDIUM',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'command.automation.followup_sweep'},

 // --- Frost Command Center Phase 7B — Multi-Agent Delegation (spec Part 6-11). One generic
 // delegation tool rather than one bespoke tool per target agent: the allowlist below is the
 // real gate (an unknown/unlisted agent id is refused in the handler), and the delegated run
 // goes through the exact same `agentRuntime.run()` as every other run — the target agent's OWN
 // permission level/approval gates are never bypassed (Frost cannot elevate another agent,
 // spec item 52), only invoked.
 // Phase 7C (spec item 81 — MAX_AGENT_DELEGATION_DEPTH): `allowedAgents` restricts this tool to
 // frost_commander ONLY — none of the four delegate targets ever receive this tool themselves
 // (they have no `delegate_to_agent` in their own tool list), so a delegation chain is
 // STRUCTURALLY capped at depth 1. This is stronger than a numeric counter: recursive
 // delegation is not just discouraged, it is architecturally impossible.
 delegate_to_agent:{description:'Delegate one objective to an existing specialist agent (performance, intelligence, leads, or strategy) and get back its real, structured result. Call this multiple times in the SAME reply when the analyses are independent (they will run in parallel); call it again in a LATER reply only when one result must inform the next request (sequential dependency).',
  inputSchema:obj({agent:{type:'string',enum:['performance','intelligence','leads','strategy']},objective:string},['agent','objective']),minLevel:'L0',allowedAgents:['frost_commander'],
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.delegate.agent'},

 // --- Frost Command Center Phase 7B — honest integration with the automation that actually
 // exists (spec Part 2-5): after auditing the codebase, no generic multi-step Workflow engine
 // exists anywhere (no workflow_definitions/workflow_runs/builder UI — see Phase 7B report Part
 // A/B). The two REAL, existing, safely-controllable automation surfaces are the Content
 // Calendar's scheduled publish jobs (planning.js) and the follow-up sweep (already wired
 // above) — Frost gets real read/stop access to the former here, never a fabricated generic
 // "create a workflow" capability.
 list_scheduled_content_jobs:{description:'List real Content Calendar scheduled/failed publish jobs for this tenant (the closest real thing to a "workflow run list" that exists in this system).',inputSchema:obj({}),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.jobs.read'},
 cancel_scheduled_content_job:{description:'Cancel the real pending scheduled publish job(s) for one content item. Always requires human approval.',inputSchema:obj({contentId:string},['contentId']),minLevel:'L1',requiresApprovalBelowLevel:'L2',
  category:'Command',riskLevel:'MEDIUM',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'command.jobs.cancel'},
 explain_followup_status:{description:'Explain why a specific lead\'s follow-up sequence is in its current state (e.g. on hold, and why) from the real crm_followups record — never a guess.',inputSchema:obj({leadId:string},['leadId']),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.followups.explain'},

 // --- Frost Command Center Phase 7B — Safe Bulk Preview (spec Part 33-35). A PREVIEW only —
 // no message is ever sent from this tool. The actual send still only ever happens through
 // run_followup_sweep above (already approval-gated, already per-lead-safe via the real
 // Follow-up agent) — this just shows the real target count/channel/connection BEFORE anyone
 // decides whether to run that.
 prepare_bulk_followup_plan:{description:'Preview (never sends) a bulk follow-up plan: real target count, channel, and connection for the tenant\'s overdue follow-ups.',inputSchema:obj({}),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.bulk.preview'},

 // --- Frost Command Center Phase 7C — Native Workflow Engine chat integration (spec Part
 // 26-35). Frost never activates or runs a workflow silently: create_workflow_draft is L0/
 // no-approval because it only ever produces an unpublished DRAFT (spec item 27); activating
 // or manually running an already-created workflow are real automations and go through the
 // exact same approval gate every other automation-trigger tool already uses.
 create_workflow_draft:{description:'Create a new Workflow as a DRAFT from a structured plan (trigger + steps) — never activates it. The human must review and explicitly activate it afterward.',
  inputSchema:obj({nameAr:string,description:string,trigger:{type:'object'},steps:{type:'array',items:{type:'object'}}},['nameAr','trigger','steps']),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'command.workflow.draft'},
 list_workflows:{description:'List real workflows for this tenant with their status (DRAFT/ACTIVE/PAUSED/ARCHIVED).',inputSchema:obj({status:string},[]),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.workflow.read'},
 explain_workflow_failure:{description:'Inspect a workflow\'s most recent run (or a specific run id) and explain exactly which step failed, the real error, and which agent/tool/connection was involved.',
  inputSchema:obj({workflowId:string,runId:string},[]),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'READ',integrationSlug:null,requiresConnection:false,isReadOnly:true,capability:'command.workflow.read'},
 activate_workflow:{description:'Activate a DRAFT workflow (after real readiness checks pass). Always requires human approval.',inputSchema:obj({workflowId:string},['workflowId']),minLevel:'L1',requiresApprovalBelowLevel:'L2',
  category:'Command',riskLevel:'MEDIUM',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'command.workflow.activate'},
 run_workflow_now:{description:'Manually trigger an ACTIVE workflow right now. Always requires human approval.',inputSchema:obj({workflowId:string},['workflowId']),minLevel:'L1',requiresApprovalBelowLevel:'L2',
  category:'Command',riskLevel:'MEDIUM',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'command.workflow.run'},
 pause_workflow_now:{description:'Pause an ACTIVE workflow (stops future manual/schedule/event runs; never affects a run already in progress).',inputSchema:obj({workflowId:string},['workflowId']),minLevel:'L0',
  category:'Command',riskLevel:'LOW',actionType:'INTERNAL_WRITE',integrationSlug:null,requiresConnection:false,isReadOnly:false,capability:'command.workflow.pause'}
};
/** Static metadata only — no store/env/handler required. Used to seed `tool_definitions` at boot (src/runtime/tool-definitions.js) and by anything else that needs the catalog without a live registry instance. */
export function listToolMetadata() {
 return Object.entries(TOOL_METADATA).map(([name,meta])=>({name,allowedAgents:null,requiresApprovalBelowLevel:null,isAvailable:true,...meta}));
}

// WhatsApp's real policy: free-form text replies are only allowed within 24 hours of the
// customer's last inbound message; outside that window, only a pre-approved template may
// be sent. This is Meta's own rule (not a HyperCool invention), enforced here in the
// backend rather than assumed — see Part P of the WhatsApp integration spec.
function withinCustomerServiceWindow(lead) {
 return !!lead.lastInboundAt && Date.now()-Date.parse(lead.lastInboundAt)<=86400000;
}
export function buildToolRegistry({store,env,eventBus,fetcher=fetch,runtimeRef=null}) {
 const db=store.db;
 // Shared by every publish tool (meta_publish/x_publish/linkedin_publish) so the
 // content-item bookkeeping, schedule_jobs status, audit trail and event emission are
 // identical regardless of platform (spec Part A: "Content Agent must not know per-platform
 // detail" — this is that same principle applied to the OUTCOME side, not just the request
 // side). A job is only ever touched if one is currently READY_FOR_CONNECTOR for this
 // content — a manual/ad-hoc publish with no active schedule job leaves scheduling alone.
 function finalizePublishResult(contentId,platform,result,ctx) {
  const jobRow=db.prepare("SELECT id,json FROM schedule_jobs WHERE tenant_id=? AND content_id=? AND status='READY_FOR_CONNECTOR'").get(ctx.tenantId||resolveActiveTenantId(db),contentId);
  const now=new Date().toISOString();
  if(result.status==='PUBLISHED') {
   store.mutate(()=>{
    const target=getContent(db,contentId,ctx.tenantId);
    target.status='PUBLISHED';target.externalPostId=result.externalPostId;target.liveUrl=result.liveUrl||null;target.publishedAt=now;
    writeContent(db,target);
    recordAudit(db,{id:crypto.randomUUID(),action:'CONTENT_PUBLISHED',itemId:contentId,actorId:ctx.actor.id,actorName:ctx.actor.name,actorRole:ctx.actor.role,at:now},ctx.tenantId);
   });
   if(jobRow){const job=JSON.parse(jobRow.json);job.status='PUBLISHED';job.publishedAt=now;job.externalPostId=result.externalPostId;job.liveUrl=result.liveUrl||null;db.prepare('UPDATE schedule_jobs SET status=?,json=? WHERE id=?').run('PUBLISHED',JSON.stringify(job),jobRow.id);}
   if(eventBus)eventBus.emit('CONTENT_PUBLISHED',{contentId,platform,externalPostId:result.externalPostId,tenantId:ctx.tenantId});
  } else if(result.status==='STATUS_UNKNOWN') {
   // A timeout/network failure with no confirmed outcome — never assumed to be a failure
   // (which would invite a blind retry and a possible duplicate post) nor a success. Left
   // for human reconciliation via a real P2 escalation (spec Part Q/AP) instead of a
   // fabricated automatic retry loop.
   recordAudit(db,{id:crypto.randomUUID(),action:platform.toUpperCase()+'_PUBLISH_STATUS_UNKNOWN',itemId:contentId,errorCode:result.errorCode||null,actorId:ctx.actor.id,actorName:ctx.actor.name,actorRole:ctx.actor.role,at:now},ctx.tenantId);
   if(jobRow){const job=JSON.parse(jobRow.json);job.status='STATUS_UNKNOWN';job.blockReason=result.errorCode||'STATUS_UNKNOWN';db.prepare('UPDATE schedule_jobs SET status=?,json=? WHERE id=?').run('STATUS_UNKNOWN',JSON.stringify(job),jobRow.id);}
   createEscalation(db,{runId:ctx.runId,agentId:ctx.agentId,priority:'P2',reason:`نتيجة نشر ${platform} غير معروفة بعد خطأ اتصال — يحتاج تحققًا يدويًا قبل أي إعادة محاولة`,context:{contentId,platform,errorCode:result.errorCode||null},tenantId:ctx.tenantId});
  } else if(result.status==='FAILED') {
   recordAudit(db,{id:crypto.randomUUID(),action:platform.toUpperCase()+'_PUBLISH_FAILED',itemId:contentId,errorCode:result.errorCode||null,actorId:ctx.actor.id,actorName:ctx.actor.name,actorRole:ctx.actor.role,at:now},ctx.tenantId);
   if(jobRow){const job=JSON.parse(jobRow.json);job.status='FAILED';job.blockReason=result.errorCode||'FAILED';db.prepare('UPDATE schedule_jobs SET status=?,json=? WHERE id=?').run('FAILED',JSON.stringify(job),jobRow.id);}
  }
  return result;
 }
 // Off by default; only ever affects X/LinkedIn publish tools (spec Part AX). Never touches
 // the network, never marks content PUBLISHED — used to rehearse the full validation/
 // approval/scheduling path (including a real agent run) without ever creating a real post.
 function testModeEnabled() { return env.SOCIAL_PUBLISHING_TEST_MODE==='true'; }
 const HANDLERS={
  // Phase 6D, Part 60 — the generic tool's handler doesn't know the provider in advance
  // (resolveGenericCapabilityTool picked whichever connection actually matched); it looks up
  // THIS connection's real connector slug, then executes through the exact same
  // ConnectorRuntime pipeline (tenant/capability/health/approval/audit) every other connector
  // action already goes through — no special-casing for any specific connector here.
  get_invoices:async(input,ctx)=>{
   if(!ctx.connectionId)return {status:'INTEGRATION_REQUIRED'};
   const connection=getConnectionOrNull(db,ctx.connectionId,ctx.tenantId);
   if(!connection)return {status:'INTEGRATION_REQUIRED'};
   const result=await executeConnectorAction({db,env,fetcher,tenantId:ctx.tenantId,connectorSlug:connection.integrationDefinitionId,connectionId:connection.id,actionId:'get_invoices',input:{},actor:ctx.actor});
   return result.status==='OK'?result.output:result;
  },
  get_orders:async(input,ctx)=>{
   if(!ctx.connectionId)return {status:'INTEGRATION_REQUIRED'};
   const connection=getConnectionOrNull(db,ctx.connectionId,ctx.tenantId);
   if(!connection)return {status:'INTEGRATION_REQUIRED'};
   const result=await executeConnectorAction({db,env,fetcher,tenantId:ctx.tenantId,connectorSlug:connection.integrationDefinitionId,connectionId:connection.id,actionId:'get_orders',input:{page:input?.page,perPage:input?.perPage},actor:ctx.actor});
   return result.status==='OK'?result.output:result;
  },
  get_customers:async(input,ctx)=>{
   if(!ctx.connectionId)return {status:'INTEGRATION_REQUIRED'};
   const connection=getConnectionOrNull(db,ctx.connectionId,ctx.tenantId);
   if(!connection)return {status:'INTEGRATION_REQUIRED'};
   const result=await executeConnectorAction({db,env,fetcher,tenantId:ctx.tenantId,connectorSlug:connection.integrationDefinitionId,connectionId:connection.id,actionId:'get_customers',input:{page:input?.page,perPage:input?.perPage},actor:ctx.actor});
   return result.status==='OK'?result.output:result;
  },
  get_products:(input,ctx)=>listProducts(db,ctx.tenantId),
  get_product:({productId},ctx)=>listProducts(db,ctx.tenantId).find(p=>p.id===productId)||{status:'NO_DATA'},
  get_current_price:({productId},ctx)=>{const p=listProducts(db,ctx.tenantId).find(x=>x.id===productId);return p?{price:p.price,syncedAt:p.syncedAt,source:p.price?.source||null}:{status:'NO_DATA'};},
  get_stock:({productId},ctx)=>{const p=listProducts(db,ctx.tenantId).find(x=>x.id===productId);return p?{stock:p.stock,available:p.available,syncedAt:p.syncedAt}:{status:'NO_DATA'};},
  search_crm:({query},ctx)=>searchLeads(db,query,20,ctx.tenantId),
  get_lead:({leadId},ctx)=>{try{return leadDetail(db,leadId,ctx.tenantId);}catch{return {status:'NO_DATA'};}},
  get_conversation:({leadId},ctx)=>{try{return leadDetail(db,leadId,ctx.tenantId).messages;}catch{return {status:'NO_DATA'};}},
  search_brand_memory:({kind}={},ctx)=>currentMemory(db,ctx.tenantId).filter(entry=>!kind||entry.kind===kind),
  get_competitor_data:(input,ctx)=>currentMemory(db,ctx.tenantId).filter(entry=>entry.kind==='competitor_insight'),
  get_metrics:(input,ctx)=>buildWeeklyReport(store,currentWeekStart(),ctx.tenantId),

  // --- draft/propose tools: create pending, human-reviewable records. Allowed from L0 because
  // nothing here is an external action — it mirrors what an operator can already do by hand.
  create_lead:(input,ctx)=>createLead(store,input,ctx.actor,ctx.tenantId),
  update_lead:({leadId,...input},ctx)=>{
   const before=getLead(db,leadId,ctx.tenantId);
   const updated=updateLead(store,leadId,input,ctx.actor,ctx.tenantId);
   maybeEscalateHotLead(store,eventBus,before,updated,{agentId:ctx.agentId,runId:ctx.runId,tenantId:ctx.tenantId});
   return updated;
  },
  save_message:({leadId,...input},ctx)=>recordMessage(store,leadId,input,ctx.actor,ctx.tenantId),
  create_followup:({leadId,...input},ctx)=>createFollowups(store,leadId,input,ctx.actor,ctx.tenantId),
  create_content:(input,ctx)=>{const item={...createContent(input),createdBy:ctx.actor.id,origin:'AI'};insertContent(db,item,ctx.tenantId);recordAudit(db,{id:crypto.randomUUID(),action:'DRAFT_CREATED',itemId:item.id,actorId:ctx.actor.id,actorName:ctx.actor.name,actorRole:ctx.actor.role,at:new Date().toISOString()},ctx.tenantId);return item;},
  propose_memory_update:(input,ctx)=>createApproval(db,{runId:ctx.runId,agentId:ctx.agentId,actionType:'memory_policy_change',proposedOutput:input,riskLevel:'MEDIUM',reason:'Agent-proposed memory update requires human approval before it becomes fact.',tenantId:ctx.tenantId}),

  // --- external actions: always integration-gated. Real credentials flip these on later
  // without any agent code changing — only connectionStatus() and these handlers.
  // Names use underscores, not dots: Anthropic tool names must match ^[a-zA-Z0-9_-]{1,128}$.
  whatsapp_send:async({leadId,text,templateName,templateLanguage},ctx)=>{
   if(!isEnabled(env,'ENABLE_EXTERNAL_MESSAGING'))return featureDisabled('ENABLE_EXTERNAL_MESSAGING');
   if(!whatsappConfigured({store,env},ctx.tenantId))return blocked('whatsapp','send_message');
   const lead=getLead(db,leadId,ctx.tenantId);
   if(lead.optOut)return {status:'BLOCKED',reason:'OPT_OUT'};
   if(lead.humanHold)return {status:'BLOCKED',reason:'HUMAN_HOLD'};
   if(!lead.phone)return {status:'BLOCKED',reason:'NO_PHONE'};
   if(!templateName && !withinCustomerServiceWindow(lead))return {status:'BLOCKED',reason:'TEMPLATE_REQUIRED_OUTSIDE_WINDOW'};
   const result=await sendWhatsAppMessage({store,env,fetcher},{to:lead.phone,text,templateName,templateLanguage},ctx.tenantId);
   if(result.status==='SENT'){
    recordChannelMessage(store,{leadId,channel:'WhatsApp',direction:'OUTBOUND',text:text||`[template:${templateName}]`,externalMessageId:result.externalMessageId,messageType:templateName?'template':'text'},ctx.actor,ctx.tenantId);
   }
   return result;
  },
  whatsapp_campaign_send:async(input,ctx)=>{
   if(!isEnabled(env,'ENABLE_EXTERNAL_MESSAGING'))return featureDisabled('ENABLE_EXTERNAL_MESSAGING');
   return sendWhatsAppCampaign({store,env,fetcher},input,ctx.actor,ctx.tenantId);
  },
  // Phase MKT-2, Part I/J — real Messenger/Instagram reply. Requires a real externalContactId
  // captured off a genuine inbound webhook (see crm.js's findOrCreateLeadFromChannel) — there
  // is no other way to obtain a PSID/IGSID, so a lead with none can never have been messaged
  // through this channel and is correctly refused rather than guessing an id.
  meta_message_send:async({leadId,text},ctx)=>{
   if(!isEnabled(env,'ENABLE_EXTERNAL_MESSAGING'))return featureDisabled('ENABLE_EXTERNAL_MESSAGING');
   const lead=getLead(db,leadId,ctx.tenantId);
   if(lead.optOut)return {status:'BLOCKED',reason:'OPT_OUT'};
   if(lead.humanHold)return {status:'BLOCKED',reason:'HUMAN_HOLD'};
   if(!lead.externalContactId||!['Instagram','Facebook'].includes(lead.channelOrigin))return {status:'BLOCKED',reason:'NO_EXTERNAL_CONTACT_ID'};
   const resolved=resolveMetaAccessToken({store,env},'page',ctx.tenantId);
   if(!resolved)return blocked('meta','send_message');
   const result=await sendMetaMessage({store,env,fetcher},{recipientId:lead.externalContactId,text},ctx.tenantId);
   if(result.status==='SENT'){
    recordChannelMessage(store,{leadId,channel:lead.channelOrigin,direction:'OUTBOUND',text,externalMessageId:result.externalMessageId,messageType:'text'},ctx.actor,ctx.tenantId);
   }
   return result;
  },
  // All three publish tools are restricted to the Publishing & Scheduling agent
  // (allowedAgents) — spec Part L/M: only that agent's flow verifies approval/compliance/
  // schedule/idempotency before ever reaching here, so no other agent (even at L2+) should
  // be able to trigger a real post as a side effect of unrelated reasoning.
  meta_publish:async({contentId},ctx)=>{
   if(!isEnabled(env,'ENABLE_EXTERNAL_PUBLISHING'))return featureDisabled('ENABLE_EXTERNAL_PUBLISHING');
   const resolved=resolveMetaAccessToken({store,env},'page',ctx.tenantId);
   if(!resolved)return blocked('meta','publish_post');
   const item=getContentOrNull(db,contentId,ctx.tenantId);
   if(!item)return {status:'ERROR',error:'CONTENT_NOT_FOUND'};
   if(item.status!=='APPROVED')return {status:'BLOCKED',reason:'NOT_APPROVED'};
   if(alreadyPublished(item))return {status:'OK',reason:'ALREADY_PUBLISHED',externalPostId:item.externalPostId,liveUrl:item.liveUrl};
   if(!['Instagram','Facebook'].includes(item.platform))return {status:'BLOCKED',reason:'UNSUPPORTED_PLATFORM'};
   if(item.platform==='Instagram' && !item.assetUrl)return {status:'BLOCKED',reason:'ASSET_REQUIRED'};
   const result=item.platform==='Instagram'
    ?await publishToInstagram({store,env,fetcher},{imageUrl:item.assetUrl,caption:item.body},ctx.tenantId)
    :await publishToFacebook({store,env,fetcher},{message:item.body,link:item.url},ctx.tenantId);
   return finalizePublishResult(contentId,item.platform,result,ctx);
  },
  x_publish:async({contentId},ctx)=>{
   if(!isEnabled(env,'ENABLE_EXTERNAL_PUBLISHING'))return featureDisabled('ENABLE_EXTERNAL_PUBLISHING');
   const item=getContentOrNull(db,contentId,ctx.tenantId);
   if(!item)return {status:'ERROR',error:'CONTENT_NOT_FOUND'};
   if(item.status!=='APPROVED')return {status:'BLOCKED',reason:'NOT_APPROVED'};
   if(alreadyPublished(item))return {status:'OK',reason:'ALREADY_PUBLISHED',externalPostId:item.externalPostId,liveUrl:item.liveUrl};
   if(item.platform!=='X')return {status:'BLOCKED',reason:'UNSUPPORTED_PLATFORM'};
   if(testModeEnabled())return {status:'OK',testMode:true,would_publish:true,platform:'X',payload:{text:item.body},approval_required:false};
   const resolved=await resolveXAccessToken({store,env,fetcher},'publish',ctx.tenantId);
   if(!resolved)return blocked('x','publish_post');
   const result=await publishTweet({store,env,fetcher},{text:item.body},ctx.tenantId);
   return finalizePublishResult(contentId,'X',result,ctx);
  },
  linkedin_publish:async({contentId},ctx)=>{
   if(!isEnabled(env,'ENABLE_EXTERNAL_PUBLISHING'))return featureDisabled('ENABLE_EXTERNAL_PUBLISHING');
   const item=getContentOrNull(db,contentId,ctx.tenantId);
   if(!item)return {status:'ERROR',error:'CONTENT_NOT_FOUND'};
   if(item.status!=='APPROVED')return {status:'BLOCKED',reason:'NOT_APPROVED'};
   if(alreadyPublished(item))return {status:'OK',reason:'ALREADY_PUBLISHED',externalPostId:item.externalPostId,liveUrl:item.liveUrl};
   if(item.platform!=='LinkedIn')return {status:'BLOCKED',reason:'UNSUPPORTED_PLATFORM'};
   if(!item.englishCopy?.trim())return {status:'BLOCKED',reason:'ENGLISH_COPY_REQUIRED'};
   if(testModeEnabled())return {status:'OK',testMode:true,would_publish:true,platform:'LinkedIn',payload:{text:item.englishCopy,link:item.url},approval_required:false};
   const resolved=await resolveLinkedInAccessToken({store,env,fetcher},ctx.tenantId);
   if(!resolved||!resolved.organizationId)return blocked('linkedin','publish_post');
   const result=await publishLinkedInPost({store,env,fetcher},{text:item.englishCopy,link:item.url},ctx.tenantId);
   return finalizePublishResult(contentId,'LinkedIn',result,ctx);
  },
  // category values requiring approval are hardcoded here, not left to the model to decide
  // for itself — a "quote"/"discount"/"large_b2b"/"legal" email always creates a real
  // agent_approvals row and returns WAITING_APPROVAL, regardless of permission level;
  // approval is granted via POST /api/approvals/:id/decide (see application.js), which
  // performs the real send at decide-time using the stored proposed_output.
  microsoft_sendEmail:async({leadId,subject,bodyHtml,category='general',cc},ctx)=>{
   const lead=getLead(db,leadId,ctx.tenantId);
   if(lead.optOut)return {status:'BLOCKED',reason:'OPT_OUT'};
   if(lead.humanHold)return {status:'BLOCKED',reason:'HUMAN_HOLD'};
   if(!lead.email)return {status:'BLOCKED',reason:'NO_EMAIL'};
   if(['quote','discount','large_b2b','legal'].includes(category)) {
    const approval=createApproval(db,{runId:ctx.runId,agentId:ctx.agentId,actionType:'send_marketing_message',
     proposedOutput:{leadId,to:lead.email,cc:cc||[],subject,bodyHtml,category},
     riskLevel:category==='legal'?'HIGH':'MEDIUM',reason:`Agent-drafted ${category} email to ${lead.email} requires owner approval before sending.`,tenantId:ctx.tenantId,
     toolSlug:'microsoft_sendEmail',assignmentId:ctx.assignmentId||null,connectionId:ctx.connectionId||null});
    return {status:'WAITING_APPROVAL',approvalId:approval.id};
   }
   // Drafting/requesting approval above is never gated by ENABLE_EXTERNAL_MESSAGING —
   // only the immediate real send below is (spec Phase 83: "AI drafts: ON" while
   // "automatic send: OFF initially" are independent switches).
   if(!isEnabled(env,'ENABLE_EXTERNAL_MESSAGING'))return featureDisabled('ENABLE_EXTERNAL_MESSAGING');
   const configured=await resolveMicrosoftAccessToken({store,env,fetcher},ctx.tenantId);
   if(!configured)return blocked('microsoft365','send_email');
   const result=await sendMail({store,env,fetcher},{to:lead.email,cc,subject,bodyHtml},ctx.tenantId);
   if(result.status==='SENT') {
    const recovered=await findRecentSentMessage({store,env,fetcher},{subject,to:lead.email},ctx.tenantId).catch(()=>null);
    recordChannelMessage(store,{leadId,channel:'Email',direction:'OUTBOUND',text:bodyHtml,subject,cc:cc||null,externalMessageId:recovered?.externalMessageId,externalThreadId:recovered?.externalThreadId,internetMessageId:recovered?.internetMessageId,messageType:'email'},ctx.actor,ctx.tenantId);
   }
   return result;
  },
  search_email_conversation:({leadId,query},ctx)=>{
   const detail=leadDetail(db,leadId,ctx.tenantId);
   const emails=detail.messages.filter(m=>m.channel==='Email');
   if(!query)return emails;
   const q=query.toLowerCase();
   return emails.filter(m=>(m.subject||'').toLowerCase().includes(q)||(m.text||'').toLowerCase().includes(q));
  },
  get_email_thread:({leadId,externalThreadId},ctx)=>leadDetail(db,leadId,ctx.tenantId).messages.filter(m=>m.channel==='Email'&&m.externalThreadId===externalThreadId),
  get_recent_replies:({leadId,sinceIso},ctx)=>leadDetail(db,leadId,ctx.tenantId).messages.filter(m=>m.direction==='INBOUND'&&(!sinceIso||m.recordedAt>sinceIso)),
  // Calendar tools are restricted to the agents actually responsible for scheduling
  // (spec Part AC) — enforced below in list()/get(), not left to permission level alone,
  // since every other agent passing L1+ would otherwise also qualify.
  create_calendar_event:async(input,ctx)=>{
   const configured=await resolveMicrosoftAccessToken({store,env,fetcher},ctx.tenantId);
   if(!configured)return blocked('microsoft365','create_event');
   return createCalendarEvent({store,env,fetcher},input,ctx.tenantId);
  },
  get_calendar_availability:async(input,ctx)=>{
   const configured=await resolveMicrosoftAccessToken({store,env,fetcher},ctx.tenantId);
   if(!configured)return blocked('microsoft365','get_availability');
   return getCalendarAvailability({store,env,fetcher},input,ctx.tenantId);
  },
  canva_generateAsset:()=>blocked('canva','generate_asset'),
  salla_syncOrders:()=>blocked('salla_webhooks','sync_orders'),

  // --- Frost Command Center (Phase 7A) ---------------------------------------------------
  get_company_health:(input,ctx)=>computeCompanyHealth(store,ctx.tenantId),
  get_followups_needing_attention:(input,ctx)=>{
   const now=Date.now();
   const followups=listFollowups(db,ctx.tenantId).filter(f=>f.status==='DRAFT'&&f.dueAt&&Date.parse(f.dueAt)<now);
   const eligibleStages=['QUOTE_SENT','DEMO','POST_PURCHASE'];
   const hotLeads=listLeads(db,ctx.tenantId).filter(l=>l.temperature==='HOT'&&eligibleStages.includes(l.stage)&&!l.optOut&&!l.humanHold);
   return {
    overdueFollowupsCount:followups.length,
    overdueFollowups:followups.slice(0,10).map(f=>({id:f.id,leadId:f.leadId,dueAt:f.dueAt})),
    hotLeadsNeedingAttentionCount:hotLeads.length,
    hotLeadsNeedingAttention:hotLeads.slice(0,10).map(l=>({id:l.id,name:l.name||l.company||null,stage:l.stage,city:l.city||null}))
   };
  },
  get_integrations_health:(input,ctx)=>listConnections(db,{},ctx.tenantId).map(c=>({id:c.id,name:c.name,integration:c.integrationDefinitionId,status:c.status,lastHealthCheck:c.lastHealthCheck,lastErrorCode:c.lastErrorCode})),
  get_agent_tool_status:(input,ctx)=>buildAgentConnectionMap(db,env,ctx.tenantId,{}),
  search_context:({query,type}={},ctx)=>searchContextItems(db,ctx.tenantId,{query,type}).slice(0,15),
  update_agent_tool_connection:({targetAgentId,toolSlug,connectionId},ctx)=>{
   const before=getAssignment(db,ctx.tenantId,targetAgentId,toolSlug);
   const updated=upsertAssignment(db,ctx.tenantId,targetAgentId,toolSlug,{connectionId});
   recordAudit(db,{id:crypto.randomUUID(),action:'COMMAND_AGENT_TOOL_CONNECTION_CHANGED',itemId:updated.id,actorId:ctx.actor.id,actorName:ctx.actor.name,actorRole:ctx.actor.role,at:new Date().toISOString(),detail:{targetAgentId,toolSlug,previousConnectionId:before?.connectionId||null,newConnectionId:connectionId}},ctx.tenantId);
   // Phase 7B — Configuration History (spec Part 20-23): this IS the one real, reversible
   // configuration write Command Center chat can make, recorded here (not re-derived from
   // audit_logs later) so Undo has an exact, structured before/after value to restore.
   recordConfigurationChange(db,{tenantId:ctx.tenantId,entityType:'agent_tool_connection',entityId:`${targetAgentId}::${toolSlug}`,field:'connectionId',
    previousValue:{connectionId:before?.connectionId||null},newValue:{connectionId:updated.connectionId},actor:ctx.actor,commandRunId:ctx.runId,reversible:true});
   return {targetAgentId,toolSlug,previousConnectionId:before?.connectionId||null,newConnectionId:updated.connectionId};
  },
  run_followup_sweep:async(input,ctx)=>{
   if(!runtimeRef?.current)return {status:'ERROR',error:'RUNTIME_NOT_READY'};
   return sweepFollowupGaps({store,agentRuntime:runtimeRef.current,env,tenantId:ctx.tenantId});
  },

  // --- Frost Command Center Phase 7B ---------------------------------------------------
  delegate_to_agent:async({agent,objective},ctx)=>{
   if(!runtimeRef?.current)return {status:'ERROR',error:'RUNTIME_NOT_READY'};
   const allowed=['performance','intelligence','leads','strategy'];
   if(!allowed.includes(agent))return {status:'ERROR',error:'UNSUPPORTED_DELEGATE_AGENT'};
   // Same free-text `scenario` shape the existing manual "test run" endpoint already uses for
   // every agent (application.js's POST /api/agents/:id/run) — no new, agent-specific input
   // contract invented for delegation.
   const run=await runtimeRef.current.run(agent,{triggerType:'DELEGATED',parentRunId:ctx.runId,
    input:{scenario:`مهمة ضمن خطة Frost: ${objective}`,current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh'},
    user:ctx.actor,tenantId:ctx.tenantId});
   // Agent Result Contract (spec item 10) — every agent's decision envelope already shares the
   // same top-level shape (RUNTIME CONTRACT ADAPTER in agents.js), so this is a real, uniform
   // extraction, not a per-agent-type guess. No hidden reasoning is included — only the
   // envelope's own declared rationale/verification/payload fields.
   return {
    agent,status:run.status,
    summary:run.output?.rationale||null,
    evidence:run.output?.verification||[],
    artifacts:{runId:run.id,payload:run.output?.payload||null},
    errors:run.error?[run.error]:run.status==='FAILED'?['UNKNOWN_ERROR']:[]
   };
  },
  list_scheduled_content_jobs:(input,ctx)=>listJobs(db,ctx.tenantId).slice(0,30),
  cancel_scheduled_content_job:({contentId},ctx)=>cancelJobs(store,null,contentId,ctx.actor,ctx.tenantId),
  explain_followup_status:({leadId},ctx)=>{
   const followups=listFollowups(db,ctx.tenantId).filter(f=>f.leadId===leadId);
   if(!followups.length)return {status:'NO_DATA',leadId};
   return {leadId,followups:followups.map(f=>({id:f.id,status:f.status,dueAt:f.dueAt,holdReason:f.holdReason||null,sequenceName:f.sequenceName||null}))};
  },
  prepare_bulk_followup_plan:(input,ctx)=>{
   const overdue=listFollowups(db,ctx.tenantId).filter(f=>f.status==='DRAFT'&&f.dueAt&&Date.parse(f.dueAt)<Date.now());
   const connection=listConnections(db,{},ctx.tenantId).find(c=>c.integrationDefinitionId==='whatsapp');
   return {
    targetsCount:overdue.length,
    targets:overdue.slice(0,20).map(f=>({followupId:f.id,leadId:f.leadId,dueAt:f.dueAt})),
    channel:'WhatsApp',
    connection:connection?{id:connection.id,name:connection.name,status:connection.status}:null,
    approvalRequired:true,
    note:connection?null:'لا يوجد اتصال واتساب مهيأ لهذه المنشأة — لا يمكن التنفيذ حتى يتم ربط الاتصال أولًا.'
   };
  },

  // --- Frost Command Center Phase 7C — Native Workflow Engine chat tools ------------------
  create_workflow_draft:({nameAr,nameEn,description,trigger,steps},ctx)=>{
   try{return createWorkflowDraft(db,env,ctx.tenantId,{nameAr,nameEn,description,trigger,steps},ctx.actor);}
   catch(error){return {status:'ERROR',error:error.message};}
  },
  list_workflows:({status}={},ctx)=>listWorkflows(db,ctx.tenantId,{status}).map(w=>({id:w.id,nameAr:w.nameAr,status:w.status})),
  explain_workflow_failure:({workflowId,runId}={},ctx)=>{
   let targetRunId=runId;
   if(!targetRunId && workflowId)targetRunId=listWorkflowRuns(db,ctx.tenantId,{workflowId,limit:1})[0]?.id;
   if(!targetRunId)return {status:'NO_DATA'};
   try{
    const run=getRunWithSteps(db,targetRunId,ctx.tenantId);
    const failedStep=run.steps.find(s=>s.status==='FAILED');
    return {runId:run.id,workflowId:run.workflowId,status:run.status,
     failedStep:failedStep?{stepId:failedStep.stepId,stepType:failedStep.stepType,error:failedStep.error,output:failedStep.output}:null};
   }catch(error){return {status:'ERROR',error:error.message};}
  },
  activate_workflow:({workflowId},ctx)=>{
   try{return activateWorkflow(db,env,workflowId,ctx.actor,ctx.tenantId);}
   catch(error){return {status:'ERROR',error:error.message};}
  },
  run_workflow_now:async({workflowId},ctx)=>{
   if(!runtimeRef?.current)return {status:'ERROR',error:'RUNTIME_NOT_READY'};
   const deps={store,env,fetcher,agentRuntime:runtimeRef.current,toolRegistry:runtimeRef.current.toolRegistry};
   try{return await startWorkflowRun(deps,workflowId,{triggerType:'MANUAL',tenantId:ctx.tenantId});}
   catch(error){return {status:'ERROR',error:error.message};}
  },
  pause_workflow_now:({workflowId},ctx)=>{
   try{return pauseWorkflow(db,workflowId,ctx.actor,ctx.tenantId);}
   catch(error){return {status:'ERROR',error:error.message};}
  }
 };
 const tools=Object.entries(TOOL_METADATA).map(([name,meta])=>({name,...meta,handler:HANDLERS[name]}));
 return {
  list:(level,agentId)=>tools.filter(tool=>(!level||meetsLevel(tool.minLevel,level))&&(!tool.allowedAgents||!agentId||tool.allowedAgents.includes(agentId))),
  get:(name)=>tools.find(tool=>tool.name===name),
  all:tools
 };
}
function meetsLevel(min,level) {
 const order=['L0','L1','L2','L3'];
 return order.indexOf(level)>=order.indexOf(min);
}
