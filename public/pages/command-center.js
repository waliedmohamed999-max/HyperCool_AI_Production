// Frost Command Center (Phase 7A). Reuses the existing design system entirely (no new
// component library): drawer/promptDrawer/confirmAction/tabs/badge/metric/empty/table from
// components/ui/index.js, the same api()/toast conventions every other page already uses.
// Every number here comes from a real backend read (src/runtime/command-health.js,
// src/runtime/suggestions.js, src/runtime/context-items.js, /api/command/operations/inbox) —
// an empty/not-configured state renders as a real empty state, never a placeholder number.
import {escape,button,badge,empty,metric,drawer,promptDrawer,confirmAction,table,tabs,enhance,icon,toast} from '../components/ui/index.js';
import {navigate} from '../components/layout/app-shell.js';
import {t,getLocale} from '../i18n.js';
import {fmtDateTime} from '../format.js';

const $=s=>document.querySelector('#command-center '+s);
let apiClient,pollTimer=null,currentConversationId=null,renderGeneration=0;
let activeRunId=null,activeRunSteps=[],activeRunTopStatus=null;
async function api(path,body,method){return apiClient(path,body,method);}
function staleGuard(generation){return generation!==renderGeneration;}

const CONTEXT_TYPES=[
 'company_goal','business_rule','client_note','campaign_note','operational_issue','decision',
 'policy','product_information','brand_information','sales_context',
 'brain_identity','brain_goals','brain_customers','brain_products','brain_brand','brain_rules'
];
// Company Brain (UI-4) — the real category set is exactly this subset of CONTEXT_TYPES, in a
// fixed display order; there is no separate "Knowledge"/"Recent Insights" type in the data
// model, so those are represented by the hero's real "recent updates" count instead of an
// invented category.
const BRAIN_TYPES=['brain_identity','brain_goals','brain_customers','brain_products','brain_brand','brain_rules','decision'];
let currentBrainType=BRAIN_TYPES[0],brainRowsCache=BRAIN_TYPES.map(()=>[]),brainConflictsCache=[],dataContextTabsController=null;
const OPERATION_ICON={agent_run:'agent',audit:'clock'};
const INBOX_ICON={crm_lead:'users',crm_followup:'clock',content:'file',escalation:'bell',connection:'plug',webhook:'plug'};
// Live Frost delegation diagram — exactly the 4 agents delegate_to_agent can actually reach
// from Command Center (runtime/tools.js's own enum), plus Frost itself. Not the full 12-agent
// roster shown on the public marketing site's decorative diagram — that would misrepresent what
// this surface can really do.
const FROST_MAP_AGENTS=['performance','intelligence','leads','strategy'];
const FROST_MAP_COLOR={frost:'#7c3aed',performance:'#0ea5e9',intelligence:'#22c55e',leads:'#8b5cf6',strategy:'#f97316'};
function frostMapStatusLabel(status){
 if(!status)return '';
 const key='run'+status.toLowerCase().split('_').map(part=>part[0].toUpperCase()+part.slice(1)).join('');
 return t('agents.'+key);
}

