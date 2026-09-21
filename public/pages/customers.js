// Customers & merchants administration (main dashboard, platform admins only). Every action calls
// /api/client-admin/*, which re-checks the caller is a platform admin; every write needs a stated reason and
// lands in the customer's audit log. "Support mode" starts a time-limited, logged session - never a login as the customer.
import {escape,badge,empty,metric,tabs,drawer,promptDrawer,confirmAction,toast,skeleton,table,button} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';
import {fmtDateTime} from '../format.js';

const AGENTS=['frost','strategy','copy','creative','compliance','publishing','leads','sales','followup','intelligence','performance','memory'];
const CLIENT_ENTS=['client.dashboard','client.analytics','client.integrations','client.team','client.workflows','client.approvals','client.export'];
const ALL_ENTS=[...CLIENT_ENTS,...AGENTS.map(a=>`agent.${a}`)];
const LIMITS=['users','integrations','workflows','tasks_per_month','agent_runs_per_month'];
const STATUSES=['pending','trial','active','limited','past_due','suspended','cancelled','archived'];
const TABS=['overview','customers','applications','workspaces','plans','agents','permissions','usage','integrations','support','audit','settings'];

let api,auth,generation=0,activeTab='overview';
const root=()=>document.querySelector('[data-page="customers"] #customers');
const tr=(key,vars)=>t('customers.'+key,vars);
const num=n=>Number(n||0).toLocaleString('en-US');
const errToast=e=>toast(e.message||String(e),'error');
const qs=p=>{const q=new URLSearchParams();for(const [k,v] of Object.entries(p||{}))if(v!==undefined&&v!==null&&v!=='')q.set(k,v);const s=q.toString();return s?'?'+s:'';};
const label=(ns,v)=>{const k=`customers.${ns}.${v}`;const x=t(k);return x===k?String(v):x;};
const pill=(ns,v)=>badge(label(ns,v),v);
const name=o=>getLocale()==='en'?(o.nameEn||o.nameAr):(o.nameAr||o.nameEn);
const node=html=>{const el=document.createElement('div');el.innerHTML=html;return el;};
const form=html=>`<form class="pt-form" novalidate>${html}</form>`;
const fieldH=(l,c,hint)=>`<label>${escape(l)}${c}${hint?`<small>${escape(hint)}</small>`:''}</label>`;
const inp=(n,{type='text',value='',required=false,max,dir,placeholder=''}={})=>`<input name="${n}" type="${type==='number'?'text':type}" ${type==='number'?'inputmode="numeric"':''} value="${escape(value??'')}" ${required?'required':''} ${max?`maxlength="${max}"`:''} placeholder="${escape(placeholder)}" ${dir?`dir="${dir}"`:''}>`;
const area=(n,{value='',required=false,max=1000,rows=3}={})=>`<textarea name="${n}" rows="${rows}" ${required?'required':''} maxlength="${max}">${escape(value??'')}</textarea>`;
const sel=(n,opts,v)=>`<select name="${n}">${opts.map(([a,b])=>`<option value="${escape(a)}" ${String(a)===String(v)?'selected':''}>${escape(b)}</option>`).join('')}</select>`;
const chk=(n,l,c)=>`<label class="check"><input type="checkbox" name="${n}" ${c?'checked':''}>${escape(l)}</label>`;
const read=f=>{const o={};for(const el of f.elements){if(!el.name)continue;o[el.name]=el.type==='checkbox'?el.checked:el.value;}return o;};
const link=(l,attrs='')=>`<button type="button" class="secondary small" ${attrs}>${escape(l)}</button>`;

export function installCustomersPage(){const h=root();if(h)h.innerHTML='<div class="pt-shell"></div>';}

export async function renderCustomersPage({api:client,auth:a}){
 api=client;auth=a;
 const host=root();if(!host)return;
 const my=++generation;
 if(!a.isPlatformAdmin){host.innerHTML=empty(tr('noAccess'),tr('noAccessHint'));return;}
 const shell=host.querySelector('.pt-shell')||host;
 shell.replaceChildren();
 if(!TABS.includes(activeTab))activeTab='overview';
 const panels=TABS.map(id=>{const el=document.createElement('div');el.dataset.tab=id;el.className='pt-panel';return el;});
 shell.append(...panels);
 const bar=tabs(shell,TABS.map((id,i)=>[tr('tab.'+id),panels[i]]));
 const buttons=[...shell.querySelectorAll('.ui-tabs [role=tab]')];
 const loaded=new Set();
 const load=async i=>{
  const id=TABS[i];activeTab=id;if(loaded.has(id))return;loaded.add(id);
  panels[i].replaceChildren(node(skeleton(tr('loading'))));
  try{await LOADERS[id](panels[i],{reload:()=>{loaded.delete(id);return load(i);}});}
  catch(error){if(my!==generation)return;loaded.delete(id);panels[i].innerHTML=`<div class="empty"><strong>${escape(error.message)}</strong></div>`;const b=button(tr('retry'),{variant:'secondary'});b.onclick=()=>load(i);panels[i].firstChild.append(b);}
 };
 buttons.forEach((b,i)=>b.addEventListener('click',()=>load(i)));
 const start=Math.max(0,TABS.indexOf(activeTab));
 bar.select(start);await load(start);
}

