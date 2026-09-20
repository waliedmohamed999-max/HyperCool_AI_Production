// Packages (src/plans.js) — a real, tenant-scoped plan-management page. Reuses the existing
// design system entirely (no new component library): badge/confirmAction/toast from
// components/ui/index.js. Every number shown here comes straight from GET /api/plans, which
// mirrors src/plans.js exactly — there is no second, competing notion of "what's included" on
// the frontend. No payment gateway exists anywhere in this app (see plans.js's own module
// doc) — switching plans here is the real, whole action, performed directly by the owner.
import {escape,badge,button,toast,confirmAction} from '../components/ui/index.js';
import {t,getLocale} from '../i18n.js';

const $=s=>document.querySelector('#packages '+s);
let apiClient,renderGeneration=0;
async function api(path,body,method){return apiClient(path,body,method);}
function staleGuard(generation){return generation!==renderGeneration;}

// Static display data for real, fixed integration slugs (src/integrations/definitions.js).
// Only UI labels — never a second source of truth for WHICH slugs a plan includes (that stays
// entirely server-side in src/plans.js).
const INTEGRATION_LABEL={whatsapp:'واتساب بزنس',meta:'ميتا (فيسبوك/إنستغرام)',x:'إكس',linkedin:'لينكدإن',microsoft365:'مايكروسوفت 365',salla:'سلة',zid:'زد'};
const INTEGRATION_LABEL_EN={whatsapp:'WhatsApp Business',meta:'Meta (Facebook/Instagram)',x:'X',linkedin:'LinkedIn',microsoft365:'Microsoft 365',salla:'Salla',zid:'Zid'};
const TOTAL_AGENT_COUNT=13;

function agentLabel(id){return t('agents.roles.'+id)||id;}
function integrationLabel(slug){return (getLocale()==='en'?INTEGRATION_LABEL_EN[slug]:INTEGRATION_LABEL[slug])||slug;}

function priceLine(plan){
 const amount=`${plan.price.toLocaleString()} ${t('packages.currency')}`;
 const prefix=plan.priceIsStartingFrom?t('packages.startingFrom')+' ':'';
 return `${prefix}${amount} / ${t('packages.monthly')}`;
}

function featureRow(included,label){
 return `<li class="pkg-feature ${included?'included':'excluded'}">${included?'✓':'—'}<span>${escape(label)}</span></li>`;
}

function planCard(plan,currentPlanId,canManage){
 const isCurrent=plan.id===currentPlanId;
 const agentsLine=plan.allowedAgents==='ALL'?t('packages.allAgents',{count:TOTAL_AGENT_COUNT}):plan.allowedAgents.map(agentLabel).join('، ');
 const channelsLine=plan.allowedIntegrations==='ALL'?t('packages.allChannels'):plan.allowedIntegrations.map(integrationLabel).join('، ');
 const seatsLine=plan.maxTeamMembers==null?t('packages.unlimitedSeats'):t('packages.seatsLimit',{count:plan.maxTeamMembers});
 return `<article class="pkg-card${plan.highlighted?' highlighted':''}${isCurrent?' current':''}">
  ${plan.highlighted?`<span class="pkg-ribbon">${escape(t('packages.mostPopular'))}</span>`:''}
  ${isCurrent?`<span class="pkg-ribbon pkg-ribbon-current">${escape(t('packages.currentPlanBadge'))}</span>`:''}
  <h3>${escape(t('packages.planNames.'+plan.id))}</h3>
  <p class="pkg-tagline">${escape(t('packages.planTaglines.'+plan.id))}</p>
  <p class="pkg-price">${escape(priceLine(plan))}</p>
  <div class="pkg-detail"><strong>${escape(t('packages.agentsIncluded'))}</strong><span>${escape(agentsLine)}</span></div>
  <div class="pkg-detail"><strong>${escape(t('packages.channelsIncluded'))}</strong><span>${escape(channelsLine)}</span></div>
  <div class="pkg-detail"><strong>${escape(t('packages.teamSeats'))}</strong><span>${escape(seatsLine)}</span></div>
  <ul class="pkg-feature-list">
   ${featureRow(plan.features.automation,t('packages.featureAutomation'))}
   ${featureRow(plan.features.commandCenter,t('packages.featureCommandCenter'))}
   ${featureRow(plan.features.customIntegrations,t('packages.featureCustomIntegrations'))}
   ${featureRow(plan.features.advancedReports,t('packages.featureAdvancedReports'))}
  </ul>
  <div class="pkg-action" data-plan-action="${escape(plan.id)}"></div>
 </article>`;
}

export function installPackagesPage(){
 const root=document.querySelector('[data-page="packages"] #packages');
 root.innerHTML=`
  <div class="section-title"><h2>${escape(t('packages.pageTitle'))}</h2><span>${escape(t('packages.pageSubtitle'))}</span></div>
  <div id="pkg-current-summary" class="notice"></div>
  <div id="pkg-grid" class="pkg-grid"></div>
  <p id="pkg-note" class="caption-note"></p>`;
}

export async function renderPackagesPage({api:client,auth}){
 apiClient=client;
 const navLink=document.querySelector('#nav-packages');
 if(navLink)navLink.hidden=!auth.user;
 if(!auth.user)return;
 const generation=++renderGeneration;
 const {plans,currentPlanId}=await api('/api/plans');
 if(staleGuard(generation))return;
 const canManage=auth.user.role==='owner';
 $('#pkg-current-summary').innerHTML=currentPlanId
  ?`${escape(t('packages.currentPlanLabel'))}: ${badge(t('packages.planNames.'+currentPlanId))}`
  :escape(t('packages.noPlanAssigned'));
 $('#pkg-grid').innerHTML=plans.map(plan=>planCard(plan,currentPlanId,canManage)).join('');
 $('#pkg-note').textContent=canManage?t('packages.noPaymentNote'):t('packages.ownerOnlyNote');
 $('#pkg-grid').querySelectorAll('[data-plan-action]').forEach(slot=>{
  const planId=slot.dataset.planAction;
  if(!canManage||planId===currentPlanId)return;
  const activate=button(t('packages.activatePlan'),{variant:planId===currentPlanId?'secondary':'primary'});
  activate.onclick=async()=>{
   const planName=t('packages.planNames.'+planId);
   const confirmed=await confirmAction(t('packages.confirmSwitchTitle',{plan:planName}),t('packages.confirmSwitchBody'));
   if(!confirmed)return;
   try{
    await api('/api/tenant/plan',{planId},'PATCH');
    toast(t('packages.switchSuccess',{plan:planName}),'success');
    await renderPackagesPage({api:client,auth});
   }catch(error){toast(error.message,'error');}
  };
  slot.replaceChildren(activate);
 });
}
