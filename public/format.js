// Shared formatting/rendering helpers for the dashboard-style pages (reports, CRM).
// Pure presentation only — no API calls, no state — so both pages can depend on it
// without either depending on the other.
// `empty` is re-exported (not redefined) from the shared ui kit so every page renders the
// exact same empty-state markup — icon, escaped title, escaped hint — instead of a
// page-local variant that quietly drifted from it.
import {empty,escape} from './components/ui/index.js';
import {getLocale,t} from './i18n.js';
export {empty};
// fmtNum/fmtSAR keep Western tabular digits in both languages (matches the tables'
// font-variant-numeric:tabular-nums) since they're dense counts/amounts; fmtDate/fmtDateTime
// simply follow whichever Intl locale is active — unchanged from the app's existing Arabic
// date behavior, now also switching to en-US month names/order in English mode.
const intlLocale=()=>getLocale()==='en'?'en-US':'ar-SA';
export const fmtNum=n=>Number.isFinite(n)?n.toLocaleString('en-US'):'—';
export const fmtSAR=n=>Number.isFinite(n)?n.toLocaleString('en-US',{maximumFractionDigits:0})+(getLocale()==='en'?' SAR':' ر.س'):'—';
export const fmtDate=iso=>iso?new Date(iso+'T12:00:00Z').toLocaleDateString(intlLocale(),{day:'numeric',month:'short',timeZone:'UTC'}):'';
export const fmtDateRange=(start,end)=>`${fmtDate(start)} ← ${fmtDate(new Date(Date.parse(end)-86400000).toISOString().slice(0,10))}`;
export const fmtDateTime=iso=>iso?new Date(iso).toLocaleString(intlLocale(),{timeZone:'Asia/Riyadh',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'';

export function miniStat(label,value) {
 return `<div class="kpi-card"><span class="kpi-label">${label}</span><span class="kpi-value" dir="ltr">${value}</span></div>`;
}
export function kpiCard(def,kpi,escape) {
 const hasComparison=kpi && typeof kpi.previous==='number' && typeof kpi.change==='number';
 const value=def.format==='sar'?fmtSAR(kpi.value):def.format==='percent'?(Number.isFinite(kpi.value)?kpi.value+'%':'0%'):fmtNum(kpi.value);
 const noData=(kpi.value||0)===0 && (!hasComparison || (kpi.previous||0)===0);
 let trend='';
 if(hasComparison) {
  if(noData)trend=`<span class="kpi-trend neutral">${escape(t('common.charts.kpiNotEnoughData'))}</span>`;
  else {
   const dir=kpi.trend==='flat'?'neutral':(def.good==='up'?(kpi.trend==='up'?'good':'bad'):(kpi.trend==='down'?'good':'bad'));
   const arrow=kpi.trend==='up'?'↑':kpi.trend==='down'?'↓':'—';
   trend=`<span class="kpi-trend ${dir}" dir="ltr">${arrow}${kpi.changePercent!==null?' '+Math.abs(kpi.changePercent)+'%':''}</span>`;
  }
 }
 const context=hasComparison?t('common.charts.kpiComparedToPreviousPeriod'):escape(kpi.note||'');
 const cls='kpi-card'+(def.page?' clickable':'');
 const attr=def.page?` data-report-nav="${def.page}"`:'';
 return `<div class="${cls}"${attr}><span class="kpi-label">${escape(def.label)}</span><span class="kpi-value" dir="ltr">${value}</span>${trend}<span class="kpi-context">${context}</span></div>`;
}
// SVG geometry (not CSS) draws every proportional bar — the app's CSP is style-src
// 'self', which silently blocks any inline style="width:…" attribute.
export function proportionalBar(fraction,className) {
 const width=Math.max(Math.min(fraction,1)*100,fraction>0?6:0);
 return `<svg viewBox="0 0 100 24" preserveAspectRatio="none" class="proportional-track" role="presentation"><rect class="${className}" x="0" y="0" width="${width}" height="24" rx="6"></rect></svg>`;
}
export function renderBarChart(entries,escape) {
 if(!entries.length)return empty(t('common.charts.notEnoughData'));
 const max=Math.max(...entries.map(e=>e[1]),1);
 return `<div class="bar-chart">${entries.map(([label,count])=>`<div class="bar-row"><span>${escape(label)}</span><div class="bar-track">${proportionalBar(count/max,'bar-svg-fill')}</div><span class="bar-value" dir="ltr">${fmtNum(count)}</span></div>`).join('')}</div>`;
}
export function renderFunnel(funnel,escape) {
 if(!funnel.hasData)return empty(t('common.charts.funnelEmptyTitle'),t('common.charts.funnelEmptyHint'));
 const max=Math.max(...funnel.stages.map(s=>s.count),1);
 return `<div class="funnel">${funnel.stages.map(stage=>`<div class="funnel-row"><span class="funnel-label">${escape(stage.label)}</span><div class="funnel-track">${proportionalBar(stage.count/max,'funnel-svg-fill')}</div><span class="funnel-count" dir="ltr">${fmtNum(stage.count)}</span>${stage.dropOffPercent?`<span class="funnel-dropoff" dir="ltr">↓ ${stage.dropOffPercent}%</span>`:'<span></span>'}</div>`).join('')}</div><p><small>${t('common.charts.funnelSnapshotNote')}</small></p>`;
}
// Real CRM stage codes (never translated in the DB) → locale-aware display text, computed
// fresh on every access so a language switch relabels the pipeline/select-options/pills
// everywhere this is used with zero other code touched. Object.entries()/Object.keys() work
// on this Proxy exactly like a plain object (ownKeys + getOwnPropertyDescriptor traps).
const STAGE_KEYS=['NEW','QUALIFIED','QUOTE_SENT','DEMO','POST_PURCHASE','PARKED','WON','LOST'];
export const stageNames=new Proxy({},{
 get:(_,key)=>STAGE_KEYS.includes(key)?t('statuses.'+key):undefined,
 ownKeys:()=>STAGE_KEYS,
 has:(_,key)=>STAGE_KEYS.includes(key),
 getOwnPropertyDescriptor:(_,key)=>STAGE_KEYS.includes(key)?{enumerable:true,configurable:true}:undefined
});

// Fixed, CSS-class-driven color set for the widgets below. Colors must come from a class
// (defined in styles/pages.css against the real design tokens), never a raw hex or CSS
// var() poured into a bare SVG presentation attribute or a style="" attribute — both would
// either be silently blocked by the app's style-src 'self' CSP or fail to resolve var().
export const chartColors=['chart-c1','chart-c2','chart-c3','chart-c4','chart-c5','chart-c6'];

// A ring chart over real category counts. segments: [{label,value}], colorClass optional
// (defaults to chartColors in order). Never fabricates a share for a category with 0 count.
export function renderDonut(segments,escape,{size=112,thickness=13}={}) {
 const real=segments.filter(s=>s.value>0);
 const total=real.reduce((sum,s)=>sum+s.value,0);
 if(!total)return empty(t('common.charts.notEnoughData'));
 const r=(size-thickness)/2,c=2*Math.PI*r,center=size/2;
 let offset=0;
 const arcs=real.map((s,i)=>{
  const len=s.value/total*c;
  const html=`<circle class="${s.colorClass||chartColors[i%chartColors.length]}" cx="${center}" cy="${center}" r="${r}" fill="none" stroke-width="${thickness}" stroke-dasharray="${len.toFixed(2)} ${(c-len).toFixed(2)}" stroke-dashoffset="${(-offset).toFixed(2)}"></circle>`;
  offset+=len;
  return html;
 }).join('');
 const legend=real.map((s,i)=>`<li><span class="legend-dot ${s.colorClass||chartColors[i%chartColors.length]}"></span>${escape(s.label)}<b dir="ltr">${fmtNum(s.value)}</b></li>`).join('');
 return `<div class="donut-chart"><svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="${escape(t('common.charts.donutChartLabel'))}"><g transform="rotate(-90 ${center} ${center})">${arcs}</g><text x="${center}" y="${center-2}" text-anchor="middle" class="donut-total">${fmtNum(total)}</text><text x="${center}" y="${center+14}" text-anchor="middle" class="donut-total-label">${escape(t('common.charts.total'))}</text></svg><ul class="donut-legend">${legend}</ul></div>`;
}
// A tiny inline trend line for a colored stat card. values: plain numbers, oldest first.
// With fewer than 2 real points there is no trend to draw — say so instead of a flat fake line.
export function renderSparkline(values,colorClass='chart-c1') {
 const real=values.filter(Number.isFinite);
 if(real.length<2)return `<p class="spark-empty">${escape(t('common.charts.sparklineNotEnough'))}</p>`;
 const min=Math.min(...real),max=Math.max(...real),span=max-min||1;
 const pts=real.map((v,i)=>`${(i/(real.length-1)*100).toFixed(1)},${(28-(v-min)/span*26).toFixed(1)}`);
 const area=`0,30 ${pts.join(' ')} 100,30`;
 return `<svg viewBox="0 0 100 32" preserveAspectRatio="none" class="sparkline" role="presentation"><polygon class="${colorClass} spark-fill" points="${area}"></polygon><polyline class="${colorClass} spark-line" fill="none" stroke-width="2" points="${pts.join(' ')}"></polyline></svg>`;
}
// The larger weekly-trend panel. points: [{label,value}], oldest first — real saved weekly
// reports only; with under 2 saved weeks there is nothing to chart yet.
export function renderTrendChart(points,escape,colorClass='chart-c1') {
 const real=points.filter(p=>Number.isFinite(p.value));
 if(real.length<2) {
  // A ghost axis instead of a bare box — signals "chart is coming", not "broken".
  const w=600,h=180;
  const gridlines=[0.25,0.5,0.75].map(f=>`<line x1="10" y1="${(h-16)*f+8}" x2="${w-10}" y2="${(h-16)*f+8}" class="trend-ghost-grid"></line>`).join('');
  return `<div class="trend-empty"><svg viewBox="0 0 ${w} ${h}" class="trend-chart" role="presentation">${gridlines}<line x1="10" y1="${h-16}" x2="${w-10}" y2="${h-16}" class="trend-ghost-axis"></line></svg><div class="trend-empty-note">${empty(t('common.charts.trendNeedsTwoWeeks'),t('common.charts.trendSaveWeekly'))}</div></div>`;
 }
 const min=Math.min(...real.map(p=>p.value),0),max=Math.max(...real.map(p=>p.value),1),span=max-min||1;
 const w=600,h=180,padX=10,padY=16;
 const x=i=>padX+(i/(real.length-1))*(w-padX*2);
 const y=v=>h-padY-((v-min)/span)*(h-padY*2);
 const pts=real.map((p,i)=>`${x(i).toFixed(1)},${y(p.value).toFixed(1)}`);
 const area=`${x(0).toFixed(1)},${h-padY} ${pts.join(' ')} ${x(real.length-1).toFixed(1)},${h-padY}`;
 const labels=real.map((p,i)=>`<text x="${x(i).toFixed(1)}" y="${h-2}" text-anchor="middle" class="chart-axis-label">${escape(p.label)}</text>`).join('');
 // data-x/data-y/data-label/data-value let installTrendChart rebuild the exact point list
 // for the hover tooltip without recomputing the scale — no separate data channel needed.
 const dots=real.map((p,i)=>`<circle class="${colorClass} trend-dot" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.5" data-x="${x(i).toFixed(1)}" data-y="${y(p.value).toFixed(1)}" data-label="${escape(p.label)}" data-value="${escape(fmtNum(p.value))}"></circle>`).join('');
 const hoverLayer=`<g class="trend-hover" visibility="hidden"><line class="trend-hover-line" x1="0" y1="${padY}" x2="0" y2="${h-padY}"></line><circle class="${colorClass} trend-hover-dot" r="5.5"></circle><g class="trend-tooltip"><rect class="trend-tooltip-bg" width="86" height="34" rx="6"></rect><text class="trend-tooltip-label" x="8" y="14">.</text><text class="trend-tooltip-value" x="8" y="27">.</text></g></g>`;
 return `<svg viewBox="0 0 ${w} ${h}" class="trend-chart" role="img" aria-label="${escape(t('common.charts.weeklyTrendLabel'))}"><polygon class="${colorClass} spark-fill" points="${area}"></polygon><polyline class="${colorClass} spark-line" fill="none" stroke-width="2.5" points="${pts.join(' ')}"></polyline>${dots}${labels}${hoverLayer}</svg>`;
}
// Attaches real mouse-hover interactivity to every .trend-chart SVG inside container:
// a guide line, a highlighted dot and a small tooltip that snap to the nearest real data
// point. Built entirely from SVG presentation attributes (transform/x1/x2/cx/cy/visibility)
// rather than style="" or element.style — both of the latter are silently dropped by this
// app's style-src 'self' CSP, exactly like the proportional bars elsewhere in this file.
export function installTrendChart(container) {
 container.querySelectorAll('svg.trend-chart').forEach(svg=>{
  const dots=[...svg.querySelectorAll('circle.trend-dot')].map(c=>({x:Number(c.dataset.x),y:Number(c.dataset.y),label:c.dataset.label,value:c.dataset.value}));
  const hover=svg.querySelector('.trend-hover');
  if(!dots.length||!hover)return;
  const line=hover.querySelector('.trend-hover-line'),dot=hover.querySelector('.trend-hover-dot'),tip=hover.querySelector('.trend-tooltip'),tipLabel=hover.querySelector('.trend-tooltip-label'),tipValue=hover.querySelector('.trend-tooltip-value');
  const move=evt=>{
   const pt=svg.createSVGPoint();pt.x=evt.clientX;pt.y=evt.clientY;
   const svgPt=pt.matrixTransform(svg.getScreenCTM().inverse());
   let nearest=dots[0];for(const d of dots)if(Math.abs(d.x-svgPt.x)<Math.abs(nearest.x-svgPt.x))nearest=d;
   hover.setAttribute('visibility','visible');
   line.setAttribute('x1',nearest.x);line.setAttribute('x2',nearest.x);
   dot.setAttribute('cx',nearest.x);dot.setAttribute('cy',nearest.y);
   const viewBox=svg.viewBox.baseVal,tipW=86,flip=nearest.x+12+tipW>viewBox.width;
   tip.setAttribute('transform',`translate(${flip?nearest.x-tipW-12:nearest.x+12},${Math.max(4,nearest.y-30)})`);
   tipLabel.textContent=nearest.label;tipValue.textContent=nearest.value;
  };
  svg.addEventListener('mousemove',move);
  svg.addEventListener('mouseleave',()=>hover.setAttribute('visibility','hidden'));
 });
}