// ---- list scaffolding (server-side filtering + paging) ----------------------------------------------------------------------------------------
function pager(r,on){const w=document.createElement('div');w.className='pt-pager';if(!r||r.pages<=1)return w;const p=button(t('common.previous'),{variant:'ghost'}),n=button(t('common.next'),{variant:'ghost'});p.disabled=r.page<=1;n.disabled=r.page>=r.pages;p.onclick=()=>on(r.page-1);n.onclick=()=>on(r.page+1);const s=document.createElement('span');s.textContent=tr('pageOf',{page:r.page,pages:r.pages,total:r.total});w.append(p,s,n);return w;}
async function pagedList(host,{path,filters=[],columns,row,emptyTitle,emptyHint,extraHead,extraQuery={}}){
 host.replaceChildren();
 const head=document.createElement('div');head.className='pt-head';const list=document.createElement('div');
 let state={},page=1;const handlers=new Map();
 const draw=async()=>{
  list.replaceChildren(node(skeleton(tr('loading'))));
  try{
   const r=await api(path+qs({...state,...extraQuery,page}));
   list.replaceChildren();
   if(!r.items.length){list.append(node(empty(emptyTitle,emptyHint)));return;}
   const wrap=document.createElement('div');wrap.className='data-table';const sc=document.createElement('div');sc.className='table-scroll';sc.tabIndex=0;sc.setAttribute('role','region');sc.setAttribute('aria-label',tr('table'));
   sc.innerHTML=table(columns,r.items.map(row));wrap.append(sc);list.append(wrap,pager(r,p=>{page=p;draw();}));
   list.querySelectorAll('[data-row]').forEach(el=>el.addEventListener('click',()=>handlers.get(el.dataset.row.split(':')[0])?.(el.dataset.row.slice(el.dataset.row.indexOf(':')+1),el)));
  }catch(e){list.replaceChildren(node(`<div class="empty"><strong>${escape(e.message)}</strong></div>`));}
 };
 if(filters.length){
  const bar=document.createElement('div');bar.className='pt-filters';
  for(const f of filters){const el=f.type==='search'?document.createElement('input'):document.createElement('select');if(f.type==='search'){el.type='search';el.placeholder=f.label;}else el.innerHTML=`<option value="">${escape(f.label)}</option>`+f.options.map(([v,l])=>`<option value="${escape(v)}">${escape(l)}</option>`).join('');el.setAttribute('aria-label',f.label);state[f.name]='';let timer;el.addEventListener(f.type==='search'?'input':'change',()=>{clearTimeout(timer);timer=setTimeout(()=>{state={...state,[f.name]:el.value};page=1;draw();},f.type==='search'?300:0);});bar.append(el);}
  head.append(bar);
 }
 if(extraHead)head.append(...extraHead(draw));
 host.append(head,list);await draw();
 return {refresh:draw,handlers};
}
async function promptText(title,l,{multi=false,optional=false,hint='',dir}={}){
 return promptDrawer(title,body=>{body.innerHTML=form(fieldH(l,multi?area('value',{max:500,rows:3,required:!optional}):inp('value',{required:!optional,max:300,dir}),hint));const f=body.querySelector('form');const i=f.elements.value;return {focus:()=>i.focus(),validate:()=>{if(!optional&&!i.value.trim()){i.setCustomValidity(tr('required'));i.reportValidity();i.oninput=()=>i.setCustomValidity('');return false;}return true;},value:()=>i.value.trim()};},{confirmLabel:tr('save')});
}
const reasonPrompt=title=>promptText(title,tr('reason'),{multi:true});

// ---- overview -------------------------------------------------------------------------------------------------------------------------------------------
async function overview(host){
 const o=await api('/api/client-admin/overview');
 const c=o.customers;
 host.innerHTML=`
  ${!o.mailConfigured?`<div class="notice">${escape(tr('ov.mailWarn'))}</div>`:''}${!o.supportAuthorized?`<div class="notice">${escape(tr('ov.supportWarn'))}</div>`:''}
  <div class="kpi-grid">
   ${metric(tr('ov.customers'),num(c.total),tr('ov.customersHint',{active:c.active,trial:c.trial}),'users')}
   ${metric(tr('ov.limited'),num(c.limited),tr('ov.limitedHint',{suspended:c.suspended,pending:c.pending}),'clock')}
   ${metric(tr('ov.workspaces'),num(o.workspaces.total),tr('ov.workspacesHint',{onb:o.workspaces.onboarding,ready:o.workspaces.ready}),'grid')}
   ${metric(tr('ov.tasksRunning'),num(o.tasks.running),tr('ov.tasks30',{done:o.tasks.completed30,failed:o.tasks.failed30}),'chart')}
   ${metric(tr('ov.approvals'),num(o.approvalsPending),'','check')}
   ${metric(tr('ov.integrations'),num(o.integrationsBroken),tr('ov.integrationsHint'),'plug')}
   ${metric(tr('ov.support'),num(o.activeSupportSessions),tr('ov.supportHint'),'bell')}
  </div>
  <section class="panel"><h3>${escape(tr('ov.topAgents'))}</h3>${o.topAgents.length?table([tr('col.agent'),tr('col.runs'),tr('col.failed')],o.topAgents.map(a=>[escape(a.agentId),num(a.runs),num(a.failed)])):empty(tr('ov.noUsage'),tr('ov.noUsageHint'))}</section>
  <section class="panel"><h3>${escape(tr('ov.nearLimit'))}</h3>${o.nearLimit.length?table([tr('col.customer'),tr('col.tasks'),tr('col.runs')],o.nearLimit.map(n=>[`<button type="button" class="secondary small" data-open="${escape(n.tenantId)}">${escape(n.businessName)}</button>`,`${num(n.usage.tasks)} / ${n.usage.tasksLimit??'∞'}`,`${num(n.usage.runs)} / ${n.usage.runsLimit??'∞'}`])):empty(tr('ov.noNear'))}</section>`;
 host.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>openCustomer(b.dataset.open)));
}

