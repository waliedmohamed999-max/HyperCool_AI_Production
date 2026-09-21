// Partnerships administration (single dashboard page, tabs). Every number and action goes through
// /api/partners/admin/*, which re-checks the caller's partner-manager permissions on the server.
// The tab list only mirrors those permissions for display. Money/percent are typed in human
// units and converted by the server - no money math happens in the browser.
import {escape,badge,empty,metric,tabs,drawer,promptDrawer,confirmAction,icon,toast,skeleton,table,button} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';
import {fmtDateTime} from '../format.js';

const ENTITLEMENTS=['partner.dashboard','partner.referrals','partner.customers','partner.commissions','partner.payouts','partner.marketing_assets','partner.analytics','partner.export_data','partner.custom_branding','partner.team_members'];
const STAFF_PERMS=['applications','partners','commissions','payouts','plans','assets'];
const TAB_DEFS=[['overview',null],['applications','applications'],['partners','partners'],['plans','plans'],['commissions','commissions'],['payouts','payouts'],['assets','assets'],['settings','settings']];

let api,currentAuth,generation=0,activeTab='overview';
const root=()=>document.querySelector('[data-page="partnerships"] #partnerships');
const tr=(key,vars)=>t('partnerships.'+key,vars);
const money=(minor,cur='SAR')=>{try{return new Intl.NumberFormat(getLocale()==='en'?'en-US':'ar-SA-u-nu-latn',{style:'currency',currency:cur}).format((minor||0)/100);}catch{return ((minor||0)/100).toFixed(2)+' '+cur;}};
const pct=bps=>bps===null||bps===undefined?'—':(bps/100).toFixed(bps%100===0?0:2)+'%';
const num=n=>Number(n||0).toLocaleString('en-US');
const errToast=error=>toast(error.message||String(error),'error');
const qs=params=>{const q=new URLSearchParams();for(const [k,v] of Object.entries(params||{}))if(v!==undefined&&v!==null&&v!=='')q.set(k,v);const s=q.toString();return s?'?'+s:'';};
const statusPill=(ns,status)=>badge(t('partnerships.'+ns+'.'+status)===('partnerships.'+ns+'.'+status)?status:tr(ns+'.'+status),status);
const has=permission=>currentAuth?.partner?.permissions?.includes(permission);
const node=html=>{const el=document.createElement('div');el.innerHTML=html;return el;};

export function installPartnershipsPage(){
 const host=root();
 if(host)host.innerHTML=`<div class="pt-shell"></div>`;
}

export async function renderPartnershipsPage({api:client,auth}){
 api=client;currentAuth=auth;
 const host=root();
 if(!host)return;
 const my=++generation;
 if(!auth.partner?.isManager){host.innerHTML=empty(tr('noAccess'),tr('noAccessHint'));return;}
 const shell=host.querySelector('.pt-shell')||host;
 shell.replaceChildren();
 const visible=TAB_DEFS.filter(([,perm])=>!perm||has(perm));
 if(!visible.some(([id])=>id===activeTab))activeTab='overview';
 const panels=visible.map(([id])=>{const el=document.createElement('div');el.dataset.tab=id;el.className='pt-panel';return el;});
 shell.append(...panels);
 const bar=tabs(shell,visible.map(([id],i)=>[tr('tab.'+id),panels[i]]));
 const buttons=[...shell.querySelectorAll('.ui-tabs [role=tab]')];
 const loaded=new Set();
 const load=async index=>{
  const id=visible[index][0];activeTab=id;
  if(loaded.has(id))return;
  loaded.add(id);
  panels[index].replaceChildren(node(skeleton(tr('loading'))));
  try{await LOADERS[id](panels[index],{reload:()=>{loaded.delete(id);return load(index);}});}
  catch(error){if(my!==generation)return;loaded.delete(id);panels[index].innerHTML=`<div class="empty"><strong>${escape(error.message)}</strong></div>`;const retry=button(tr('retry'),{variant:'secondary'});retry.onclick=()=>load(index);panels[index].firstChild.append(retry);}
 };
 buttons.forEach((b,i)=>b.addEventListener('click',()=>load(i)));
 const startIndex=Math.max(0,visible.findIndex(([id])=>id===activeTab));
 bar.select(startIndex);
 await load(startIndex);
}

// ---- generic list scaffolding ----------------------------------------------------------------------------------------------
function pagerNode(result,onPage){
 const wrap=document.createElement('div');wrap.className='pt-pager';
 if(!result||result.pages<=1)return wrap;
 const prev=button(t('common.previous'),{variant:'ghost'}),next=button(t('common.next'),{variant:'ghost'});
 prev.disabled=result.page<=1;next.disabled=result.page>=result.pages;
 prev.onclick=()=>onPage(result.page-1);next.onclick=()=>onPage(result.page+1);
 const label=document.createElement('span');label.textContent=tr('pageOf',{page:result.page,pages:result.pages,total:result.total});
 wrap.append(prev,label,next);return wrap;
}
function filterBar(fields,onChange){
 const bar=document.createElement('div');bar.className='pt-filters';
 const state={};
 for(const f of fields){
  const el=f.type==='search'?document.createElement('input'):document.createElement('select');
  if(f.type==='search'){el.type='search';el.placeholder=f.label;}
  else el.innerHTML=`<option value="">${escape(f.label)}</option>`+f.options.map(([v,l])=>`<option value="${escape(v)}">${escape(l)}</option>`).join('');
  el.setAttribute('aria-label',f.label);state[f.name]='';
  let timer;
  el.addEventListener(f.type==='search'?'input':'change',()=>{clearTimeout(timer);timer=setTimeout(()=>{state[f.name]=el.value;onChange({...state});},f.type==='search'?300:0);});
  bar.append(el);
 }
 return {bar,state};
}
async function pagedList(host,{path,filters=[],columns,row,emptyTitle,emptyHint,extraHead,extraQuery={}}){
 host.replaceChildren();
 const head=document.createElement('div');head.className='pt-head';
 const list=document.createElement('div');
 let state={},page=1;
 const draw=async()=>{
  list.replaceChildren(node(skeleton(tr('loading'))));
  try{
   const r=await api(path+qs({...state,...extraQuery,page}));
   list.replaceChildren();
   if(!r.items.length){list.append(node(empty(emptyTitle,emptyHint)));return;}
   const wrap=document.createElement('div');wrap.className='data-table';
   const scroll=document.createElement('div');scroll.className='table-scroll';scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label',tr('tableRegion'));
   scroll.innerHTML=table(columns,r.items.map(row));
   wrap.append(scroll);list.append(wrap,pagerNode(r,p=>{page=p;draw();}));
   list.querySelectorAll('[data-row]').forEach(el=>el.addEventListener('click',()=>rowHandlers.get(el.dataset.row.split(':')[0])?.(el)));
  }catch(error){list.replaceChildren(node(`<div class="empty"><strong>${escape(error.message)}</strong></div>`));}
 };
 const rowHandlers=new Map();
 if(filters.length){const {bar}=filterBar(filters,s=>{state=s;page=1;draw();});head.append(bar);}
 if(extraHead)head.append(...extraHead(draw));
 host.append(head,list);
 await draw();
 return {refresh:draw,rowHandlers};
}
const linkBtn=(label,attrs='')=>`<button type="button" class="secondary small" ${attrs}>${escape(label)}</button>`;