export function installCommandCenter() {
 const root=document.querySelector('[data-page="command-center"] #command-center');
 root.innerHTML=`
  <div id="cmdc-health" class="kpi-grid"></div>
  <div class="cmdc-shell" id="cmdc-shell">
   <aside class="cmdc-sidebar" id="cmdc-sidebar" aria-label="${escape(t('commandCenter.sidebarLabel'))}">
    <div class="cmdc-sidebar-top">
     <button type="button" id="cmdc-new-conversation" class="cmdc-newchat">${icon('plus')}<span>${escape(t('commandCenter.newChat'))}</span></button>
     <div class="cmdc-search"><input id="cmdc-search-input" type="search" placeholder="${escape(t('commandCenter.searchPlaceholder'))}"><div id="cmdc-search-results"></div></div>
    </div>
    <div class="cmdc-sidebar-scroll">
     <section class="cmdc-side-group">
      <div class="cmdc-side-title"><span>${escape(t('commandCenter.projectsTitle'))}</span><button type="button" id="cmdc-new-project" class="cmdc-icon-btn" aria-label="${escape(t('commandCenter.newProject'))}" title="${escape(t('commandCenter.newProject'))}">${icon('plus')}</button></div>
      <div id="cmdc-projects-list"></div>
     </section>
     <section class="cmdc-side-group">
      <div class="cmdc-side-title"><span>${escape(t('commandCenter.recentChats'))}</span></div>
      <div id="cmdc-chats-list"></div>
     </section>
    </div>
   </aside>
   <section class="cmdc-chat">
    <div class="cmdc-chat-head">
     <button type="button" id="cmdc-sidebar-toggle" class="cmdc-icon-btn cmdc-toggle" aria-label="${escape(t('commandCenter.sidebarLabel'))}">${icon('menu')}</button>
     <div class="cmdc-chat-identity"><span class="cmdc-avatar" aria-hidden="true">F<i class="cmdc-online"></i></span><div><strong id="cmdc-chat-title">Frost</strong><small id="cmdc-chat-crumb">${escape(t('commandCenter.assistantSubtitle'))}</small></div></div>
     <button type="button" id="cmdc-run-executive-review" class="secondary">${icon('chart')}<span>${escape(t('commandCenter.runExecutiveReview'))}</span></button>
    </div>
    <div id="cmdc-messages" class="cmdc-messages"></div>
    <div id="cmdc-ai-notice" class="notice" hidden></div>
    <form id="cmdc-chat-form">
     <div class="cmdc-composer">
      <textarea name="text" required maxlength="4000" rows="1" placeholder="${escape(t('commandCenter.chatPlaceholder'))}"></textarea>
      <div class="cmdc-composer-bar">
       <input type="file" id="cmdc-attach-input" class="file-input-native" accept=".pdf,.csv,.xlsx,.docx,.txt,.png,.jpg,.jpeg">
       <label for="cmdc-attach-input" class="file-input-trigger cmdc-attach" title="${escape(t('commandCenter.chooseFile'))}" aria-label="${escape(t('commandCenter.chooseFile'))}">${icon('plus')}</label>
       <span id="cmdc-attach-status">${escape(t('commandCenter.noFileChosen'))}</span>
       <button type="submit" class="cmdc-send" aria-label="${escape(t('commandCenter.send'))}" title="${escape(t('commandCenter.send'))}">${icon('arrow')}</button>
      </div>
     </div>
     <p class="cmdc-hint">${escape(t('commandCenter.composerHint'))}</p>
    </form>
    <div id="cmdc-templates" class="cmdc-templates"></div>
   </section>
  </div>
  <div class="cmdc-layout">
   <div class="cmdc-main">
    <section class="report-section panel" id="cmdc-frost-map-section">
     <div class="report-section-head"><h3>${escape(t('commandCenter.frostActivityTitle'))}</h3><span class="cmdc-fm-caption" id="cmdc-frost-map-caption"></span></div>
     <div class="cmdc-fm-stage" id="cmdc-fm-stage">
      <svg class="cmdc-fm-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
       <path data-agent="performance" d="M50,50 Q50,20 12,20"/>
       <path data-agent="intelligence" d="M50,50 Q50,20 88,20"/>
       <path data-agent="leads" d="M50,50 Q50,80 12,80"/>
       <path data-agent="strategy" d="M50,50 Q50,80 88,80"/>
       <circle class="cmdc-fm-flow-dot" data-agent="performance" cx="40.5" cy="27.5" r="1.1"/>
       <circle class="cmdc-fm-flow-dot" data-agent="intelligence" cx="59.5" cy="27.5" r="1.1"/>
       <circle class="cmdc-fm-flow-dot" data-agent="leads" cx="40.5" cy="72.5" r="1.1"/>
       <circle class="cmdc-fm-flow-dot" data-agent="strategy" cx="59.5" cy="72.5" r="1.1"/>
      </svg>
      <div class="cmdc-fm-node" data-agent="frost"></div>
      <div class="cmdc-fm-node" data-agent="performance"></div>
      <div class="cmdc-fm-node" data-agent="intelligence"></div>
      <div class="cmdc-fm-node" data-agent="leads"></div>
      <div class="cmdc-fm-node" data-agent="strategy"></div>
     </div>
    </section>
    <section class="report-section" id="cmdc-data-context"><div class="report-section-head"><h3>${escape(t('commandCenter.dataContext'))}</h3></div></section>
   </div>
   <aside class="cmdc-side">
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.suggestions'))}</h3></div><div id="cmdc-suggestions"></div></section>
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.liveOperations'))}</h3></div><div id="cmdc-operations"></div></section>
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.systemMap'))}</h3><span>${escape(t('commandCenter.systemMapSubtitle'))}</span></div><div id="cmdc-system-map"></div></section>
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.workflowsWidget'))}</h3></div><div id="cmdc-workflows-widget"></div></section>
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.aiUsage'))}</h3></div><div id="cmdc-ai-usage"></div></section>
   </aside>
  </div>`;
 const panels=['inbox','addContext','companyBrain','runbooks','configHistory','attachments'].map(key=>{const el=document.createElement('div');el.id='cmdc-dc-'+key;return el;});
 $('#cmdc-data-context').append(...panels);
 dataContextTabsController=tabs($('#cmdc-data-context'),[
  [t('commandCenter.tabInbox'),panels[0]],
  [t('commandCenter.tabAddContext'),panels[1]],
  [t('commandCenter.tabCompanyBrain'),panels[2]],
  [t('commandCenter.tabRunbooks'),panels[3]],
  [t('commandCenter.tabConfigHistory'),panels[4]],
  [t('commandCenter.tabAttachments'),panels[5]]
 ]);
 panels[1].innerHTML=addContextFormHtml();
 panels[2].innerHTML=`<div class="cmdc-brain-hero" id="cmdc-brain-hero"></div><div class="cmdc-brain-layout"><nav class="cmdc-brain-nav" id="cmdc-brain-nav" role="tablist" aria-label="${escape(t('commandCenter.tabCompanyBrain'))}"></nav><div class="cmdc-brain-content" id="cmdc-brain-content"></div></div>`;
 panels[3].innerHTML=`<div id="cmdc-runbooks-list"></div><form id="cmdc-runbook-form"><input name="name" required maxlength="200" placeholder="${escape(t('commandCenter.runbookNamePlaceholder'))}"><input name="commandText" required maxlength="2000" placeholder="${escape(t('commandCenter.runbookCommandPlaceholder'))}"><button type="submit">${escape(t('commandCenter.runbookSave'))}</button></form>`;
 panels[4].innerHTML=`<div id="cmdc-config-history-list"></div>`;
 panels[5].innerHTML=`<div id="cmdc-attachments-list"></div>`;
 $('#cmdc-new-conversation').onclick=()=>onNewConversation();
 $('#cmdc-run-executive-review').onclick=onRunExecutiveReview;
 $('#cmdc-new-project').onclick=onNewProject;
 $('#cmdc-sidebar').addEventListener('click',onSidebarClick);
 $('#cmdc-sidebar-toggle').onclick=()=>$('#cmdc-shell').classList.toggle('sidebar-open');
 $('#cmdc-messages').addEventListener('click',e=>{const card=e.target.closest('[data-prompt]');if(card){prefillChat(card.dataset.prompt);$('#cmdc-chat-form').requestSubmit();}});
 $('#cmdc-chat-form textarea').addEventListener('input',e=>autosize(e.target));
 $('#cmdc-chat-form').addEventListener('submit',onSendMessage);
 $('#cmdc-chat-form textarea').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('#cmdc-chat-form').requestSubmit();}});
 // File input polish (Frost UI Part UI-2, item 30/31) — the native <input type=file>
 // stays in the DOM and fully functional (real keyboard access, real screen-reader label via
 // the <label for>, real .files value) so nothing about the actual upload logic above changes;
 // only its own browser-chrome text ("Choose File" / unlocalized) is visually replaced by a
 // real button label plus this status span, which IS ours to localize.
 $('#cmdc-attach-input').addEventListener('change',e=>{
  $('#cmdc-attach-status').textContent=e.target.files?.[0]?.name||t('commandCenter.noFileChosen');
 });
 $('#cmdc-data-context').addEventListener('submit',onAddContext);
 $('#cmdc-data-context').addEventListener('submit',onCreateRunbook);
 $('#cmdc-search-input').addEventListener('input',debounce(onSearchInput,300));
}
function debounce(fn,ms){let timer=null;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),ms);};}
// Tenant-aware Quick Commands (spec Part 48-52) — the KEYS come from the server, derived from
// real tenant signals (connected e-commerce integration, mostly-B2B leads book, or generic);
// only the localized phrase mapping lives here.
let quickKeys=[];
async function renderQuickCommands() {
 const {keys}=await api('/api/command/quick-commands');
 quickKeys=keys;
 if(currentConversationId && !messagesCache.length)$('#cmdc-messages').innerHTML=welcomeHtml();
}
function welcomeHtml() {
 const seen=new Set(),prompts=[];
 for(const key of quickKeys){const text=t('commandCenter.quickCommand.'+key);if(!seen.has(text)){seen.add(text);prompts.push(text);}}
 return `<div class="empty cmdc-welcome"><span class="cmdc-avatar big" aria-hidden="true">F</span><h2>${escape(t('commandCenter.welcomeTitle'))}</h2><p>${escape(t('commandCenter.welcomeHint'))}</p><div class="cmdc-prompts">${prompts.slice(0,prompts.length>=6?6:4).map(text=>`<button type="button" class="cmdc-prompt" data-prompt="${escape(text)}">${escape(text)}</button>`).join('')}</div></div>`;
}
function autosize(textarea) {textarea.style.height='auto';textarea.style.height=Math.min(textarea.scrollHeight,200)+'px';}
async function onSearchInput(event) {
 const query=event.target.value.trim();
 const host=$('#cmdc-search-results');
 if(!query){host.innerHTML='';host.hidden=true;return;}
 const results=await api('/api/command/search?q='+encodeURIComponent(query));
 host.hidden=false;
 host.innerHTML=results.length?results.map(r=>`<button type="button" class="cmdc-search-hit" data-conversation-id="${escape(r.conversationId)}">${escape(r.conversationTitle)} — ${escape(r.snippet)}</button>`).join(''):empty(t('commandCenter.noSearchResults'));
 host.querySelectorAll('[data-conversation-id]').forEach(hitButton=>{
  hitButton.onclick=async()=>{await openConversation(hitButton.dataset.conversationId);host.innerHTML='';host.hidden=true;$('#cmdc-search-input').value='';};
 });
}
async function onRunExecutiveReview() {
 const runbooks=await api('/api/command/runbooks');
 const executive=runbooks.find(r=>r.key==='executive_daily_review');
 if(!executive)return;
 await runRunbook(executive.id);
}

function addContextFormHtml() {
 const typeOption=type=>`<option value="${type}">${escape(t('commandCenter.contextType.'+type))}</option>`;
 return `<form id="cmdc-context-form">
  <div class="row">
   <label>${escape(t('commandCenter.fieldTitle'))}<input name="title" required maxlength="200"></label>
   <label>${escape(t('commandCenter.fieldType'))}<select name="type" required>${CONTEXT_TYPES.map(typeOption).join('')}</select></label>
   <label>${escape(t('commandCenter.fieldPriority'))}<select name="priority"><option value="">—</option><option value="LOW">${escape(t('commandCenter.priorityLow'))}</option><option value="MEDIUM">${escape(t('commandCenter.priorityMedium'))}</option><option value="HIGH">${escape(t('commandCenter.priorityHigh'))}</option></select></label>
  </div>
  <label>${escape(t('commandCenter.fieldDescription'))}<textarea name="description" maxlength="5000"></textarea></label>
  <div class="row">
   <label>${escape(t('commandCenter.fieldCategory'))}<input name="category" maxlength="100"></label>
   <label>${escape(t('commandCenter.fieldTags'))}<input name="tags" placeholder="${escape(t('commandCenter.fieldTagsPlaceholder'))}"></label>
  </div>
  <button type="submit">${escape(t('commandCenter.addContextSubmit'))}</button>
 </form>
 <div id="cmdc-context-just-added"></div>`;
}