// ---- customers / applications / workspaces ------------------------------------------------------------------------------------------------------------------
const planOptions=async()=>(await api('/api/client-admin/plans')).items;
async function customers(host){
 const plans=await planOptions();
 const ctl=await pagedList(host,{path:'/api/client-admin/customers',
  filters:[{type:'search',name:'q',label:tr('search')},{type:'select',name:'status',label:tr('col.status'),options:STATUSES.map(s=>[s,label('astatus',s)])},{type:'select',name:'plan',label:tr('col.plan'),options:plans.map(p=>[p.slug,name(p)])},{type:'select',name:'nearLimit',label:tr('col.limits'),options:[['1',tr('nearLimit')]]},{type:'select',name:'sort',label:tr('sort'),options:[['name',tr('col.customer')],['created',tr('col.created')],['activity',tr('col.activity')],['usage',tr('col.tasks')],['members',tr('col.members')]]}],
  columns:[tr('col.customer'),tr('col.plan'),tr('col.status'),tr('col.members'),tr('col.agents'),tr('col.tasks'),tr('col.activity'),tr('col.created'),''],
  row:c=>[`<strong>${escape(c.businessName)}</strong><small dir="ltr">${escape(c.ownerEmail||'')}</small>`,escape(c.plan?name(c.plan):'—'),pill('astatus',c.status)+(c.nearLimit?` <span class="pill" data-status="warn">${escape(tr('nearLimit'))}</span>`:''),num(c.members),num(c.agentsEnabled),`${num(c.usage.tasks)}${c.usage.tasksLimit!==null?' / '+num(c.usage.tasksLimit):''}`,c.lastActivityAt?fmtDateTime(c.lastActivityAt):'—',fmtDateTime(c.createdAt),link(tr('open'),`data-row="c:${escape(c.tenantId)}"`)],
  emptyTitle:tr('cust.empty'),emptyHint:tr('cust.emptyHint')});
 ctl.handlers.set('c',id=>openCustomer(id,ctl.refresh));
}
async function applications(host,{reload}){
 const ctl=await pagedList(host,{path:'/api/client-admin/applications',
  columns:[tr('col.customer'),tr('col.owner'),tr('col.country'),tr('col.type'),tr('col.plan'),tr('col.created'),''],
  row:c=>[`<strong>${escape(c.businessName)}</strong>`,`${escape(c.ownerName||'')}<small dir="ltr">${escape(c.ownerEmail||'')}</small>`,escape(c.country||''),escape(c.businessType||''),escape(c.plan?name(c.plan):'—'),fmtDateTime(c.createdAt),`<div class="row">${link(tr('approve'),`data-row="ok:${escape(c.tenantId)}"`)}${link(tr('reject'),`data-row="no:${escape(c.tenantId)}"`)}${link(tr('open'),`data-row="c:${escape(c.tenantId)}"`)}</div>`],
  emptyTitle:tr('apps.empty'),emptyHint:tr('apps.emptyHint')});
 ctl.handlers.set('c',id=>openCustomer(id,ctl.refresh));
 ctl.handlers.set('ok',async id=>{if(await confirmAction(tr('approve'),tr('apps.confirm'))){try{await api(`/api/client-admin/customers/${id}/approve`,{});toast(tr('saved'),'success');ctl.refresh();}catch(e){errToast(e);}}});
 ctl.handlers.set('no',async id=>{const r=await reasonPrompt(tr('reject'));if(r){try{await api(`/api/client-admin/customers/${id}/status`,{status:'cancelled',reason:r});toast(tr('saved'),'success');ctl.refresh();}catch(e){errToast(e);}}});
}
async function workspaces(host){
 const ctl=await pagedList(host,{path:'/api/client-admin/customers',filters:[{type:'search',name:'q',label:tr('search')},{type:'select',name:'status',label:tr('col.status'),options:STATUSES.map(s=>[s,label('astatus',s)])}],
  columns:[tr('col.workspace'),tr('col.workspaceStatus'),tr('col.status'),tr('col.members'),tr('col.trialEnds'),tr('col.periodEnds'),''],
  row:c=>[`<strong>${escape(c.businessName)}</strong><small dir="ltr">${escape(c.tenantId.slice(0,8))}</small>`,pill('wstatus',c.workspaceStatus),pill('astatus',c.status),num(c.members),c.trialEndsAt?fmtDateTime(c.trialEndsAt):'—',c.endsAt?fmtDateTime(c.endsAt):'—',link(tr('open'),`data-row="c:${escape(c.tenantId)}"`)],
  emptyTitle:tr('ws.empty'),emptyHint:tr('cust.emptyHint')});
 ctl.handlers.set('c',id=>openCustomer(id,ctl.refresh));
}

