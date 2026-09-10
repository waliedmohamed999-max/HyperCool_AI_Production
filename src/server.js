import http from 'node:http';
import {readFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {createContent,reviewContent,approveContent} from './domain.js';
import {openStore} from './store.js';
import {createAuth,authorize,fail} from './auth.js';
import {agentDefinitions} from './agents.js';
import {installKnowledge,listMemory,saveMemory,proposeMemoryUpdate,listProducts,replaceProducts} from './knowledge.js';
import {connectionStatus,importSalla,ConnectorError,testAnthropicConnection,testSallaConnection} from './connectors.js';
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
import {installRegistry,seedRegistry,listAgents as listRegistryAgents,getAgent,setEnabled} from './runtime/registry.js';
import {installRuntimeTables,createAgentRuntime,listRuns,getRun,listToolCalls} from './runtime/runtime.js';
import {installEvents,createEventBus} from './runtime/events.js';
import {installApprovals,listApprovals,decideApproval} from './runtime/approvals.js';
import {installEscalations,listEscalations,resolveEscalation} from './runtime/escalations.js';
import {installOrchestrator,buildDailyBrief} from './runtime/orchestrator.js';
import {integrationStatus,AGENT_INTEGRATIONS} from './runtime/tools.js';
import {providerStatus} from './runtime/llmProvider.js';
import {promotionEligibility} from './runtime/permissions.js';
import {installGate,getGateStatus,setPaused} from './runtime/gate.js';
import {createScheduler} from './runtime/scheduler.js';

export async function createApp({dataDir=fileURLToPath(new URL('../data/',import.meta.url)),env=process.env,fetcher=fetch}={}) {
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
  async function body(req) {
    if(!req.headers['content-type']?.startsWith('application/json')) fail(415,'JSON مطلوب');
    let value='';
    for await(const chunk of req) {value+=chunk; if(Buffer.byteLength(value)>64000) fail(413,'الطلب كبير جدًا');}
    let parsed;try {parsed=JSON.parse(value||'{}');} catch {fail(400,'JSON غير صالح');}
    if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) fail(400,'كائن JSON مطلوب');
    return parsed;
  }
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');
    res.setHeader('X-Content-Type-Options','nosniff');
    const send=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try {
      const host=req.headers.host;
      if(!host || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) fail(403,'Local access only');
      if(req.headers.origin && req.headers.origin!==`http://${host}`) fail(403,'Cross-origin request rejected');
      if(req.headers['sec-fetch-site']==='cross-site') fail(403,'Cross-site request rejected');
      const url=new URL(req.url,`http://${host}`);
      if(url.pathname.startsWith('/api/automation/')) {
        authorizeAutomation(req,env);
        const actor={id:'automation',name:'n8n',role:'automation'};
        if(req.method==='POST' && url.pathname==='/api/automation/daily-brief')return send(200,saveDailyBrief(store,riyadhDate(),actor));
        if(req.method==='POST' && url.pathname==='/api/automation/prepare-due')return send(200,prepareDue(store,actor));
        if(req.method==='GET' && url.pathname==='/api/automation/status')return send(200,{timezone:'Asia/Riyadh',externalPublishing:false});
        fail(404,'Unknown automation operation');
      }
      const session=auth.current(req);
      if(req.method==='GET' && url.pathname==='/api/auth') return send(200,{needsSetup:auth.needsSetup(),user:session?.user||null,csrf:session?.csrf||null});
      if(req.method==='POST' && ['/api/setup','/api/login'].includes(url.pathname)) {
        const input=await body(req);
        let result;
        if(url.pathname==='/api/setup') {
          if(!auth.needsSetup()) fail(409,'تم إعداد حساب المالك بالفعل');
          result=auth.session(auth.createUser(input,'owner'));
        } else result=auth.login(input,req.socket.remoteAddress);
        res.setHeader('Set-Cookie',`hc_session=${result.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
        return send(200,{user:result.user,csrf:result.csrf});
      }
      if(url.pathname.startsWith('/api/')) {
        authorize(session,['owner','reviewer','operator']);
        if(req.method!=='GET' && req.headers['x-csrf-token']!==session.csrf) fail(403,'رمز حماية الجلسة غير صالح');
      }
      if(req.method==='POST' && url.pathname==='/api/logout') {auth.logout(session);res.setHeader('Set-Cookie','hc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return send(200,{ok:true});}
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
        const llm=providerStatus(env);
        const integrationNames={whatsapp:'واتساب',meta:'ميتا (Instagram/Facebook)',x:'X',linkedin:'لينكدإن',microsoft365:'Microsoft 365',canva:'Canva',salla_webhooks:'ويبهوكس سلة'};
        return send(200,agentDefinitions.map(agent=>{
          const registryRow=getAgent(store.db,agent.id);
          const required=AGENT_INTEGRATIONS[agent.id]||[];
          const missing=required.filter(key=>!integrations[key]?.configured);
          const runtimeStatus=!registryRow?.enabled?'DISABLED':!llm.configured?'WAITING_LLM':missing.length?'WAITING_INTEGRATION':'ONLINE';
          const runtimeLabel=runtimeStatus==='DISABLED'?'معطّل':runtimeStatus==='WAITING_LLM'?'بانتظار إعداد مزود الذكاء الاصطناعي':runtimeStatus==='WAITING_INTEGRATION'?`جاهز داخليًا — بانتظار: ${missing.map(k=>integrationNames[k]||k).join('، ')}`:'جاهز للعمل داخليًا';
          const recentRuns=listRuns(store.db,{agentId:agent.id,limit:10});
          return {...agent,level:autonomy[agent.id].level,autonomyVersion:autonomy[agent.id].version,autonomyUpdatedAt:autonomy[agent.id].at,autonomyUpdatedBy:autonomy[agent.id].actorName,autonomyReason:autonomy[agent.id].reason,
           runtimeStatus,runtimeLabel,enabled:!!registryRow?.enabled,requiredIntegrations:required,missingIntegrations:missing,
           runsTotal:recentRuns.length,lastRunAt:recentRuns[0]?.started_at||null,lastRunStatus:recentRuns[0]?.status||null};
        }));
      }
      if(req.method==='POST' && url.pathname==='/api/agents/reseed') {authorize(session,['owner']);return send(200,seedRegistry(store.db));}
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
      if(req.method==='POST' && escalationResolve)return send(200,resolveEscalation(store.db,escalationResolve[1],session.user));
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
      if(req.method==='GET' && url.pathname==='/api/integrations/dashboard') return send(200,buildIntegrationsDashboard(store,{env,aiRuns:listAiRuns(store.db),complianceRuns:listComplianceChecksSince(store.db,'1970-01-01T00:00:00.000Z')}));
      const integrationTest=url.pathname.match(/^\/api\/integrations\/([\w-]+)\/test$/);
      if(req.method==='POST' && integrationTest) {
        authorize(session,['owner']);
        const id=integrationTest[1];
        if(id==='anthropic')return send(200,await testAnthropicConnection({env,fetcher}));
        if(id==='salla')return send(200,await testSallaConnection({env,fetcher}));
        return send(200,{result:'NOT_IMPLEMENTED'});
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
        try{const products=await importSalla({env,fetcher});store.mutate(state=>{replaceProducts(store.db,products,false);state.audit.unshift({id:crypto.randomUUID(),action:'SALLA_CATALOG_SYNCED',itemId:'catalog',count:products.length,actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});});return send(200,{count:products.length,syncedAt:new Date().toISOString()});}
        catch(error){store.mutate(state=>{state.audit.unshift({id:crypto.randomUUID(),action:'SALLA_CATALOG_SYNC_FAILED',itemId:'catalog',errorCode:error instanceof ConnectorError?error.code:'UNKNOWN',actorId:session.user.id,actorName:session.user.name,at:new Date().toISOString()});});throw error;}
        finally{syncing=false;}
      }
      if(req.method==='GET' && url.pathname==='/api/ai/runs') return send(200,listAiRuns(store.db));
      if(req.method==='GET' && url.pathname==='/api/content/dashboard') return send(200,buildContentWorkspace(store,{complianceByContent:latestComplianceByContent(store.db)}));
      if(req.method==='POST' && url.pathname==='/api/ai/draft') {
        authorize(session,['owner','operator']);
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
        if(req.method==='POST')return send(200,await checkCompliance(compliance[1],await body(req),session.user));
      }
      const files={'/favicon.svg':'favicon.svg','/':'index.html','/app.js':'app.js','/knowledge.js':'knowledge.js','/planning.js':'planning.js','/crm.js':'crm.js','/compliance.js':'compliance.js','/autonomy.js':'autonomy.js','/reporting.js':'reporting.js','/format.js':'format.js','/content.js':'content.js','/memory.js':'memory.js','/integrations.js':'integrations.js','/team.js':'team.js','/style.css':'style.css'};
      for(const file of ['components/ui/index.js','components/layout/app-shell.js','pages/workspace.js',...['fonts','tokens','base','components','layout','pages'].map(name=>'styles/'+name+'.css')])files['/'+file]=file;
      for(const weight of [400,500,600,700])for(const subset of ['arabic','latin'])files[`/fonts/ibm-plex-sans-arabic-${weight}-${subset}.woff2`]=`fonts/ibm-plex-sans-arabic-${weight}-${subset}.woff2`;
      if(req.method==='GET' && files[url.pathname]) {
        const file=files[url.pathname];
        const contents=await readFile(new URL('../public/'+file,import.meta.url));
        const type=file.endsWith('.svg')?'image/svg+xml':file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':file.endsWith('.woff2')?'font/woff2':'text/html; charset=utf-8';
        const headers={'Content-Type':type,'Content-Security-Policy':"default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
        if(file.endsWith('.woff2'))headers['Cache-Control']='public, max-age=31536000, immutable';
        res.writeHead(200,headers);
        return res.end(contents);
      }
      send(404,{error:'Not found'});
    } catch(error) {send(error instanceof ConnectorError?502:error.status||400,{error:error.message});}
  });
  return {server,store,scheduler};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try{loadEnvFile(fileURLToPath(new URL('../.env',import.meta.url)));}catch(error){if(error.code!=='ENOENT')throw error;}
  const {server,scheduler}=await createApp();
  const port=Number(process.env.PORT||3000);
  server.listen(port,'127.0.0.1',()=>{
    console.log(`HyperCool: http://localhost:${port}`);
    scheduler.start();
    console.log('Agent scheduler running — daily brief 08:00, weekly report Sunday, follow-up gap sweep every tick (Asia/Riyadh).');
  });
}