// ------------------------------------------------------------------------------------------
// Chat
// ------------------------------------------------------------------------------------------
// Phase 7B — Multi-Agent UI (spec Part 9): a delegate_to_agent step renders with its real
// target-agent name and real child-run status (delegatedStatus, from the tool's own structured
// result — command-chat.js's stepsFromToolCalls) — never a generic "tool called" line, and
// never an animated/fake state.
function stepChipHtml(step) {
 const statusLabel=step.delegatedStatus||step.status;
 return `<span class="cmdc-step${step.delegatedAgent?' cmdc-step-delegated':''}" data-status="${escape(statusLabel)}">${escape(step.label)}${step.delegatedAgent?` — ${escape(statusLabel)}`:''}</span>`;
}
function messageBubbleHtml(message) {
 const steps=message.meta?.steps||[];
 const stepsHtml=steps.length?`<div class="cmdc-steps">${steps.map(stepChipHtml).join('')}</div>`:'';
 const sourcesHtml=message.meta?.dataSources?.length?`<p class="cmdc-sources"><small>${escape(t('commandCenter.dataSources'))} ${escape(message.meta.dataSources.join('، '))}</small></p>`:'';
 // NOTE: deliberately NOT named data-approval-decide — that exact attribute name is already a
 // GLOBAL click convention in app.js (id = the approval, wired to public/autonomy.js's
 // clickApprovalCenter with its own, different dataset shape); reusing it here would make
 // app.js's unrelated global handler also fire for this button with the wrong argument shape.
 const approvalHtml=message.meta?.pendingApprovalId?`<div class="cmdc-approval-pending" data-approval-id="${escape(message.meta.pendingApprovalId)}"><p>${escape(t('commandCenter.approvalRequired'))}</p><button type="button" data-cmdc-decide="APPROVED" class="small">${escape(t('commandCenter.approve'))}</button><button type="button" data-cmdc-decide="REJECTED" class="small secondary">${escape(t('commandCenter.reject'))}</button></div>`:'';
 const usage=message.meta?.usage;
 const usageHtml=usage?`<p class="cmdc-sources"><small>${escape(t('commandCenter.usageLine',{tokens:usage.totalTokens,ms:usage.durationMs||0}))}</small></p>`:'';
 const exportHtml=message.role==='assistant'&&message.id?`<button type="button" class="small ghost" data-export-message="${escape(message.id)}">${escape(t('commandCenter.exportMarkdown'))}</button>`:'';
 return `<div class="cmdc-message cmdc-message-${escape(message.role)}"><p>${escape(message.content)}</p>${stepsHtml}${sourcesHtml}${usageHtml}${approvalHtml}${exportHtml}</div>`;
}
// ---- Chats sidebar (ChatGPT-style): Projects + recent chats, all backed by real routes ----------
const DEFAULT_CHAT_TITLE='محادثة جديدة';
let conversationsCache=[],projectsCache=[];
const expandedProjects=new Set();
const FOLDER_ICON='<svg class="icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/></svg>';
const CHEVRON_ICON='<svg class="icon cmdc-chevron" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
async function loadSidebarData() {
 // Projects are an add-on: if that route is unavailable (e.g. a new page served against an older
 // backend during a deploy) the chats must still load and send normally.
 [conversationsCache,projectsCache]=await Promise.all([api('/api/command/conversations'),api('/api/command/projects').catch(()=>[])]);
}
async function loadConversations() {
 await loadSidebarData();
 if(!conversationsCache.length) {
  const created=await api('/api/command/conversations',{});
  conversationsCache.push(created);
 }
 currentConversationId=conversationsCache[0].id;
 const project=conversationsCache[0].projectId;if(project)expandedProjects.add(project);
 updateChatHeader();
 renderSidebar();
 await renderMessages();
}
function currentConversation() {return conversationsCache.find(c=>c.id===currentConversationId)||null;}
function updateChatHeader() {
 const conversation=currentConversation();
 const project=conversation?.projectId?projectsCache.find(p=>p.id===conversation.projectId):null;
 $('#cmdc-chat-title').textContent=conversation?.title||'Frost';
 $('#cmdc-chat-crumb').textContent=project?project.name:t('commandCenter.assistantSubtitle');
}
function convItemHtml(c) {
 return `<div class="cmdc-conv${c.id===currentConversationId?' is-active':''}" data-conversation-id="${escape(c.id)}"><button type="button" class="cmdc-conv-open" title="${escape(c.title)}">${escape(c.title)}</button><button type="button" class="cmdc-conv-menu" data-menu="conversation" aria-label="${escape(t('commandCenter.menuMore'))}" aria-haspopup="menu">⋯</button></div>`;
}
function renderSidebar() {
 const projectsHost=$('#cmdc-projects-list'),chatsHost=$('#cmdc-chats-list');
 if(!projectsHost||!chatsHost)return;
 projectsHost.innerHTML=projectsCache.length?projectsCache.map(project=>{
  const chats=conversationsCache.filter(c=>c.projectId===project.id),open=expandedProjects.has(project.id);
  return `<div class="cmdc-proj${open?' is-open':''}" data-project-id="${escape(project.id)}"><div class="cmdc-proj-row"><button type="button" class="cmdc-proj-toggle" aria-expanded="${open}">${CHEVRON_ICON}${FOLDER_ICON}<span class="cmdc-proj-name">${escape(project.name)}</span><em>${chats.length}</em></button><button type="button" class="cmdc-conv-menu" data-menu="project" aria-label="${escape(t('commandCenter.menuMore'))}" aria-haspopup="menu">⋯</button></div>${open?`<div class="cmdc-proj-chats">${chats.length?chats.map(convItemHtml).join(''):`<p class="cmdc-side-empty">${escape(t('commandCenter.projectEmpty'))}</p>`}</div>`:''}</div>`;
 }).join(''):`<p class="cmdc-side-empty">${escape(t('commandCenter.noProjects'))}</p>`;
 const plain=conversationsCache.filter(c=>!c.projectId||!projectsCache.some(p=>p.id===c.projectId));
 chatsHost.innerHTML=plain.length?plain.map(convItemHtml).join(''):`<p class="cmdc-side-empty">${escape(t('commandCenter.noChats'))}</p>`;
}
function closeMenus() {document.querySelectorAll('#cmdc-sidebar .cmdc-menu').forEach(m=>m.remove());}
function openMenu(anchor,items) {
 closeMenus();
 const sidebar=$('#cmdc-sidebar'),menu=document.createElement('div');
 menu.className='cmdc-menu';menu.setAttribute('role','menu');
 for(const [label,handler,danger] of items){
  const item=document.createElement('button');item.type='button';item.setAttribute('role','menuitem');item.textContent=label;if(danger)item.className='danger';
  item.onclick=async()=>{closeMenus();try{await handler();}catch(error){toast(error.message,'error');}};
  menu.append(item);
 }
 sidebar.append(menu);
 const a=anchor.getBoundingClientRect(),s=sidebar.getBoundingClientRect();
 menu.style.top=Math.min(a.bottom-s.top+4,s.height-menu.offsetHeight-8)+'px';
 if(document.documentElement.dir==='rtl')menu.style.left=Math.max(8,a.left-s.left)+'px';
 else menu.style.left=Math.min(a.left-s.left,s.width-menu.offsetWidth-8)+'px';
 menu.querySelector('button')?.focus();
 setTimeout(()=>document.addEventListener('click',closeMenus,{once:true}),0);
}
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeMenus();});
async function askName(title,value='') {
 return promptDrawer(title,node=>{
  const input=document.createElement('input');input.name='name';input.required=true;input.maxLength=200;input.value=value;
  const label=document.createElement('label');label.textContent=t('commandCenter.nameLabel');label.append(input);node.append(label);
  return {value:()=>input.value.trim(),focus:()=>{input.focus();input.select();}};
 },{confirmLabel:t('common.save')});
}
async function onSidebarClick(event) {
 const menuButton=event.target.closest('[data-menu]');
 if(menuButton){
  event.stopPropagation();
  const projectId=menuButton.closest('[data-project-id]')?.dataset.projectId;
  if(menuButton.dataset.menu==='project'){
   const project=projectsCache.find(p=>p.id===projectId);
   openMenu(menuButton,[
    [t('commandCenter.menuNewChatInProject'),()=>onNewConversation(projectId)],
    [t('commandCenter.menuRename'),()=>renameProjectFlow(project)],
    [t('commandCenter.menuArchiveProject'),()=>archiveProjectFlow(project),true]
   ]);
  } else {
   const id=menuButton.closest('[data-conversation-id]').dataset.conversationId;
   const chat=conversationsCache.find(c=>c.id===id);
   openMenu(menuButton,[
    [t('commandCenter.menuRename'),()=>renameChatFlow(chat)],
    [t('commandCenter.menuMove'),()=>moveChatFlow(chat)],
    [t('commandCenter.menuArchive'),()=>archiveChatFlow(chat),true]
   ]);
  }
  return;
 }
 const toggle=event.target.closest('.cmdc-proj-toggle');
 if(toggle){const id=toggle.closest('[data-project-id]').dataset.projectId;if(expandedProjects.has(id))expandedProjects.delete(id);else expandedProjects.add(id);renderSidebar();return;}
 const open=event.target.closest('.cmdc-conv-open');
 if(open)await openConversation(open.closest('[data-conversation-id]').dataset.conversationId);
}
async function renameChatFlow(chat) {
 const name=await askName(t('commandCenter.menuRename'),chat.title);
 if(!name||name===chat.title)return;
 Object.assign(chat,await api(`/api/command/conversations/${chat.id}`,{title:name},'PATCH'));
 updateChatHeader();renderSidebar();
}
async function moveChatFlow(chat) {
 const result=await promptDrawer(t('commandCenter.moveTitle'),node=>{
  const select=document.createElement('select');
  select.innerHTML=`<option value="">${escape(t('commandCenter.noProject'))}</option>`+projectsCache.map(p=>`<option value="${escape(p.id)}"${p.id===chat.projectId?' selected':''}>${escape(p.name)}</option>`).join('');
  const label=document.createElement('label');label.textContent=t('commandCenter.projectLabel');label.append(select);node.append(label);
  return {value:()=>select.value,focus:()=>select.focus()};
 },{confirmLabel:t('common.save')});
 if(result===null||result===undefined||result===(chat.projectId||''))return;
 Object.assign(chat,await api(`/api/command/conversations/${chat.id}`,{projectId:result||null},'PATCH'));
 if(chat.projectId)expandedProjects.add(chat.projectId);
 updateChatHeader();renderSidebar();
}
async function archiveChatFlow(chat) {
 const confirmed=await confirmAction(t('commandCenter.archiveChatTitle'),t('commandCenter.archiveChatBody'));
 if(!confirmed)return;
 await api(`/api/command/conversations/${chat.id}/archive`,{});
 conversationsCache=conversationsCache.filter(c=>c.id!==chat.id);
 if(chat.id===currentConversationId){
  if(!conversationsCache.length)return onNewConversation();
  return openConversation(conversationsCache[0].id);
 }
 renderSidebar();
}
async function onNewProject() {
 const name=await askName(t('commandCenter.newProject'));
 if(!name)return;
 const project=await api('/api/command/projects',{name});
 projectsCache.push(project);expandedProjects.add(project.id);
 renderSidebar();
}
async function renameProjectFlow(project) {
 const name=await askName(t('commandCenter.menuRename'),project.name);
 if(!name||name===project.name)return;
 Object.assign(project,await api(`/api/command/projects/${project.id}`,{name},'PATCH'));
 updateChatHeader();renderSidebar();
}
async function archiveProjectFlow(project) {
 const confirmed=await confirmAction(t('commandCenter.archiveProjectTitle'),t('commandCenter.archiveProjectBody'));
 if(!confirmed)return;
 await api(`/api/command/projects/${project.id}/archive`,{});
 projectsCache=projectsCache.filter(p=>p.id!==project.id);
 for(const c of conversationsCache)if(c.projectId===project.id)c.projectId=null;
 updateChatHeader();renderSidebar();
}
let messagesCache=[];
async function renderMessages() {
 if(!currentConversationId)return;
 const messages=await api(`/api/command/conversations/${currentConversationId}/messages`);
 messagesCache=messages;
 const host=$('#cmdc-messages');
 host.innerHTML=messages.length?messages.map(messageBubbleHtml).join(''):welcomeHtml();
 host.scrollTop=host.scrollHeight;
 enhance(host);
}
// Command Result Export (spec Part 46-47) — plain Markdown, built entirely from data already
// visible in this same conversation (never a second fetch of anything secret) — Command,
// Summary, Results (steps), Evidence references, Timestamp. A real file download (this is the
// live app, not a published Artifact, so a blob anchor works normally) — matches the exact
// same pattern platform.js's Integration Builder already uses for exporting a connector.
function buildExportMarkdown(message,precedingUserText) {
 const lines=[
  `# ${t('commandCenter.exportTitle')}`,'',
  `**${t('commandCenter.exportCommand')}:** ${precedingUserText||''}`,'',
  `**${t('commandCenter.exportSummary')}:**`,'',message.content,''
 ];
 if(message.meta?.steps?.length) {
  lines.push(`**${t('commandCenter.exportResults')}:**`,'');
  for(const step of message.meta.steps)lines.push(`- ${step.label} — ${step.delegatedStatus||step.status}`);
  lines.push('');
 }
 if(message.meta?.dataSources?.length)lines.push(`**${t('commandCenter.exportEvidence')}:** ${message.meta.dataSources.join('، ')}`,'');
 lines.push(`**${t('commandCenter.exportTimestamp')}:** ${message.createdAt||new Date().toISOString()}`);
 return lines.join('\n');
}
document.addEventListener('click',event=>{
 const exportButton=event.target.closest('#command-center [data-export-message]');
 if(!exportButton)return;
 const messageId=exportButton.dataset.exportMessage;
 const index=messagesCache.findIndex(m=>m.id===messageId);
 if(index<0)return;
 const message=messagesCache[index];
 const precedingUser=[...messagesCache.slice(0,index)].reverse().find(m=>m.role==='user');
 const markdown=buildExportMarkdown(message,precedingUser?.content);
 const blob=new Blob([markdown],{type:'text/markdown'});
 const url=URL.createObjectURL(blob);
 const a=document.createElement('a');a.href=url;a.download=`frost-command-${messageId.slice(0,8)}.md`;a.click();
 setTimeout(()=>URL.revokeObjectURL(url),1000);
});
async function openConversation(id) {
 currentConversationId=id;
 const project=currentConversation()?.projectId;if(project)expandedProjects.add(project);
 updateChatHeader();renderSidebar();
 $('#cmdc-shell')?.classList.remove('sidebar-open');
 await renderMessages();
}
async function onNewConversation(projectId=null) {
 const created=await api('/api/command/conversations',projectId?{projectId}:{});
 conversationsCache.unshift(created);
 if(projectId)expandedProjects.add(projectId);
 await openConversation(created.id);
 $('#cmdc-chat-form textarea')?.focus();
}
export function prefillChat(text) {
 const textarea=$('#cmdc-chat-form textarea');
 if(textarea){textarea.value=text;textarea.focus();}
}
const MIME_BY_EXTENSION={pdf:'application/pdf',csv:'text/csv',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',txt:'text/plain',png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg'};
function readFileAsBase64(file) {
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onload=()=>resolve(String(reader.result).split(',')[1]||'');
  reader.onerror=()=>reject(reader.error);
  reader.readAsDataURL(file);
 });
}
async function onSendMessage(event) {
 // app.js's single global `document.addEventListener('submit',...)` unconditionally treats
 // every unrecognized form as a generic /api/content/:id/:action submit — real for every
 // existing content-review form, wrong for this one (conversation-scoped, not id/action-
 // shaped). stopPropagation keeps this form's real per-message flow intact without adding a
 // 6th special case with a different response shape to that shared dispatcher.
 event.preventDefault();
 event.stopPropagation();
 const form=event.target,textarea=form.querySelector('textarea'),button=form.querySelector('button[type=submit]'),fileInput=form.querySelector('#cmdc-attach-input');
 const text=textarea.value.trim();
 if(!text)return;
 button.disabled=true;
 try {
  if(!currentConversationId)await loadConversations();
  let attachmentId=null;
  if(fileInput?.files?.[0]) {
   const file=fileInput.files[0];
   const extension=file.name.split('.').pop().toLowerCase();
   const mimeType=file.type||MIME_BY_EXTENSION[extension]||'application/octet-stream';
   const contentBase64=await readFileAsBase64(file);
   const uploaded=await api('/api/command/attachments',{filename:file.name,mimeType,contentBase64,conversationId:currentConversationId});
   attachmentId=uploaded.id;
   fileInput.value='';
   $('#cmdc-attach-status').textContent=t('commandCenter.noFileChosen');
   renderAttachmentsList();
  }
  const host=$('#cmdc-messages');
  if(host.querySelector('.empty'))host.innerHTML='';
  host.insertAdjacentHTML('beforeend',messageBubbleHtml({role:'user',content:text}));
  messagesCache.push({role:'user',content:text});
  const isFirstMessage=messagesCache.length===1;
  textarea.value='';textarea.style.height='';
  const result=await api(`/api/command/conversations/${currentConversationId}/messages`,{text,...(attachmentId?{attachmentId}:{})});
  messagesCache.push(result.assistantMessage);
  host.insertAdjacentHTML('beforeend',messageBubbleHtml(result.assistantMessage));
  host.scrollTop=host.scrollHeight;
  enhance(host);
  {
   const conversation=currentConversation();
   if(conversation){
    conversationsCache=[conversation,...conversationsCache.filter(c=>c.id!==conversation.id)];
    if(isFirstMessage && conversation.title===DEFAULT_CHAT_TITLE) {
     try{Object.assign(conversation,await api(`/api/command/conversations/${conversation.id}`,{title:text.replace(/\s+/g,' ').slice(0,48)},'PATCH'));}catch{}
    }
    updateChatHeader();renderSidebar();
   }
  }
  activeRunId=result.assistantMessage.runId||result.assistantMessage.meta?.runId||null;
  activeRunSteps=result.assistantMessage.meta?.steps||[];
  activeRunTopStatus=result.runStatus||null;
  renderFrostActivity({fromSteps:true});
  pulsePolling();
  await Promise.all([renderSuggestions(),renderOperations(),renderAiUsage()]);
 } finally {button.disabled=false;textarea.focus();}
}
document.addEventListener('click',async event=>{
 const decideButton=event.target.closest('#command-center [data-cmdc-decide]');
 if(!decideButton)return;
 const card=decideButton.closest('[data-approval-id]');
 const decision=decideButton.dataset.cmdcDecide;
 const confirmed=await confirmAction(decision==='APPROVED'?t('commandCenter.confirmApproveTitle'):t('commandCenter.confirmRejectTitle'),t('commandCenter.confirmApprovalBody'));
 if(!confirmed)return;
 await api(`/api/approvals/${card.dataset.approvalId}/decide`,{decision});
 card.outerHTML=`<p class="cmdc-approval-decided">${escape(decision==='APPROVED'?t('commandCenter.approvedNotice'):t('commandCenter.rejectedNotice'))}</p>`;
 // An approved configuration-change tool call (update_agent_tool_connection) writes a real
 // Configuration History row at decide-time (tools.js) — refresh that tab too, not just Live
 // Operations, so Undo is immediately available without a full page reload.
 await Promise.all([renderOperations(),renderConfigHistoryList()]);
});

