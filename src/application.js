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
import {installCRM,listLeads,leadDetail,listFollowups,sequences,createLead,updateLead,recordMessage,contactControl,createFollowups,approveFollowup,prepareFollowups,cancelFollowups,searchLeads} from './crm.js';
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
import {installApprovals,listApprovals,decideApproval} from './runtime/approvals.js';
import {installEscalations,listEscalations,resolveEscalation} from './runtime/escalations.js';
import {installOrchestrator,buildDailyBrief} from './runtime/orchestrator.js';
import {integrationStatus,AGENT_INTEGRATIONS} from './runtime/tools.js';
import {providerStatus} from './runtime/llmProvider.js';
import {promotionEligibility} from './runtime/permissions.js';
import {installGate,getGateStatus,setPaused,isPaused} from './runtime/gate.js';
import {createScheduler} from './runtime/scheduler.js';
import {installCredentials,saveCredentials,credentialsConfigured} from './runtime/credentials.js';
import {createAuthorizeUrl,consumeState,exchangeCodeForTokens,sallaOAuthStatus,disconnectSalla,resolveSallaAccessToken} from './runtime/salla-oauth.js';
import {installWebhookEvents,verifySallaWebhook,processSallaWebhook,listWebhookEvents} from './runtime/salla-webhooks.js';

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
  ['WhatsApp',['WHATSAPP_ACCESS_TOKEN'],!!env.WHATSAPP_ACCESS_TOKEN],
  ['Meta (Instagram/Facebook)',['META_ACCESS_TOKEN'],!!env.META_ACCESS_TOKEN],
  ['X',['X_BEARER_TOKEN'],!!env.X_BEARER_TOKEN],
  ['LinkedIn',['LINKEDIN_ACCESS_TOKEN'],!!env.LINKEDIN_ACCESS_TOKEN],
  ['Microsoft 365',['MICROSOFT_ACCESS_TOKEN'],!!env.MICROSOFT_ACCESS_TOKEN],
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
  seedRegistry(store.db);
  const eventBus=createEventBus(store.db);
  const agentRuntime=createAgentRuntime({store,env,fetcher,eventBus});
  const {routes:orchestratorRoutes}=installOrchestrator(eventBus,agentRuntime,store.db);
  function reportExtras() {
    return {agents:listRegistryAgents(store.db),agentRuns:listRuns(store.db,{limit:2000}),escalations:listEscalations(store.db),approvals:listApprovals(store.db),env};
  }
  const scheduler=createScheduler({store,agentRuntime,env,getExtras:reportExtras});
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
        if(req.method==='POST' && url.pathname==='/api/automation/prepare-due')return send(200,prepareDue(store,actor));
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
        return send(200,processSallaWebhook({db:store.db,eventBus,body:payload}));
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
        const integrations=integrationStatus(env);
        for(const [name,status] of Object.entries(integrations))dependencies['integration_'+name]=status.configured?'configured':'not_configured';
        const coreOk=dependencies.database==='ok';
        return send(coreOk?200:503,{status:coreOk?'ready':'not_ready',core_status:coreOk?'ok':'degraded',dependencies,timestamp:new Date().toISOString(),version:packageVersion});
      }
      const session=auth.current(req);
      userId=session?.user?.id||null;
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
          store.mutate(state=>{state.audit.unshift({id:crypto.randomUUID(),action:'USER_CREATED',itemId:created.id,actorId:session.user.id,actorName:session.user.name,actorRole:session.user.role,at:new Date().toISOString()});});
          return send(201,created);
        }
      }
      if(req.method==='GET' && url.pathname==='/api/team/dashboard') {
        authorize(session,['owner']);
        return send(200,buildTeamDashboard(store.db,{auditEntries:store.read().audit}));
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
        store.mutate(state=>{state.audit.unshift({id:crypto.randomUUID(),action:auditAction,itemId:id,itemName,actorId:session.user.id,actorName:session.user.name,actorRole:session.user.role,at:new Date().toISOString()});});
        return send(200,action==='remove'?{ok:true}:auth.get(id)||{ok:true});
      }
      if(req.method==='GET' && url.pathname==='/api/agents') {
        const autonomy=currentAutonomy(store.db);
        const integrations=integrationStatus(env);
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
          const recentRuns=listRuns(store.db,{agentId:agent.id,limit:10});
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
      if(req.method==='GET' && agentRuns)return send(200,listRuns(store.db,{agentId:agentRuns[1],limit:50}));
      const agentRunTrigger=url.pathname.match(/^\/api\/agents\/([\w-]+)\/run$/);
      if(req.method==='POST' && agentRunTrigger) {
        authorize(session,['owner','operator']);
        checkLlmRateLimit(session.user.id);
        const input=await body(req);
        if(typeof input.scenario!=='string'||!input.scenario.trim()||input.scenario.length>4000)fail(400,'أدخل سيناريو الاختبار (حتى 4000 حرف)');
        return send(200,await agentRuntime.run(agentRunTrigger[1],{triggerType:'TEST',input:{scenario:input.scenario.trim(),current_datetime:new Date().toISOString(),timezone:'Asia/Riyadh'},user:session.user}));
      }
      const runDetail=url.pathname.match(/^\/api\/agents\/runs\/([\w-]+)$/);
      if(req.method==='GET' && runDetail) {
        const run=getRun(store.db,runDetail[1]);
        if(!run)fail(404,'التشغيلة غير موجودة');
        return send(200,{...run,toolCalls:listToolCalls(store.db,runDetail[1])});
      }
      if(url.pathname==='/api/approvals') {
        if(req.method==='GET')return send(200,listApprovals(store.db,{status:url.searchParams.get('status')||undefined}));
      }
      const approvalDecide=url.pathname.match(/^\/api\/approvals\/([\w-]+)\/decide$/);
      if(req.method==='POST' && approvalDecide) {
        authorize(session,['owner']);
        const input=await body(req);
        return send(200,decideApproval(store.db,approvalDecide[1],input.decision,session.user));
      }
      if(req.method==='GET' && url.pathname==='/api/escalations')return send(200,listEscalations(store.db,{status:url.searchParams.get('status')||undefined}));
      const escalationResolve=url.pathname.match(/^\/api\/escalations\/([\w-]+)\/resolve$/);
      if(req.method==='POST' && escalationResolve) {
        authorize(session,['owner']);
        return send(200,resolveEscalation(store.db,escalationResolve[1],session.user));
      }
      if(req.method==='GET' && url.pathname==='/api/frost/daily-brief')return send(200,buildDailyBrief({store,db:store.db,listEscalations,listRuns,buildBriefFn:buildBrief}));
      if(req.method==='GET' && url.pathname==='/api/frost/status')return send(200,{gate:getGateStatus(store.db),schedulerRunning:scheduler.running(),routes:orchestratorRoutes});
      if(req.method==='POST' && url.pathname==='/api/frost/pause') {authorize(session,['owner']);const input=await body(req);return send(200,setPaused(store.db,true,session.user,typeof input.reason==='string'?input.reason.slice(0,1000):null));}
      if(req.method==='POST' && url.pathname==='/api/frost/resume') {authorize(session,['owner']);return send(200,setPaused(store.db,false,session.user));}
      if(req.method==='POST' && url.pathname==='/api/frost/run-now') {authorize(session,['owner']);return send(200,await scheduler.tick());}
      const autonomyRoute=url.pathname.match(/^\/api\/agents\/([\w-]+)\/autonomy$/);
      if(autonomyRoute) {
        if(req.method==='GET')return send(200,listAutonomyLog(store.db,autonomyRoute[1]));
        if(req.method==='POST') {authorize(session,['owner']);return send(201,setAutonomy(store,autonomyRoute[1],await body(req),session.user));}
      }
      if(req.method==='GET' && url.pathname==='/api/connections') return send(200,connectionStatus(env));
      if(req.method==='GET' && url.pathname==='/api/integrations/dashboard') return send(200,buildIntegrationsDashboard(store,{env,aiRuns:listAiRuns(store.db),complianceRuns:listComplianceChecksSince(store.db,'1970-01-01T00:00:00.000Z'),agentRuns:listRuns(store.db,{limit:2000})}));
      const integrationTest=url.pathname.match(/^\/api\/integrations\/([\w-]+)\/test$/);
      if(req.method==='POST' && integrationTest) {
        authorize(session,['owner']);
        const id=integrationTest[1];
        if(id==='anthropic')return send(200,await testAnthropicConnection({env,fetcher}));
        if(id==='openai')return send(200,await testOpenAIConnection({env,fetcher}));
        if(id==='salla'){const resolved=await resolveSallaAccessToken({store,env,fetcher});return send(200,await testSallaConnection({env,fetcher,accessToken:resolved?.token}));}
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
        store.mutate(state=>{state.audit.unshift({id:crypto.randomUUID(),action:'SALLA_OAUTH_CONNECTED',itemId:'salla',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});});
        res.writeHead(302,{Location:'/#integrations'});return res.end();
      }
      if(req.method==='POST' && url.pathname==='/api/integrations/salla/disconnect') {
        authorize(session,['owner']);
        disconnectSalla(store.db);
        store.mutate(state=>{state.audit.unshift({id:crypto.randomUUID(),action:'SALLA_OAUTH_DISCONNECTED',itemId:'salla',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});});
        return send(200,{disconnected:true});
      }
      if(req.method==='GET' && url.pathname==='/api/webhooks/salla/events') {
        authorize(session,['owner']);
        return send(200,listWebhookEvents(store.db,{source:'salla',limit:Number(url.searchParams.get('limit'))||50}));
      }
      if(req.method==='GET' && url.pathname==='/api/memory') return send(200,listMemory(store.db));
      if(req.method==='GET' && url.pathname==='/api/memory/dashboard') return send(200,buildMemoryWorkspace(store,{pendingApprovals:listApprovals(store.db,{status:'PENDING'}).filter(a=>a.action_type==='memory_policy_change')}));
      if(req.method==='GET' && url.pathname==='/api/memory/usage') return send(200,computeMemoryUsage(store.db,url.searchParams.get('key')||''));
      if(req.method==='POST' && url.pathname==='/api/memory') {
        authorize(session,['owner']);
        const input=await body(req);
        return send(201,store.mutate(state=>{const entry=saveMemory(store.db,input,session.user);state.audit.unshift({id:crypto.randomUUID(),action:'MEMORY_VERSION_SAVED',itemId:entry.id,actorId:session.user.id,actorName:session.user.name,at:entry.verifiedAt});return entry;}));
      }
      if(req.method==='POST' && url.pathname==='/api/memory/propose') {
        authorize(session,['owner','operator']);
        return send(201,proposeMemoryUpdate(store.db,await body(req),session.user));
      }
      if(req.method==='GET' && url.pathname==='/api/products') return send(200,listProducts(store.db));
      if(req.method==='POST' && url.pathname==='/api/salla/sync') {
        authorize(session,['owner']);
        if(syncing)fail(409,'مزامنة سلة قيد التنفيذ');
        syncing=true;
        try{const resolved=await resolveSallaAccessToken({store,env,fetcher});const products=await importSalla({env,fetcher,accessToken:resolved?.token});store.mutate(state=>{replaceProducts(store.db,products,false);state.audit.unshift({id:crypto.randomUUID(),action:'SALLA_CATALOG_SYNCED',itemId:'catalog',count:products.length,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});});return send(200,{count:products.length,syncedAt:new Date().toISOString()});}
        catch(error){store.mutate(state=>{state.audit.unshift({id:crypto.randomUUID(),action:'SALLA_CATALOG_SYNC_FAILED',itemId:'catalog',errorCode:error instanceof ConnectorError?error.code:'UNKNOWN',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});});throw error;}
        finally{syncing=false;}
      }
      if(req.method==='GET' && url.pathname==='/api/ai/runs') return send(200,listAiRuns(store.db));
      if(req.method==='GET' && url.pathname==='/api/content/dashboard') return send(200,buildContentWorkspace(store,{complianceByContent:latestComplianceByContent(store.db)}));
      if(req.method==='POST' && url.pathname==='/api/ai/draft') {
        authorize(session,['owner','operator']);
        checkLlmRateLimit(session.user.id);
        return send(200,await generate(await body(req),session.user));
      }
      if(req.method==='GET' && url.pathname==='/api/state') return send(200,store.read());
      if(url.pathname.startsWith('/api/crm')) {
        authorize(session,['owner','operator']);
        if(req.method==='GET' && url.pathname==='/api/crm')return send(200,{leads:listLeads(store.db),followups:listFollowups(store.db),sequences:Object.entries(sequences).map(([id,sequence])=>({id,name:sequence.name,stages:sequence.stages})),staff:store.db.prepare("SELECT id,name,role FROM users WHERE role IN ('owner','operator') ORDER BY name").all(),channelsConnected:false});
        if(req.method==='GET' && url.pathname==='/api/crm/dashboard')return send(200,buildSalesDashboard(store,{agentRuns:listRuns(store.db,{limit:2000}),env}));
        if(req.method==='GET' && url.pathname==='/api/crm/search')return send(200,searchLeads(store.db,url.searchParams.get('q')));
        if(req.method==='POST' && url.pathname==='/api/crm/leads'){const lead=createLead(store,await body(req),session.user);eventBus.emit('LEAD_CREATED',{leadId:lead.id,customerType:lead.customerType,sourceType:lead.sourceType});return send(201,lead);}
        if(req.method==='POST' && url.pathname==='/api/crm/followups/prepare'){authorize(session,['owner']);return send(200,prepareFollowups(store,session.user));}
        const approval=url.pathname.match(/^\/api\/crm\/followups\/([\w-]+)\/approve$/);
        if(req.method==='POST' && approval){authorize(session,['owner']);return send(200,approveFollowup(store,approval[1],session.user));}
        const leadRoute=url.pathname.match(/^\/api\/crm\/leads\/([\w-]+)(?:\/(update|messages|contact|followups|stop-followups))?$/);
        if(leadRoute){
          if(req.method==='GET' && !leadRoute[2])return send(200,leadDetail(store.db,leadRoute[1]));
          if(req.method==='POST'){
            const input=await body(req),id=leadRoute[1],user=session.user;
            if(leadRoute[2]==='update')return send(200,updateLead(store,id,input,user));
            if(leadRoute[2]==='messages'){
              const message=recordMessage(store,id,input,user);
              if(!message.replayed && message.direction==='INBOUND')eventBus.emit('CUSTOMER_MESSAGE_RECEIVED',{leadId:id,channel:message.channel,text:message.text});
              return send(201,message);
            }
            if(leadRoute[2]==='contact')return send(200,contactControl(store,id,input,user));
            if(leadRoute[2]==='followups')return send(201,createFollowups(store,id,input,user));
            if(leadRoute[2]==='stop-followups')return send(200,cancelFollowups(store,id,user));
          }
        }
        fail(404,'مسار CRM غير موجود');
      }
      if(req.method==='GET' && url.pathname==='/api/planning')return send(200,{slots:listSlots(store.db),jobs:listJobs(store.db),brief:buildBrief(store),savedBriefs:store.db.prepare('SELECT json FROM daily_briefs ORDER BY date DESC LIMIT 14').all().map(row=>JSON.parse(row.json)),today:riyadhDate(),automationConfigured:!!(env.AUTOMATION_TOKEN?.length>=32),publishingConnected:false});
      if(req.method==='POST' && url.pathname==='/api/calendar') {authorize(session,['owner','operator']);return send(201,createCalendar(store,(await body(req)).startDate,session.user));}
      if(req.method==='POST' && url.pathname==='/api/schedule') {authorize(session,['owner']);return send(201,scheduleContent(store,await body(req),session.user));}
      if(req.method==='POST' && url.pathname==='/api/schedule/prepare') {authorize(session,['owner']);return send(200,prepareDue(store,session.user));}
      if(req.method==='POST' && url.pathname==='/api/brief') {authorize(session,['owner']);return send(200,saveDailyBrief(store,riyadhDate(),session.user));}
      if(req.method==='GET' && url.pathname==='/api/reports/weekly')return send(200,{current:buildExecutiveReport(store,currentWeekStart(),reportExtras()),saved:listWeeklyReports(store.db)});
      if(req.method==='POST' && url.pathname==='/api/reports/weekly') {authorize(session,['owner']);const input=await body(req);return send(201,saveWeeklyReport(store,input.weekStart||currentWeekStart(),session.user,reportExtras()));}
      if(req.method==='POST' && url.pathname==='/api/schedule/cancel') {authorize(session,['owner']);const input=await body(req);if(typeof input.contentId!=='string')fail(400,'معرف المحتوى مطلوب');return send(200,store.mutate(state=>cancelJobs(store,state,input.contentId,session.user)));}
      const log=(next,action,item)=>next.audit.unshift({id:crypto.randomUUID(),action,itemId:item.id,actorId:session.user.id,actorName:session.user.name,actorRole:session.user.role,at:new Date().toISOString()});
      if(req.method==='POST' && url.pathname==='/api/content') {
        authorize(session,['owner','operator']);
        const input=await body(req);
        return send(201,store.mutate(next=>{const item={...createContent(input),createdBy:session.user.id};next.content.unshift(item);log(next,'DRAFT_CREATED',item);return item;}));
      }
      const change=url.pathname.match(/^\/api\/content\/([\w-]+)\/(revise|reject)$/);
      if(req.method==='POST' && change) {
        authorize(session,change[2]==='revise'?['owner','operator']:['owner','reviewer']);
        const input=await body(req);
        if(typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>1000)fail(400,'سبب التعديل أو الرفض مطلوب (حتى 1000 حرف)');
        return send(200,store.mutate(state=>{
          const current=state.content.find(item=>item.id===change[1]);if(!current)fail(404,'المحتوى غير موجود');
          if(current.status==='SUPERSEDED')fail(409,'توجد نسخة أحدث من هذا المحتوى');
          if(current.status==='APPROVED' && session.user.role!=='owner')fail(403,'تغيير المحتوى المعتمد متاح للمالك فقط');
          if(change[2]==='reject' && current.status==='REJECTED')fail(409,'المحتوى مرفوض بالفعل');
          const revised=change[2]==='revise'?{...createContent(input),createdBy:session.user.id,parentId:current.id,revision:(current.revision||1)+1}:null;
          cancelJobs(store,state,current.id,session.user);
          current.status=revised?'SUPERSEDED':'REJECTED';current.changeReason=input.reason.trim();current.changedBy=session.user.id;
          if(revised)state.content.unshift(revised);
          log(state,revised?'CONTENT_REVISED':'CONTENT_REJECTED',current);return revised||current;
        }));
      }
      const match=url.pathname.match(/^\/api\/content\/([\w-]+)\/(review|approve)$/);
      if(req.method==='POST' && match) {
        authorize(session,match[2]==='review'?['owner','reviewer']:['owner']);
        const input=await body(req);
        return send(200,store.mutate(next=>{
          const index=next.content.findIndex(item=>item.id===match[1]);
          if(index<0) fail(404,'المحتوى غير موجود');
          const current=next.content[index];
          if(match[2]==='approve' && (!current.review?.userId || current.legacyUnauthenticated)) fail(409,'المراجعة القديمة غير موثقة بحساب؛ أنشئ مسودة جديدة للمراجعة');
          const item=match[2]==='review'?reviewContent(current,{...input,reviewer:session.user.name}):approveContent(current,{owner:session.user.name});
          if(match[2]==='review') {item.review.userId=session.user.id;item.legacyUnauthenticated=false;} else item.approval.userId=session.user.id;
          next.content[index]=item;log(next,match[2]==='review'?'COMPLIANCE_REVIEWED':'OWNER_APPROVED',item);
          if(match[2]==='approve')queueMicrotask(()=>eventBus.emit('CONTENT_APPROVED',{contentId:item.id,platform:item.platform}));
          return item;
        }));
      }
      const compliance=url.pathname.match(/^\/api\/content\/([\w-]+)\/compliance$/);
      if(compliance) {
        authorize(session,['owner','reviewer']);
        if(req.method==='GET')return send(200,listComplianceChecks(store.db,compliance[1]));
        if(req.method==='POST') {
          checkLlmRateLimit(session.user.id);
          return send(200,await checkCompliance(compliance[1],await body(req),session.user));
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
