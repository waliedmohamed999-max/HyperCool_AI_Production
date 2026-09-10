const levels=['L0','L1','L2','L3'];
const levelNames={L0:'L0 — مسودة، اعتماد كل عنصر',L1:'L1 — اعتماد أسبوعي، الردود ما زالت فردية',L2:'L2 — رد حر ضمن نص وأسعار معتمدة',L3:'L3 — تشغيل يومي، مراجعة السجل لاحقًا'};
const runStatusNames={QUEUED:'في الانتظار',RUNNING:'قيد التنفيذ',WAITING_APPROVAL:'ينتظر موافقة',COMPLETED:'تم',FAILED:'فشل',ESCALATED:'تم التصعيد',CANCELLED:'ملغى'};
let agents=[];
const testResults=new Map();
export async function renderAgents({api,auth,escape}) {
 agents=await api('/api/agents');
 document.querySelector('#agent-list').innerHTML=agents.map(agent=>{
  const index=levels.indexOf(agent.level);
  const options=[...(index<levels.length-1?[levels[index+1]]:[]),...levels.slice(0,index)];
  const history=agent.autonomyUpdatedAt?`<small>آخر تغيير: ${escape(agent.autonomyUpdatedBy||'')} · ${escape(agent.autonomyReason||'')} · ${escape(new Date(agent.autonomyUpdatedAt).toLocaleDateString('ar-SA'))}</small>`:'<small>لم يتغير المستوى منذ الإعداد — L0 افتراضيًا</small>';
  const control=auth.user.role==='owner'&&options.length?`<details><summary>تغيير مستوى الصلاحية</summary><form data-autonomy="${agent.id}"><label>المستوى الجديد<select name="level">${options.map(level=>`<option value="${level}">${levelNames[level]}</option>`).join('')}</select></label><label>سبب التغيير — يشترط 14 يومًا صافيًا بلا خرق امتثال قبل أي ترقية<input name="reason" required maxlength="1000"></label><button>حفظ المستوى</button></form></details>`:'';
  const runLine=agent.lastRunAt?`<small>آخر تشغيلة: ${escape(runStatusNames[agent.lastRunStatus]||agent.lastRunStatus)} · ${escape(new Date(agent.lastRunAt).toLocaleString('ar-SA',{timeZone:'Asia/Riyadh'}))} · آخر 10: ${agent.runsTotal}</small>`:'<small>لا تشغيلات مسجلة بعد لهذا الوكيل</small>';
  const test=testResults.get(agent.id);
  const testBody=!test?'':test.status==='RUNNING'?'<p>جارٍ التشغيل…</p>':`<p><b>${escape(test.status)}</b>${test.output?.action?' · '+escape(test.output.action):''}</p>${test.output?.rationale?`<p>${escape(test.output.rationale)}</p>`:''}${test.error?`<p>${escape(test.error)}</p>`:''}${test.output?.payload?`<pre>${escape(JSON.stringify(test.output.payload,null,2))}</pre>`:''}${test.toolCalls?.length?`<p>استدعاءات أدوات: ${test.toolCalls.map(t=>escape(t.tool)+' ('+escape(t.status)+')').join('، ')}</p>`:''}<p><small>${test.output?.escalation_required?'يحتاج تصعيد بشري':'لا يحتاج تصعيد'} · ${test.output?.risk_level?'الخطورة: '+escape(test.output.risk_level):''} · لم يُرسل أي شيء خارجيًا — عرض داخلي فقط</small></p>`;
  return `<article class="card"><div class="meta"><span class="pill" data-status="${escape(agent.level)}">${escape(agent.level)}</span><span class="pill" data-status="${agent.runtimeStatus==='ONLINE'?'COMPLETED':agent.runtimeStatus==='WAITING_INTEGRATION'?'HOLD':agent.runtimeStatus==='DISABLED'?'CANCELLED':'NEEDS_DATA'}">${escape(agent.runtimeLabel)}</span></div><h3>${escape(agent.name)}</h3><p>${escape(agent.purpose)}</p>${runLine}${history}${control}<details><summary>اختبار الوكيل (بدون إرسال خارجي)</summary><form data-agent-test="${agent.id}"><label>سيناريو<textarea name="scenario" required maxlength="4000" placeholder="مثال: عميل يسأل عن سعر جهاز الكرايوثيرابي ويطلب خصم 20%"></textarea></label><button>تشغيل الاختبار</button></form>${testBody}</details></article>`;
 }).join('');
 if(auth.user.role==='reviewer')document.querySelectorAll('#agent-list [data-agent-test]').forEach(form=>form.closest('details').remove());
}
export async function submitAutonomy(form,input,api) {
 if(!form.dataset.autonomy)return null;
 const id=form.dataset.autonomy;
 input.expectedVersion=agents.find(agent=>agent.id===id)?.autonomyVersion||0;
 await api(`/api/agents/${id}/autonomy`,input);
 return 'تم تحديث مستوى صلاحية الوكيل';
}
export async function renderFrostControl({api,auth,escape}) {
 const status=await api('/api/frost/status');
 const gate=status.gate;
 document.querySelector('#frost-status').innerHTML=`<div class="row-between"><h2>غرفة تحكم Frost</h2><span class="pill" data-status="${gate.paused||!status.schedulerRunning?'HOLD':'ONLINE'}">${gate.paused?'متوقف مؤقتًا':status.schedulerRunning?'الجدولة نشطة':'الجدولة غير نشطة'}</span></div><p>الفحص اليومي 08:00 بتوقيت الرياض · التقرير الأسبوعي يوم الأحد.</p>${gate.paused&&gate.pausedBy?'<p>أوقفه: '+escape(gate.pausedBy)+(gate.reason?' · '+escape(gate.reason):'')+'</p>':''}<details><summary>تفاصيل التشغيل والأحداث</summary><p>${status.schedulerRunning?'المجدول الداخلي يعمل.':'المجدول غير نشط في عملية الخادم الحالية.'}</p><p dir="ltr">${status.routes.map(escape).join(' · ')}</p></details>`;
 document.querySelector('#frost-pause').hidden=gate.paused||auth.user.role!=='owner';
 document.querySelector('#frost-resume').hidden=!gate.paused||auth.user.role!=='owner';
 document.querySelector('#frost-run-now').hidden=auth.user.role!=='owner';
}
export async function clickFrost(button,api) {
 if(button.id==='frost-pause'){await api('/api/frost/pause',{reason:'إيقاف يدوي من غرفة العمليات'});return 'تم إيقاف كل الإجراءات المستقلة';}
 if(button.id==='frost-resume'){await api('/api/frost/resume',{});return 'تم استئناف الإجراءات المستقلة';}
 if(button.id==='frost-run-now'){const result=await api('/api/frost/run-now',{});return result.skipped?'الدورة متوقفة حاليًا — استأنف أولًا':'تم تشغيل دورة Frost يدويًا الآن';}
 return null;
}
const actionTypeNames={publish_content:'نشر محتوى',send_marketing_message:'إرسال رسالة تسويقية',discount:'خصم',large_quote:'عرض سعر كبير',memory_policy_change:'تغيير في ذاكرة العلامة',medical_claim:'ادعاء طبي',agent_permission_change:'تغيير صلاحية وكيل'};
export async function renderApprovalCenter({api,auth,escape}) {
 const [approvals,escalations]=await Promise.all([api('/api/approvals?status=PENDING'),api('/api/escalations?status=OPEN')]);
 const canDecide=auth.user.role==='owner';
 const rows=[
  ...approvals.map(a=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(actionTypeNames[a.action_type]||a.action_type)}</span><span class="risk-meta">وكيل: ${escape(a.agent_id)} · ${escape(a.reason)}</span></div>${canDecide?`<div class="row"><button type="button" data-approval-decide="${a.id}" data-decision="APPROVED">اعتماد</button><button type="button" class="secondary" data-approval-decide="${a.id}" data-decision="REJECTED">رفض</button></div>`:`<span class="pill" data-status="${escape(a.risk_level)}">${escape(a.risk_level)}</span>`}</div>`),
  ...escalations.map(e=>`<div class="risk-item"><div class="risk-body"><span class="risk-title">${escape(e.reason)}</span><span class="risk-meta">وكيل: ${escape(e.agent_id)} · تصعيد</span></div>${canDecide?`<div class="row"><button type="button" data-escalation-resolve="${e.id}">تحديد كمُعالَج</button><span class="pill" data-status="${escape(e.priority)}">${escape(e.priority)}</span></div>`:`<span class="pill" data-status="${escape(e.priority)}">${escape(e.priority)}</span>`}</div>`)
 ];
 document.querySelector('#approval-center-list').innerHTML=rows.length?`<div class="risk-list">${rows.join('')}</div>`:'<div class="empty">لا قرارات معلّقة حاليًا — كل شيء تحت السيطرة.</div>';
}
export async function clickApprovalCenter(button,api) {
 if(button.dataset.approvalDecide){await api(`/api/approvals/${button.dataset.approvalDecide}/decide`,{decision:button.dataset.decision});return button.dataset.decision==='APPROVED'?'تم اعتماد القرار':'تم رفض القرار';}
 if(button.dataset.escalationResolve){await api(`/api/escalations/${button.dataset.escalationResolve}/resolve`,{});return 'تم تحديد التصعيد كمُعالَج';}
 return null;
}
export async function submitAgentTest(form,input,api) {
 if(!form.dataset.agentTest)return null;
 const id=form.dataset.agentTest;
 testResults.set(id,{status:'RUNNING'});
 try {
  const run=await api(`/api/agents/${id}/run`,{scenario:input.scenario});
  testResults.set(id,{status:run.status,output:run.output,error:run.error,toolCalls:run.toolCalls});
  return 'انتهى تشغيل الاختبار';
 } catch(error) {
  testResults.set(id,{status:'FAILED',error:error.message});
  throw error;
 }
}