// ------------------------------------------------------------------------------------------
// Suggestions
// ------------------------------------------------------------------------------------------
const PRIORITY_STATUS={HIGH:'ERROR',MEDIUM:'PENDING',LOW:'CONNECTED'};
async function renderSuggestions() {
 const suggestions=await api('/api/command/suggestions');
 const host=$('#cmdc-suggestions');
 host.innerHTML=suggestions.length?suggestions.map(s=>`
  <article class="card cmdc-suggestion" data-suggestion-id="${s.id}">
   <div class="row-between"><strong>${escape(s.title)}</strong>${badge(s.priority,PRIORITY_STATUS[s.priority])}</div>
   <p>${escape(s.reason)}</p>
   <div class="row">
    <button type="button" class="small ghost" data-suggestion-action="evidence">${escape(t('commandCenter.why'))}</button>
    <button type="button" class="small ghost" data-suggestion-action="ask">${escape(t('commandCenter.askFrost'))}</button>
    <button type="button" class="small" data-suggestion-action="task">${escape(t('commandCenter.createTask'))}</button>
    ${s.automatable?`<button type="button" class="small" data-suggestion-action="automate">${escape(t('commandCenter.automate'))}</button>`:''}
    <button type="button" class="small secondary" data-suggestion-action="dismiss">${escape(t('commandCenter.dismiss'))}</button>
   </div>
  </article>`).join(''):empty(t('commandCenter.noSuggestionsTitle'),t('commandCenter.noSuggestionsHint'));
}
document.addEventListener('click',async event=>{
 const actionButton=event.target.closest('#command-center [data-suggestion-action]');
 if(!actionButton)return;
 const card=actionButton.closest('[data-suggestion-id]');
 const id=card.dataset.suggestionId,action=actionButton.dataset.suggestionAction;
 if(action==='evidence') {
  const suggestions=await api('/api/command/suggestions');
  const suggestion=suggestions.find(s=>s.id===id);
  const node=document.createElement('div');
  node.innerHTML=`<p>${escape(suggestion.reason)}</p><p><strong>${escape(t('commandCenter.impact'))}</strong> ${escape(suggestion.impact||'—')}</p><pre>${escape(JSON.stringify(suggestion.evidence,null,2))}</pre>`;
  drawer(t('commandCenter.evidenceTitle'),node,{restore:true});
  return;
 }
 if(action==='ask') {navigate('command-center');prefillChat(card.querySelector('strong').textContent);return;}
 if(action==='task') {await api(`/api/command/suggestions/${id}/create-task`,{});await renderSuggestions();return;}
 if(action==='automate') {
  const confirmed=await confirmAction(t('commandCenter.automate'),t('commandCenter.automateConfirm'));
  if(!confirmed)return;
  await api(`/api/command/suggestions/${id}/automate`,{});
  toast(t('commandCenter.automateCreated'),'success');
  navigate('workflows');
  return;
 }
 if(action==='dismiss') {await api(`/api/command/suggestions/${id}/dismiss`,{});await renderSuggestions();}
});

