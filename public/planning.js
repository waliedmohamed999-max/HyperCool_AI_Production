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
export async function renderPlanning({api,auth,state,escape}) {
 const plan=await api('/api/planning');
 $('#calendar-form').hidden=auth.user.role==='reviewer';
 for(const id of ['schedule-form','save-brief','prepare-due'])$('#'+id).hidden=auth.user.role!=='owner';
 const start=$('#calendar-form input');if(!start.value)start.value=plan.today;
 const select=$('#schedule-content'),selected=select.value;
 select.innerHTML=`<option value="">${escape(t('calendar.chooseApprovedContentOption'))}</option>`+state.content.filter(item=>item.status==='APPROVED').map(item=>`<option value="${item.id}">${escape(item.title)} · ${item.platform} · ${item.date}</option>`).join('');select.value=selected;
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