// ---- customer detail -------------------------------------------------------------------------------------------------------------------------------------------
async function openCustomer(tenantId,refresh){
 const holder=document.createElement('div');
 const dialog=drawer(tr('cust.detail'),holder);
 dialog.classList.add('wide');
 dialog.addEventListener('close',()=>{dialog.remove();refresh?.();});
 const plans=await planOptions();
 async function paint(){
  holder.replaceChildren(node(skeleton(tr('loading'))));
  let d;try{d=await api('/api/client-admin/customers/'+tenantId);}catch(e){holder.innerHTML=`<div class="empty"><strong>${escape(e.message)}</strong></div>`;return;}
  const r=d.row,s=d.subscription;
  holder.innerHTML=`
   <div class="row-between"><div><h3>${escape(r.businessName)}</h3><p class="muted" dir="ltr">${escape(d.owner?.email||'')} · ${escape(d.owner?.username||'')}</p></div><div>${pill('astatus',r.status)} ${pill('wstatus',r.workspaceStatus)}</div></div>
   ${d.profile.statusReason?`<p class="notice">${escape(d.profile.statusReason)}</p>`:''}
   <dl class="pt-dl">
    <div><dt>${escape(tr('col.plan'))}</dt><dd>${escape(s.plan?name(s.plan):'—')}</dd></div>
    <div><dt>${escape(tr('col.trialEnds'))}</dt><dd>${s.trialEndsAt?fmtDateTime(s.trialEndsAt):'—'}</dd></div>
    <div><dt>${escape(tr('col.periodEnds'))}</dt><dd>${s.endsAt?fmtDateTime(s.endsAt):'—'}</dd></div>
    <div><dt>${escape(tr('d.grace'))}</dt><dd>${s.graceUntil?fmtDateTime(s.graceUntil):'—'}</dd></div>
    <div><dt>${escape(tr('col.country'))}</dt><dd>${escape(d.profile.country||'')}</dd></div>
    <div><dt>${escape(tr('d.businessType'))}</dt><dd>${escape(d.profile.businessType||'')} · ${escape(d.profile.businessSize||'')}</dd></div>
    <div><dt>${escape(tr('d.platform'))}</dt><dd>${escape(d.profile.ecommercePlatform||'')}</dd></div>
    <div><dt>${escape(tr('d.terms'))}</dt><dd>${escape(d.profile.termsVersion||'')} · ${d.profile.termsAcceptedAt?fmtDateTime(d.profile.termsAcceptedAt):''}</dd></div>
   </dl>
   <div class="row pt-actions" id="cd-actions"></div>
   <h4>${escape(tr('d.usage'))}</h4>
   ${table([tr('d.limit'),tr('d.used'),tr('d.max')],LIMITS.filter(k=>d.access.limits[k]!==undefined).map(k=>[escape(label('limit',k)),d.access.usage[k]===null?'—':num(d.access.usage[k]),d.access.limits[k]===null?'∞':num(d.access.limits[k])]))}
   <h4>${escape(tr('d.agents'))}</h4>
   ${table([tr('col.agent'),tr('col.status'),tr('d.adminState'),tr('d.approval'),tr('d.monthly'),''],d.agents.map(a=>[`<strong>${escape(name(a))}</strong><small>${escape(a.key)}</small>`,pill('astate',a.status),escape(label('adminstate',a.adminState)),escape(label('level',a.approvalLevel)),`${num(a.usageThisMonth)}${a.usageLimitMonthly!==null?' / '+num(a.usageLimitMonthly):''}`,link(tr('control'),`data-agent="${escape(a.key)}"`)]))}
   <h4>${escape(tr('d.team'))}</h4>
   ${table([tr('col.owner'),tr('d.role'),tr('col.status')],d.team.members.map(m=>[`<strong>${escape(m.name)}</strong><small dir="ltr">${escape(m.email||m.username)}</small>`,escape(label('role',m.role)),pill('mstatus',m.status)]))}
   ${d.team.invitations.length?`<p class="muted">${escape(tr('d.pendingInvites'))}: ${d.team.invitations.map(i=>`<span dir="ltr">${escape(i.email)}</span> <button type="button" class="secondary small" data-resend="${escape(i.id)}">${escape(tr('resend'))}</button>`).join(' · ')}</p>`:''}
   <h4>${escape(tr('d.integrations'))}</h4>
   ${d.integrations.length?table([tr('col.provider'),tr('col.status'),tr('d.lastCheck'),tr('d.lastError')],d.integrations.map(i=>[escape(name(i)),escape(i.connection.status),i.connection.lastHealthCheck?fmtDateTime(i.connection.lastHealthCheck):'—',escape(i.connection.lastError||'')])):`<p class="muted">${escape(tr('d.noIntegrations'))}</p>`}
   <h4>${escape(tr('d.tasks'))}</h4>
   ${d.tasks.recent.length?table([tr('col.title'),tr('col.agent'),tr('col.status'),tr('d.error')],d.tasks.recent.map(x=>[escape(x.title),escape(x.agentId),escape(x.status),escape(x.error||'')])):`<p class="muted">${escape(tr('d.noTasks'))}</p>`}
   ${d.errors.length?`<h4>${escape(tr('d.errors'))}</h4>${table([tr('col.agent'),tr('d.error'),tr('col.created')],d.errors.map(e=>[escape(e.agentId),escape(String(e.error||'').slice(0,160)),fmtDateTime(e.at)]))}`:''}
   <h4>${escape(tr('d.support'))}</h4>
   ${d.supportSessions.length?table([tr('col.admin'),tr('d.level'),tr('reason'),tr('col.status'),tr('col.created')],d.supportSessions.map(x=>[escape(x.adminName),escape(label('slevel',x.accessLevel)),escape(x.reason),pill('sstatus',x.status),fmtDateTime(x.startedAt)])):`<p class="muted">${escape(tr('d.noSupport'))}</p>`}
   <h4>${escape(tr('d.notes'))}</h4>
   <div>${d.notes.length?d.notes.map(n=>`<div class="audit-row">${escape(n.note)}<time>${escape(n.authorName||'')} · ${fmtDateTime(n.createdAt)}</time></div>`).join(''):`<p class="muted">${escape(tr('d.noNotes'))}</p>`}</div>
   <h4>${escape(tr('d.audit'))}</h4>
   <div>${d.audit.slice(0,25).map(a=>`<div class="audit-row"><strong dir="ltr">${escape(a.action)}</strong> · ${escape(a.actorName||a.actorKind)}${a.supportSessionId?` · <em>${escape(tr('viaSupport'))}</em>`:''}${a.reason?` · ${escape(a.reason)}`:''}<time>${fmtDateTime(a.createdAt)}</time></div>`).join('')||`<p class="muted">${escape(tr('d.noAudit'))}</p>`}</div>`;
  const actions=holder.querySelector('#cd-actions');
  const add=(text,fn,variant='secondary')=>{const b=button(text,{variant});b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){errToast(e);}finally{b.disabled=false;}};actions.append(b);};
  const post=async(path,body,method)=>{await api(`/api/client-admin/customers/${tenantId}${path}`,body,method);toast(tr('saved'),'success');await paint();};
  if(r.storedStatus==='pending'){add(tr('approve'),async()=>{if(await confirmAction(tr('approve'),tr('apps.confirm')))await post('/approve',{});},'primary');}
  add(tr('act.supportSession'),()=>startSupport(tenantId),'primary');
  add(tr('act.plan'),async()=>{
   const v=await promptDrawer(tr('act.plan'),b=>{b.innerHTML=form(`${fieldH(tr('col.plan'),sel('planId',plans.filter(p=>p.status==='active').map(p=>[p.id,name(p)]),s.plan?.id))}${chk('trial',tr('act.asTrial'),false)}${fieldH(tr('act.endsAt'),inp('endsAt',{type:'date'}),tr('act.endsAtHint'))}${fieldH(tr('reason'),area('reason',{required:true,max:300,rows:2}))}`);const f=b.querySelector('form');return {validate:()=>f.reportValidity(),value:()=>read(f)};},{confirmLabel:tr('save')});
   if(v)await post('/plan',{planId:v.planId,trial:v.trial,endsAt:v.endsAt?new Date(v.endsAt+'T23:59:59Z').toISOString():undefined,reason:v.reason});
  });
  add(tr('act.grace'),async()=>{
   const v=await promptDrawer(tr('act.grace'),b=>{b.innerHTML=form(`${fieldH(tr('act.graceUntil'),inp('until',{type:'date',required:true}))}${fieldH(tr('reason'),area('reason',{required:true,max:300,rows:2}))}`);const f=b.querySelector('form');return {validate:()=>f.reportValidity(),value:()=>read(f)};},{confirmLabel:tr('save')});
   if(v)await post('/grace',{until:new Date(v.until+'T23:59:59Z').toISOString(),reason:v.reason});
  });
  add(tr('act.overrides'),()=>overridesDrawer(tenantId,d,paint));
  if(['suspended','cancelled','archived'].includes(r.storedStatus))add(tr('act.reactivate'),async()=>{const reason=await reasonPrompt(tr('act.reactivate'));if(reason)await post('/status',{status:'active',reason});});
  else{
   add(tr('act.suspend'),async()=>{const reason=await reasonPrompt(tr('act.suspend'));if(reason)await post('/status',{status:'suspended',reason});},'danger');
   add(tr('act.cancel'),async()=>{const reason=await reasonPrompt(tr('act.cancel'));if(reason)await post('/status',{status:'cancelled',reason});},'danger');
   add(tr('act.archive'),async()=>{const reason=await reasonPrompt(tr('act.archive'));if(reason)await post('/status',{status:'archived',reason});});
  }
  add(tr('act.logout'),async()=>{const reason=await reasonPrompt(tr('act.logout'));if(reason)await post('/force-logout',{reason});});
  add(tr('act.note'),async()=>{const n=await promptText(tr('act.note'),tr('d.notes'),{multi:true});if(n)await post('/notes',{note:n});});
  holder.querySelectorAll('[data-agent]').forEach(b=>b.addEventListener('click',()=>agentControl(tenantId,d.agents.find(a=>a.key===b.dataset.agent),paint)));
  holder.querySelectorAll('[data-resend]').forEach(b=>b.addEventListener('click',async()=>{try{await api(`/api/client-admin/customers/${tenantId}/invitations/${b.dataset.resend}/resend`,{});toast(tr('saved'),'success');}catch(e){errToast(e);}}));
 }
 await paint();
}
async function startSupport(tenantId){
 const v=await promptDrawer(tr('act.supportSession'),b=>{b.innerHTML=`<p class="notice">${escape(tr('sup.explain'))}</p>`+form(`${fieldH(tr('sup.level'),sel('level',[['view_only',label('slevel','view_only')],['limited',label('slevel','limited')],['extended',label('slevel','extended')]],'view_only'),tr('sup.levelHint'))}${fieldH(tr('sup.minutes'),inp('minutes',{type:'number',value:'30',required:true}))}${fieldH(tr('sup.ticket'),inp('ticket',{max:60,dir:'ltr'}))}${fieldH(tr('reason'),area('reason',{required:true,max:500,rows:3}),tr('sup.reasonHint'))}`);const f=b.querySelector('form');return {validate:()=>f.reportValidity(),value:()=>read(f)};},{confirmLabel:tr('sup.start')});
 if(!v)return;
 try{const r=await api(`/api/client-admin/customers/${tenantId}/support-sessions`,{reason:v.reason,ticket:v.ticket||undefined,level:v.level,minutes:Number(v.minutes)});location.assign(r.redirect);}catch(e){errToast(e);}
}
async function overridesDrawer(tenantId,d,paint){
 const ov=d.access.overrides;
 const v=await promptDrawer(tr('act.overrides'),b=>{
  b.innerHTML=`<p class="muted">${escape(tr('ov.help'))}</p>`+form(`
   <fieldset><legend>${escape(tr('ov.entitlements'))}</legend>${ALL_ENTS.map(k=>`<label>${escape(k)}${sel('e:'+k,[['inherit',tr('ov.inherit')],['allow',tr('ov.allow')],['deny',tr('ov.deny')]],ov.entitlements[k]||'inherit')}<small>${escape(tr('ov.effective'))}: ${d.access.entitlements.includes(k)?'✔':'✘'}</small></label>`).join('')}</fieldset>
   <fieldset><legend>${escape(tr('ov.limits'))}</legend>${LIMITS.map(k=>fieldH(label('limit',k),inp('l:'+k,{value:k in ov.limits?ov.limits[k]:'',placeholder:d.access.limits[k]===null?'∞':String(d.access.limits[k]),dir:'ltr'}),tr('ov.limitHint'))).join('')}</fieldset>
   ${fieldH(tr('reason'),area('reason',{required:true,max:300,rows:2}))}`);
  const f=b.querySelector('form');return {validate:()=>f.reportValidity(),value:()=>read(f)};
 },{confirmLabel:tr('save')});
 if(!v)return;
 const entitlements={},limits={};
 for(const k of ALL_ENTS)if((ov.entitlements[k]||'inherit')!==v['e:'+k])entitlements[k]=v['e:'+k];
 for(const k of LIMITS){const raw=String(v['l:'+k]).trim();const before=k in ov.limits?String(ov.limits[k]):'';if(raw===before)continue;limits[k]=raw===''?'inherit':/^(unlimited|∞)$/i.test(raw)?null:Number(raw);}
 try{await api(`/api/client-admin/customers/${tenantId}/overrides`,{entitlements,limits,reason:v.reason},'PUT');toast(tr('saved'),'success');await paint();}catch(e){errToast(e);}
}
async function agentControl(tenantId,a,paint){
 const v=await promptDrawer(`${tr('control')}: ${name(a)}`,b=>{
  b.innerHTML=form(`${fieldH(tr('d.adminState'),sel('adminState',[['default',label('adminstate','default')],['enabled',label('adminstate','enabled')],['disabled',label('adminstate','disabled')]],a.adminState),tr('agent.stateHint'))}
   ${fieldH(tr('agent.approval'),sel('approvalLevel',[['',tr('agent.noForce')],['manual',label('level','manual')],['approval_required',label('level','approval_required')],['limited_autonomy',label('level','limited_autonomy')]],''),tr('agent.approvalHint'))}
   ${fieldH(tr('agent.limit'),inp('usageLimitMonthly',{value:a.usageLimitMonthly??'',dir:'ltr'}),tr('agent.limitHint'))}
   ${fieldH(tr('agent.allowed'),inp('allowed',{value:(a.allowedActions||[]).join(', '),dir:'ltr'}),tr('agent.actionsHint',{list:a.supportedActions.slice(0,6).join(', ')}))}
   ${fieldH(tr('agent.blocked'),inp('blocked',{value:(a.blockedActions||[]).join(', '),dir:'ltr'}))}
   ${fieldH(tr('agent.note'),inp('adminNote',{value:a.adminNote||'',max:300}))}
   ${fieldH(tr('reason'),area('reason',{required:true,max:300,rows:2}))}`);
  const f=b.querySelector('form');return {validate:()=>f.reportValidity(),value:()=>read(f)};
 },{confirmLabel:tr('save')});
 if(!v)return;
 const list=s=>String(s).split(',').map(x=>x.trim()).filter(Boolean);
 const body={adminState:v.adminState,allowedActions:list(v.allowed),blockedActions:list(v.blocked),adminNote:v.adminNote,usageLimitMonthly:String(v.usageLimitMonthly).trim()===''?null:Number(v.usageLimitMonthly),reason:v.reason};
 if(v.approvalLevel)body.approvalLevel=v.approvalLevel;
 try{await api(`/api/client-admin/customers/${tenantId}/agents/${a.key}`,body,'PUT');toast(tr('saved'),'success');await paint();}catch(e){errToast(e);}
}