// ------------------------------------------------------------------------------------------
// Live Frost delegation diagram — "who Frost is working with right now." Chat sends are fully
// synchronous (command-chat.js's sendCommandMessage awaits the whole delegated chain before the
// HTTP response returns), so this is never a fabricated mid-flight animation: it reveals the
// real outcome the instant it's known (from the send response itself, zero extra fetch), then
// re-confirms via the same polling burst every other live panel already uses, and keeps the
// last real snapshot visible as the baseline until the next send — never resets to a fake
// "nothing happened" state once something real has.
// ------------------------------------------------------------------------------------------
const FROST_MAP_ICON={frost:'agent',performance:'chart',intelligence:'search',leads:'users',strategy:'file'};
function frostMapNodeHtml(agentId,status) {
 const stage=$('#cmdc-fm-stage');
 const node=stage?.querySelector(`.cmdc-fm-node[data-agent="${agentId}"]`);
 if(!node)return;
 const isFrost=agentId==='frost';
 node.style.setProperty('--node-color',FROST_MAP_COLOR[agentId]);
 node.classList.toggle('is-active',status==='RUNNING'||(isFrost&&status));
 node.innerHTML=isFrost
  ?`<span class="cmdc-fm-node-icon">${icon('agent')}</span><span class="cmdc-fm-node-label">Frost Core</span><span class="cmdc-fm-node-caption">${escape(t('commandCenter.frostActivityController'))}</span>${status?badge(frostMapStatusLabel(status),status):`<span class="pill">${escape(t('commandCenter.frostActivityReady'))}</span>`}`
  :`<span class="cmdc-fm-node-icon">${icon(FROST_MAP_ICON[agentId])}</span><span class="cmdc-fm-node-text"><strong class="cmdc-fm-node-label">${escape(t('agents.roles.'+agentId))}</strong>${status?badge(frostMapStatusLabel(status),status):`<span class="cmdc-fm-node-idle">${escape(t('commandCenter.frostActivityIdleNode'))}</span>`}</span>`;
 for(const el of stage?.querySelectorAll(`svg [data-agent="${agentId}"]`)||[])el.classList.toggle('is-active',!!status);
}
async function renderFrostActivity({fromSteps=false}={}) {
 const generation=renderGeneration;
 const caption=$('#cmdc-frost-map-caption');
 if(!activeRunId) {
  frostMapNodeHtml('frost',null);
  FROST_MAP_AGENTS.forEach(agentId=>frostMapNodeHtml(agentId,null));
  if(caption)caption.textContent=t('commandCenter.frostActivityIdleCaption');
  return;
 }
 let frostStatus,statusByAgent={};
 if(fromSteps) {
  frostStatus=activeRunTopStatus;
  for(const step of activeRunSteps)if(step.delegatedAgent)statusByAgent[step.delegatedAgent]=step.delegatedStatus;
 } else {
  let run;
  try {run=await api('/api/agents/runs/'+activeRunId);} catch {return;}
  if(staleGuard(generation))return;
  frostStatus=run.status;
  for(const child of run.childRuns||[])if(FROST_MAP_AGENTS.includes(child.agent_id))statusByAgent[child.agent_id]=child.status;
 }
 frostMapNodeHtml('frost',frostStatus);
 FROST_MAP_AGENTS.forEach(agentId=>frostMapNodeHtml(agentId,statusByAgent[agentId]||null));
 if(caption)caption.textContent=t('commandCenter.frostActivityLastRunCaption').replace('{when}',fmtDateTime(new Date().toISOString()));
}