function form(html){return `<form class="pt-form" novalidate>${html}</form>`;}
const field=(label,control,hint)=>`<label>${escape(label)}${control}${hint?`<small>${escape(hint)}</small>`:''}</label>`;
const inp=(name,{type='text',value='',required=false,max,placeholder='',dir}={})=>`<input name="${name}" type="${type==='number'?'text':type}" ${type==='number'?'inputmode="numeric" pattern="[0-9]*"':''} value="${escape(value??'')}" ${required?'required':''} ${max?`maxlength="${max}"`:''} placeholder="${escape(placeholder)}" ${dir?`dir="${dir}"`:type==='number'||type==='email'||type==='url'?'dir="ltr"':''}>`;
const area=(name,{value='',required=false,max=1000,rows=3}={})=>`<textarea name="${name}" rows="${rows}" ${required?'required':''} maxlength="${max}">${escape(value??'')}</textarea>`;
const sel=(name,options,value)=>`<select name="${name}">${options.map(([v,l])=>`<option value="${escape(v)}" ${String(v)===String(value)?'selected':''}>${escape(l)}</option>`).join('')}</select>`;
const chk=(name,label,checked)=>`<label class="check"><input type="checkbox" name="${name}" ${checked?'checked':''}>${escape(label)}</label>`;
const readForm=formEl=>{const out={};for(const el of formEl.elements){if(!el.name)continue;out[el.name]=el.type==='checkbox'?el.checked:el.value;}return out;};

// ---- overview ----------------------------------------------------------------------------------------------------------------------
async function overview(host){
 const o=await api('/api/partners/admin/overview');
 const cur=o.settings.currency;
 const warn=[];
 if(!o.capabilities.billingWebhook)warn.push(tr('cap.webhook'));
 if(!o.capabilities.mail)warn.push(tr('cap.mail'));
 if(!o.capabilities.encryption)warn.push(tr('cap.encryption'));
 host.innerHTML=`
  ${warn.length?`<div class="notice"><strong>${escape(tr('cap.title'))}</strong><ul>${warn.map(w=>`<li>${escape(w)}</li>`).join('')}</ul></div>`:''}
  <div class="kpi-grid">
   ${metric(tr('ov.partners'),num(o.partners.total),tr('ov.partnersHint',{active:o.partners.active,suspended:o.partners.suspended}),'users')}
   ${metric(tr('ov.applications'),num(o.applications.pending+o.applications.underReview+o.applications.needsInformation),tr('ov.applicationsHint',{pending:o.applications.pending,info:o.applications.needsInformation}),'file')}
   ${metric(tr('ov.referrals'),num(o.referrals.total),tr('ov.referralsHint',{clicks:num(o.referrals.clicks),converted:o.referrals.converted}),'chart')}
   ${metric(tr('ov.commissionsReview'),num(o.commissions.needsReview),tr('ov.commissionsReviewHint'),'check')}
   ${metric(tr('ov.owed'),money(o.commissions.pendingMinor+o.commissions.availableMinor+o.commissions.reservedMinor,cur),tr('ov.owedHint',{pending:money(o.commissions.pendingMinor,cur),available:money(o.commissions.availableMinor,cur)}),'clock')}
   ${metric(tr('ov.payoutsOpen'),num(o.payouts.open),money(o.payouts.openMinor,cur),'plug')}
   ${metric(tr('ov.paid'),money(o.commissions.paidMinor,cur),'','check')}
  </div>
  <section class="panel"><h3>${escape(tr('ov.top'))}</h3>${o.topPartners.length?table([tr('col.partner'),tr('col.converted'),tr('col.earned')],o.topPartners.map(p=>[escape(p.name),num(p.converted),money(p.earnedMinor,cur)])):empty(tr('ov.topEmpty'),tr('ov.topEmptyHint'))}</section>`;
}

