// Frost Command Center (Phase 7A). Reuses the existing design system entirely (no new
// component library): drawer/promptDrawer/confirmAction/tabs/badge/metric/empty/table from
// components/ui/index.js, the same api()/toast conventions every other page already uses.
// Every number here comes from a real backend read (src/runtime/command-health.js,
// src/runtime/suggestions.js, src/runtime/context-items.js, /api/command/operations/inbox) —
// an empty/not-configured state renders as a real empty state, never a placeholder number.
import {escape,button,badge,empty,metric,drawer,promptDrawer,confirmAction,table,tabs,enhance,icon} from '../components/ui/index.js';
import {navigate} from '../components/layout/app-shell.js';
import {t,getLocale} from '../i18n.js';
import {fmtDateTime} from '../format.js';

const $=s=>document.querySelector('#command-center '+s);
let apiClient,pollTimer=null,currentConversationId=null,renderGeneration=0;
async function api(path,body,method){return apiClient(path,body,method);}
function staleGuard(generation){return generation!==renderGeneration;}

const CONTEXT_TYPES=[
 'company_goal','business_rule','client_note','campaign_note','operational_issue','decision',
 'policy','product_information','brand_information','sales_context',
 'brain_identity','brain_goals','brain_customers','brain_products','brain_brand','brain_rules'
];
const OPERATION_ICON={agent_run:'agent',audit:'clock'};
const INBOX_ICON={crm_lead:'users',crm_followup:'clock',content:'file',escalation:'bell',connection:'plug',webhook:'plug'};