// ------------------------------------------------------------------------------------------
// Live Operations (safe polling — no SSE/WebSocket exists anywhere in this app; paused when
// the tab/page is hidden, matching spec item 73's "safe polling is acceptable initially")
// ------------------------------------------------------------------------------------------
function operationLabel(op) {
 if(op.kind==='workflow_run')return `${t('commandCenter.opWorkflowPrefix')} ${op.workflowName}`;
 return op.action||op.triggerType||op.agentId||'';
}
async function renderOperations() {
 const {items}=await api('/api/command/operations');
 const host=$('#cmdc-operations');
 host.innerHTML=items.length?`<div class="cmdc-ops-list">${items.map(op=>`<button type="button" class="cmdc-op-row" data-op-kind="${escape(op.kind)}" data-op-id="${escape(op.id)}">${icon(OPERATION_ICON[op.kind]||'clock')}<span class="cmdc-op-label">${escape(operationLabel(op))}</span>${badge(op.status,op.status==='COMPLETED'?'CONNECTED':op.status==='FAILED'?'ERROR':'PENDING')}<time>${escape(fmtDateTime(op.at))}</time></button>`).join('')}</div>`:empty(t('commandCenter.noOperationsTitle'));
}
document.addEventListener('click',async event=>{
 const row=event.target.closest('#command-center .cmdc-op-row');
 if(!row)return;
 if(row.dataset.opKind==='agent_run') {
  const run=await api(`/api/agents/runs/${row.dataset.opId}`);
  const node=document.createElement('div');
  node.innerHTML=`<p>${escape(t('commandCenter.opStatusLabel'))} ${escape(run.status)}</p>
   <div class="cmdc-ops-list">${(run.toolCalls||[]).map(tc=>`<div class="cmdc-op-row"><span>${escape(tc.tool)}</span>${badge(tc.status,tc.status==='OK'?'CONNECTED':tc.status==='WAITING_APPROVAL'?'PENDING':'ERROR')}</div>`).join('')||empty(t('commandCenter.noStepsTitle'))}</div>`;
  drawer(t('commandCenter.operationDetailTitle'),node,{restore:true});
  return;
 }
 if(row.dataset.opKind==='workflow_run') {
  const run=await api(`/api/workflow-runs/${row.dataset.opId}`);
  const node=document.createElement('div');
  node.innerHTML=`<p>${escape(t('commandCenter.opStatusLabel'))} ${escape(run.status)}</p>
   <div class="cmdc-ops-list">${(run.steps||[]).map(s=>`<div class="cmdc-op-row"><span>${escape(s.stepType)} (${escape(s.stepId)})</span>${badge(s.status,s.status==='COMPLETED'?'CONNECTED':s.status==='FAILED'?'ERROR':'PENDING')}</div>`).join('')||empty(t('commandCenter.noStepsTitle'))}</div>
   <div class="report-actions" id="cmdc-wf-run-actions"></div>`;
  const dialog=drawer(t('commandCenter.operationDetailTitle'),node,{restore:true});
  if(['PENDING','RUNNING','WAITING','WAITING_APPROVAL','CANCEL_REQUESTED'].includes(run.status)) {
   const cancelButton=document.createElement('button');cancelButton.type='button';cancelButton.className='button danger';cancelButton.textContent=t('commandCenter.cancelRun');
   cancelButton.onclick=async()=>{
    const confirmed=await confirmAction(t('commandCenter.cancelRun'),t('commandCenter.cancelRunExplain'));
    if(!confirmed)return;
    await api(`/api/workflow-runs/${run.id}/cancel`,{});
    dialog.close();
    await renderOperations();
   };
   node.querySelector('#cmdc-wf-run-actions').append(cancelButton);
  }
 }
});
// Smart polling (spec Part 30): fast (3s) for a short burst right after the user sends a
// command — this is exactly the window a delegated multi-agent run's child steps are actually
// still RUNNING in — then falls back to a slower, idle-appropriate 15s so a quiet tab doesn't
// keep hammering the DB. No new transport — still the same GET /api/command/operations poll.
function startPolling(intervalMs=15000) {
 stopPolling();
 pollTimer=setInterval(()=>{if(document.visibilityState==='visible' && location.hash==='#command-center')Promise.all([renderOperations(),renderFrostActivity()]).catch(()=>{});},intervalMs);
}
function stopPolling() {if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}
function pulsePolling() {
 startPolling(3000);
 setTimeout(()=>{if(location.hash==='#command-center')startPolling(15000);},20000);
}