// ---- plans ---------------------------------------------------------------------------------------------------------------------------------------------------------
async function plans(host,{reload}){
 const r=await api('/api/client-admin/plans');
 host.innerHTML=`<div class="row-between pt-head"><p class="muted">${escape(tr('plans.hint'))}</p></div><div id="cp-plans"></div>`;
 const add=button(tr('plans.new'),{variant:'primary',iconName:'plus'});add.onclick=()=>editPlan(null,reload);host.querySelector('.pt-head').append(add);
 host.querySelector('#cp-plans').innerHTML=r.items.length?table([tr('col.plan'),tr('plans.price'),tr('plans.agents'),tr('plans.users'),tr('plans.tasks'),tr('plans.customers'),tr('col.status'),''],r.items.map(p=>[`<strong>${escape(name(p))}</strong><small dir="ltr">${escape(p.slug)}</small>`,p.priceMinor?`${(p.priceMinor/100).toFixed(2)} ${escape(p.currency)} / ${escape(label('period',p.billingPeriod))}`:escape(tr('plans.free')),num(p.entitlements.filter(e=>e.startsWith('agent.')).length),p.limits.users??'∞',p.limits.tasks_per_month??'∞',num(r.customers[p.id]||0),pill('pstatus',p.status),link(tr('edit'),`data-plan="${escape(p.id)}"`)])):empty(tr('plans.empty'));
 host.querySelectorAll('[data-plan]').forEach(b=>b.addEventListener('click',()=>editPlan(r.items.find(p=>p.id===b.dataset.plan),reload)));
}
async function editPlan(plan,reload){
 const p=plan||{};
 const v=await promptDrawer(plan?tr('plans.edit'):tr('plans.new'),b=>{
  b.innerHTML=form(`${plan?'':fieldH(tr('plans.slug'),inp('slug',{required:true,max:40,dir:'ltr'}))}
   <div class="row">${fieldH(tr('plans.nameAr'),inp('nameAr',{required:true,value:p.nameAr,max:120}))}${fieldH(tr('plans.nameEn'),inp('nameEn',{required:true,value:p.nameEn,max:120,dir:'ltr'}))}</div>
   ${fieldH(tr('plans.descAr'),area('descriptionAr',{value:p.descriptionAr,max:2000,rows:2}))}${fieldH(tr('plans.descEn'),area('descriptionEn',{value:p.descriptionEn,max:2000,rows:2}))}
   <div class="row">${fieldH(tr('plans.price'),inp('price',{value:p.priceMinor!==undefined?(p.priceMinor/100).toFixed(2):'0.00',dir:'ltr'}),tr('plans.priceHint'))}${fieldH(tr('plans.period'),sel('billingPeriod',['free','monthly','yearly','one_time'].map(x=>[x,label('period',x)]),p.billingPeriod||'monthly'))}${fieldH(tr('plans.trialDays'),inp('trialDays',{type:'number',value:p.trialDays??14}))}</div>
   <div class="row">${fieldH(tr('col.status'),sel('status',['active','inactive','archived'].map(x=>[x,label('pstatus',x)]),p.status||'active'))}${fieldH(tr('plans.support'),inp('supportLevel',{value:p.supportLevel||'standard',max:30}))}${chk('highlighted',tr('plans.highlighted'),p.highlighted)}</div>
   <fieldset><legend>${escape(tr('ov.limits'))}</legend><div class="row">${LIMITS.map(k=>fieldH(label('limit',k),inp('l:'+k,{value:p.limits?.[k]??'',dir:'ltr'}))).join('')}</div><small>${escape(tr('plans.limitsHint'))}</small></fieldset>
   <fieldset><legend>${escape(tr('ov.entitlements'))}</legend>${ALL_ENTS.map(k=>chk('e:'+k,k,(p.entitlements||[]).includes(k))).join('')}</fieldset>`);
  const f=b.querySelector('form');return {validate:()=>f.reportValidity(),value:()=>read(f)};
 },{confirmLabel:tr('save')});
 if(!v)return;
 const limits={};for(const k of LIMITS){const raw=String(v['l:'+k]).trim();if(raw!=='')limits[k]=Number(raw);}
 const payload={nameAr:v.nameAr,nameEn:v.nameEn,descriptionAr:v.descriptionAr,descriptionEn:v.descriptionEn,price:v.price,billingPeriod:v.billingPeriod,trialDays:Number(v.trialDays),status:v.status,supportLevel:v.supportLevel,highlighted:v.highlighted,limits,entitlements:ALL_ENTS.filter(k=>v['e:'+k])};
 if(!plan)payload.slug=v.slug;
 try{await api(plan?'/api/client-admin/plans/'+plan.id:'/api/client-admin/plans',payload,plan?'PATCH':'POST');toast(tr('saved'),'success');await reload();}catch(e){errToast(e);}
}

