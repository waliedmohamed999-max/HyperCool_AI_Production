const $=selector=>document.querySelector(selector);
const statuses={SCHEDULED:'مجدول',READY_FOR_CONNECTOR:'جاهز — ينتظر ربط النشر',BLOCKED:'موقوف لتغير الاعتماد',CANCELLED:'ملغى'};
export function installPlanningFields() {
 const form=$('#draft');
 for(const [name,label,type] of [['englishCopy','النص الإنجليزي (مطلوب لـLinkedIn)','textarea'],['assetUrl','رابط الأصل البصري HTTPS (مطلوب لـInstagram)','input']]) {
  const wrapper=document.createElement('label');wrapper.textContent=label;
  const field=document.createElement(type);field.name=name;
  if(type==='textarea'){field.maxLength=10000;field.rows=3;}else{field.type='url';field.dir='ltr';}
  wrapper.append(field);form.insertBefore(wrapper,form.querySelector('button'));
 }
}
export function addContentActions(card,item,auth,escape) {
 if(!['DRAFT','REVIEWED','APPROVED'].includes(item.status)){
  const notice=card.querySelector(':scope > p:last-child');if(notice)notice.textContent=item.status==='REJECTED'?'المحتوى مرفوض؛ أنشئ نسخة معدلة لإعادة المراجعة.':'توجد نسخة أحدث من هذا المحتوى.';
 }
 if(item.assetUrl){const p=document.createElement('p'),a=document.createElement('a');a.href=item.assetUrl;a.textContent='فتح الأصل البصري للمراجعة';a.target='_blank';a.rel='noopener noreferrer';p.append(a);card.append(p);
  const review=card.querySelector('[data-action="review"]');if(review){const label=document.createElement('label');label.className='check';const input=document.createElement('input');input.type='checkbox';input.name='asset';input.required=true;label.append(input,document.createTextNode('راجعت الأصل البصري مع النص'));review.insertBefore(label,review.querySelector('button'));}}
 const role=auth.user.role;
 if(item.status!=='SUPERSEDED' && role!=='reviewer' && (item.status!=='APPROVED'||role==='owner')) {
  const details=document.createElement('details');
  details.innerHTML=`<summary>إنشاء نسخة معدلة وإعادة المراجعة</summary><form data-id="${item.id}" data-action="revise"><label>العنوان<input name="title" required maxlength="200" value="${escape(item.title)}"></label><label>النص العربي<textarea name="body" required maxlength="10000">${escape(item.body)}</textarea></label><label>النص الإنجليزي<textarea name="englishCopy" maxlength="10000">${escape(item.englishCopy||'')}</textarea></label><label>رابط المنتج<input type="url" name="url" required value="${escape(item.url)}"></label><label>الأصل البصري<input type="url" name="assetUrl" value="${escape(item.assetUrl||'')}"></label><label>المنصة<select name="platform">${['Instagram','X','Facebook','LinkedIn'].map(p=>`<option ${item.platform===p?'selected':''}>${p}</option>`).join('')}</select></label><label>التاريخ<input type="date" name="date" required value="${escape(item.date)}"></label><label>سبب التعديل<input name="reason" required maxlength="1000"></label><button>حفظ نسخة جديدة</button></form>`;
  card.append(details);
 }
 if(['DRAFT','REVIEWED','APPROVED'].includes(item.status) && (role==='owner'||(role==='reviewer'&&item.status!=='APPROVED'))) {
  const details=document.createElement('details');details.innerHTML=`<summary>رفض المحتوى</summary><form data-id="${item.id}" data-action="reject"><label>سبب الرفض<input name="reason" required maxlength="1000"></label><button>رفض وإلغاء الجدولة</button></form>`;card.append(details);
 }
}
export async function renderPlanning({api,auth,state,escape}) {
 const plan=await api('/api/planning');
 $('#calendar-form').hidden=auth.user.role==='reviewer';
 for(const id of ['schedule-form','save-brief','prepare-due'])$('#'+id).hidden=auth.user.role!=='owner';
 const start=$('#calendar-form input');if(!start.value)start.value=plan.today;
 const select=$('#schedule-content'),selected=select.value;
 select.innerHTML='<option value="">اختر محتوى معتمدًا</option>'+state.content.filter(item=>item.status==='APPROVED').map(item=>`<option value="${item.id}">${escape(item.title)} · ${item.platform} · ${item.date}</option>`).join('');select.value=selected;
 const brief=plan.brief;
 $('#brief-view').innerHTML=`<p>محتوى الغد: ${brief.tomorrowContent.length} · قرارات مطلوبة: ${brief.decisionsNeeded.length}</p><p>خانات الغد غير المجدولة: ${brief.gaps.length}${brief.calendarMissing?' · تقويم الغد غير موجود':''}</p><p>موقوف: ${brief.blockedJobs.length} · ينتظر ربط النشر: ${brief.waitingForConnector}</p>${brief.decisionsNeeded.slice(0,10).map(item=>`<p>${escape(item.title)} · ${item.action==='OWNER_APPROVAL'?'بانتظار الاعتماد':'بانتظار المراجعة'}</p>`).join('')}<small>معاينة حية · الحزمة المحفوظة لا تتغير تلقائيًا · لا إرسال إلى واتساب أو البريد</small>`;
 for(const saved of plan.savedBriefs){const details=document.createElement('details');details.innerHTML=`<summary>حزمة ${saved.date} المحفوظة</summary><p>قرارات: ${saved.decisionsNeeded.length} · محتوى الغد: ${saved.tomorrowContent.length}</p>${saved.tomorrowContent.map(item=>`<article><h4>${escape(item.title)} · ${escape(item.platform)}</h4><p>${escape(item.arabicCopy)}</p><p dir="ltr">${escape(item.englishCopy)}</p><p>${escape(item.url)}</p></article>`).join('')}`;$('#brief-view').append(details);}
 const days=[...new Set(plan.slots.map(slot=>slot.date))];
 $('#calendar-view').innerHTML=days.length?`<table><thead><tr><th>التاريخ</th>${['Instagram','X','Facebook','LinkedIn'].map(p=>`<th>${p}</th>`).join('')}</tr></thead><tbody>${days.map(date=>`<tr><td>${date}</td>${['Instagram','X','Facebook','LinkedIn'].map(platform=>{const slot=plan.slots.find(s=>s.date===date&&s.platform===platform);const content=state.content.find(item=>item.id===slot?.contentId);return `<td>${slot?escape(slot.pillar)+(content?'<br><b>'+escape(content.title)+'</b>':'<br><small>بانتظار محتوى معتمد وجدولة</small>'):'—'}</td>`;}).join('')}</tr>`).join('')}</tbody></table>`:'لا يوجد تقويم بعد.';
 $('#jobs-view').innerHTML=plan.jobs.length?plan.jobs.map(job=>`<div class="audit-row"><div class="row-between"><b>${escape(job.snapshot.title)}</b><span class="pill" data-status="${escape(job.status)}">${statuses[job.status]||escape(job.status)}</span></div><p>${escape(new Date(job.scheduledAt).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'}))}</p>${auth.user.role==='owner'&&job.status!=='CANCELLED'?`<button type="button" data-cancel-content="${job.contentId}">إلغاء الجدولة</button>`:''}</div>`).join(''):'لا توجد مواعيد مجدولة.';
}
export async function submitPlanning(form,input,api) {
 if(form.id==='calendar-form'){const result=await api('/api/calendar',input);return `تمت إضافة ${result.created} خانة؛ الخانات الموجودة محفوظة`;} 
 if(form.id==='schedule-form'){await api('/api/schedule',{contentId:input.contentId,scheduledAt:input.localTime+':00+03:00'});return 'تمت الجدولة؛ النشر ينتظر ربط المنصة';}
 return null;
}