// ------------------------------------------------------------------------------------------
// Data & Context
// ------------------------------------------------------------------------------------------
async function renderInbox() {
 const {items}=await api('/api/command/inbox');
 $('#cmdc-dc-inbox').innerHTML=items.length?`<div class="cmdc-ops-list">${items.map(i=>`<div class="cmdc-op-row">${icon(INBOX_ICON[i.kind]||'file')}<span class="cmdc-op-label">${escape(i.title||'—')}</span><time>${escape(fmtDateTime(i.at))}</time></div>`).join('')}</div>`:empty(t('commandCenter.noInboxTitle'));
}
async function onAddContext(event) {
 if(event.target.id!=='cmdc-context-form')return;
 event.preventDefault();
 event.stopPropagation(); // see onSendMessage's comment above — same reason
 const form=event.target;
 const input={
  type:form.type.value,title:form.title.value.trim(),description:form.description.value.trim(),
  category:form.category.value.trim()||undefined,priority:form.priority.value||undefined,
  tags:form.tags.value.split(',').map(s=>s.trim()).filter(Boolean)
 };
 await api('/api/command/context',input);
 form.reset();
 $('#cmdc-context-just-added').innerHTML=`<p class="notice">${escape(t('commandCenter.contextAdded'))}</p>`;
 await Promise.all([renderInbox(),renderCompanyBrain()]);
}
// Spec items 41-43 (Phase 7B) + Phase UI-4 information-architecture pass — Pinned
// Decisions/Active Goals are just the existing decision/brain_goals types (no new data model);
// conflicts (two ACTIVE singleton-brain records) and freshness (STALE = ACTIVE but past its own
// expiry) are shown explicitly, never silently resolved by picking one. UI-4 adds: a real-count
// hero, a category nav so only one section is read at a time instead of 7 stacked blocks, and
// wires the already-existing (but previously unused by this page) PATCH/archive endpoints to
// real Pin/Edit/Archive actions — no new backend capability, just surfacing what already exists.
async function renderCompanyBrain() {
 const [rows,conflicts]=await Promise.all([
  Promise.all(BRAIN_TYPES.map(type=>api('/api/command/context?type='+type))),
  api('/api/command/context/conflicts')
 ]);
 brainRowsCache=rows;brainConflictsCache=conflicts;
 if(!BRAIN_TYPES.includes(currentBrainType))currentBrainType=BRAIN_TYPES[0];
 renderBrainHero();
 renderBrainCategory();
}
function renderBrainHero() {
 const all=brainRowsCache.flat();
 const countOf=type=>brainRowsCache[BRAIN_TYPES.indexOf(type)].length;
 const weekAgo=Date.now()-7*24*60*60*1000;
 const recentCount=all.filter(item=>Date.parse(item.updatedAt)>=weekAgo).length;
 const stat=(value,label)=>`<div class="cmdc-brain-stat"><strong>${escape(String(value))}</strong><span>${escape(label)}</span></div>`;
 $('#cmdc-brain-hero').innerHTML=`
  <div class="cmdc-brain-hero-top"><h4>${escape(t('commandCenter.brainHeroTitle'))}</h4><p class="cmdc-muted">${escape(t('commandCenter.brainHeroSubtitle'))}</p></div>
  <div class="cmdc-brain-hero-stats">
   ${stat(all.length,t('commandCenter.brainStatActive'))}
   ${stat(countOf('brain_goals'),t('commandCenter.brainStatGoals'))}
   ${stat(countOf('brain_rules'),t('commandCenter.brainStatRules'))}
   ${stat(countOf('decision'),t('commandCenter.brainStatDecisions'))}
   ${stat(recentCount,t('commandCenter.brainStatRecent'))}
  </div>`;
}
function brainSourceLabel(source) {
 const key='commandCenter.brainSource.'+source;
 const translated=t(key);
 return translated===key?source:translated;
}
function brainItemCardHtml(item) {
 const important=item.pinned||item.priority==='HIGH';
 const badges=[
  item.pinned?badge(t('commandCenter.brainPinned'),'CONNECTED'):'',
  (!item.pinned&&item.priority==='HIGH')?badge(t('commandCenter.priorityHigh'),'BLOCKED'):'',
  item.freshness==='STALE'?badge(t('commandCenter.stale'),'PENDING'):''
 ].filter(Boolean).join('');
 return `<article class="cmdc-brain-card${important?' cmdc-brain-card-important':''}">
  <div class="cmdc-brain-card-head"><h5>${escape(item.title)}</h5><div class="cmdc-brain-card-badges">${badges}</div></div>
  <p class="cmdc-brain-card-summary">${item.description?escape(item.description):`<span class="cmdc-muted">${escape(t('commandCenter.brainNoDescription'))}</span>`}</p>
  <div class="cmdc-brain-card-meta">
   <span class="cmdc-brain-source-chip">${escape(brainSourceLabel(item.source))}</span>
   <span>${escape(t('commandCenter.brainUpdated'))} ${escape(fmtDateTime(item.updatedAt))}</span>
   ${item.confidence!=null?`<span>${escape(t('commandCenter.brainConfidence',{pct:Math.round(item.confidence*100)}))}</span>`:''}
  </div>
  <div class="row cmdc-brain-card-actions">
   <button type="button" class="small ghost" data-brain-pin="${escape(item.id)}">${escape(item.pinned?t('commandCenter.brainUnpin'):t('commandCenter.brainPin'))}</button>
   <button type="button" class="small ghost" data-brain-edit="${escape(item.id)}">${escape(t('commandCenter.brainEdit'))}</button>
   <button type="button" class="small ghost" data-brain-archive="${escape(item.id)}">${escape(t('commandCenter.brainArchive'))}</button>
  </div>
 </article>`;
}
function renderBrainNav() {
 const conflictTypes=new Set(brainConflictsCache.map(c=>c.type));
 $('#cmdc-brain-nav').innerHTML=BRAIN_TYPES.map((type,i)=>`<button type="button" class="cmdc-brain-nav-item" data-brain-type="${type}" aria-current="${type===currentBrainType}">
   <span>${escape(t('commandCenter.contextType.'+type))}</span>
   <span class="cmdc-brain-nav-count">${brainRowsCache[i].length}</span>
   ${conflictTypes.has(type)?`<span class="cmdc-brain-nav-flag" title="${escape(t('commandCenter.conflict'))}"></span>`:''}
  </button>`).join('');
}
function renderBrainCategory() {
 renderBrainNav();
 const index=BRAIN_TYPES.indexOf(currentBrainType);
 const items=brainRowsCache[index]||[];
 const hasConflict=brainConflictsCache.some(c=>c.type===currentBrainType);
 const conflictHtml=hasConflict?`<div class="cmdc-brain-conflict">${badge(t('commandCenter.conflict'),'PENDING')}<span>${escape(t('commandCenter.brainConflictNote'))}</span></div>`:'';
 const bodyHtml=items.length
  ?items.map(brainItemCardHtml).join('')
  :`<div class="empty">${icon('book')}<strong>${escape(t('commandCenter.brainEmptyCategory',{category:t('commandCenter.contextType.'+currentBrainType)}))}</strong><p>${escape(t('commandCenter.brainEmptyCategoryHint'))}</p><button type="button" class="small secondary" data-brain-add-type="${currentBrainType}">${escape(t('commandCenter.brainAddForCategory'))}</button></div>`;
 $('#cmdc-brain-content').innerHTML=conflictHtml+bodyHtml;
}
function findCachedBrainItem(id) {
 for(const rows of brainRowsCache){const found=rows.find(item=>item.id===id);if(found)return found;}
 return null;
}
function brainEditFormFields(node,item) {
 node.innerHTML=`
  <label>${escape(t('commandCenter.fieldTitle'))}<input name="title" required maxlength="200" value="${escape(item.title)}"></label>
  <label>${escape(t('commandCenter.fieldPriority'))}<select name="priority"><option value="">—</option><option value="LOW">${escape(t('commandCenter.priorityLow'))}</option><option value="MEDIUM">${escape(t('commandCenter.priorityMedium'))}</option><option value="HIGH">${escape(t('commandCenter.priorityHigh'))}</option></select></label>
  <label>${escape(t('commandCenter.fieldDescription'))}<textarea name="description" maxlength="5000">${escape(item.description)}</textarea></label>
  <label>${escape(t('commandCenter.fieldCategory'))}<input name="category" maxlength="100" value="${escape(item.category||'')}"></label>
  <label>${escape(t('commandCenter.fieldTags'))}<input name="tags" placeholder="${escape(t('commandCenter.fieldTagsPlaceholder'))}" value="${escape((item.tags||[]).join(', '))}"></label>`;
 const titleInput=node.querySelector('[name=title]');
 node.querySelector('[name=priority]').value=item.priority||'';
 return {
  value:()=>({
   title:node.querySelector('[name=title]').value.trim(),
   description:node.querySelector('[name=description]').value.trim(),
   category:node.querySelector('[name=category]').value.trim()||null,
   priority:node.querySelector('[name=priority]').value||null,
   tags:node.querySelector('[name=tags]').value.split(',').map(s=>s.trim()).filter(Boolean)
  }),
  validate:()=>{if(!titleInput.value.trim()){titleInput.setCustomValidity(t('common.reasonRequired'));titleInput.reportValidity();return false;}titleInput.setCustomValidity('');return true;},
  focus:()=>titleInput.focus()
 };
}
async function openBrainEdit(item) {
 const patch=await promptDrawer(t('commandCenter.brainEditTitle'),node=>brainEditFormFields(node,item),{confirmLabel:t('common.save')});
 if(!patch)return;
 await api(`/api/command/context/${item.id}`,patch,'PATCH');
 await renderCompanyBrain();
}
async function toggleBrainPin(item) {
 await api(`/api/command/context/${item.id}`,{pinned:!item.pinned},'PATCH');
 await renderCompanyBrain();
}
async function archiveBrainItem(item) {
 const confirmed=await confirmAction(t('commandCenter.brainArchiveConfirmTitle'),t('commandCenter.brainArchiveConfirmBody'));
 if(!confirmed)return;
 await api(`/api/command/context/${item.id}/archive`,{},'POST');
 await renderCompanyBrain();
}
document.addEventListener('click',async event=>{
 const navButton=event.target.closest('#command-center [data-brain-type]');
 if(navButton){currentBrainType=navButton.dataset.brainType;renderBrainCategory();return;}
 const addTypeButton=event.target.closest('#command-center [data-brain-add-type]');
 if(addTypeButton){
  dataContextTabsController?.select(1);
  const typeSelect=$('#cmdc-context-form [name=type]');
  if(typeSelect)typeSelect.value=addTypeButton.dataset.brainAddType;
  return;
 }
 const pinButton=event.target.closest('#command-center [data-brain-pin]');
 if(pinButton){const item=findCachedBrainItem(pinButton.dataset.brainPin);if(item)await toggleBrainPin(item);return;}
 const editButton=event.target.closest('#command-center [data-brain-edit]');
 if(editButton){const item=findCachedBrainItem(editButton.dataset.brainEdit);if(item)await openBrainEdit(item);return;}
 const archiveButton=event.target.closest('#command-center [data-brain-archive]');
 if(archiveButton){const item=findCachedBrainItem(archiveButton.dataset.brainArchive);if(item)await archiveBrainItem(item);}
});

// ------------------------------------------------------------------------------------------
// Runbooks / Favorites (spec Part 12-14/45) — "Run" sends the SAME real command text through
// the exact same chat pipeline (POST .../runbooks/:id/run -> sendCommandMessage server-side).
// ------------------------------------------------------------------------------------------
async function renderRunbooksList() {
 const runbooks=await api('/api/command/runbooks');
 const host=$('#cmdc-runbooks-list');
 host.innerHTML=runbooks.map(r=>`<article class="card cmdc-runbook" data-runbook-id="${escape(r.id)}">
   <div class="row-between"><strong>${escape(r.name)}</strong>${r.isBuiltin?badge(t('commandCenter.builtin'),'CONNECTED'):''}</div>
   <p class="cmdc-muted">${escape(r.description||r.commandText)}</p>
   <div class="row">
    <button type="button" class="small" data-runbook-action="run">${escape(t('commandCenter.runbookRun'))}</button>
    ${r.isBuiltin?'':`<button type="button" class="small secondary" data-runbook-action="archive">${escape(t('commandCenter.runbookArchive'))}</button>`}
   </div>
  </article>`).join('');
}
async function runRunbook(id) {
 const conversations=await api('/api/command/conversations');
 const conversationId=currentConversationId||conversations[0]?.id;
 const result=await api(`/api/command/runbooks/${id}/run`,conversationId?{conversationId}:{});
 currentConversationId=result.conversationId;
 await loadSidebarData();
 updateChatHeader();renderSidebar();
 await renderMessages();
 pulsePolling();
 await Promise.all([renderSuggestions(),renderOperations()]);
}
document.addEventListener('click',async event=>{
 const actionButton=event.target.closest('#command-center [data-runbook-action]');
 if(!actionButton)return;
 const card=actionButton.closest('[data-runbook-id]');
 if(actionButton.dataset.runbookAction==='run')await runRunbook(card.dataset.runbookId);
 else {await api(`/api/command/runbooks/${card.dataset.runbookId}/archive`,{});await renderRunbooksList();}
});
async function onCreateRunbook(event) {
 if(event.target.id!=='cmdc-runbook-form')return;
 event.preventDefault();
 event.stopPropagation();
 const form=event.target;
 await api('/api/command/runbooks',{name:form.name.value.trim(),commandText:form.commandText.value.trim()});
 form.reset();
 await renderRunbooksList();
}

