import http from 'node:http';
import {readFileSync} from 'node:fs';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createContent,reviewContent,approveContent} from './domain.js';
import {openStore} from './store.js';
import {createAuth,authorize,fail} from './auth.js';
import {agentDefinitions} from './agents.js';
import {installKnowledge,listMemory,saveMemory,proposeMemoryUpdate,listProducts,replaceProducts} from './knowledge.js';
import {connectionStatus,importSalla,ConnectorError,testAnthropicConnection,testOpenAIConnection,testSallaConnection} from './connectors.js';
import {createGenerator,listAiRuns} from './generation.js';
import {loadEnvFile} from 'node:process';
import {installPlanning,listSlots,listJobs,createCalendar,scheduleContent,cancelJobs,prepareDue,buildBrief,saveDailyBrief,riyadhDate,authorizeAutomation} from './planning.js';
import {installCRM,listLeads,leadDetail,listFollowups,sequences,createLead,updateLead,recordMessage,contactControl,createFollowups,approveFollowup,prepareFollowups,cancelFollowups,searchLeads,getLead,maybeEscalateHotLead,findOrCreateLeadFromChannel,recordChannelMessage,updateMessageStatus,isOptOutText} from './crm.js';
import {buildSalesDashboard} from './sales-dashboard.js';
import {installCompliance,listComplianceChecks,listComplianceChecksSince,createComplianceChecker,latestComplianceByContent} from './compliance.js';
import {buildIntegrationsDashboard} from './integration-ops.js';
import {buildContentWorkspace} from './content-ops.js';
import {buildMemoryWorkspace,computeMemoryUsage} from './memory-ops.js';
import {assertRoleChangeAllowed,assertDeactivationAllowed,buildTeamDashboard} from './team-ops.js';
import {installAutonomy,currentAutonomy,setAutonomy,listAutonomyLog} from './autonomy.js';
import {installReporting,buildExecutiveReport,saveWeeklyReport,listWeeklyReports,currentWeekStart} from './reporting.js';
import {installRegistry,seedRegistry,listAgents as listRegistryAgents,getAgent,setEnabled,setModelConfig} from './runtime/registry.js';
import {installRuntimeTables,createAgentRuntime,listRuns,getRun,listToolCalls} from './runtime/runtime.js';
import {installEvents,createEventBus} from './runtime/events.js';
import {installApprovals,listApprovals,decideApproval,createApproval} from './runtime/approvals.js';
import {installEscalations,listEscalations,resolveEscalation} from './runtime/escalations.js';
import {installOrchestrator,buildDailyBrief} from './runtime/orchestrator.js';
import {integrationStatus,AGENT_INTEGRATIONS} from './runtime/tools.js';
import {providerStatus} from './runtime/llmProvider.js';
import {promotionEligibility} from './runtime/permissions.js';
import {installGate,getGateStatus,setPaused,isPaused} from './runtime/gate.js';
import {createScheduler} from './runtime/scheduler.js';
import {installCredentials,saveCredentials,credentialsConfigured} from './runtime/credentials.js';
import {installTenancy,ensureDefaultTenant,resolveTenantForUser,resolveActiveTenantId} from './tenancy.js';
import {installContent,listContent,getContent,getContentOrNull,insertContent,writeContent} from './content.js';
import {installAuditLog,recordAudit,listAuditLog} from './audit.js';
import {createAuthorizeUrl,consumeState,exchangeCodeForTokens,sallaOAuthStatus,disconnectSalla,resolveSallaAccessToken} from './runtime/salla-oauth.js';
import {installWebhookEvents,listWebhookEvents} from './runtime/webhook-events.js';
import {verifySallaWebhook,processSallaWebhook} from './runtime/salla-webhooks.js';
import {handleVerificationChallenge,verifyMetaSignature,normalizeWhatsAppWebhook} from './runtime/meta-webhooks.js';
import {metaOAuthConfigured,createMetaAuthorizeUrl,consumeMetaState,exchangeCodeAndResolveAssets,saveMetaConnection,metaOAuthStatus,disconnectMeta,resolveMetaAccessToken,connectedWhatsAppPhoneNumberId} from './runtime/meta-oauth.js';
import {sendWhatsAppMessage,testWhatsAppConnection,syncWhatsAppTemplates,installWhatsAppTemplates,listWhatsAppTemplates,whatsappConfigured} from './runtime/whatsapp.js';
import {microsoftOAuthConfigured,createMicrosoftAuthorizeUrl,consumeMicrosoftState,exchangeCodeForTokens as exchangeMicrosoftCodeForTokens,resolveConnectedProfile,saveMicrosoftConnection,microsoftOAuthStatus,disconnectMicrosoft,resolveMicrosoftAccessToken} from './runtime/microsoft-oauth.js';
import {testMicrosoftConnection,sendMail,getMessage,createMailSubscription,deleteMailSubscription} from './runtime/microsoft-graph.js';
import {handleValidationHandshake,processMicrosoftNotifications} from './runtime/microsoft-webhooks.js';
import {updateCredentialsMetadata,getCredentialsMeta} from './runtime/credentials.js';
import {xOAuthConfigured,createXAuthorizeUrl,consumeXState,exchangeCodeForTokens as exchangeXCodeForTokens,resolveConnectedProfile as resolveXProfile,saveXConnection,xOAuthStatus,disconnectX} from './runtime/x-oauth.js';
import {testXConnection} from './runtime/x-publishing.js';
import {linkedInOAuthConfigured,createLinkedInAuthorizeUrl,consumeLinkedInState,exchangeCodeForTokens as exchangeLinkedInCodeForTokens,resolveConnectedProfile as resolveLinkedInProfile,resolveAdministeredOrganizations,saveLinkedInConnection,linkedInOAuthStatus,disconnectLinkedIn} from './runtime/linkedin-oauth.js';
import {testLinkedInConnection} from './runtime/linkedin-publishing.js';