export function installCommandCenter() {
 const root=document.querySelector('[data-page="command-center"] #command-center');
 root.innerHTML=`
  <div id="cmdc-health" class="kpi-grid"></div>
  <div class="cmdc-layout">
   <section class="cmdc-chat panel">
    <div class="cmdc-chat-head">
     <select id="cmdc-conversation-select" aria-label="${escape(t('commandCenter.conversationSelectLabel'))}"></select>
     <button type="button" id="cmdc-new-conversation" class="secondary">${escape(t('commandCenter.newConversation'))}</button>
    </div>
    <div id="cmdc-messages" class="cmdc-messages"></div>
    <div id="cmdc-ai-notice" class="notice" hidden></div>
    <form id="cmdc-chat-form"><textarea name="text" required maxlength="4000" placeholder="${escape(t('commandCenter.chatPlaceholder'))}"></textarea><button type="submit">${escape(t('commandCenter.send'))}</button></form>
    <div id="cmdc-templates" class="cmdc-templates"></div>
   </section>
   <aside class="cmdc-side">
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.suggestions'))}</h3></div><div id="cmdc-suggestions"></div></section>
    <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.liveOperations'))}</h3></div><div id="cmdc-operations"></div></section>
   </aside>
  </div>
  <div class="cmdc-layout">
   <section class="report-section" id="cmdc-data-context"><div class="report-section-head"><h3>${escape(t('commandCenter.dataContext'))}</h3></div></section>
   <section class="report-section"><div class="report-section-head"><h3>${escape(t('commandCenter.systemMap'))}</h3><span>${escape(t('commandCenter.systemMapSubtitle'))}</span></div><div id="cmdc-system-map"></div></section>
  </div>`;
 const panels=['inbox','addContext','companyBrain'].map(key=>{const el=document.createElement('div');el.id='cmdc-dc-'+key;return el;});
 $('#cmdc-data-context').append(...panels);
 tabs($('#cmdc-data-context'),[
  [t('commandCenter.tabInbox'),panels[0]],
  [t('commandCenter.tabAddContext'),panels[1]],
  [t('commandCenter.tabCompanyBrain'),panels[2]]
 ]);
 panels[1].innerHTML=addContextFormHtml();
 $('#cmdc-new-conversation').onclick=onNewConversation;
 $('#cmdc-conversation-select').onchange=e=>openConversation(e.target.value);
 $('#cmdc-chat-form').addEventListener('submit',onSendMessage);
 $('#cmdc-data-context').addEventListener('submit',onAddContext);
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
function messageBubbleHtml(message) {
 const steps=message.meta?.steps||[];
 const stepsHtml=steps.length?`<div class="cmdc-steps">${steps.map(s=>`<span class="cmdc-step" data-status="${escape(s.status)}">${escape(s.label)}</span>`).join('')}</div>`:'';
 const sourcesHtml=message.meta?.dataSources?.length?`<p class="cmdc-sources"><small>${escape(t('commandCenter.dataSources'))} ${escape(message.meta.dataSources.join('، '))}</small></p>`:'';
 // NOTE: deliberately NOT named data-approval-decide — that exact attribute name is already a
 // GLOBAL click convention in app.js (id = the approval, wired to public/autonomy.js's
 // clickApprovalCenter with its own, different dataset shape); reusing it here would make
 // app.js's unrelated global handler also fire for this button with the wrong argument shape.
 const approvalHtml=message.meta?.pendingApprovalId?`<div class="cmdc-approval-pending" data-approval-id="${escape(message.meta.pendingApprovalId)}"><p>${escape(t('commandCenter.approvalRequired'))}</p><button type="button" data-cmdc-decide="APPROVED" class="small">${escape(t('commandCenter.approve'))}</button><button type="button" data-cmdc-decide="REJECTED" class="small secondary">${escape(t('commandCenter.reject'))}</button></div>`:'';
 return `<div class="cmdc-message cmdc-message-${escape(message.role)}"><p>${escape(message.content)}</p>${stepsHtml}${sourcesHtml}${approvalHtml}</div>`;
}
async function loadConversations() {
 const conversations=await api('/api/command/conversations');
 const select=$('#cmdc-conversation-select');
 if(!conversations.length) {
  const created=await api('/api/command/conversations',{});
  conversations.push(created);
 }
 select.innerHTML=conversations.map(c=>`<option value="${c.id}">${escape(c.title)}</option>`).join('');
 currentConversationId=conversations[0].id;
 select.value=currentConversationId;
 await renderMessages();
}
async function renderMessages() {
 if(!currentConversationId)return;
 const messages=await api(`/api/command/conversations/${currentConversationId}/messages`);
 const host=$('#cmdc-messages');
 host.innerHTML=messages.length?messages.map(messageBubbleHtml).join(''):empty(t('commandCenter.noMessagesTitle'),t('commandCenter.noMessagesHint'));
 host.scrollTop=host.scrollHeight;
 enhance(host);
}
async function openConversation(id) {
 currentConversationId=id;
 await renderMessages();
}
async function onNewConversation() {
 const created=await api('/api/command/conversations',{});
 const select=$('#cmdc-conversation-select');
 const option=document.createElement('option');option.value=created.id;option.textContent=created.title;
 select.prepend(option);select.value=created.id;
 await openConversation(created.id);
}
export function prefillChat(text) {
 const textarea=$('#cmdc-chat-form textarea');
 if(textarea){textarea.value=text;textarea.focus();}
}
async function onSendMessage(event) {
 // app.js's single global `document.addEventListener('submit',...)` unconditionally treats
 // every unrecognized form as a generic /api/content/:id/:action submit — real for every
 // existing content-review form, wrong for this one (conversation-scoped, not id/action-
 // shaped). stopPropagation keeps this form's real per-message flow intact without adding a
 // 6th special case with a different response shape to that shared dispatcher.
 event.preventDefault();
 event.stopPropagation();
 const form=event.target,textarea=form.querySelector('textarea'),button=form.querySelector('button');
 const text=textarea.value.trim();
 if(!text)return;
 button.disabled=true;
 try {
  if(!currentConversationId)await loadConversations();
  const host=$('#cmdc-messages');
  if(host.querySelector('.empty'))host.innerHTML='';
  host.insertAdjacentHTML('beforeend',messageBubbleHtml({role:'user',content:text}));
  textarea.value='';
  const result=await api(`/api/command/conversations/${currentConversationId}/messages`,{text});
  host.insertAdjacentHTML('beforeend',messageBubbleHtml(result.assistantMessage));
  host.scrollTop=host.scrollHeight;
  enhance(host);
  await Promise.all([renderSuggestions(),renderOperations()]);
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
 await renderOperations();
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
 if(action==='dismiss') {await api(`/api/command/suggestions/${id}/dismiss`,{});await renderSuggestions();}
});

// ------------------------------------------------------------------------------------------
// Live Operations (safe polling — no SSE/WebSocket exists anywhere in this app; paused when
// the tab/page is hidden, matching spec item 73's "safe polling is acceptable initially")
// ------------------------------------------------------------------------------------------
async function renderOperations() {
 const {items}=await api('/api/command/operations');
 const host=$('#cmdc-operations');
 host.innerHTML=items.length?`<div class="cmdc-ops-list">${items.map(op=>`<button type="button" class="cmdc-op-row" data-op-kind="${escape(op.kind)}" data-op-id="${escape(op.id)}">${icon(OPERATION_ICON[op.kind]||'clock')}<span class="cmdc-op-label">${escape(op.action||op.triggerType||op.agentId||'')}</span><time>${escape(fmtDateTime(op.at))}</time></button>`).join('')}</div>`:empty(t('commandCenter.noOperationsTitle'));
}
document.addEventListener('click',async event=>{
 const row=event.target.closest('#command-center .cmdc-op-row');
 if(!row||row.dataset.opKind!=='agent_run')return;
 const run=await api(`/api/agents/runs/${row.dataset.opId}`);
 const node=document.createElement('div');
 node.innerHTML=`<p>${escape(t('commandCenter.opStatusLabel'))} ${escape(run.status)}</p>
  <div class="cmdc-ops-list">${(run.toolCalls||[]).map(tc=>`<div class="cmdc-op-row"><span>${escape(tc.tool)}</span>${badge(tc.status,tc.status==='OK'?'CONNECTED':tc.status==='WAITING_APPROVAL'?'PENDING':'ERROR')}</div>`).join('')||empty(t('commandCenter.noStepsTitle'))}</div>`;
 drawer(t('commandCenter.operationDetailTitle'),node,{restore:true});
});
function startPolling() {
 stopPolling();
 pollTimer=setInterval(()=>{if(document.visibilityState==='visible' && location.hash==='#command-center')renderOperations().catch(()=>{});},10000);
}
function stopPolling() {if(pollTimer){clearInterval(pollTimer);pollTimer=null;}}

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
async function renderCompanyBrain() {
 const brainTypes=['brain_identity','brain_goals','brain_customers','brain_products','brain_brand','brain_rules'];
 const rows=await Promise.all(brainTypes.map(type=>api('/api/command/context?type='+type)));
 const sections=brainTypes.map((type,i)=>`<div class="cmdc-brain-section"><h4>${escape(t('commandCenter.contextType.'+type))}</h4>${rows[i].length?rows[i].map(item=>`<p><strong>${escape(item.title)}</strong> — ${escape(item.description)}</p>`).join(''):`<p class="cmdc-muted">${escape(t('commandCenter.noBrainItem'))}</p>`}</div>`);
 $('#cmdc-dc-companyBrain').innerHTML=sections.join('');
}

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
export async function renderCommandCenter({api:client}) {
 apiClient=client;
 const generation=++renderGeneration;
 stopPolling();
 currentConversationId=null;
 try {
  const health=await api('/api/command/health');
  if(staleGuard(generation))return;
  renderHealthFrom(health);
  await Promise.all([loadConversations(),renderSuggestions(),renderOperations(),renderInbox(),renderCompanyBrain(),renderSystemMap()]);
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
  [metric(t('commandCenter.metricUnhealthyConnections'),health.unhealthyConnections.length,t('commandCenter.metricUnhealthyConnectionsHint'),'plug'),'integrations'],
  [metric(t('commandCenter.metricNewLeads'),health.newLeadsThisWeek,t('commandCenter.metricNewLeadsHint'),'users'),'crm'],
  [metric(t('commandCenter.metricContentPlanned'),health.contentPlannedThisWeek,t('commandCenter.metricContentPlannedHint'),'file'),'content']
 ];
 $('#cmdc-health').innerHTML=cards.map(([html])=>html).join('');
 $('#cmdc-health').querySelectorAll('.kpi-card').forEach((card,i)=>{card.classList.add('clickable');card.onclick=()=>navigate(cards[i][1]);});
}