// ------------------------------------------------------------------------------------------
// Configuration History + Undo (spec Part 20-23)
// ------------------------------------------------------------------------------------------
async function renderConfigHistoryList() {
 const history=await api('/api/command/configuration-history');
 const host=$('#cmdc-config-history-list');
 host.innerHTML=history.length?history.map(h=>`<div class="cmdc-op-row" data-history-id="${escape(h.id)}">
   <span>${escape(h.entityType)} · ${escape(h.field)}</span>
   <span class="cmdc-muted">${escape(JSON.stringify(h.previousValue))} → ${escape(JSON.stringify(h.newValue))}</span>
   <time>${escape(fmtDateTime(h.createdAt))}</time>
   ${h.revertedAt?badge(t('commandCenter.reverted'),'DISCONNECTED'):(h.reversible?`<button type="button" class="small secondary" data-undo-history="${escape(h.id)}">${escape(t('commandCenter.undo'))}</button>`:badge(t('commandCenter.irreversible'),'ERROR'))}
  </div>`).join(''):empty(t('commandCenter.noConfigHistory'));
}
document.addEventListener('click',async event=>{
 const undoButton=event.target.closest('#command-center [data-undo-history]');
 if(!undoButton)return;
 const confirmed=await confirmAction(t('commandCenter.confirmUndoTitle'),t('commandCenter.confirmUndoBody'));
 if(!confirmed)return;
 try{await api(`/api/command/configuration-history/${undoButton.dataset.undoHistory}/undo`,{});await renderConfigHistoryList();}
 catch(error){/* toast handled by shared api() error path */}
});

// ------------------------------------------------------------------------------------------
// Attachments (spec Part 15-19) — safe, tenant-scoped, never auto-pinned to Company Brain.
// ------------------------------------------------------------------------------------------
async function renderAttachmentsList() {
 const attachments=await api('/api/command/attachments');
 const host=$('#cmdc-attachments-list');
 host.innerHTML=attachments.length?attachments.map(a=>`<div class="cmdc-op-row" data-attachment-id="${escape(a.id)}">
   ${icon('file')}<span class="cmdc-op-label">${escape(a.filename)}</span>
   <span class="cmdc-muted">${escape(a.uploadedByName||'—')} · ${escape(fmtDateTime(a.createdAt))}</span>
   ${a.savedToBrainContextId?badge(t('commandCenter.savedToBrain'),'CONNECTED'):`<button type="button" class="small secondary" data-pin-attachment="${escape(a.id)}">${escape(t('commandCenter.pinToBrain'))}</button>`}
  </div>`).join(''):empty(t('commandCenter.noAttachments'));
}
document.addEventListener('click',async event=>{
 const pinButton=event.target.closest('#command-center [data-pin-attachment]');
 if(!pinButton)return;
 await api(`/api/command/attachments/${pinButton.dataset.pinAttachment}/pin-to-brain`,{});
 await Promise.all([renderAttachmentsList(),renderCompanyBrain()]);
});

// ------------------------------------------------------------------------------------------
// System Map (compact — the full interactive Agent/Tool/Connection map already exists in
// Control Center; this links to it rather than rebuilding it, per the architectural rule).
// ------------------------------------------------------------------------------------------
async function renderSystemMap() {
 const map=await api('/api/command/system-map');
 const agents=map.agents||map.items||[];
 const ready=agents.filter(a=>a.status==='READY').length;
 const host=$('#cmdc-system-map');
 host.innerHTML=`<div class="kpi-grid">${metric(t('commandCenter.agentsReady'),`${ready}/${agents.length}`,'','agent')}</div>
  <button type="button" class="secondary" id="cmdc-open-full-map">${escape(t('commandCenter.openFullMap'))}</button>`;
 host.querySelector('#cmdc-open-full-map').onclick=()=>navigate('control-center');
}

// ------------------------------------------------------------------------------------------
// Workflows widget (spec Part 36) — real counts only, links to the full Workflows/Automation
// page rather than rebuilding it here (same "link, don't duplicate" rule as System Map).
// ------------------------------------------------------------------------------------------
async function renderWorkflowsWidget() {
 const summary=await api('/api/command/workflows-summary');
 const host=$('#cmdc-workflows-widget');
 host.innerHTML=`<div class="kpi-grid">
   ${metric(t('commandCenter.wfActive'),summary.active,'','clock')}
   ${metric(t('commandCenter.wfRunning'),summary.running,'','clock')}
   ${metric(t('commandCenter.wfWaitingApproval'),summary.waitingApproval,'','bell')}
   ${metric(t('commandCenter.wfFailedRecent'),summary.failedRecent,'','bell')}
   ${metric(t('commandCenter.wfScheduledToday'),summary.scheduledToday,'','clock')}
  </div>
  <button type="button" class="secondary" id="cmdc-open-workflows">${escape(t('commandCenter.openWorkflows'))}</button>`;
 host.querySelector('#cmdc-open-workflows').onclick=()=>navigate('workflows');
}

// ------------------------------------------------------------------------------------------
// AI Usage (spec Part 43-45) — real token counts already recorded on every agent_runs row;
// no monetary figure shown unless a real pricing table has been filled in (llmProvider.js).
// ------------------------------------------------------------------------------------------
let aiUsagePeriod='today';
async function renderAiUsage() {
 const summary=await api('/api/command/ai-usage?period='+aiUsagePeriod);
 const host=$('#cmdc-ai-usage');
 const periodButtons=['today','7d','30d'].map(p=>`<button type="button" class="small ${p===aiUsagePeriod?'':'ghost'}" data-usage-period="${p}">${escape(t('commandCenter.usagePeriod.'+p))}</button>`).join('');
 const byAgentRows=Object.entries(summary.byAgent).map(([agentId,a])=>`<div class="cmdc-op-row"><span>${escape(agentId)}</span><span class="cmdc-muted">${a.calls} · ${a.tokensInput+a.tokensOutput} tokens</span></div>`).join('');
 host.innerHTML=`<div class="row">${periodButtons}</div>
  <div class="kpi-grid">
   ${metric(t('commandCenter.usageCalls'),summary.totals.calls,'','agent')}
   ${metric(t('commandCenter.usageTokens'),summary.totals.tokensInput+summary.totals.tokensOutput,'','file')}
  </div>
  ${summary.totals.hasCostData?`<p class="kpi-context">${escape(t('commandCenter.usageCost'))} ${summary.totals.estimatedCost.toFixed(4)}</p>`:''}
  ${byAgentRows||empty(t('commandCenter.noUsage'))}`;
 host.querySelectorAll('[data-usage-period]').forEach(btn=>{btn.onclick=()=>{aiUsagePeriod=btn.dataset.usagePeriod;renderAiUsage();};});
}

// ------------------------------------------------------------------------------------------
export async function renderCommandCenter({api:client}) {
 apiClient=client;
 const generation=++renderGeneration;
 stopPolling();
 currentConversationId=null;
 try {
  const health=await api('/api/command/health');
  if(staleGuard(generation))return;
  renderHealthFrom(health);
  await Promise.all([loadConversations(),renderSuggestions(),renderOperations(),renderInbox(),renderCompanyBrain(),renderSystemMap(),renderWorkflowsWidget(),renderAiUsage(),renderRunbooksList(),renderConfigHistoryList(),renderAttachmentsList(),renderQuickCommands(),renderFrostActivity()]);
  if(staleGuard(generation))return;
  startPolling();
 } catch(error) {
  console.error('command center load failed:',error);
 }
}
function renderHealthFrom(health) {
 const cards=[
  [metric(t('commandCenter.metricPendingApprovals'),health.pendingApprovals,t('commandCenter.metricPendingApprovalsHint'),'bell'),'agents'],
  [metric(t('commandCenter.metricOpenTasks'),health.openEscalations,t('commandCenter.metricOpenTasksHint'),'clock'),'agents'],
  [metric(t('commandCenter.metricUnhealthyConnections'),health.unhealthyConnections.length,t('commandCenter.metricUnhealthyConnectionsHint'),'plug'),'control-center'],
  [metric(t('commandCenter.metricNewLeads'),health.newLeadsThisWeek,t('commandCenter.metricNewLeadsHint'),'users'),'crm'],
  [metric(t('commandCenter.metricContentPlanned'),health.contentPlannedThisWeek,t('commandCenter.metricContentPlannedHint'),'file'),'content']
 ];
 $('#cmdc-health').innerHTML=cards.map(([html])=>html).join('');
 $('#cmdc-health').querySelectorAll('.kpi-card').forEach((card,i)=>{card.classList.add('clickable');card.onclick=()=>navigate(cards[i][1]);});
}