const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
// Environment validation — logged at startup, never crashes the process. Every core config
// value (DATA_DIR/PORT/HOST) already has a safe default, so nothing here is required for
// the app to start; this only reports which OPTIONAL integrations aren't configured yet, so
// an operator sees exactly what won't work instead of a vague crash or a silently-fake
// "connected" status. Distinguishes REQUIRED_FOR_CORE (none exist today) from
// REQUIRED_FOR_OPTIONAL_INTEGRATION (everything below).
function validateEnv(env) {
 const optionalIntegrations=[
  ['Anthropic (AI)',['ANTHROPIC_API_KEY / AI_API_KEY','ANTHROPIC_MODEL / AI_DEFAULT_MODEL'],!!(env.AI_API_KEY||env.ANTHROPIC_API_KEY)&&!!(env.AI_DEFAULT_MODEL||env.ANTHROPIC_MODEL)],
  ['Salla catalog sync',['SALLA_ACCESS_TOKEN, or SALLA_CLIENT_ID/SALLA_CLIENT_SECRET/SALLA_REDIRECT_URI for OAuth'],!!env.SALLA_ACCESS_TOKEN||!!(env.SALLA_CLIENT_ID&&env.SALLA_CLIENT_SECRET&&env.SALLA_REDIRECT_URI)],
  ['Salla OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.SALLA_CLIENT_ID||credentialsConfigured(env)],
  ['Salla webhooks',['SALLA_WEBHOOK_SECRET'],!!env.SALLA_WEBHOOK_SECRET],
  ['WhatsApp',['WHATSAPP_ACCESS_TOKEN, or connect Meta via OAuth below'],!!env.WHATSAPP_ACCESS_TOKEN||!!(env.META_APP_ID&&env.META_APP_SECRET&&env.META_REDIRECT_URI)],
  ['Meta (Instagram/Facebook)',['META_ACCESS_TOKEN, or META_APP_ID/META_APP_SECRET/META_REDIRECT_URI for OAuth'],!!env.META_ACCESS_TOKEN||!!(env.META_APP_ID&&env.META_APP_SECRET&&env.META_REDIRECT_URI)],
  ['Meta OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.META_APP_ID||credentialsConfigured(env)],
  ['Meta webhooks',['META_WEBHOOK_SECRET or META_APP_SECRET','META_VERIFY_TOKEN'],!!(env.META_WEBHOOK_SECRET||env.META_APP_SECRET)&&!!env.META_VERIFY_TOKEN],
  ['X',['X_CLIENT_ID/X_CLIENT_SECRET/X_REDIRECT_URI for OAuth (required — publishing needs a user-context token; X_BEARER_TOKEN alone is read-only)'],!!(env.X_CLIENT_ID&&env.X_CLIENT_SECRET&&env.X_REDIRECT_URI)],
  ['X OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.X_CLIENT_ID||credentialsConfigured(env)],
  ['LinkedIn',['LINKEDIN_CLIENT_ID/SECRET/REDIRECT_URI for OAuth, or LINKEDIN_ACCESS_TOKEN+LINKEDIN_ORGANIZATION_ID'],!!(env.LINKEDIN_CLIENT_ID&&env.LINKEDIN_CLIENT_SECRET&&env.LINKEDIN_REDIRECT_URI)||!!(env.LINKEDIN_ACCESS_TOKEN&&env.LINKEDIN_ORGANIZATION_ID)],
  ['LinkedIn OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.LINKEDIN_CLIENT_ID||credentialsConfigured(env)],
  ['Microsoft 365',['MICROSOFT_ACCESS_TOKEN, or MICROSOFT_CLIENT_ID/SECRET/TENANT_ID/REDIRECT_URI for OAuth'],!!env.MICROSOFT_ACCESS_TOKEN||!!(env.MICROSOFT_CLIENT_ID&&env.MICROSOFT_CLIENT_SECRET&&env.MICROSOFT_REDIRECT_URI)],
  ['Microsoft 365 OAuth token encryption',['INTEGRATION_ENCRYPTION_KEY'],!env.MICROSOFT_CLIENT_ID||credentialsConfigured(env)],
  ['Microsoft 365 mail webhook',['MICROSOFT_WEBHOOK_SECRET'],!!env.MICROSOFT_WEBHOOK_SECRET],
  ['Canva',['CANVA_API_KEY'],!!env.CANVA_API_KEY]
 ];
 for(const [name,vars,configured] of optionalIntegrations)
  if(!configured)console.warn(`[HyperCool] REQUIRED_FOR_OPTIONAL_INTEGRATION — ${name} not configured (missing: ${vars.join(', ')}). Core app and CRM are unaffected; only this integration's tools stay INTEGRATION_REQUIRED.`);
 const configuredCount=optionalIntegrations.filter(o=>o[2]).length;
 console.log(`[HyperCool] environment check: ${configuredCount}/${optionalIntegrations.length} optional integrations configured. SYSTEM_MODE=${env.SYSTEM_MODE||'(unset — autonomy levels run uncapped; set PRODUCTION_SAFE to cap every agent at L1 for first launch)'}.`);
}

export async function createApp({env=process.env,dataDir=env.DATA_DIR||fileURLToPath(new URL('../data/',import.meta.url)),fetcher=fetch}={}) {
  const publicUrl=env.PUBLIC_ORIGIN?new URL(env.PUBLIC_ORIGIN):null;
  if(publicUrl && (publicUrl.protocol!=='https:' || publicUrl.username || publicUrl.password || publicUrl.pathname!=='/' || publicUrl.search || publicUrl.hash)) throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a path');
  const secureCookie=publicUrl?'; Secure':'';
  await mkdir(dataDir,{recursive:true});
  const store=openStore(resolve(dataDir,'hypercool.sqlite'),resolve(dataDir,'state.json'));
  const auth=createAuth(store.db);
  installTenancy(store.db);
  ensureDefaultTenant(store.db); // real, lossless backfill — see docs/MULTI_TENANT_ARCHITECTURE.md
  installContent(store.db); // migrates legacy state.content into a real tenant-scoped table — see docs/CONTENT_MIGRATION.md
  installAuditLog(store.db); // migrates legacy state.audit into a real tenant-scoped table — see docs/AUDIT_MIGRATION.md
  installKnowledge(store.db);
  installPlanning(store.db);
  installCRM(store.db);
  installCompliance(store.db);
  installAutonomy(store.db);
  installReporting(store.db);
  installRegistry(store.db);
  installRuntimeTables(store.db);
  installEvents(store.db);
  installApprovals(store.db);
  installEscalations(store.db);
  installGate(store.db);
  installCredentials(store.db);
  installWebhookEvents(store.db);
  installWhatsAppTemplates(store.db);
  seedRegistry(store.db);
  const eventBus=createEventBus(store.db);
  const agentRuntime=createAgentRuntime({store,env,fetcher,eventBus});
  const {routes:orchestratorRoutes}=installOrchestrator(eventBus,agentRuntime,store.db);
  function reportExtras(tenantId=null) {
    return {agents:listRegistryAgents(store.db),agentRuns:listRuns(store.db,{limit:2000},tenantId),escalations:listEscalations(store.db,{},tenantId),approvals:listApprovals(store.db,{},tenantId),env};
  }
  const scheduler=createScheduler({store,agentRuntime,env,getExtras:reportExtras,fetcher,eventBus});
  const generate=createGenerator(store,env,fetcher);
  const checkCompliance=createComplianceChecker(store,env,fetcher);
  let syncing=false;
  // Guards real, billed LLM calls (content drafts, compliance checks, manual agent test
  // runs) against a single authenticated user hammering the Anthropic API with repeated
  // sequential requests — the per-route idempotency/concurrency locks only stop duplicates
  // or overlap, not a fast sequential loop. Fixed window, in-memory, per-user.
  const llmCallLog=new Map();
  function checkLlmRateLimit(userId) {
    const now=Date.now(),windowMs=600000,limit=20;
    const hits=(llmCallLog.get(userId)||[]).filter(at=>now-at<windowMs);
    if(hits.length>=limit) fail(429,'تجاوزت حد الطلبات المسموح لهذه الميزة؛ حاول لاحقًا');
    hits.push(now);llmCallLog.set(userId,hits);
  }
  async function body(req) {
    if(!req.headers['content-type']?.startsWith('application/json')) fail(415,'JSON مطلوب');
    let value='';
    for await(const chunk of req) {value+=chunk; if(Buffer.byteLength(value)>64000) fail(413,'الطلب كبير جدًا');}
    let parsed;try {parsed=JSON.parse(value||'{}');} catch {fail(400,'JSON غير صالح');}
    if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) fail(400,'كائن JSON مطلوب');
    return parsed;
  }
  // Webhook signature verification needs the exact raw bytes Salla signed — body() above
  // JSON-parses immediately and would lose that, so this is a separate, minimal reader.
  async function rawBody(req,maxBytes=1000000) {
    const chunks=[];let size=0;
    for await(const chunk of req) {size+=chunk.length;if(size>maxBytes) fail(413,'الطلب كبير جدًا');chunks.push(chunk);}
    return Buffer.concat(chunks).toString('utf8');
  }
  // Structured, production-safe logging: one JSON line per request (never the request/response
  // body, which could carry a password or a customer's raw message), correlated by a
  // per-request id that's also returned as X-Request-Id so a user-reported error can be
  // traced back to this exact log line.
  function logRequest(fields) {
    console.log(JSON.stringify({timestamp:new Date().toISOString(),level:fields.status>=500?'ERROR':fields.status>=400?'WARN':'INFO',...fields}));
  }
  const server=http.createServer(async(req,res)=>{
    const requestId=crypto.randomUUID();
    const startedAt=Date.now();
    let userId=null;
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('X-Request-Id',requestId);
    const send=(status,value)=>{
      res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});
      res.end(JSON.stringify(value));
      logRequest({request_id:requestId,method:req.method,path:req.url.split('?')[0],status,duration_ms:Date.now()-startedAt,user_id:userId,error_code:status>=400?value?.error:undefined});
    };
    try {
      const host=req.headers.host;
      if(!host || (publicUrl?host!==publicUrl.host:!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))) fail(403,'Host not allowed');
      if(req.headers.origin && req.headers.origin!==(publicUrl?.origin||`http://${host}`)) fail(403,'Cross-origin request rejected');
      const url=new URL(req.url,`http://${host}`);
      // External links may open the public shell; API and embedded requests remain protected.
      const publicNavigation=req.method==='GET' && url.pathname==='/' &&
        req.headers['sec-fetch-mode']==='navigate' && req.headers['sec-fetch-dest']==='document';
      if(req.headers['sec-fetch-site']==='cross-site' && !publicNavigation) fail(403,'Cross-site request rejected');
      if(url.pathname.startsWith('/api/automation/')) {
        authorizeAutomation(req,env);
        const actor={id:'automation',name:'مشغّل خارجي',role:'automation'};
        // This external-trigger path duplicates exactly what the internal scheduler already
        // does on its own — so it must obey the same "pause all autonomous actions" gate,
        // not just the scheduler's own tick(). Otherwise pausing from Frost Control Center
        // would silently fail to stop this path.
        if(req.method==='POST' && (url.pathname==='/api/automation/daily-brief'||url.pathname==='/api/automation/prepare-due') && isPaused(store.db))return send(200,{skipped:'PAUSED'});
        if(req.method==='POST' && url.pathname==='/api/automation/daily-brief')return send(200,saveDailyBrief(store,riyadhDate(),actor));
        if(req.method==='POST' && url.pathname==='/api/automation/prepare-due')return send(200,prepareDue(store,actor,Date.now(),eventBus,env));
        if(req.method==='GET' && url.pathname==='/api/automation/status')return send(200,{timezone:'Asia/Riyadh',externalPublishing:false});
        fail(404,'Unknown automation operation');
      }
      // Unauthenticated on purpose, like /api/automation/* above — this is Salla's own
      // server calling us, not a browser with a session. Authenticity comes entirely from
      // verifySallaWebhook() (signature or token match against SALLA_WEBHOOK_SECRET), never
      // from a session cookie or CSRF token. Verify → store (idempotent) → map → return fast.
      if(req.method==='POST' && url.pathname==='/api/webhooks/salla') {
        const raw=await rawBody(req);
        verifySallaWebhook(req,raw,env);
        let payload;try{payload=JSON.parse(raw||'{}');}catch{fail(400,'JSON غير صالح');}
        return send(200,processSallaWebhook({db:store.db,eventBus,body:payload,paused:isPaused(store.db)}));
      }
      // Meta's verification handshake — GET with hub.challenge, no body, no signature (the
      // handshake IS the authentication: only someone holding META_VERIFY_TOKEN can pass it).
      if(req.method==='GET' && url.pathname==='/api/webhooks/meta/whatsapp') {
        res.writeHead(200,{'Content-Type':'text/plain'});return res.end(handleVerificationChallenge(url.searchParams,env));
      }
      // Real inbound WhatsApp delivery. Same unauthenticated-by-session, authenticated-by-
      // secret pattern as /api/webhooks/salla — see verifyMetaSignature. This is the one
      // route the whole PART F flow (webhook → CUSTOMER_MESSAGE_RECEIVED → Frost → Sales
      // Agent) starts from.
      if(req.method==='POST' && url.pathname==='/api/webhooks/meta/whatsapp') {
        const raw=await rawBody(req);
        verifyMetaSignature(req,raw,env);
        let payload;try{payload=JSON.parse(raw||'{}');}catch{fail(400,'JSON غير صالح');}
        const normalized=normalizeWhatsAppWebhook(store.db,payload);
        const paused=isPaused(store.db);
        const connectorActor={id:'connector:whatsapp',name:'موصل واتساب',role:'automation'};
        // No per-tenant webhook routing exists yet (Multi-Tenant Phase 2/3 — see
        // docs/MULTI_TENANT_ARCHITECTURE.md): every WhatsApp connection today belongs to
        // the one active tenant, so resolving it once here and tagging both the lead and
        // its events with it is correct today, not a fallback masking a real gap.
        const webhookTenantId=resolveActiveTenantId(store.db);
        for(const item of normalized.messages) {
          if(item.replayed||item.error||!item.phone)continue;
          const {lead}=findOrCreateLeadFromChannel(store,{phone:item.phone,name:item.name,channel:'WhatsApp'},connectorActor,webhookTenantId);
          const message=recordChannelMessage(store,{leadId:lead.id,channel:'WhatsApp',direction:'INBOUND',text:item.text,externalMessageId:item.externalMessageId,messageType:item.messageType,media:item.media||null},connectorActor,webhookTenantId);
          if(message.replayed)continue;
          if(message.optedOut)eventBus.emit('CUSTOMER_OPTED_OUT',{leadId:lead.id,channel:'WhatsApp',tenantId:webhookTenantId});
          // The pause gate stops autonomous AGENT action, never the recording of the message
          // itself — a paused system must still capture what the customer said, exactly like
          // the internal scheduler's own tick() only skips its own triggered work, not intake.
          if(!paused)eventBus.emit('CUSTOMER_MESSAGE_RECEIVED',{leadId:lead.id,channel:'WhatsApp',text:item.text,tenantId:webhookTenantId});
        }
        for(const item of normalized.statuses) {
          if(item.replayed)continue;
          updateMessageStatus(store,item.externalMessageId,item.status,{errorCode:item.errorCode});
        }
        return send(200,{received:normalized.messages.length,statuses:normalized.statuses.length,skipped:normalized.skipped});
      }
      // Microsoft Graph's real webhook mechanism is different from Meta's/Salla's: EVERY
      // POST (including the very first, which is the validation handshake) hits the same
      // URL. A validation POST carries ?validationToken=... and must get that token echoed
      // back as plain text within 10 seconds — no JSON body to parse, no secret involved
      // (the handshake just proves we control this URL). Real notifications carry a JSON
      // body instead and are verified per-item via clientState (see microsoft-webhooks.js).
      if(req.method==='POST' && url.pathname==='/api/webhooks/microsoft/mail') {
        const token=handleValidationHandshake(url);
        if(token!==null){res.writeHead(200,{'Content-Type':'text/plain'});return res.end(token);}
        const raw=await rawBody(req);
        let payload;try{payload=JSON.parse(raw||'{}');}catch{fail(400,'JSON غير صالح');}
        const result=processMicrosoftNotifications(store.db,payload,env);
        const paused=isPaused(store.db);
        const connectorActor={id:'connector:microsoft365',name:'موصل Microsoft 365',role:'automation'};
        const webhookTenantId=resolveActiveTenantId(store.db); // see the WhatsApp webhook above for why this is correct today
        for(const {messageId} of result.toFetch) {
          try {
           const graphMessage=await getMessage({store,env,fetcher},messageId);
           if(!graphMessage||graphMessage.isDraft)continue; // never ingest our own drafts as if a customer sent them
           const fromAddress=graphMessage.from?.emailAddress?.address||null;
           if(!fromAddress)continue;
           const {lead}=findOrCreateLeadFromChannel(store,{email:fromAddress,name:graphMessage.from?.emailAddress?.name,channel:'Email'},connectorActor,webhookTenantId);
           const message=recordChannelMessage(store,{leadId:lead.id,channel:'Email',direction:'INBOUND',text:graphMessage.bodyPreview||'',subject:graphMessage.subject||null,externalMessageId:graphMessage.id,internetMessageId:graphMessage.internetMessageId,externalThreadId:graphMessage.conversationId,messageType:'email'},connectorActor,webhookTenantId);
           if(message.replayed)continue;
           if(message.optedOut)eventBus.emit('CUSTOMER_OPTED_OUT',{leadId:lead.id,channel:'Email',tenantId:webhookTenantId});
           if(!paused)eventBus.emit('CUSTOMER_MESSAGE_RECEIVED',{leadId:lead.id,channel:'Email',text:message.text,tenantId:webhookTenantId});
          } catch(error) {
           recordAudit(store.db,{id:crypto.randomUUID(),action:'EMAIL_INGEST_FAILED',itemId:messageId,errorCode:error.message,at:new Date().toISOString()},webhookTenantId);
          }
        }
        return send(200,{toFetch:result.toFetch.length,rejected:result.rejected,replayed:result.replayed});
      }
      // Unauthenticated on purpose — load balancers/uptime monitors never hold a session.
      // Still pass through the Host/Origin/Sec-Fetch checks above, same as everything else.
      if(req.method==='GET' && (url.pathname==='/health'||url.pathname==='/health/live')) {
        return send(200,{status:'ok',timestamp:new Date().toISOString()});
      }
      if(req.method==='GET' && url.pathname==='/health/ready') {
        const dependencies={};
        try{store.db.prepare('SELECT 1').get();dependencies.database='ok';}catch{dependencies.database='error';}
        dependencies.scheduler=scheduler.running()?'running':'stopped';
        dependencies.llm=providerStatus(env).configured?'configured':'not_configured';
        const integrations=integrationStatus(env,store.db);
        for(const [name,status] of Object.entries(integrations))dependencies['integration_'+name]=status.configured?'configured':'not_configured';
        const coreOk=dependencies.database==='ok';
        return send(coreOk?200:503,{status:coreOk?'ready':'not_ready',core_status:coreOk?'ok':'degraded',dependencies,timestamp:new Date().toISOString(),version:packageVersion});
      }
      const session=auth.current(req);
      userId=session?.user?.id||null;
      // TenantContext resolution (Multi-Tenant Control Center, Phase 1 — see
      // docs/MULTI_TENANT_ARCHITECTURE.md). Resolved once per request from the real
      // TenantMembership table, never trusted from a query string or request body — a
      // route that wants to scope a query explicitly (rather than relying on a library
      // function's own default-tenant fallback) uses `session.tenantId` here.
      if(session)session.tenantId=resolveTenantForUser(store.db,session.user.id);
      if(req.method==='GET' && url.pathname==='/api/auth') return send(200,{needsSetup:auth.needsSetup(),user:session?.user||null,csrf:session?.csrf||null});
      if(req.method==='POST' && ['/api/setup','/api/login'].includes(url.pathname)) {
        const input=await body(req);
        let result;
        if(url.pathname==='/api/setup') {
          if(!auth.needsSetup()) fail(409,'تم إعداد حساب المالك بالفعل');
          result=auth.session(auth.createUser(input,'owner'));
        } else result=auth.login(input,req.socket.remoteAddress);
        res.setHeader('Set-Cookie',`hc_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie}`);
        return send(200,{user:result.user,csrf:result.csrf});
      }
      if(url.pathname.startsWith('/api/')) {
        authorize(session,['owner','reviewer','operator']);
        if(req.method!=='GET' && req.headers['x-csrf-token']!==session.csrf) fail(403,'رمز حماية الجلسة غير صالح');
      }
      if(req.method==='POST' && url.pathname==='/api/logout') {auth.logout(session);res.setHeader('Set-Cookie',`hc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie}`);return send(200,{ok:true});}
      if(req.method==='POST' && url.pathname==='/api/preferences/locale') {
        const input=await body(req);
        auth.setPreferredLocale(session.user.id,input.locale);
        return send(200,{ok:true});
      }
      if(url.pathname==='/api/users') {
        authorize(session,['owner']);
        if(req.method==='GET') return send(200,auth.list());
        if(req.method==='POST') {
          const created=auth.createUser(await body(req));
          recordAudit(store.db,{id:crypto.randomUUID(),action:'USER_CREATED',itemId:created.id,actorId:session.user.id,actorName:session.user.name,actorRole:session.user.role,at:new Date().toISOString()},session.tenantId);
          return send(201,created);
        }
      }
      if(req.method==='GET' && url.pathname==='/api/team/dashboard') {
        authorize(session,['owner']);
        return send(200,buildTeamDashboard(store.db,{auditEntries:listAuditLog(store.db,{tenantId:session.tenantId})}));
      }
      const userAction=url.pathname.match(/^\/api\/users\/([\w-]+)\/(role|suspend|reactivate|remove|reset-access|revoke-sessions)$/);
      if(req.method==='POST' && userAction) {
        authorize(session,['owner']);
        const [,id,action]=userAction;
        if(!auth.get(id))fail(404,'العضو غير موجود');
        const input=await body(req);
        let auditAction,itemName=auth.get(id).name;
        if(action==='role') {
          if(!['owner','reviewer','operator'].includes(input.role))fail(400,'دور غير صالح');
          assertRoleChangeAllowed(store.db,id,input.role);
          auth.setRole(id,input.role);auditAction='USER_ROLE_CHANGED';
        } else if(action==='suspend') {
          assertDeactivationAllowed(store.db,id);
          auth.setStatus(id,'suspended');auditAction='USER_SUSPENDED';
        } else if(action==='reactivate') {
          auth.setStatus(id,'active');auditAction='USER_REACTIVATED';
        } else if(action==='remove') {
          assertDeactivationAllowed(store.db,id);
          auth.removeUser(id);auditAction='USER_REMOVED';
        } else if(action==='reset-access') {
          auth.resetPassword(id,input.password);auditAction='USER_ACCESS_RESET';
        } else if(action==='revoke-sessions') {
          auth.revokeSessions(id);auditAction='USER_SESSIONS_REVOKED';
        }
        recordAudit(store.db,{id:crypto.randomUUID(),action:auditAction,itemId:id,itemName,actorId:session.user.id,actorName:session.user.name,actorRole:session.user.role,at:new Date().toISOString()},session.tenantId);
        return send(200,action==='remove'?{ok:true}:auth.get(id)||{ok:true});
      }
      if(req.method==='GET' && url.pathname==='/api/agents') {
        const autonomy=currentAutonomy(store.db);
        const integrations=integrationStatus(env,store.db);
        const integrationNames={whatsapp:'واتساب',meta:'ميتا (Instagram/Facebook)',x:'X',linkedin:'لينكدإن',microsoft365:'Microsoft 365',canva:'Canva',salla_webhooks:'ويبهوكس سلة'};
        return send(200,agentDefinitions.map(agent=>{
          const registryRow=getAgent(store.db,agent.id);
          // Per-agent, not global: an agent pinned to a provider/model override (registry
          // row) is only WAITING_LLM if THAT provider is unconfigured, even if the account
          // default provider is configured (or vice versa).
          const llm=providerStatus(env,{provider:registryRow?.provider,model:registryRow?.model});
          const required=AGENT_INTEGRATIONS[agent.id]||[];
          const missing=required.filter(key=>!integrations[key]?.configured);
          const runtimeStatus=!registryRow?.enabled?'DISABLED':!llm.configured?'WAITING_LLM':missing.length?'WAITING_INTEGRATION':'ONLINE';
          const runtimeLabel=runtimeStatus==='DISABLED'?'معطّل':runtimeStatus==='WAITING_LLM'?'بانتظار إعداد مزود الذكاء الاصطناعي':runtimeStatus==='WAITING_INTEGRATION'?`جاهز داخليًا — بانتظار: ${missing.map(k=>integrationNames[k]||k).join('، ')}`:'جاهز للعمل داخليًا';
          const recentRuns=listRuns(store.db,{agentId:agent.id,limit:10},session.tenantId);
          return {...agent,level:autonomy[agent.id].level,autonomyVersion:autonomy[agent.id].version,autonomyUpdatedAt:autonomy[agent.id].at,autonomyUpdatedBy:autonomy[agent.id].actorName,autonomyReason:autonomy[agent.id].reason,
           runtimeStatus,runtimeLabel,enabled:!!registryRow?.enabled,requiredIntegrations:required,missingIntegrations:missing,
           modelConfig:registryRow?{provider:registryRow.provider,model:registryRow.model,temperature:registryRow.temperature,maxTokens:registryRow.max_tokens}:null,
           runsTotal:recentRuns.length,lastRunAt:recentRuns[0]?.started_at||null,lastRunStatus:recentRuns[0]?.status||null};
        }));
      }
      if(req.method==='POST' && url.pathname==='/api/agents/reseed') {authorize(session,['owner']);return send(200,seedRegistry(store.db));}
      const agentModelConfig=url.pathname.match(/^\/api\/agents\/([\w-]+)\/model-config$/);
      if(req.method==='POST' && agentModelConfig) {
        authorize(session,['owner']);
        const input=await body(req);
        const row=setModelConfig(store.db,agentModelConfig[1],{provider:input.provider,model:input.model,temperature:input.temperature,maxTokens:input.maxTokens});
        if(!row)fail(404,'وكيل غير موجود');
        return send(200,row);
      }
      if(req.method==='GET' && url.pathname==='/api/agents/cost-summary') {
        authorize(session,['owner']);
        const since=url.searchParams.get('since')||new Date(Date.now()-30*86400000).toISOString();
        const rows=store.db.prepare('SELECT agent_id,provider,model,COUNT(*) runs,SUM(tokens_input) tokens_input,SUM(tokens_output) tokens_output,SUM(estimated_cost) estimated_cost,SUM(used_fallback) fallback_runs FROM agent_runs WHERE started_at>=? GROUP BY agent_id,provider,model ORDER BY estimated_cost DESC').all(since);
        return send(200,{since,provider:providerStatus(env),rows});
      }
      const agentEnable=url.pathname.match(/^\/api\/agents\/([\w-]+)\/enabled$/);
      if(agentEnable) {
        authorize(session,['owner']);
        if(req.method==='POST'){const input=await body(req);const row=setEnabled(store.db,agentEnable[1],!!input.enabled);if(!row)fail(404,'وكيل غير موجود');return send(200,row);}
      }
      const agentHealth=url.pathname.match(/^\/api\/agents\/([\w-]+)\/health$/);
      if(req.method==='GET' && agentHealth)return send(200,promotionEligibility(store.db,agentHealth[1]));
      const agentRuns=url.pathname.match(/^\/api\/agents\/([\w-]+)\/runs$/);
      if(req.method==='GET' && agentRuns)return send(200,listRuns(store.db,{agentId:agentRuns[1],limit:50},session.tenantId));
      const agentRunTrigger=url.pathname.match(/^\/api\/agents\/([\w-]+)\/run$/);
      if(req.method==='POST' && agentRunTrigger) {
        authorize(session,['owner','operator']);
        checkLlmRateLimit(session.user.id);
        const input=await body(req);
        if(typeof input.scenario!=='string'||!input.scenario.trim()||input.scenario.length>4000)fail(400,'أدخل سيناريو الاختبار (حتى 4000 حرف)');
        return send(200,await agentRuntime.run(agentRunTrigger[1],{triggerType:'TEST',input:{scenario:input.scenario.trim(),current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh'},user:session.user,tenantId:session.tenantId}));
      }
      const runDetail=url.pathname.match(/^\/api\/agents\/runs\/([\w-]+)$/);
      if(req.method==='GET' && runDetail) {
        const run=getRun(store.db,runDetail[1],session.tenantId);
        if(!run)fail(404,'التشغيلة غير موجودة');
        return send(200,{...run,toolCalls:listToolCalls(store.db,runDetail[1])});
      }
      if(url.pathname==='/api/approvals') {
        if(req.method==='GET')return send(200,listApprovals(store.db,{status:url.searchParams.get('status')||undefined},session.tenantId));
      }
      const approvalDecide=url.pathname.match(/^\/api\/approvals\/([\w-]+)\/decide$/);
      if(req.method==='POST' && approvalDecide) {
        authorize(session,['owner']);
        const input=await body(req);
        const decided=decideApproval(store.db,approvalDecide[1],input.decision,session.user,session.tenantId);
        // Execution-on-approval, scoped to exactly one action type: an approved email send.
        // This is the one place in the whole Approval Center where deciding APPROVED also
        // performs the real side effect — every other approval type (memory, permission
        // changes, etc.) stays decision-only, matching the existing pattern (spec Part O:
        // "use existing Approval Center, don't duplicate logic" — this reuses it rather
        // than inventing a parallel "pending email" queue).
        if(decided.status==='APPROVED' && decided.action_type==='send_marketing_message') {
          const proposed=JSON.parse(decided.proposed_output);
          if(proposed?.to && proposed?.subject && proposed?.bodyHtml) {
            try {
             const sendResult=await sendMail({store,env,fetcher},{to:proposed.to,cc:proposed.cc,subject:proposed.subject,bodyHtml:proposed.bodyHtml});
             if(sendResult.status==='SENT' && proposed.leadId)recordChannelMessage(store,{leadId:proposed.leadId,channel:'Email',direction:'OUTBOUND',text:proposed.bodyHtml,subject:proposed.subject,cc:proposed.cc||null,messageType:'email'},session.user,session.tenantId);
             return send(200,{...decided,emailSendResult:sendResult});
            } catch(error) {
             return send(200,{...decided,emailSendResult:{status:'FAILED',errorDetail:error.message}});
            }
          }
        }
        return send(200,decided);
      }
      if(req.method==='GET' && url.pathname==='/api/escalations')return send(200,listEscalations(store.db,{status:url.searchParams.get('status')||undefined},session.tenantId));
      const escalationResolve=url.pathname.match(/^\/api\/escalations\/([\w-]+)\/resolve$/);
      if(req.method==='POST' && escalationResolve) {
        authorize(session,['owner']);
        return send(200,resolveEscalation(store.db,escalationResolve[1],session.user,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/frost/daily-brief')return send(200,buildDailyBrief({store,db:store.db,listEscalations,listRuns,buildBriefFn:buildBrief}));
      if(req.method==='GET' && url.pathname==='/api/frost/status')return send(200,{gate:getGateStatus(store.db),schedulerRunning:scheduler.running(),routes:orchestratorRoutes});
      if(req.method==='POST' && url.pathname==='/api/frost/pause') {authorize(session,['owner']);const input=await body(req);return send(200,setPaused(store.db,true,session.user,typeof input.reason==='string'?input.reason.slice(0,1000):null));}
      if(req.method==='POST' && url.pathname==='/api/frost/resume') {authorize(session,['owner']);return send(200,setPaused(store.db,false,session.user));}
      if(req.method==='POST' && url.pathname==='/api/frost/run-now') {authorize(session,['owner']);return send(200,await scheduler.tick());}
      const autonomyRoute=url.pathname.match(/^\/api\/agents\/([\w-]+)\/autonomy$/);
      if(autonomyRoute) {
        if(req.method==='GET')return send(200,listAutonomyLog(store.db,autonomyRoute[1]));
        if(req.method==='POST') {authorize(session,['owner']);return send(201,setAutonomy(store,autonomyRoute[1],await body(req),session.user,env,session.tenantId));}
      }
      if(req.method==='GET' && url.pathname==='/api/connections') return send(200,connectionStatus(env));
      if(req.method==='GET' && url.pathname==='/api/integrations/dashboard') return send(200,buildIntegrationsDashboard(store,{env,aiRuns:listAiRuns(store.db,50,session.tenantId),complianceRuns:listComplianceChecksSince(store.db,'1970-01-01T00:00:00.000Z',session.tenantId),agentRuns:listRuns(store.db,{limit:2000},session.tenantId),tenantId:session.tenantId}));
      const integrationTest=url.pathname.match(/^\/api\/integrations\/([\w-]+)\/test$/);
      if(req.method==='POST' && integrationTest) {
        authorize(session,['owner']);
        const id=integrationTest[1];
        if(id==='anthropic')return send(200,await testAnthropicConnection({env,fetcher}));
        if(id==='openai')return send(200,await testOpenAIConnection({env,fetcher}));
        if(id==='salla'){const resolved=await resolveSallaAccessToken({store,env,fetcher});return send(200,await testSallaConnection({env,fetcher,accessToken:resolved?.token}));}
        if(id==='whatsapp')return send(200,await testWhatsAppConnection({store,env,fetcher}));
        if(id==='meta')return send(200,resolveMetaAccessToken({store,env},'page')?{result:'OK'}:{result:'NOT_CONFIGURED',code:'META_NOT_CONFIGURED'});
        if(id==='microsoft365')return send(200,await testMicrosoftConnection({store,env,fetcher}));
        if(id==='x')return send(200,await testXConnection({store,env,fetcher}));
        if(id==='linkedin')return send(200,await testLinkedInConnection({store,env,fetcher}));
        return send(200,{result:'NOT_IMPLEMENTED'});
      }
      // Salla OAuth (owner only — connecting/disconnecting the store's own commerce data is
      // an ownership-level decision, same bar as any other integration credential).
      if(req.method==='GET' && url.pathname==='/api/integrations/salla/oauth/status') {
        authorize(session,['owner']);
        return send(200,sallaOAuthStatus(store.db,env));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/salla/oauth/start') {
        authorize(session,['owner']);
        res.writeHead(302,{Location:createAuthorizeUrl(env,session.user.id)});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/salla/oauth/callback') {
        authorize(session,['owner']);
        const code=url.searchParams.get('code'),state=url.searchParams.get('state');
        if(!code||!state)fail(400,'استجابة ربط سلة ناقصة (code/state)');
        consumeState(state,session.user.id);
        const tokens=await exchangeCodeForTokens({env,fetcher,code});
        saveCredentials(store.db,env,'salla',tokens,session.user);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'SALLA_OAUTH_CONNECTED',itemId:'salla',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:'/#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/salla/disconnect') {
        authorize(session,['owner']);
        disconnectSalla(store.db);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'SALLA_OAUTH_DISCONNECTED',itemId:'salla',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{disconnected:true});
      }
      if(req.method==='GET' && url.pathname==='/api/webhooks/salla/events') {
        authorize(session,['owner']);
        return send(200,listWebhookEvents(store.db,{source:'salla',limit:Number(url.searchParams.get('limit'))||50},session.tenantId));
      }
      // Meta OAuth (owner only, same bar as Salla above).
      if(req.method==='GET' && url.pathname==='/api/integrations/meta/oauth/status') {
        authorize(session,['owner']);
        return send(200,metaOAuthStatus(store.db));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/meta/oauth/start') {
        authorize(session,['owner']);
        res.writeHead(302,{Location:createMetaAuthorizeUrl(env,session.user.id)});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/meta/oauth/callback') {
        authorize(session,['owner']);
        const code=url.searchParams.get('code'),oauthState=url.searchParams.get('state');
        if(!code||!oauthState)fail(400,'استجابة ربط Meta ناقصة (code/state)');
        consumeMetaState(oauthState,session.user.id);
        const assets=await exchangeCodeAndResolveAssets({env,fetcher,code});
        saveMetaConnection(store.db,env,assets,session.user);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'META_OAUTH_CONNECTED',itemId:'meta',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:'/#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/meta/disconnect') {
        authorize(session,['owner']);
        disconnectMeta(store.db);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'META_OAUTH_DISCONNECTED',itemId:'meta',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{disconnected:true});
      }
      if(req.method==='GET' && url.pathname==='/api/webhooks/meta/events') {
        authorize(session,['owner']);
        return send(200,listWebhookEvents(store.db,{source:'meta',limit:Number(url.searchParams.get('limit'))||50},session.tenantId));
      }
      // WhatsApp templates — real approval status pulled from Meta, never invented locally.
      if(req.method==='GET' && url.pathname==='/api/whatsapp/templates') {
        authorize(session,['owner','operator']);
        return send(200,listWhatsAppTemplates(store.db,{status:url.searchParams.get('status')||undefined},session.tenantId));
      }
      if(req.method==='POST' && url.pathname==='/api/whatsapp/templates/sync') {
        authorize(session,['owner']);
        const result=await syncWhatsAppTemplates({store,env,fetcher},session.tenantId);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'WHATSAPP_TEMPLATES_SYNCED',itemId:'whatsapp',count:result.synced,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,result);
      }
      // Manual send outside the agent runtime — an owner/operator replying by hand from the
      // Shared Inbox still goes through the exact same permission/opt-out/window checks as
      // the whatsapp_send agent tool (see runtime/tools.js), never a second, looser path.
      const manualWhatsAppSend=url.pathname.match(/^\/api\/crm\/leads\/([\w-]+)\/whatsapp-send$/);
      if(req.method==='POST' && manualWhatsAppSend) {
        authorize(session,['owner','operator']);
        const id=manualWhatsAppSend[1],input=await body(req);
        const lead=getLead(store.db,id,session.tenantId);
        if(lead.optOut)fail(409,'العميل أوقف التواصل (opt-out)');
        if(lead.humanHold)fail(409,'المحادثة موقوفة بانتظار مراجعة بشرية');
        if(!lead.phone)fail(409,'لا يوجد رقم هاتف لهذا العميل');
        if(!input.templateName && !(lead.lastInboundAt && Date.now()-Date.parse(lead.lastInboundAt)<=86400000))fail(409,'خارج نافذة خدمة العملاء (24 ساعة) — استخدم قالبًا معتمدًا');
        const result=await sendWhatsAppMessage({store,env,fetcher},{to:lead.phone,text:input.text,templateName:input.templateName,templateLanguage:input.templateLanguage});
        if(result.status==='SENT')recordChannelMessage(store,{leadId:id,channel:'WhatsApp',direction:'OUTBOUND',text:input.text||`[template:${input.templateName}]`,externalMessageId:result.externalMessageId,messageType:input.templateName?'template':'text'},session.user,session.tenantId);
        return send(200,result);
      }
      // Microsoft 365 OAuth (owner only, same bar as Salla/Meta above).
      if(req.method==='GET' && url.pathname==='/api/integrations/microsoft/oauth/status') {
        authorize(session,['owner']);
        return send(200,microsoftOAuthStatus(store.db));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/microsoft/oauth/start') {
        authorize(session,['owner']);
        res.writeHead(302,{Location:createMicrosoftAuthorizeUrl(env,session.user.id)});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/microsoft/oauth/callback') {
        authorize(session,['owner']);
        const code=url.searchParams.get('code'),oauthState=url.searchParams.get('state');
        if(!code||!oauthState)fail(400,'استجابة ربط Microsoft ناقصة (code/state)');
        consumeMicrosoftState(oauthState,session.user.id);
        const tokens=await exchangeMicrosoftCodeForTokens({env,fetcher,code});
        const profile=await resolveConnectedProfile({env,fetcher,accessToken:tokens.accessToken});
        saveMicrosoftConnection(store.db,env,tokens,profile,session.user);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'MICROSOFT_CONNECTED',itemId:'microsoft365',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:'/#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/microsoft/disconnect') {
        authorize(session,['owner']);
        // Delete the webhook subscription first (best-effort) so a disconnected mailbox
        // doesn't keep sending notifications this app can no longer act on.
        const meta=getCredentialsMeta(store.db,'microsoft365');
        if(meta?.metadata?.mailSubscription?.id)await deleteMailSubscription({store,env,fetcher},meta.metadata.mailSubscription.id);
        disconnectMicrosoft(store.db);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'MICROSOFT_DISCONNECTED',itemId:'microsoft365',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{disconnected:true});
      }
      // Creates the real Graph subscription that makes /api/webhooks/microsoft/mail
      // receive anything at all — a separate, explicit step from OAuth connect, since a
      // notificationUrl only resolves correctly once PUBLIC_ORIGIN/deployment is live.
      if(req.method==='POST' && url.pathname==='/api/integrations/microsoft/subscribe') {
        authorize(session,['owner']);
        if(!env.MICROSOFT_WEBHOOK_SECRET)fail(400,'أضف MICROSOFT_WEBHOOK_SECRET في إعدادات الخادم أولًا');
        if(!publicUrl)fail(400,'يتطلب اشتراك الويبهوك نطاقًا عامًا (PUBLIC_ORIGIN) — لا يقبل Graph عناوين محلية');
        const notificationUrl=new URL('/api/webhooks/microsoft/mail',publicUrl).href;
        const subscription=await createMailSubscription({store,env,fetcher},{notificationUrl,clientState:env.MICROSOFT_WEBHOOK_SECRET});
        updateCredentialsMetadata(store.db,'microsoft365',{mailSubscription:{id:subscription.subscriptionId,expiresAt:subscription.expiresAt,resource:subscription.resource,createdAt:new Date().toISOString()}});
        recordAudit(store.db,{id:crypto.randomUUID(),action:'MICROSOFT_SUBSCRIPTION_CREATED',itemId:subscription.subscriptionId,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,subscription);
      }
      // X OAuth (owner only, same bar as Salla/Meta/Microsoft above). PKCE's code_verifier
      // never leaves the server (x-oauth.js keeps it in the same in-memory state map as the
      // CSRF nonce) — the browser round-trip only ever sees `code`/`state`.
      if(req.method==='GET' && url.pathname==='/api/integrations/x/oauth/status') {
        authorize(session,['owner']);
        return send(200,xOAuthStatus(store.db));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/x/oauth/start') {
        authorize(session,['owner']);
        res.writeHead(302,{Location:createXAuthorizeUrl(env,session.user.id)});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/x/oauth/callback') {
        authorize(session,['owner']);
        const code=url.searchParams.get('code'),oauthState=url.searchParams.get('state');
        if(!code||!oauthState)fail(400,'استجابة ربط X ناقصة (code/state)');
        const codeVerifier=consumeXState(oauthState,session.user.id);
        const tokens=await exchangeXCodeForTokens({env,fetcher,code,codeVerifier});
        const profile=await resolveXProfile({fetcher,accessToken:tokens.accessToken});
        saveXConnection(store.db,env,tokens,profile,session.user);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'X_CONNECTED',itemId:'x',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:'/#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/x/disconnect') {
        authorize(session,['owner']);
        disconnectX(store.db);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'X_DISCONNECTED',itemId:'x',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{disconnected:true});
      }
      // LinkedIn OAuth (owner only, same bar as above). Organization resolution is a real,
      // separate API call (see resolveAdministeredOrganizations) — a connection can succeed
      // as identity-only if rw_organization_admin wasn't granted, in which case publishing
      // stays INTEGRATION_REQUIRED until an organization is actually resolved.
      if(req.method==='GET' && url.pathname==='/api/integrations/linkedin/oauth/status') {
        authorize(session,['owner']);
        return send(200,linkedInOAuthStatus(store.db));
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/linkedin/oauth/start') {
        authorize(session,['owner']);
        res.writeHead(302,{Location:createLinkedInAuthorizeUrl(env,session.user.id)});return res.end();
      }
      if(req.method==='GET' && url.pathname==='/api/integrations/linkedin/oauth/callback') {
        authorize(session,['owner']);
        const code=url.searchParams.get('code'),oauthState=url.searchParams.get('state');
        if(!code||!oauthState)fail(400,'استجابة ربط LinkedIn ناقصة (code/state)');
        consumeLinkedInState(oauthState,session.user.id);
        const tokens=await exchangeLinkedInCodeForTokens({env,fetcher,code});
        const profile=await resolveLinkedInProfile({fetcher,accessToken:tokens.accessToken});
        let organization=null;
        try{organization=(await resolveAdministeredOrganizations({fetcher,accessToken:tokens.accessToken}))[0]||null;}
        catch{organization=null;} // rw_organization_admin not granted yet — connection still succeeds as identity-only.
        saveLinkedInConnection(store.db,env,tokens,profile,organization,session.user);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'LINKEDIN_CONNECTED',itemId:'linkedin',organizationId:organization?.id||null,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        if(organization)recordAudit(store.db,{id:crypto.randomUUID(),action:'LINKEDIN_ORGANIZATION_SELECTED',itemId:organization.id,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        res.writeHead(302,{Location:'/#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/linkedin/disconnect') {
        authorize(session,['owner']);
        disconnectLinkedIn(store.db);
        recordAudit(store.db,{id:crypto.randomUUID(),action:'LINKEDIN_DISCONNECTED',itemId:'linkedin',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);
        return send(200,{disconnected:true});
      }
      // Manual reply outside the agent runtime — same permission/opt-out/approval-category
      // checks as the microsoft_sendEmail agent tool, never a second, looser path.
      const manualEmailSend=url.pathname.match(/^\/api\/crm\/leads\/([\w-]+)\/email-send$/);
      if(req.method==='POST' && manualEmailSend) {
        authorize(session,['owner','operator']);
        const id=manualEmailSend[1],input=await body(req);
        const lead=getLead(store.db,id,session.tenantId);
        if(lead.optOut)fail(409,'العميل أوقف التواصل (opt-out)');
        if(lead.humanHold)fail(409,'المحادثة موقوفة بانتظار مراجعة بشرية');
        if(!lead.email)fail(409,'لا يوجد بريد إلكتروني لهذا العميل');
        if(!input.subject||!input.bodyHtml)fail(400,'العنوان والنص مطلوبان');
        const category=input.category||'general';
        if(['quote','discount','large_b2b','legal'].includes(category)) {
         const approval=createApproval(store.db,{runId:null,agentId:'human',actionType:'send_marketing_message',
          proposedOutput:{leadId:id,to:lead.email,cc:input.cc||[],subject:input.subject,bodyHtml:input.bodyHtml,category},
          riskLevel:category==='legal'?'HIGH':'MEDIUM',reason:`${session.user.name} drafted a ${category} email to ${lead.email} — requires owner approval before sending.`,tenantId:session.tenantId});
         return send(200,{status:'WAITING_APPROVAL',approvalId:approval.id});
        }
        const result=await sendMail({store,env,fetcher},{to:lead.email,cc:input.cc,subject:input.subject,bodyHtml:input.bodyHtml});
        if(result.status==='SENT')recordChannelMessage(store,{leadId:id,channel:'Email',direction:'OUTBOUND',text:input.bodyHtml,subject:input.subject,cc:input.cc||null,messageType:'email'},session.user,session.tenantId);
        return send(200,result);
      }
      if(req.method==='GET' && url.pathname==='/api/memory') return send(200,listMemory(store.db,session.tenantId));
      if(req.method==='GET' && url.pathname==='/api/memory/dashboard') return send(200,buildMemoryWorkspace(store,{pendingApprovals:listApprovals(store.db,{status:'PENDING'},session.tenantId).filter(a=>a.action_type==='memory_policy_change')}));
      if(req.method==='GET' && url.pathname==='/api/memory/usage') return send(200,computeMemoryUsage(store.db,url.searchParams.get('key')||''));
      if(req.method==='POST' && url.pathname==='/api/memory') {
        authorize(session,['owner']);
        const input=await body(req);
        return send(201,store.mutate(()=>{const entry=saveMemory(store.db,input,session.user,session.tenantId);recordAudit(store.db,{id:crypto.randomUUID(),action:'MEMORY_VERSION_SAVED',itemId:entry.id,actorId:session.user.id,actorName:session.user.name,at:entry.verifiedAt},session.tenantId);return entry;}));
      }
      if(req.method==='POST' && url.pathname==='/api/memory/propose') {
        authorize(session,['owner','operator']);
        return send(201,proposeMemoryUpdate(store.db,await body(req),session.user,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/products') return send(200,listProducts(store.db,session.tenantId));
      if(req.method==='POST' && url.pathname==='/api/salla/sync') {
        authorize(session,['owner']);
        if(syncing)fail(409,'مزامنة سلة قيد التنفيذ');
        syncing=true;
        try{const resolved=await resolveSallaAccessToken({store,env,fetcher});const products=await importSalla({env,fetcher,accessToken:resolved?.token});store.mutate(()=>{replaceProducts(store.db,products,false,session.tenantId);recordAudit(store.db,{id:crypto.randomUUID(),action:'SALLA_CATALOG_SYNCED',itemId:'catalog',count:products.length,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);});return send(200,{count:products.length,syncedAt:new Date().toISOString()});}
        catch(error){recordAudit(store.db,{id:crypto.randomUUID(),action:'SALLA_CATALOG_SYNC_FAILED',itemId:'catalog',errorCode:error instanceof ConnectorError?error.code:'UNKNOWN',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()},session.tenantId);throw error;}
        finally{syncing=false;}
      }
      if(req.method==='GET' && url.pathname==='/api/ai/runs') return send(200,listAiRuns(store.db,50,session.tenantId));
      if(req.method==='GET' && url.pathname==='/api/content/dashboard') return send(200,buildContentWorkspace(store,{complianceByContent:latestComplianceByContent(store.db,session.tenantId),tenantId:session.tenantId}));
      if(req.method==='POST' && url.pathname==='/api/ai/draft') {
        authorize(session,['owner','operator']);
        checkLlmRateLimit(session.user.id);
        return send(200,await generate(await body(req),session.user,session.tenantId));
      }
      if(req.method==='GET' && url.pathname==='/api/state') return send(200,{...store.read(),content:listContent(store.db,session?.tenantId),audit:listAuditLog(store.db,{tenantId:session?.tenantId})});
      if(url.pathname.startsWith('/api/crm')) {
        authorize(session,['owner','operator']);
        if(req.method==='GET' && url.pathname==='/api/crm')return send(200,{leads:listLeads(store.db,session.tenantId),followups:listFollowups(store.db,session.tenantId),sequences:Object.entries(sequences).map(([id,sequence])=>({id,name:sequence.name,stages:sequence.stages})),staff:store.db.prepare("SELECT id,name,role FROM users WHERE role IN ('owner','operator') ORDER BY name").all(),channelsConnected:false});
        if(req.method==='GET' && url.pathname==='/api/crm/dashboard')return send(200,buildSalesDashboard(store,{agentRuns:listRuns(store.db,{limit:2000},session.tenantId),env,tenantId:session.tenantId}));
        if(req.method==='GET' && url.pathname==='/api/crm/search')return send(200,searchLeads(store.db,url.searchParams.get('q'),20,session.tenantId));
        if(req.method==='POST' && url.pathname==='/api/crm/leads'){const lead=createLead(store,await body(req),session.user,session.tenantId);eventBus.emit('LEAD_CREATED',{leadId:lead.id,customerType:lead.customerType,sourceType:lead.sourceType,tenantId:session.tenantId});return send(201,lead);}
        if(req.method==='POST' && url.pathname==='/api/crm/followups/prepare'){authorize(session,['owner']);return send(200,prepareFollowups(store,session.user,Date.now(),session.tenantId));}
        const approval=url.pathname.match(/^\/api\/crm\/followups\/([\w-]+)\/approve$/);
        if(req.method==='POST' && approval){authorize(session,['owner']);return send(200,approveFollowup(store,approval[1],session.user,session.tenantId));}
        const leadRoute=url.pathname.match(/^\/api\/crm\/leads\/([\w-]+)(?:\/(update|messages|contact|followups|stop-followups))?$/);
        if(leadRoute){
          if(req.method==='GET' && !leadRoute[2])return send(200,leadDetail(store.db,leadRoute[1],session.tenantId));
          if(req.method==='POST'){
            const input=await body(req),id=leadRoute[1],user=session.user;
            if(leadRoute[2]==='update'){
              const before=getLead(store.db,id,session.tenantId);
              const updated=updateLead(store,id,input,user,session.tenantId);
              maybeEscalateHotLead(store,eventBus,before,updated,{agentId:'human',tenantId:session.tenantId});
              return send(200,updated);
            }
            if(leadRoute[2]==='messages'){
              const message=recordMessage(store,id,input,user,session.tenantId);
              if(!message.replayed && message.direction==='INBOUND'){
                eventBus.emit('CUSTOMER_MESSAGE_RECEIVED',{leadId:id,channel:message.channel,text:message.text,tenantId:session.tenantId});
                if(message.optedOut)eventBus.emit('CUSTOMER_OPTED_OUT',{leadId:id,channel:message.channel,tenantId:session.tenantId});
              }
              return send(201,message);
            }
            if(leadRoute[2]==='contact')return send(200,contactControl(store,id,input,user,session.tenantId));
            if(leadRoute[2]==='followups')return send(201,createFollowups(store,id,input,user,session.tenantId));
            if(leadRoute[2]==='stop-followups')return send(200,cancelFollowups(store,id,user,session.tenantId));
          }
        }
        fail(404,'مسار CRM غير موجود');
      }
      if(req.method==='GET' && url.pathname==='/api/planning') {
        const publishingIntegrations=integrationStatus(env,store.db);
        return send(200,{slots:listSlots(store.db,session?.tenantId),jobs:listJobs(store.db,session?.tenantId),brief:buildBrief(store,undefined,session?.tenantId),savedBriefs:store.db.prepare('SELECT json FROM daily_briefs ORDER BY date DESC LIMIT 14').all().map(row=>JSON.parse(row.json)),today:riyadhDate(),automationConfigured:!!(env.AUTOMATION_TOKEN?.length>=32),publishingConnected:['meta','x','linkedin'].some(id=>publishingIntegrations[id]?.configured)});
      }
      if(req.method==='POST' && url.pathname==='/api/calendar') {authorize(session,['owner','operator']);return send(201,createCalendar(store,(await body(req)).startDate,session.user,session.tenantId));}
      if(req.method==='POST' && url.pathname==='/api/schedule') {authorize(session,['owner']);return send(201,scheduleContent(store,await body(req),session.user,undefined,session.tenantId));}
      if(req.method==='POST' && url.pathname==='/api/schedule/prepare') {authorize(session,['owner']);return send(200,prepareDue(store,session.user,Date.now(),eventBus,env,session.tenantId));}
      if(req.method==='POST' && url.pathname==='/api/brief') {authorize(session,['owner']);return send(200,saveDailyBrief(store,riyadhDate(),session.user,session.tenantId));}
      if(req.method==='GET' && url.pathname==='/api/reports/weekly')return send(200,{current:buildExecutiveReport(store,currentWeekStart(),{...reportExtras(session.tenantId),tenantId:session.tenantId}),saved:listWeeklyReports(store.db,session.tenantId)});
      if(req.method==='POST' && url.pathname==='/api/reports/weekly') {authorize(session,['owner']);const input=await body(req);return send(201,saveWeeklyReport(store,input.weekStart||currentWeekStart(),session.user,reportExtras(session.tenantId),session.tenantId));}
      if(req.method==='POST' && url.pathname==='/api/schedule/cancel') {authorize(session,['owner']);const input=await body(req);if(typeof input.contentId!=='string')fail(400,'معرف المحتوى مطلوب');return send(200,store.mutate(state=>cancelJobs(store,state,input.contentId,session.user,session.tenantId)));}
      const log=(action,item)=>recordAudit(store.db,{id:crypto.randomUUID(),action,itemId:item.id,actorId:session.user.id,actorName:session.user.name,actorRole:session.user.role,at:new Date().toISOString()},session.tenantId);
      if(req.method==='POST' && url.pathname==='/api/content') {
        authorize(session,['owner','operator']);
        const input=await body(req);
        return send(201,store.mutate(()=>{const item={...createContent(input),createdBy:session.user.id};insertContent(store.db,item,session.tenantId);log('DRAFT_CREATED',item);return item;}));
      }
      const change=url.pathname.match(/^\/api\/content\/([\w-]+)\/(revise|reject)$/);
      if(req.method==='POST' && change) {
        authorize(session,change[2]==='revise'?['owner','operator']:['owner','reviewer']);
        const input=await body(req);
        if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000)fail(400,'سبب التعديل أو الرفض مطلوب (حتى 1000 حرف)');
        return send(200,store.mutate(state=>{
          const current=getContent(store.db,change[1],session.tenantId);
          if(current.status==='SUPERSEDED')fail(409,'توجد نسخة أحدث من هذا المحتوى');
          if(current.status==='APPROVED' && session.user.role!=='owner')fail(403,'تغيير المحتوى المعتمد متاح للمالك فقط');
          if(change[2]==='reject' && current.status==='REJECTED')fail(409,'المحتوى مرفوض بالفعل');
          const revised=change[2]==='revise'?{...createContent(input),createdBy:session.user.id,parentId:current.id,revision:(current.revision||1)+1}:null;
          cancelJobs(store,state,current.id,session.user,session.tenantId);
          current.status=revised?'SUPERSEDED':'REJECTED';current.changeReason=input.reason.trim();current.changedBy=session.user.id;
          writeContent(store.db,current);
          if(revised)insertContent(store.db,revised,session.tenantId);
          log(revised?'CONTENT_REVISED':'CONTENT_REJECTED',current);return revised||current;
        }));
      }
      const match=url.pathname.match(/^\/api\/content\/([\w-]+)\/(review|approve)$/);
      if(req.method==='POST' && match) {
        authorize(session,match[2]==='review'?['owner','reviewer']:['owner']);
        const input=await body(req);
        return send(200,store.mutate(()=>{
          const current=getContent(store.db,match[1],session.tenantId);
          if(match[2]==='approve' && (!current.review?.userId || current.legacyUnauthenticated)) fail(409,'المراجعة القديمة غير موثقة بحساب؛ أنشئ مسودة جديدة للمراجعة');
          const item=match[2]==='review'?reviewContent(current,{...input,reviewer:session.user.name}):approveContent(current,{owner:session.user.name});
          if(match[2]==='review') {item.review.userId=session.user.id;item.legacyUnauthenticated=false;} else item.approval.userId=session.user.id;
          writeContent(store.db,item);log(match[2]==='review'?'COMPLIANCE_REVIEWED':'OWNER_APPROVED',item);
          if(match[2]==='approve')queueMicrotask(()=>eventBus.emit('CONTENT_APPROVED',{contentId:item.id,platform:item.platform,tenantId:session.tenantId}));
          return item;
        }));
      }
      const compliance=url.pathname.match(/^\/api\/content\/([\w-]+)\/compliance$/);
      if(compliance) {
        authorize(session,['owner','reviewer']);
        if(req.method==='GET')return send(200,listComplianceChecks(store.db,compliance[1],session.tenantId));
        if(req.method==='POST') {
          checkLlmRateLimit(session.user.id);
          return send(200,await checkCompliance(compliance[1],await body(req),session.user,session.tenantId));
        }
      }
      const files={'/favicon.svg':'favicon.svg','/':'index.html','/app.js':'app.js','/knowledge.js':'knowledge.js','/planning.js':'planning.js','/crm.js':'crm.js','/compliance.js':'compliance.js','/autonomy.js':'autonomy.js','/reporting.js':'reporting.js','/format.js':'format.js','/content.js':'content.js','/memory.js':'memory.js','/integrations.js':'integrations.js','/team.js':'team.js','/style.css':'style.css','/site.webmanifest':'site.webmanifest','/i18n.js':'i18n.js','/icons/icon-192.png':'icons/icon-192.png','/icons/icon-512.png':'icons/icon-512.png','/icons/icon-maskable-512.png':'icons/icon-maskable-512.png','/icons/apple-touch-icon.png':'icons/apple-touch-icon.png'};
      for(const file of ['components/ui/index.js','components/layout/app-shell.js','pages/workspace.js',...['fonts','tokens','base','components','layout','pages'].map(name=>'styles/'+name+'.css')])files['/'+file]=file;
      for(const loc of ['ar','en'])for(const domain of ['common','navigation','overview','sales','calendar','weeklyReport','content','agents','memory','integrations','operationsLog','team','forms','validation','statuses','errors'])files[`/locales/${loc}/${domain}.json`]=`locales/${loc}/${domain}.json`;
      for(const weight of [400,500,600,700])for(const subset of ['arabic','latin'])files[`/fonts/ibm-plex-sans-arabic-${weight}-${subset}.woff2`]=`fonts/ibm-plex-sans-arabic-${weight}-${subset}.woff2`;
      if(req.method==='GET' && files[url.pathname]) {
        const file=files[url.pathname];
        const contents=await readFile(new URL('../public/'+file,import.meta.url));
        const type=file.endsWith('.svg')?'image/svg+xml':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.woff2')?'font/woff2':file.endsWith('.webmanifest')?'application/manifest+json':file.endsWith('.png')?'image/png':file.endsWith('.json')?'application/json; charset=utf-8':'text/html; charset=utf-8';
        const headers={'Content-Type':type,'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
        if(file.endsWith('.woff2')||file.endsWith('.png'))headers['Cache-Control']='public, max-age=31536000, immutable';
        res.writeHead(200,headers);
        return res.end(contents);
      }
      send(404,{error:'Not found'});
    } catch(error) {send(error instanceof ConnectorError?502:error.status||400,{error:error.message});}
  });
  return {server,store,scheduler};
}
export async function startServer() {
  console.log('HyperCool: initializing application');
  try{loadEnvFile(fileURLToPath(new URL('../.env',import.meta.url)));}catch(error){if(error.code!=='ENOENT')throw error;}
  validateEnv(process.env);
  const {server,scheduler}=await createApp();
  const port=Number(process.env.PORT||3000);
  server.on('error',error=>{console.error('Server startup failed:',error);process.exitCode=1;});
  server.listen(port,process.env.HOST||(process.env.PUBLIC_ORIGIN?'0.0.0.0':'127.0.0.1'),()=>{
    console.log(`HyperCool: http://localhost:${port}`);
    scheduler.start();
    console.log('Agent scheduler running — daily brief 08:00, weekly report Sunday, follow-up gap sweep every tick (Asia/Riyadh).');
  });
}