// ---- agents (platform-wide) ------------------------------------------------------------------------------------------------------------------------------------------
async function agents(host,{reload}){
 const r=await api('/api/client-admin/agents');
 host.innerHTML=`<p class="muted">${escape(tr('agents.hint'))}</p>${table([tr('col.agent'),tr('agents.category'),tr('agents.risk'),tr('agents.platform'),tr('agents.plans'),tr('agents.runs30'),tr('agents.workspaces'),''],r.items.map(a=>[`<strong>${escape(name(a))}</strong><small>${escape(a.key)}</small>`,escape(a.category),escape(a.riskLevel),pill('avail',a.platform.available?'on':'off'),escape(a.platform.allowedPlans?a.platform.allowedPlans.join(', '):tr('agents.allPlans')),`${num(a.runs30)} (${num(a.failed30)} ${escape(tr('col.failed'))})`,num(a.workspaces30),link(tr('control'),`data-agent="${escape(a.key)}"`)]))}`;
 host.querySelectorAll('[data-agent]').forEach(b=>b.addEventListener('click',async()=>{
  const a=r.items.find(x=>x.key===b.dataset.agent);
  const v=await promptDrawer(`${tr('control')}: ${name(a)}`,body=>{body.innerHTML=form(`${chk('available',tr('agents.available'),a.platform.available)}${fieldH(tr('agents.plansOnly'),inp('plans',{value:(a.platform.allowedPlans||[]).join(', '),dir:'ltr'}),tr('agents.plansHint',{list:r.plans.map(p=>p.slug).join(', ')}))}${fieldH(tr('agent.note'),inp('note',{value:a.platform.note||'',max:300}))}${fieldH(tr('reason'),area('reason',{required:true,max:300,rows:2}))}`);const f=body.querySelector('form');return {validate:()=>f.reportValidity(),value:()=>read(f)};},{confirmLabel:tr('save')});
  if(!v)return;
  try{await api(`/api/client-admin/agents/${a.key}/platform`,{available:v.available,allowedPlans:String(v.plans).split(',').map(x=>x.trim()).filter(Boolean),note:v.note,reason:v.reason},'PUT');toast(tr('saved'),'success');await reload();}catch(e){errToast(e);}
 }));
}

