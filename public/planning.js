import {t,getLocale} from './i18n.js';
const $=selector=>document.querySelector(selector);
const statuses=new Proxy({},{get:(_,code)=>{
 if(code==='SCHEDULED')return t('statuses.SCHEDULED');
 if(code==='CANCELLED')return t('statuses.CANCELLED');
 const key='calendar.jobStatus'+code.split('_').map(p=>p.charAt(0)+p.slice(1).toLowerCase()).join('');
 const value=t(key);return value===key?undefined:value;
}});
function dateLocale(){return getLocale()==='en'?'en-US':'ar-SA';}
export function installPlanningFields() {
 const form=$('#draft');
 for(const [name,label,type] of [['englishCopy',t('calendar.englishCopyFieldLabel'),'textarea'],['assetUrl',t('calendar.assetUrlFieldLabel'),'input']]) {
  const wrapper=document.createElement('label');wrapper.textContent=label;
  const field=document.createElement(type);field.name=name;
  if(type==='textarea'){field.maxLength=10000;field.rows=3;}else{field.type='url';field.dir='ltr';}
  wrapper.append(field);form.insertBefore(wrapper,form.querySelector('button'));
 }
}
export function addContentActions(card,item,auth,escape) {
 if(!['DRAFT','REVIEWED','APPROVED'].includes(item.status)){
  const notice=card.querySelector(':scope > p:last-child');if(notice)notice.textContent=item.status==='REJECTED'?t('calendar.contentRejectedNotice'):t('calendar.newerVersionExistsNotice');
 }
 if(item.assetUrl){const p=document.createElement('p'),a=document.createElement('a');a.href=item.assetUrl;a.textContent=t('calendar.openVisualAssetLink');a.target='_blank';a.rel='noopener noreferrer';p.append(a);card.append(p);
  const review=card.querySelector('[data-action="review"]');if(review){const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.name='asset';input.required=true;label.append(input,document.createTextNode(t('calendar.reviewedAssetCheckbox')));review.insertBefore(label,review.querySelector('button'));}}
 const role=auth.user.role;
 if(item.status!=='SUPERSEDED' && role!=='reviewer' && (item.status!=='APPROVED'||role==='owner')) {
  const details=document.createElement('details');
  details.innerHTML=`<summary>${t('calendar.reviseDetailsSummary')}</summary><form data-id="${item.id}" data-action="revise"><label>${t('calendar.titleFieldLabel')}<input name="title" required maxlength="200" value="${escape(item.title)}"></label><label>${t('calendar.arabicTextFieldLabel')}<textarea name="body" required maxlength="10000">${escape(item.body)}</textarea></label><label>${t('calendar.englishTextFieldLabel')}<textarea name="englishCopy" maxlength="10000">${escape(item.englishCopy||'')}</textarea></label><label>${t('calendar.productLinkFieldLabel')}<input type="url" name="url" required value="${escape(item.url)}"></label><label>${t('calendar.visualAssetFieldLabel')}<input type="url" name="assetUrl" value="${escape(item.assetUrl||'')}"></label><label>${t('content.platform')}<select name="platform">${['Instagram','X','Facebook','LinkedIn'].map(p=>`<option ${item.platform===p?'selected':''}>${p}</option>`).join('')}</select></label><label>${t('content.date')}<input type="date" name="date" required value="${escape(item.date)}"></label><label>${t('calendar.editReasonFieldLabel')}<input name="reason" required maxlength="1000"></label><button>${t('calendar.saveNewVersionButton')}</button></form>`;
  card.append(details);
 }
 if(['DRAFT','REVIEWED','APPROVED'].includes(item.status) && (role==='owner'||(role==='reviewer'&&item.status!=='APPROVED'))) {
  const details=document.createElement('details');details.innerHTML=`<summary>${t('calendar.rejectContentSummary')}</summary><form data-id="${item.id}" data-action="reject"><label>${t('calendar.rejectReasonFieldLabel')}<input name="reason" required maxlength="1000"></label><button>${t('calendar.rejectAndCancelButton')}</button></form>`;card.append(details);
 }
}
// Content Unification: the legacy "Schedule Approved Content" form below (#schedule-form)
// always meant one specific thing — scheduleContent()'s own hash-pinned review/approval
// invariant (src/planning.js) — which campaign-originated content never has (it uses its own
// compliance-classification gate instead, scheduled from its OWN Marketing UI via
// scheduleCampaignContent()). state.content already excludes campaign-shaped rows at the
// /api/state level (see src/application.js), so this filter is defense-in-depth, not the only
// guard — but kept explicit here since this exact dropdown is the one place scheduling this
// legacy way is actually attempted.
let campaignsCache=[],metaCache={contentFormats:[],contentStatuses:[]};
const LEGACY_STATUSES=['DRAFT','REVIEWED','APPROVED','REJECTED','SUPERSEDED','PUBLISHED'];
let unifiedFilters={campaignId:'',platform:'',format:'',status:'',dateFrom:'',dateTo:''};
function campaignName(id){return campaignsCache.find(c=>c.id===id)?.name||id;}
function populateFilterOptions(escape){
 const campaignSelect=$('#filter-campaign');
 if(campaignSelect && !campaignSelect.dataset.populated){
  campaignSelect.innerHTML=`<option value="">${escape(t('calendar.filterCampaignAll'))}</option><option value="none">${escape(t('calendar.filterCampaignNone'))}</option>`+campaignsCache.map(c=>`<option value="${c.id}">${escape(c.name)}</option>`).join('');
  campaignSelect.dataset.populated='true';
 }
 const formatSelect=$('#filter-format');
 if(formatSelect && !formatSelect.dataset.populated){
  formatSelect.innerHTML=`<option value="">${escape(t('calendar.filterFormatAll'))}</option>`+metaCache.contentFormats.map(f=>`<option value="${f}">${escape(f)}</option>`).join('');
  formatSelect.dataset.populated='true';
 }
 const statusSelect=$('#filter-status');
 if(statusSelect && !statusSelect.dataset.populated){
  const allStatuses=[...new Set([...LEGACY_STATUSES,...metaCache.contentStatuses])];
  statusSelect.innerHTML=`<option value="">${escape(t('calendar.filterStatusAll'))}</option>`+allStatuses.map(s=>`<option value="${s}">${escape(statuses[s]||s)}</option>`).join('');
  statusSelect.dataset.populated='true';
 }
}
function renderUnifiedContentList(content,escape){
 const host=$('#unified-content-list');
 if(!host)return;
 host.innerHTML=content.length?content.map(item=>`<article class="card"><div class="meta"><span>${escape(item.platform)}${item.format?' · '+escape(item.format):''} · ${escape(item.scheduledAt?item.scheduledAt.slice(0,10):item.date)}</span><span class="pill" data-status="${escape(item.status)}">${escape(statuses[item.status]||item.status)}</span></div><h4>${escape(item.title||item.hook||'')}</h4>${item.campaignId?`<p><small>${escape(t('calendar.campaignBadge',{name:campaignName(item.campaignId)}))}</small></p>`:''}</article>`).join(''):`<div class="empty">${escape(t('calendar.noUnifiedContent'))}</div>`;
}
async function refreshUnifiedContentList(api,escape){
 const params=new URLSearchParams();
 if(unifiedFilters.campaignId)params.set('campaignId',unifiedFilters.campaignId);
 if(unifiedFilters.platform)params.set('platform',unifiedFilters.platform);
 if(unifiedFilters.format)params.set('format',unifiedFilters.format);
 if(unifiedFilters.status)params.set('status',unifiedFilters.status);
 if(unifiedFilters.dateFrom)params.set('dateFrom',unifiedFilters.dateFrom);
 if(unifiedFilters.dateTo)params.set('dateTo',unifiedFilters.dateTo);
 const query=params.toString();
 const plan=await api('/api/planning'+(query?'?'+query:''));
 renderUnifiedContentList(plan.content||[],escape);
}
function wireUnifiedContentFilters(api,escape){
 const bar=$('#unified-content-filters');
 if(!bar||bar.dataset.wired)return;
 bar.dataset.wired='true';
 const bindings=[['#filter-campaign','campaignId'],['#filter-platform','platform'],['#filter-format','format'],['#filter-status','status'],['#filter-date-from','dateFrom'],['#filter-date-to','dateTo']];
 for(const [selector,key] of bindings){
  const el=$(selector);
  if(!el)continue;
  el.addEventListener('change',()=>{unifiedFilters[key]=el.value;refreshUnifiedContentList(api,escape).catch(()=>{});});
 }
}
export async function renderPlanning({api,auth,state,escape}) {
 const plan=await api('/api/planning');
 $('#calendar-form').hidden=auth.user.role==='reviewer';
 for(const id of ['schedule-form','save-brief','prepare-due'])$('#'+id).hidden=auth.user.role!=='owner';
 const start=$('#calendar-form input');if(!start.value)start.value=plan.today;
 const select=$('#schedule-content'),selected=select.value;
 select.innerHTML=`<option value="">${escape(t('calendar.chooseApprovedContentOption'))}</option>`+state.content.filter(item=>item.status==='APPROVED'&&!item.campaignId).map(item=>`<option value="${item.id}">${escape(item.title)} · ${item.platform} · ${item.date}</option>`).join('');select.value=selected;
 try{
  const [campaigns,meta]=await Promise.all([api('/api/marketing/campaigns'),api('/api/marketing/meta')]);
  campaignsCache=campaigns;metaCache=meta;
 }catch{campaignsCache=[];}
 populateFilterOptions(escape);
 wireUnifiedContentFilters(api,escape);
 renderUnifiedContentList(plan.content||[],escape);
 const brief=plan.brief;
 $('#brief-view').innerHTML=`<p>${escape(t('calendar.briefTomorrowContentLine',{count:brief.tomorrowContent.length,count2:brief.decisionsNeeded.length}))}</p><p>${escape(t('calendar.briefGapsLine',{count:brief.gaps.length,missing:brief.calendarMissing?t('calendar.calendarMissingSuffix'):''}))}</p><p>${escape(t('calendar.briefBlockedLine',{blocked:brief.blockedJobs.length,waiting:brief.waitingForConnector}))}</p>${brief.decisionsNeeded.slice(0,10).map(item=>`<p>${escape(item.title)} · ${item.action==='OWNER_APPROVAL'?escape(t('calendar.decisionOwnerApproval')):escape(t('calendar.decisionReview'))}</p>`).join('')}<small>${escape(t('calendar.livePreviewNote'))}</small>`;
 const locale=dateLocale();
 for(const saved of plan.savedBriefs){const details=document.createElement('details');details.innerHTML=`<summary>${t('calendar.savedBriefSummary',{date:saved.date})}</summary><p>${t('calendar.savedBriefDecisionsLine',{decisions:saved.decisionsNeeded.length,tomorrow:saved.tomorrowContent.length})}</p>${saved.tomorrowContent.map(item=>`<article><h4>${escape(item.title)} · ${escape(item.platform)}</h4><p>${escape(item.arabicCopy)}</p><p dir="ltr">${escape(item.englishCopy)}</p><p>${escape(item.url)}</p></article>`).join('')}`;$('#brief-view').append(details);}
 const days=[...new Set(plan.slots.map(slot=>slot.date))];
 $('#calendar-view').innerHTML=days.length?`<table><thead><tr><th>${escape(t('content.date'))}</th>${['Instagram','X','Facebook','LinkedIn'].map(p=>`<th>${p}</th>`).join('')}</tr></thead><tbody>${days.map(date=>`<tr><td>${date}</td>${['Instagram','X','Facebook','LinkedIn'].map(platform=>{const slot=plan.slots.find(s=>s.date===date&&s.platform===platform);const content=state.content.find(item=>item.id===slot?.contentId);return `<td>${slot?escape(slot.pillar)+(content?'<br><b>'+escape(content.title)+'</b>':'<br><small>'+escape(t('calendar.waitingForApprovedContentAndScheduling'))+'</small>'):'—'}</td>`;}).join('')}</tr>`).join('')}</tbody></table>`:escape(t('calendar.noCalendarYet'));
 $('#jobs-view').innerHTML=plan.jobs.length?plan.jobs.map(job=>`<div class="audit-row"><div class="row-between"><b>${escape(job.snapshot.title)}</b><span class="pill" data-status="${escape(job.status)}">${statuses[job.status]||escape(job.status)}</span></div><p>${escape(new Date(job.scheduledAt).toLocaleString(locale,{timeZone:'Asia/Riyadh'}))}</p>${auth.user.role==='owner'&&job.status!=='CANCELLED'?`<button type="button" data-cancel-content="${job.contentId}">${escape(t('calendar.cancelScheduleButton'))}</button>`:''}</div>`).join(''):escape(t('calendar.noScheduledJobs'));
}
export async function submitPlanning(form,input,api) {
 if(form.id==='calendar-form'){const result=await api('/api/calendar',input);return t('calendar.calendarSlotsAddedToast',{count:result.created});}
 if(form.id==='schedule-form'){await api('/api/schedule',{contentId:input.contentId,scheduledAt:input.localTime+':00+03:00'});return t('calendar.scheduledToast');}
 return null;
}