// ---- applications -------------------------------------------------------------------------------------------------------------------
const APP_STATUSES=['pending','under_review','needs_information','approved','rejected'];
async function applications(host){
  const plans=(await api('/api/partners/admin/plans').catch(()=>({items:[]}))).items;
  const ctl=await pagedList(host,{
   path:'/api/partners/admin/applications',
   filters:[{type:'search',name:'q',label:tr('search')},{type:'select',name:'status',label:tr('col.status'),options:APP_STATUSES.map(s=>[s,tr('astatus.'+s)])}],
   columns:[tr('col.applicant'),tr('col.type'),tr('col.country'),tr('col.expected'),tr('col.status'),tr('col.date'),''],
   row:a=>[`<strong>${escape(a.fullName)}</strong><small dir="ltr">${escape(a.email)}${a.emailVerified?'':' · '+escape(tr('unverified'))}</small>`,escape(tr('ptype.'+a.partnerType)),escape(a.country),num(a.expectedCustomers),statusPill('astatus',a.status),fmtDateTime(a.createdAt),linkBtn(tr('review'),`data-row="app:${escape(a.id)}"`)],
   emptyTitle:tr('apps.empty'),emptyHint:tr('apps.emptyHint')
  });
  ctl.rowHandlers.set('app',el=>reviewApplication(el.dataset.row.slice(4),plans,ctl.refresh));
}
async function reviewApplication(id,plans,refresh){
 const a=await api('/api/partners/admin/applications/'+id).catch(errToast);
 if(!a)return;
 const closed=['approved','rejected'].includes(a.status);
 const details=[[tr('col.applicant'),a.fullName],[tr('col.email'),a.email],[tr('col.phone'),a.phone],[tr('col.country'),a.country],[tr('app.company'),a.companyName||'—'],[tr('app.website'),a.website||'—'],[tr('col.type'),tr('ptype.'+a.partnerType)],[tr('col.expected'),num(a.expectedCustomers)],[tr('app.method'),a.marketingMethod],[tr('app.terms'),a.termsVersion+' · '+fmtDateTime(a.termsAcceptedAt)]];
 const result=await promptDrawer(tr('apps.review'),body=>{
  body.innerHTML=`<dl class="pt-dl">${details.map(([k,v])=>`<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join('')}</dl>
   <p>${statusPill('astatus',a.status)}</p>
   ${a.infoRequest?`<blockquote>${escape(a.infoRequest)}</blockquote>`:''}${a.applicantResponse?`<blockquote>${escape(a.applicantResponse)}</blockquote>`:''}
   ${closed?`<p class="muted">${escape(a.decisionReason||'')}</p>`:form(`
    ${field(tr('apps.decision'),sel('decision',[['approve',tr('apps.approve')],['under_review',tr('apps.underReview')],['needs_information',tr('apps.needInfo')],['reject',tr('apps.reject')]],'approve'))}
    <div data-when="approve">${field(tr('apps.plan'),sel('planId',plans.filter(p=>p.status==='active').map(p=>[p.id,`${getLocale()==='en'?p.nameEn:p.nameAr} — ${pct(p.defaultCommissionBps)}`]),a.requestedPlanId||plans.find(p=>p.status==='active')?.id))}
     ${field(tr('apps.customRate'),inp('customCommissionPercent',{placeholder:tr('apps.customRateHint'),dir:'ltr'}),tr('apps.customRateHelp'))}</div>
    <div data-when="reject" hidden>${field(tr('apps.reason'),area('reason',{max:1500}))}</div>
    <div data-when="needs_information" hidden>${field(tr('apps.message'),area('message',{max:1500}))}</div>`)}`;
  const f=body.querySelector('form');
  if(f){const sync=()=>body.querySelectorAll('[data-when]').forEach(el=>{el.hidden=el.dataset.when!==f.elements.decision.value;});f.elements.decision.addEventListener('change',sync);sync();}
  return {validate:()=>{if(closed)return false;const v=readForm(f);if(v.decision==='reject'&&!v.reason.trim()){f.elements.reason.setCustomValidity(tr('required'));f.elements.reason.reportValidity();f.elements.reason.oninput=()=>f.elements.reason.setCustomValidity('');return false;}if(v.decision==='needs_information'&&!v.message.trim()){f.elements.message.setCustomValidity(tr('required'));f.elements.message.reportValidity();f.elements.message.oninput=()=>f.elements.message.setCustomValidity('');return false;}return true;},value:()=>readForm(f)};
 },{confirmLabel:closed?tr('close'):tr('apps.submitDecision')});
 if(!result)return;
 const body={decision:result.decision};
 if(result.decision==='approve'){body.planId=result.planId;if(result.customCommissionPercent!=='')body.customCommissionPercent=result.customCommissionPercent;}
 if(result.decision==='reject')body.reason=result.reason;
 if(result.decision==='needs_information')body.message=result.message;
 try{await api(`/api/partners/admin/applications/${id}/decision`,body);toast(tr('saved'),'success');refresh();}catch(error){errToast(error);}
}

// ---- partners ------------------------------------------------------------------------------------------------------------------------
async function partners(host){
 const plans=(await api('/api/partners/admin/plans').catch(()=>({items:[]}))).items;
 const ctl=await pagedList(host,{
  path:'/api/partners/admin/partners',
  filters:[{type:'search',name:'q',label:tr('search')},{type:'select',name:'status',label:tr('col.status'),options:['active','limited','suspended','closed'].map(s=>[s,tr('pstatus.'+s)])},{type:'select',name:'plan',label:tr('col.plan'),options:plans.map(p=>[p.id,getLocale()==='en'?p.nameEn:p.nameAr])}],
  columns:[tr('col.partner'),tr('col.plan'),tr('col.status'),tr('col.code'),tr('col.referrals'),tr('col.earned'),tr('col.available'),''],
  row:p=>[`<strong>${escape(p.displayName)}</strong><small dir="ltr">${escape(p.email)}</small>`,escape(p.plan?(getLocale()==='en'?p.plan.nameEn:p.plan.nameAr):'—')+`<small>${escape(pct(p.effectiveCommissionBps))}</small>`,statusPill('pstatus',p.status),`<code dir="ltr">${escape(p.referralCode)}</code>`,`${num(p.stats.referrals)} / ${num(p.stats.converted)}`,money(p.stats.pendingMinor+p.stats.availableMinor+p.stats.reservedMinor+p.stats.paidMinor),money(Math.max(0,p.stats.availableMinor)),linkBtn(tr('open'),`data-row="p:${escape(p.id)}"`)],
  emptyTitle:tr('partners.empty'),emptyHint:tr('partners.emptyHint')
 });
 ctl.rowHandlers.set('p',el=>openPartner(el.dataset.row.slice(2),plans,ctl.refresh));
}
async function openPartner(id,plans,refresh){
 const holder=document.createElement('div');
 const dialog=drawer(tr('partners.detail'),holder);
 dialog.addEventListener('close',()=>{dialog.remove();refresh();});
 async function paint(){
  holder.replaceChildren(node(skeleton(tr('loading'))));
  let d;try{d=await api('/api/partners/admin/partners/'+id);}catch(error){holder.replaceChildren(node(`<div class="empty"><strong>${escape(error.message)}</strong></div>`));return;}
  const cur='SAR';
  holder.innerHTML=`
   <div class="row-between"><div><h3>${escape(d.displayName)}</h3><p dir="ltr" class="muted">${escape(d.user.email||'')} · ${escape(d.user.username)}</p></div>${statusPill('pstatus',d.status)}</div>
   ${d.suspendedReason?`<p class="notice">${escape(d.suspendedReason)}</p>`:''}
   <dl class="pt-dl">
    <div><dt>${escape(tr('col.code'))}</dt><dd dir="ltr">${escape(d.referralCode)}</dd></div>
    <div><dt>${escape(tr('col.plan'))}</dt><dd>${escape(d.plan?(getLocale()==='en'?d.plan.nameEn:d.plan.nameAr):'—')}</dd></div>
    <div><dt>${escape(tr('partners.rate'))}</dt><dd>${escape(pct(d.effectiveCommissionBps))}${d.customCommissionBps!==null?' ('+escape(tr('partners.custom'))+')':''}</dd></div>
    <div><dt>${escape(tr('partners.periodEnd'))}</dt><dd>${d.subscription?.endsAt?fmtDateTime(d.subscription.endsAt):'—'}${d.planExpired?' · '+escape(tr('partners.expired')):''}</dd></div>
    <div><dt>${escape(tr('col.referrals'))}</dt><dd>${num(d.stats.referrals)} / ${num(d.stats.converted)}</dd></div>
    <div><dt>${escape(tr('col.clicks'))}</dt><dd>${num(d.stats.clicks)}</dd></div>
    <div><dt>${escape(tr('partners.pending'))}</dt><dd>${money(d.stats.pendingMinor,cur)}</dd></div>
    <div><dt>${escape(tr('col.available'))}</dt><dd>${money(Math.max(0,d.stats.availableMinor),cur)}</dd></div>
    <div><dt>${escape(tr('partners.reserved'))}</dt><dd>${money(d.stats.reservedMinor,cur)}</dd></div>
    <div><dt>${escape(tr('partners.paid'))}</dt><dd>${money(d.stats.paidMinor,cur)}</dd></div>
   </dl>
   <div class="row pt-actions" id="pt-actions"></div>
   <h4>${escape(tr('partners.history'))}</h4>
   ${d.subscriptions.length?table([tr('col.plan'),tr('col.status'),tr('partners.from'),tr('partners.to'),tr('partners.source')],d.subscriptions.map(s=>[escape(getLocale()==='en'?s.planNameEn:s.planNameAr),escape(s.status),fmtDateTime(s.startedAt),s.endsAt?fmtDateTime(s.endsAt):'—',escape(s.source)])):''}
   <h4>${escape(tr('partners.notes'))}</h4>
   <div id="pt-notes">${d.notes.length?d.notes.map(n=>`<div class="audit-row">${escape(n.note)}<time>${escape(n.authorName||'')} · ${fmtDateTime(n.createdAt)}</time></div>`).join(''):`<p class="muted">${escape(tr('partners.noNotes'))}</p>`}</div>`;
  const actions=holder.querySelector('#pt-actions');
  const add=(label,fn,{variant='secondary'}={})=>{const b=button(label,{variant});b.onclick=async()=>{b.disabled=true;try{await fn();}catch(error){errToast(error);}finally{b.disabled=false;}};actions.append(b);};
  if(has('partners')){
   if(d.storedStatus==='suspended')add(tr('partners.reactivate'),async()=>{if(await confirmAction(tr('partners.reactivate'),d.displayName)){await api(`/api/partners/admin/partners/${id}`,{status:'active'},'PATCH');toast(tr('saved'),'success');await paint();}});
   else add(tr('partners.suspend'),async()=>{const reason=await promptText(tr('partners.suspend'),tr('apps.reason'));if(reason){await api(`/api/partners/admin/partners/${id}`,{status:'suspended',reason},'PATCH');toast(tr('saved'),'success');await paint();}},{variant:'danger'});
   add(tr('partners.setRate'),async()=>{const v=await promptText(tr('partners.setRate'),tr('apps.customRate'),{hint:tr('apps.customRateHelp'),optional:true,dir:'ltr'});if(v!==null){await api(`/api/partners/admin/partners/${id}`,{customCommissionPercent:v},'PATCH');toast(tr('saved'),'success');await paint();}});
   add(tr('partners.regenerate'),async()=>{if(await confirmAction(tr('partners.regenerate'),tr('partners.regenerateWarn'))){await api(`/api/partners/admin/partners/${id}/regenerate-code`,{});toast(tr('saved'),'success');await paint();}});
   add(tr('partners.addNote'),async()=>{const note=await promptText(tr('partners.addNote'),tr('partners.notes'),{textarea:true});if(note){await api(`/api/partners/admin/partners/${id}/notes`,{note});await paint();}});
  }
  if(has('plans'))add(tr('partners.changePlan'),async()=>{
   const r=await promptDrawer(tr('partners.changePlan'),body=>{body.innerHTML=form(`${field(tr('col.plan'),sel('planId',plans.filter(p=>p.status==='active').map(p=>[p.id,getLocale()==='en'?p.nameEn:p.nameAr]),d.planId))}${field(tr('partners.periodEnd'),inp('endsAt',{type:'date'}),tr('partners.endsAtHint'))}${chk('trial',tr('partners.trial'),false)}`);const f=body.querySelector('form');return {value:()=>readForm(f)};},{confirmLabel:tr('save')});
   if(!r)return;
   await api(`/api/partners/admin/partners/${id}/plan`,{planId:r.planId,...(r.endsAt?{endsAt:new Date(r.endsAt+'T23:59:59Z').toISOString()}:{}),trial:r.trial});
   toast(tr('saved'),'success');await paint();
  });
 }
 await paint();
}
/** Small reusable prompt: one text/textarea field. Returns the trimmed value, '' for optional-empty, null if cancelled. */
async function promptText(title,label,{textarea:multi=false,optional=false,hint='',dir}={}){
 const result=await promptDrawer(title,body=>{
  body.innerHTML=form(field(label,multi?area('value',{max:2000,rows:4,required:!optional}):inp('value',{required:!optional,max:200,dir}),hint));
  const f=body.querySelector('form');const input=f.elements.value;
  return {focus:()=>input.focus(),validate:()=>{if(!optional&&!input.value.trim()){input.setCustomValidity(tr('required'));input.reportValidity();input.oninput=()=>input.setCustomValidity('');return false;}return true;},value:()=>input.value.trim()};
 },{confirmLabel:tr('save')});
 return result;
}

// ---- plans -----------------------------------------------------------------------------------------------------------------------------
async function plans(host,{reload}){
 const r=await api('/api/partners/admin/plans');
 const cur='SAR';
 const canEdit=has('plans');
 host.innerHTML=`<div class="row-between pt-head"><p class="muted">${escape(tr('plans.hint'))}</p></div><div id="pt-plans"></div>`;
 if(canEdit){const add=button(tr('plans.new'),{variant:'primary',iconName:'plus'});add.onclick=()=>editPlan(null,r.entitlementCatalog||ENTITLEMENTS,reload);host.querySelector('.pt-head').append(add);}
 host.querySelector('#pt-plans').innerHTML=r.items.length?table([tr('col.plan'),tr('plans.price'),tr('partners.rate'),tr('plans.hold'),tr('plans.entitlements'),tr('plans.subscribers'),tr('col.status'),''],r.items.map(p=>[`<strong>${escape(getLocale()==='en'?p.nameEn:p.nameAr)}</strong><small dir="ltr">${escape(p.slug)}</small>`,p.priceMinor?`${money(p.priceMinor,p.currency)} / ${escape(tr('period.'+p.billingPeriod))}`:escape(tr('plans.free')),pct(p.defaultCommissionBps),p.commissionHoldDays===null?'—':num(p.commissionHoldDays)+' '+escape(tr('days')),`${p.entitlements.length}/${ENTITLEMENTS.length}`,num(r.subscribers[p.id]||0),statusPill('planstatus',p.status),canEdit?linkBtn(tr('edit'),`data-plan="${escape(p.id)}"`):''])):empty(tr('plans.empty'));
 host.querySelectorAll('[data-plan]').forEach(b=>b.addEventListener('click',()=>editPlan(r.items.find(p=>p.id===b.dataset.plan),r.entitlementCatalog||ENTITLEMENTS,reload)));
}
async function editPlan(plan,catalog,reload){
 const p=plan||{};
 const result=await promptDrawer(plan?tr('plans.edit'):tr('plans.new'),body=>{
  body.innerHTML=form(`
   ${plan?'':field(tr('plans.slug'),inp('slug',{required:true,max:40,dir:'ltr'}),tr('plans.slugHint'))}
   <div class="row">${field(tr('plans.nameAr'),inp('nameAr',{required:true,value:p.nameAr,max:120}))}${field(tr('plans.nameEn'),inp('nameEn',{required:true,value:p.nameEn,max:120,dir:'ltr'}))}</div>
   ${field(tr('plans.descAr'),area('descriptionAr',{value:p.descriptionAr,max:2000}))}${field(tr('plans.descEn'),area('descriptionEn',{value:p.descriptionEn,max:2000}))}
   <div class="row">${field(tr('plans.price'),inp('price',{value:p.priceMinor!==undefined?(p.priceMinor/100).toFixed(2):'0.00',dir:'ltr'}))}${field(tr('plans.period'),sel('billingPeriod',['free','monthly','yearly','one_time'].map(v=>[v,tr('period.'+v)]),p.billingPeriod||'free'))}</div>
   <div class="row">${field(tr('plans.commission'),inp('commissionPercent',{value:p.defaultCommissionBps!==undefined?String(p.defaultCommissionBps/100):'20',dir:'ltr'}),tr('plans.percentHint'))}${field(tr('plans.trialDays'),inp('trialDays',{type:'number',value:p.trialDays??0}))}</div>
   <div class="row">${field(tr('plans.hold'),inp('commissionHoldDays',{type:'number',value:p.commissionHoldDays??''}),tr('plans.holdHint'))}${field(tr('plans.duration'),inp('commissionDurationDays',{type:'number',value:p.commissionDurationDays??''}),tr('plans.durationHint'))}</div>
   <div class="row">${field(tr('plans.minPayout'),inp('minPayout',{value:p.minPayoutMinor!==null&&p.minPayoutMinor!==undefined?(p.minPayoutMinor/100).toFixed(2):'',dir:'ltr'}),tr('plans.minPayoutHint'))}${field(tr('plans.maxReferrals'),inp('maxReferrals',{type:'number',value:p.maxReferrals??''}))}</div>
   <div class="row">${field(tr('plans.maxTeam'),inp('maxTeamMembers',{type:'number',value:p.maxTeamMembers??''}))}${field(tr('plans.sort'),inp('sortOrder',{type:'number',value:p.sortOrder??0}))}</div>
   <div class="row">${field(tr('col.status'),sel('status',['active','inactive','archived'].map(v=>[v,tr('planstatus.'+v)]),p.status||'active'))}${chk('highlighted',tr('plans.highlighted'),p.highlighted)}</div>
   <fieldset><legend>${escape(tr('plans.entitlements'))}</legend>${catalog.map(k=>chk('ent:'+k,tr('ent.'+k),(p.entitlements||[]).includes(k))).join('')}</fieldset>`);
  const f=body.querySelector('form');
  return {validate:()=>f.reportValidity(),value:()=>readForm(f)};
 },{confirmLabel:tr('save')});
 if(!result)return;
 const num0=v=>v===''?null:Number(v);
 const payload={nameAr:result.nameAr,nameEn:result.nameEn,descriptionAr:result.descriptionAr,descriptionEn:result.descriptionEn,price:result.price,billingPeriod:result.billingPeriod,commissionPercent:result.commissionPercent,trialDays:num0(result.trialDays)??0,commissionHoldDays:num0(result.commissionHoldDays),commissionDurationDays:num0(result.commissionDurationDays),minPayout:result.minPayout,maxReferrals:num0(result.maxReferrals),maxTeamMembers:num0(result.maxTeamMembers),sortOrder:num0(result.sortOrder)??0,status:result.status,highlighted:result.highlighted,entitlements:Object.keys(result).filter(k=>k.startsWith('ent:')&&result[k]).map(k=>k.slice(4))};
 if(!plan)payload.slug=result.slug;
 try{await api(plan?'/api/partners/admin/plans/'+plan.id:'/api/partners/admin/plans',payload,plan?'PATCH':'POST');toast(tr('saved'),'success');await reload();}catch(error){errToast(error);}
}

// ---- commissions + billing events ---------------------------------------------------------------------------------------------------------
async function commissions(host){
 host.innerHTML=`<div class="pt-subtabs"><button type="button" class="secondary small" data-sub="list" aria-pressed="true">${escape(tr('com.list'))}</button><button type="button" class="secondary small" data-sub="events" aria-pressed="false">${escape(tr('com.events'))}</button></div><div id="pt-sub"></div>`;
 let sub=host.querySelector('#pt-sub');
 const show=async name=>{host.querySelectorAll('[data-sub]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.sub===name)));const fresh=document.createElement('div');fresh.id='pt-sub';sub.replaceWith(fresh);sub=fresh;await (name==='list'?commissionList:billingEvents)(fresh);};
 host.querySelectorAll('[data-sub]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.sub)));
 await show('list');
}
async function commissionList(host){
 const ctl=await pagedList(host,{
  path:'/api/partners/admin/commissions',
  filters:[{type:'select',name:'status',label:tr('col.status'),options:['pending','on_hold','approved','available','paid','rejected','cancelled'].map(s=>[s,tr('cstatus.'+s)])}],
  columns:[tr('col.date'),tr('col.partner'),tr('col.customer'),tr('com.gross'),tr('com.rate'),tr('com.commission'),tr('col.status'),''],
  row:c=>[fmtDateTime(c.createdAt),escape(c.partnerName),`${escape(c.customerName||'')}<small dir="ltr">${escape(c.customerEmail||'')}</small>`,money(c.grossMinor,c.currency),pct(c.rateBps),money(c.netMinor,c.currency),statusPill('cstatus',c.status)+(c.holdUntil&&['pending','approved'].includes(c.status)?`<small>${escape(tr('com.holdUntil'))} ${fmtDateTime(c.holdUntil)}</small>`:''),actionButtons(c)],
  emptyTitle:tr('com.empty'),emptyHint:tr('com.emptyHint')
 });
 function actionButtons(c){
  const btns=[];
  if(c.status==='pending')btns.push(linkBtn(tr('com.approve'),`data-c="approve:${c.id}"`));
  if(['pending','approved','on_hold'].includes(c.status))btns.push(linkBtn(tr('com.reject'),`data-c="reject:${c.id}"`));
  if(['pending','approved'].includes(c.status))btns.push(linkBtn(tr('com.hold'),`data-c="hold:${c.id}"`));
  if(c.status==='on_hold')btns.push(linkBtn(tr('com.release'),`data-c="release_hold:${c.id}"`));
  return `<div class="row">${btns.join('')}</div>`;
 }
 host.addEventListener('click',async event=>{
  const b=event.target.closest('[data-c]');if(!b)return;
  const [action,id]=b.dataset.c.split(':');
  try{
   let reason;
   if(action==='reject'){reason=await promptText(tr('com.reject'),tr('apps.reason'),{textarea:true});if(!reason)return;}
   else if(!await confirmAction(tr('com.'+(action==='release_hold'?'release':action)),tr('com.confirm')))return;
   await api(`/api/partners/admin/commissions/${id}/decision`,{action,reason});toast(tr('saved'),'success');ctl.refresh();
  }catch(error){errToast(error);}
 });
}
async function billingEvents(host){
 const ctl=await pagedList(host,{
  path:'/api/partners/admin/billing-events',
  columns:[tr('col.date'),tr('ev.type'),tr('col.customer'),tr('com.gross'),tr('ev.source'),tr('ev.result')],
  row:e=>[fmtDateTime(e.occurredAt),escape(tr('evtype.'+e.type)),`<span dir="ltr">${escape(e.customerEmail||'—')}</span>`,money(e.amountMinor,e.currency),escape(e.source),escape(t('partnerships.evresult.'+e.result)===('partnerships.evresult.'+e.result)?e.result:tr('evresult.'+e.result))],
  emptyTitle:tr('ev.empty'),emptyHint:tr('ev.emptyHint'),
  extraHead:refresh=>{if(!has('commissions'))return [];const b=button(tr('ev.record'),{variant:'primary',iconName:'plus'});b.onclick=async()=>{
   const r=await promptDrawer(tr('ev.record'),body=>{body.innerHTML=form(`<p class="muted">${escape(tr('ev.recordHint'))}</p>${field(tr('ev.type'),sel('type',['payment_succeeded','refund','payment_failed'].map(v=>[v,tr('evtype.'+v)]),'payment_succeeded'))}${field(tr('col.customer')+' ('+tr('col.email')+')',inp('customerEmail',{type:'email',required:true}))}${field(tr('ev.amount'),inp('amount',{required:true,dir:'ltr',placeholder:'120.00'}))}${field(tr('ev.externalId'),inp('externalId',{max:120,dir:'ltr'}),tr('ev.externalIdHint'))}${field(tr('ev.refersTo'),inp('refersToExternalId',{max:120,dir:'ltr'}),tr('ev.refersToHint'))}${field(tr('ev.plan'),inp('planRef',{max:80}))}`);const f=body.querySelector('form');return {validate:()=>f.reportValidity(),value:()=>readForm(f)};},{confirmLabel:tr('save')});
   if(!r)return;
   const payload={};for(const [k,v] of Object.entries(r))if(v!=='')payload[k]=v;
   try{const res=await api('/api/partners/admin/billing-events',payload);toast(res.duplicate?tr('ev.duplicate'):tr('evresult.'+res.result)===('partnerships.evresult.'+res.result)?res.result:tr('evresult.'+res.result),res.result==='commission_created'||res.result==='reversal_applied'?'success':'info');refresh();}catch(error){errToast(error);}
  };return [b];}
 });
 return ctl;
}

// ---- payouts -----------------------------------------------------------------------------------------------------------------------------
async function payouts(host){
 const ctl=await pagedList(host,{
  path:'/api/partners/admin/payouts',
  filters:[{type:'select',name:'status',label:tr('col.status'),options:['requested','under_review','approved','processing','paid','rejected','cancelled'].map(s=>[s,tr('paystatus.'+s)])}],
  columns:[tr('col.date'),tr('col.partner'),tr('com.amount'),tr('pay.method'),tr('col.status'),''],
  row:p=>[fmtDateTime(p.requestedAt),escape(p.partnerName),`<strong>${money(p.amountMinor,p.currency)}</strong>`,`${escape(t('partnerships.method.'+p.methodType))}<small dir="ltr">${escape(p.methodMasked)}</small>`,statusPill('paystatus',p.status),linkBtn(tr('open'),`data-row="pay:${escape(p.id)}"`)],
  emptyTitle:tr('pay.empty'),emptyHint:tr('pay.emptyHint')
 });
 ctl.rowHandlers.set('pay',el=>openPayout(el.dataset.row.slice(4),ctl.refresh));
}
async function openPayout(id,refresh){
 const holder=document.createElement('div');
 const dialog=drawer(tr('pay.detail'),holder);
 dialog.addEventListener('close',()=>{dialog.remove();refresh();});
 async function paint(){
  holder.replaceChildren(node(skeleton(tr('loading'))));
  let p;try{p=await api('/api/partners/admin/payouts/'+id);}catch(error){holder.innerHTML=`<div class="empty"><strong>${escape(error.message)}</strong></div>`;return;}
  holder.innerHTML=`
   <div class="row-between"><div><h3>${money(p.amountMinor,p.currency)}</h3><p class="muted">${escape(p.partnerName)}</p></div>${statusPill('paystatus',p.status)}</div>
   <dl class="pt-dl"><div><dt>${escape(tr('pay.method'))}</dt><dd>${escape(t('partnerships.method.'+p.methodType))} · <span dir="ltr">${escape(p.methodMasked)}</span></dd></div>
    <div><dt>${escape(tr('col.date'))}</dt><dd>${fmtDateTime(p.requestedAt)}</dd></div>
    ${p.paymentReference?`<div><dt>${escape(tr('pay.reference'))}</dt><dd dir="ltr">${escape(p.paymentReference)}</dd></div>`:''}
    ${p.rejectReason?`<div><dt>${escape(tr('apps.reason'))}</dt><dd>${escape(p.rejectReason)}</dd></div>`:''}
    <div><dt>${escape(tr('pay.commissions'))}</dt><dd>${p.commissions.length}</dd></div></dl>
   <div id="pt-reveal"></div><div class="row pt-actions" id="pt-pactions"></div><div id="pt-receipt"></div>`;
  const actions=holder.querySelector('#pt-pactions');
  const add=(label,fn,variant='secondary')=>{const b=button(label,{variant});b.onclick=async()=>{b.disabled=true;try{await fn();}catch(error){errToast(error);}finally{b.disabled=false;}};actions.append(b);};
  const decide=async(action,extra)=>{await api(`/api/partners/admin/payouts/${id}/decision`,{action,...extra});toast(tr('saved'),'success');await paint();};
  if(['requested','under_review','approved','processing'].includes(p.status)){
   add(tr('pay.reveal'),async()=>{const r=await api(`/api/partners/admin/payouts/${id}/details`);holder.querySelector('#pt-reveal').innerHTML=`<div class="notice"><strong>${escape(tr('pay.revealNote'))}</strong><dl class="pt-dl">${Object.entries(r.details).filter(([,v])=>v).map(([k,v])=>`<div><dt>${escape(k)}</dt><dd dir="ltr">${escape(v)}</dd></div>`).join('')}</dl></div>`;});
   if(p.status==='requested')add(tr('pay.startReview'),()=>decide('under_review'));
   if(['requested','under_review'].includes(p.status))add(tr('pay.approve'),async()=>{if(await confirmAction(tr('pay.approve'),tr('com.confirm')))await decide('approve');},'primary');
   if(p.status==='approved')add(tr('pay.processing'),()=>decide('processing'));
   if(['approved','processing'].includes(p.status))add(tr('pay.markPaid'),async()=>{const ref=await promptText(tr('pay.markPaid'),tr('pay.reference'),{dir:'ltr'});if(ref)await decide('pay',{paymentReference:ref});},'primary');
   add(tr('com.reject'),async()=>{const reason=await promptText(tr('com.reject'),tr('apps.reason'),{textarea:true});if(reason)await decide('reject',{reason});},'danger');
  }
  const rc=holder.querySelector('#pt-receipt');
  rc.innerHTML=`<h4>${escape(tr('pay.receipt'))}</h4>${p.hasReceipt?`<p><a class="button secondary" href="/api/partners/admin/payouts/${escape(id)}/receipt" download>${escape(tr('pay.downloadReceipt'))}</a></p>`:`<p class="muted">${escape(tr('pay.noReceipt'))}</p>`}<label>${escape(tr('pay.uploadReceipt'))}<input type="file" accept="application/pdf,image/png,image/jpeg"></label>`;
  rc.querySelector('input[type=file]').addEventListener('change',async event=>{const file=event.target.files[0];if(!file)return;try{await uploadFile(`/api/partners/admin/payouts/${id}/receipt`,file);toast(tr('saved'),'success');await paint();}catch(error){errToast(error);}});
 }
 await paint();
}
async function uploadFile(path,file){
 const response=await fetch(path,{method:'PUT',headers:{'Content-Type':file.type,'X-CSRF-Token':currentAuth.csrf||'','X-File-Name':encodeURIComponent(file.name)},body:file});
 const value=await response.json().catch(()=>({}));
 if(!response.ok)throw new Error(value.error||'Upload failed');
 return value;
}

// ---- marketing assets -------------------------------------------------------------------------------------------------------------------------
async function assets(host,{reload}){
 const [r,plansRes]=await Promise.all([api('/api/partners/admin/assets'),api('/api/partners/admin/plans').catch(()=>({items:[]}))]);
 host.innerHTML=`<div class="row-between pt-head"><p class="muted">${escape(tr('assets.hint'))}</p></div><div id="pt-assets"></div>`;
 const add=button(tr('assets.new'),{variant:'primary',iconName:'plus'});add.onclick=()=>editAsset(null,plansRes.items,reload);host.querySelector('.pt-head').append(add);
 host.querySelector('#pt-assets').innerHTML=r.items.length?table([tr('assets.title'),tr('assets.category'),tr('assets.kind'),tr('assets.plans'),tr('col.status'),''],r.items.map(a=>[`<strong>${escape(getLocale()==='en'?a.titleEn:a.titleAr)}</strong>`,escape(tr('assetcat.'+a.category)),escape(tr('assetkind.'+a.kind))+(a.kind==='file'?`<small>${a.hasFile?escape(a.fileName||''):escape(tr('assets.noFile'))}</small>`:''),a.planIds.length?a.planIds.length:escape(tr('assets.allPlans')),statusPill('assetstatus',a.status),linkBtn(tr('edit'),`data-asset="${escape(a.id)}"`)])):empty(tr('assets.empty'),tr('assets.emptyHint'));
 host.querySelectorAll('[data-asset]').forEach(b=>b.addEventListener('click',()=>editAsset(r.items.find(a=>a.id===b.dataset.asset),plansRes.items,reload)));
}
async function editAsset(asset,plansList,reload){
 const a=asset||{};
 const cats=['logo','banner','copy','social','guide','presentation','other'];
 const result=await promptDrawer(asset?tr('assets.edit'):tr('assets.new'),body=>{
  body.innerHTML=form(`
   <div class="row">${field(tr('assets.category'),sel('category',cats.map(c=>[c,tr('assetcat.'+c)]),a.category||'copy'))}${field(tr('assets.kind'),asset?`<input value="${escape(tr('assetkind.'+a.kind))}" disabled><input type="hidden" name="kind" value="${escape(a.kind)}">`:sel('kind',['text','link','file'].map(k=>[k,tr('assetkind.'+k)]),'text'))}</div>
   <div class="row">${field(tr('plans.nameAr'),inp('titleAr',{required:true,value:a.titleAr,max:120}))}${field(tr('plans.nameEn'),inp('titleEn',{required:true,value:a.titleEn,max:120,dir:'ltr'}))}</div>
   ${field(tr('plans.descAr'),area('descriptionAr',{value:a.descriptionAr,max:1000,rows:2}))}${field(tr('plans.descEn'),area('descriptionEn',{value:a.descriptionEn,max:1000,rows:2}))}
   <div data-when="text">${field(tr('assets.textAr'),area('textAr',{value:a.textAr||'',max:4000}))}${field(tr('assets.textEn'),area('textEn',{value:a.textEn||'',max:4000}))}</div>
   <div data-when="link" hidden>${field(tr('assets.url'),inp('url',{type:'url',value:a.url||'',max:300}))}</div>
   <div data-when="file" hidden><label>${escape(tr('assets.file'))}<input type="file" name="file" accept="image/png,image/jpeg,image/webp,application/pdf"></label><small>${escape(tr('assets.fileHint'))}</small></div>
   ${field(tr('col.status'),sel('status',['active','archived'].map(s=>[s,tr('assetstatus.'+s)]),a.status||'active'))}
   <fieldset><legend>${escape(tr('assets.plans'))}</legend><small>${escape(tr('assets.plansHint'))}</small>${plansList.map(p=>chk('plan:'+p.id,getLocale()==='en'?p.nameEn:p.nameAr,(a.planIds||[]).includes(p.id))).join('')}</fieldset>`);
  const f=body.querySelector('form');
  const sync=()=>body.querySelectorAll('[data-when]').forEach(el=>{el.hidden=el.dataset.when!==f.elements.kind.value;});
  if(f.elements.kind.tagName==='SELECT')f.elements.kind.addEventListener('change',sync);sync();
  return {validate:()=>f.reportValidity(),value:()=>({...readForm(f),file:f.elements.file?.files?.[0]||null})};
 },{confirmLabel:tr('save')});
 if(!result)return;
 const payload={category:result.category,titleAr:result.titleAr,titleEn:result.titleEn,descriptionAr:result.descriptionAr,descriptionEn:result.descriptionEn,status:result.status,planIds:Object.keys(result).filter(k=>k.startsWith('plan:')&&result[k]).map(k=>k.slice(5))};
 if(result.kind==='text'){payload.textAr=result.textAr;payload.textEn=result.textEn;}
 if(result.kind==='link')payload.url=result.url;
 try{
  let saved;
  if(asset)saved=await api('/api/partners/admin/assets/'+asset.id,payload,'PATCH');
  else saved=await api('/api/partners/admin/assets',{...payload,kind:result.kind});
  if(result.kind==='file'&&result.file)await uploadFile(`/api/partners/admin/assets/${saved.id}/file`,result.file);
  toast(tr('saved'),'success');await reload();
 }catch(error){errToast(error);}
}

// ---- settings (program settings, staff, invites, audit) ---------------------------------------------------------------------------------------
async function settings(host,{reload}){
 const s=await api('/api/partners/admin/settings');
 const admin=currentAuth.isPlatformAdmin;
 const methods=['bank_transfer','paypal','other'];
 host.innerHTML=`
  <section class="panel"><h3>${escape(tr('set.program'))}</h3>${form(`
   <div class="row">${field(tr('set.attribution'),inp('attribution_window_days',{type:'number',value:s.attribution_window_days}),tr('set.attributionHint'))}${field(tr('set.conversion'),inp('conversion_window_days',{type:'number',value:s.conversion_window_days}),tr('set.conversionHint'))}</div>
   <div class="row">${field(tr('set.hold'),inp('commission_hold_days',{type:'number',value:s.commission_hold_days}),tr('set.holdHint'))}${field(tr('set.minPayout'),inp('min_payout',{value:(s.min_payout_minor/100).toFixed(2),dir:'ltr'}))}</div>
   <div class="row">${field(tr('set.currency'),inp('default_currency',{value:s.default_currency,max:3,dir:'ltr'}),tr('set.currencyHint'))}${field(tr('set.registration'),sel('registration_mode',[['open',tr('set.open')],['invite_only',tr('set.inviteOnly')]],s.registration_mode))}</div>
   <div class="row">${field(tr('set.approval'),sel('approval_mode',[['manual',tr('set.manual')],['auto',tr('set.auto')]],s.approval_mode),tr('set.approvalHint'))}${field(tr('set.commissionReview'),sel('commission_review',[['manual',tr('set.manual')],['auto',tr('set.auto')]],s.commission_review))}</div>
   <fieldset><legend>${escape(tr('set.methods'))}</legend>${methods.map(m=>chk('method:'+m,tr('method.'+m),s.payout_methods.includes(m))).join('')}</fieldset>
   <fieldset><legend>${escape(tr('set.fraud'))}</legend>${chk('block_self_referral',tr('set.blockSelf'),s.block_self_referral)}<div class="row">${field(tr('set.visitsHour'),inp('max_visits_per_ip_per_hour',{type:'number',value:s.max_visits_per_ip_per_hour}))}${field(tr('set.regsDay'),inp('max_registrations_per_ip_per_day',{type:'number',value:s.max_registrations_per_ip_per_day}))}</div></fieldset>
   ${chk('notify_partner_email',tr('set.notifyEmail'),s.notify_partner_email)}
   <fieldset><legend>${escape(tr('set.terms'))}</legend>${!s.terms_ar&&!s.terms_en?`<p class="notice">${escape(tr('set.termsEmpty'))}</p>`:''}${field(tr('set.termsVersion'),inp('terms_version',{value:s.terms_version,max:20,dir:'ltr'}),tr('set.termsVersionHint'))}${field(tr('set.termsAr'),area('terms_ar',{value:s.terms_ar,max:20000,rows:6}))}${field(tr('set.termsEn'),area('terms_en',{value:s.terms_en,max:20000,rows:6}))}</fieldset>`)}
   <div class="row"><button type="button" id="pt-save-settings">${escape(tr('save'))}</button></div></section>
  ${admin?`<section class="panel"><h3>${escape(tr('staff.title'))}</h3><p class="muted">${escape(tr('staff.hint'))}</p><div id="pt-staff"></div></section>`:''}
  <section class="panel"><h3>${escape(tr('invites.title'))}</h3><p class="muted">${escape(tr('invites.hint'))}</p><div id="pt-invites"></div></section>
  <section class="panel"><h3>${escape(tr('audit.title'))}</h3><div id="pt-audit"></div></section>`;
 host.querySelector('#pt-save-settings').addEventListener('click',async event=>{
  const f=host.querySelector('form');if(!f.reportValidity())return;
  const v=readForm(f);event.target.disabled=true;
  const payload={attribution_window_days:Number(v.attribution_window_days),conversion_window_days:Number(v.conversion_window_days),commission_hold_days:Number(v.commission_hold_days),min_payout:v.min_payout,default_currency:v.default_currency.toUpperCase(),registration_mode:v.registration_mode,approval_mode:v.approval_mode,commission_review:v.commission_review,payout_methods:methods.filter(m=>v['method:'+m]),block_self_referral:v.block_self_referral,max_visits_per_ip_per_hour:Number(v.max_visits_per_ip_per_hour),max_registrations_per_ip_per_day:Number(v.max_registrations_per_ip_per_day),notify_partner_email:v.notify_partner_email,terms_version:v.terms_version,terms_ar:v.terms_ar,terms_en:v.terms_en};
  try{await api('/api/partners/admin/settings',payload,'PUT');toast(tr('saved'),'success');await reload();}catch(error){errToast(error);}finally{event.target.disabled=false;}
 });
 if(admin)await drawStaff(host.querySelector('#pt-staff'));
 await drawInvites(host.querySelector('#pt-invites'));
 await drawAudit(host.querySelector('#pt-audit'));
}
async function drawStaff(el){
 const r=await api('/api/partners/admin/staff');
 el.innerHTML=(r.items.length?table([tr('staff.user'),tr('staff.permissions'),tr('col.status')],r.items.map(m=>[`<strong>${escape(m.name)}</strong><small dir="ltr">${escape(m.username)}</small>`,escape(m.permissions.map(p=>tr('perm.'+p)).join(' · ')||'—'),statusPill('staffstatus',m.status)])):`<p class="muted">${escape(tr('staff.none'))}</p>`)+`<div class="row"></div>`;
 const add=button(tr('staff.add'),{variant:'secondary',iconName:'plus'});
 add.onclick=async()=>{
  const v=await promptDrawer(tr('staff.add'),body=>{body.innerHTML=form(`${field(tr('staff.identity'),inp('identity',{required:true,max:254,dir:'ltr'}),tr('staff.identityHint'))}<fieldset><legend>${escape(tr('staff.permissions'))}</legend>${STAFF_PERMS.map(p=>chk('perm:'+p,tr('perm.'+p),false)).join('')}</fieldset>${field(tr('col.status'),sel('status',['active','disabled'].map(x=>[x,tr('staffstatus.'+x)]),'active'))}`);const f=body.querySelector('form');return {validate:()=>f.reportValidity(),value:()=>readForm(f)};},{confirmLabel:tr('save')});
  if(!v)return;
  try{await api('/api/partners/admin/staff',{identity:v.identity,permissions:STAFF_PERMS.filter(p=>v['perm:'+p]),status:v.status},'PUT');toast(tr('saved'),'success');await drawStaff(el);}catch(error){errToast(error);}
 };
 el.querySelector('.row').append(add);
}
async function drawInvites(el){
 const r=await api('/api/partners/admin/invites');
 el.innerHTML=(r.items.length?table([tr('invites.code'),tr('invites.email'),tr('invites.expires'),tr('col.status'),''],r.items.map(i=>[`<code dir="ltr">${escape(i.code)}</code>`,escape(i.email||'—'),fmtDateTime(i.expiresAt),escape(i.usedAt?tr('invites.used'):Date.parse(i.expiresAt)<Date.now()?tr('invites.expired'):tr('invites.open')),i.usedAt?'':linkBtn(tr('copy'),`data-copy="${escape(i.url)}"`)])):`<p class="muted">${escape(tr('invites.none'))}</p>`)+`<div class="row"></div>`;
 el.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(b.dataset.copy);toast(tr('copied'),'success');}catch{toast(b.dataset.copy);}}));
 const add=button(tr('invites.create'),{variant:'secondary',iconName:'plus'});
 add.onclick=async()=>{
  const v=await promptDrawer(tr('invites.create'),body=>{body.innerHTML=form(`${field(tr('invites.email'),inp('email',{type:'email'}),tr('invites.emailHint'))}${field(tr('invites.days'),inp('expiresInDays',{type:'number',value:30}))}${field(tr('invites.note'),inp('note',{max:300}))}`);const f=body.querySelector('form');return {validate:()=>f.reportValidity(),value:()=>readForm(f)};},{confirmLabel:tr('invites.create')});
  if(!v)return;
  try{const res=await api('/api/partners/admin/invites',{email:v.email||undefined,expiresInDays:Number(v.expiresInDays),note:v.note||undefined});toast(tr('invites.created'),'success');try{await navigator.clipboard.writeText(res.url);}catch{}await drawInvites(el);}catch(error){errToast(error);}
 };
 el.querySelector('.row').append(add);
}
async function drawAudit(el){
 const r=await api('/api/partners/admin/audit?limit=30');
 el.innerHTML=r.items.length?r.items.map(i=>`<div class="audit-row"><strong dir="ltr">${escape(i.action)}</strong> · ${escape(i.actorName||i.actorRole||'system')}<time>${fmtDateTime(i.createdAt)}</time></div>`).join(''):`<p class="muted">${escape(tr('audit.none'))}</p>`;
}

const LOADERS={overview,applications,partners,plans,commissions,payouts,assets,settings};