// ---- permissions (reference) -----------------------------------------------------------------------------------------------------------------------------------------
async function permissions(host){
 const r=await api('/api/client-admin/permissions');
 host.innerHTML=`<p class="muted">${escape(tr('perm.hint'))}</p>${table([tr('perm.permission'),...r.roles.map(x=>label('role',x.role))],r.permissions.map(p=>[`<code dir="ltr">${escape(p)}</code>`,...r.roles.map(x=>x.permissions.includes(p)?'✔':'—')]))}
  <section class="panel"><h3>${escape(tr('perm.entitlements'))}</h3><p class="chips-line">${r.entitlements.map(e=>`<code dir="ltr">${escape(e)}</code>`).join(' ')}</p></section>`;
}

// ---- usage / integrations --------------------------------------------------------------------------------------------------------------------------------------------
async function usage(host){
 const ctl=await pagedList(host,{path:'/api/client-admin/usage',columns:[tr('col.customer'),tr('col.plan'),tr('col.status'),tr('col.members'),tr('col.tasks'),tr('col.runs'),tr('usage.tokens'),''],
  row:u=>[`<strong>${escape(u.businessName)}</strong>`,escape(u.plan?name(u.plan):'—'),pill('astatus',u.status),num(u.members),`${num(u.usage.tasks)}${u.usage.tasksLimit!==null?' / '+num(u.usage.tasksLimit):''}`,`${num(u.usage.runs)}${u.usage.runsLimit!==null?' / '+num(u.usage.runsLimit):''}`,num(u.tokens30),link(tr('open'),`data-row="c:${escape(u.tenantId)}"`)],emptyTitle:tr('cust.empty'),emptyHint:tr('cust.emptyHint')});
 ctl.handlers.set('c',id=>openCustomer(id,ctl.refresh));
}
async function integrations(host){
 const ctl=await pagedList(host,{path:'/api/client-admin/integrations',columns:[tr('col.customer'),tr('col.provider'),tr('col.status'),tr('d.lastCheck'),tr('d.lastError'),''],
  row:i=>[`<strong>${escape(i.businessName)}</strong>`,escape(i.provider),`<span class="pill" data-status="${i.status==='CONNECTED'?'active':'pending'}">${escape(i.status)}</span>`,i.lastHealthCheck?fmtDateTime(i.lastHealthCheck):'—',escape(i.lastError||''),link(tr('open'),`data-row="c:${escape(i.tenantId)}"`)],emptyTitle:tr('int.empty'),emptyHint:tr('int.emptyHint')});
 ctl.handlers.set('c',id=>openCustomer(id,ctl.refresh));
}

// ---- support sessions / audit ----------------------------------------------------------------------------------------------------------------------------------------
async function support(host,{reload}){
 const r=await api('/api/client-admin/support-sessions');
 host.innerHTML=`<p class="muted">${escape(tr('sup.hint'))}${r.canStart?'':' '+escape(tr('sup.notAuthorized'))}</p>${r.items.length?table([tr('col.customer'),tr('col.admin'),tr('d.level'),tr('reason'),tr('col.status'),tr('col.created'),tr('sup.expires'),tr('sup.activity'),''],r.items.map(s=>[`<strong>${escape(s.businessName||'')}</strong>`,escape(s.adminName),escape(label('slevel',s.accessLevel)),`${escape(s.reason)}${s.ticket?`<small>#${escape(s.ticket)}</small>`:''}`,pill('sstatus',s.status),fmtDateTime(s.startedAt),fmtDateTime(s.expiresAt),`${num(s.actions)} / ${num(s.pageViews)}`,`<div class="row">${link(tr('open'),`data-s="${escape(s.id)}"`)}${s.status==='active'?link(tr('sup.revoke'),`data-revoke="${escape(s.id)}"`):''}</div>`])):empty(tr('sup.empty'),tr('sup.emptyHint'))}`;
 host.querySelectorAll('[data-revoke]').forEach(b=>b.addEventListener('click',async()=>{const reason=await reasonPrompt(tr('sup.revoke'));if(!reason)return;try{await api(`/api/client-admin/support-sessions/${b.dataset.revoke}/revoke`,{reason});toast(tr('saved'),'success');await reload();}catch(e){errToast(e);}}));
 host.querySelectorAll('[data-s]').forEach(b=>b.addEventListener('click',async()=>{
  try{const d=await api('/api/client-admin/support-sessions/'+b.dataset.s);
   const holder=document.createElement('div');holder.innerHTML=`<p><strong>${escape(tr('reason'))}:</strong> ${escape(d.reason)}</p><h4>${escape(tr('sup.actions'))}</h4>${d.actions.length?table([tr('d.action'),tr('col.created')],d.actions.map(a=>[escape(a.action),fmtDateTime(a.at)])):`<p class="muted">${escape(tr('sup.noActions'))}</p>`}<h4>${escape(tr('sup.activity'))}</h4>${d.events.length?table([tr('sup.event'),tr('sup.path'),tr('col.created')],d.events.slice(0,80).map(e=>[escape(e.kind),escape(e.path||e.detail||''),fmtDateTime(e.at)])):`<p class="muted">${escape(tr('sup.noActions'))}</p>`}`;
   const dlg=drawer(tr('sup.detail'),holder);dlg.addEventListener('close',()=>dlg.remove());}catch(e){errToast(e);}
 }));
}
async function audit(host){
 const ctl=await pagedList(host,{path:'/api/client-admin/audit',filters:[{type:'search',name:'action',label:tr('audit.action')},{type:'select',name:'support',label:tr('audit.scope'),options:[['1',tr('audit.supportOnly')]]}],
  columns:[tr('col.created'),tr('col.customer'),tr('d.action'),tr('audit.by'),tr('reason')],
  row:a=>[fmtDateTime(a.createdAt),escape(a.businessName||'—'),`<strong dir="ltr">${escape(a.action)}</strong>`,`${escape(a.actorName||a.actorKind||'')}${a.supportSessionId?`<small>${escape(tr('viaSupport'))}</small>`:''}`,escape(a.reason||'')],emptyTitle:tr('audit.empty'),emptyHint:tr('audit.emptyHint')});
 return ctl;
}

// ---- settings --------------------------------------------------------------------------------------------------------------------------------------------------------------
async function settings(host,{reload}){
 const s=await api('/api/client-admin/settings');
 const plansList=(await planOptions()).filter(p=>p.status==='active');
 host.innerHTML=`<section class="panel"><h3>${escape(tr('set.title'))}</h3>${form(`
  <div class="row">${fieldH(tr('set.registration'),sel('registration_mode',[['open',tr('set.open')],['approval',tr('set.approval')]],s.registration_mode),tr('set.registrationHint'))}${fieldH(tr('set.defaultPlan'),sel('default_plan_slug',plansList.map(p=>[p.slug,name(p)]),s.default_plan_slug))}</div>
  <div class="row">${chk('support_ticket_required',tr('set.ticket'),s.support_ticket_required)}${chk('support_notify_customer',tr('set.notify'),s.support_notify_customer)}${fieldH(tr('set.maxMinutes'),inp('support_max_minutes',{type:'number',value:s.support_max_minutes}))}</div>
  <fieldset><legend>${escape(tr('set.legal'))}</legend>${!s.terms_ar&&!s.terms_en?`<p class="notice">${escape(tr('set.termsEmpty'))}</p>`:''}${fieldH(tr('set.termsVersion'),inp('terms_version',{value:s.terms_version,max:20,dir:'ltr'}))}${fieldH(tr('set.termsAr'),area('terms_ar',{value:s.terms_ar,max:20000,rows:5}))}${fieldH(tr('set.termsEn'),area('terms_en',{value:s.terms_en,max:20000,rows:5}))}${fieldH(tr('set.privacyAr'),area('privacy_ar',{value:s.privacy_ar,max:20000,rows:4}))}${fieldH(tr('set.privacyEn'),area('privacy_en',{value:s.privacy_en,max:20000,rows:4}))}</fieldset>`)}
  <div class="row"><button type="button" id="cs-save">${escape(tr('save'))}</button></div></section>`;
 host.querySelector('#cs-save').addEventListener('click',async e=>{
  const f=host.querySelector('form');if(!f.reportValidity())return;const v=read(f);e.target.disabled=true;
  try{await api('/api/client-admin/settings',{registration_mode:v.registration_mode,default_plan_slug:v.default_plan_slug,support_ticket_required:v.support_ticket_required,support_notify_customer:v.support_notify_customer,support_max_minutes:Number(v.support_max_minutes),terms_version:v.terms_version,terms_ar:v.terms_ar,terms_en:v.terms_en,privacy_ar:v.privacy_ar,privacy_en:v.privacy_en},'PUT');toast(tr('saved'),'success');await reload();}catch(err){errToast(err);}finally{e.target.disabled=false;}
 });
}

const LOADERS={overview,customers,applications,workspaces,plans,agents,permissions,usage,integrations,support,audit,settings};
