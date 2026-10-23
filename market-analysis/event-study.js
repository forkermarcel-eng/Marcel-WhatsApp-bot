import {setImmediate as yieldEventLoop} from 'node:timers/promises';
import {requireValue,utcMillis} from './instruments.js';
import {assessBars} from './quality.js';
import {digest} from './news/events.js';
import {eventFamily,EVENT_FAMILIES} from './event-types.js';
import {ms} from './storage.js';

const finite=x=>typeof x==='number' && Number.isFinite(x) && Math.abs(x)<=1e15;
function abort(signal) {if(signal?.aborted)throw Object.assign(new Error('ABORTED'),{code:'ABORTED'});}
function stats(values) {
  if(!values.length)return null;
  const sorted=values.toSorted((a,b)=>a-b),n=sorted.length,mean=sorted.reduce((s,x)=>s+x,0)/n;
  return {count:n,mean,median:n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2,min:sorted[0],max:sorted.at(-1),
    sampleStd:n>1?Math.sqrt(sorted.reduce((s,x)=>s+(x-mean)**2,0)/(n-1)):null,
    positive:values.filter(x=>x>0).length,negative:values.filter(x=>x<0).length,zero:values.filter(x=>x===0).length};
}
const effectiveKnown=row=>Math.max(ms(row.stored_at),ms(row.body.fetchedAt ?? row.fetched_at),ms(row.body.processedAt ?? row.processed_at));
// Only actual macro publication instants. Scheduled calendar dates are not releases.
export async function analyzeEventStudy(request,{signal}={}) {
  abort(signal);
  const {instrument,eventRows,barRows,calendar,intervalMs,windows,asOf}=request,at=utcMillis(asOf);
  requireValue(instrument?.id && instrument.active===true && ['offline-fixture','historical'].includes(request.mode),'Invalid study identity/mode.');
  requireValue(Number.isInteger(intervalMs) && intervalMs>=60000 && intervalMs<=86400000,'Invalid study interval.');
  requireValue(Array.isArray(eventRows) && eventRows.length<=2000 && Array.isArray(barRows) && barRows.length<=20000,'Study row limit exceeded.');
  requireValue(Array.isArray(windows) && windows.length>=1 && windows.length<=5,'Study window limit exceeded.');
  requireValue(windows.every(w=>[w.beforeMs,w.afterMs].every(x=>Number.isInteger(x) && x>=intervalMs && x<=86400000) && (w.beforeMs+w.afterMs)/intervalMs<=2000),'Invalid bounded event window.');
  const latency=request.maxObservationLagMs ?? 0;
  requireValue(Number.isInteger(latency) && latency>=0 && latency<=3600000,'Invalid historical observation lag.');
  const minimum=request.minimumSample ?? 5;
  requireValue(Number.isInteger(minimum) && minimum>=2 && minimum<=250,'Invalid sample threshold.');
  requireValue(Array.isArray(request.families) && request.families.length>0 && request.families.every(x=>EVENT_FAMILIES.includes(x)),'Explicit event families required.');
  requireValue(calendar?.reference && Array.isArray(calendar.windows) && calendar.windows.length<=400,'Explicit study calendar required.');
  const sessions=calendar.windows.map(w=>({start:utcMillis(w.start),end:utcMillis(w.end)})).sort((a,b)=>a.start-b.start);
  requireValue(sessions.every((w,i)=>w.start<w.end && (!i || sessions[i-1].end<=w.start)),'Invalid study sessions.');
  const openAt=(t,length=intervalMs)=>{
    let lo=0,hi=sessions.length-1,found=-1;
    while(lo<=hi){const m=(lo+hi)>>1;if(sessions[m].start<=t){found=m;lo=m+1;}else hi=m-1;}
    return found>=0 && t+length<=sessions[found].end;
  };
  const exclude=[],eventGroups=new Map(),selected=[];
  for(const row of eventRows) {
    abort(signal);const e=row.body;
    if(e?.kind!=='macro'){exclude.push({eventId:e?.eventId ?? null,reason:'NOT_AN_ACTUAL_MACRO_RELEASE'});continue;}
    if(!request.families.includes(eventFamily(e)))continue;
    if(!e.affectedMarkets?.some(x=>x.instrumentId===instrument.id)){exclude.push({eventId:e.eventId,reason:'INSTRUMENT_NOT_MAPPED'});continue;}
    if(!e.published?.at || e.published.precision!=='INSTANT'){exclude.push({eventId:e.eventId,reason:'PUBLICATION_TIME_NOT_PRECISE'});continue;}
    let known;
    try {known=effectiveKnown(row);}catch{exclude.push({eventId:e.eventId,reason:'KNOWLEDGE_TIME_MISSING'});continue;}
    if(known>at)continue;
    if(!eventGroups.has(e.eventId))eventGroups.set(e.eventId,[]);
    eventGroups.get(e.eventId).push({row,known});
  }
  requireValue(eventGroups.size<=250,'Historical event count limit exceeded.');
  let ignoredRevisions=0;
  for(const [id,versions] of eventGroups) {
    const originals=versions.filter(x=>x.row.body.revised?.precision==='UNKNOWN' && !x.row.body.revisionOf && x.row.body.status!=='CANCELLED');
    ignoredRevisions+=versions.length-originals.length;
    originals.sort((a,b)=>a.known-b.known || Number(a.row.sequence ?? 0)-Number(b.row.sequence ?? 0));
    const first=originals[0];
    if(!first){exclude.push({eventId:id,reason:'ORIGINAL_VINTAGE_UNAVAILABLE'});continue;}
    const publication=utcMillis(first.row.body.published.at);
    if(first.known<publication || first.known>publication+latency){exclude.push({eventId:id,reason:'ORIGINAL_NOT_KNOWN_NEAR_RELEASE'});continue;}
    selected.push({...first,publication});
  }
  requireValue(selected.length*windows.reduce((n,w)=>n+Math.ceil((w.beforeMs+w.afterMs)/intervalMs),0)<=200000,'Study computation budget exceeded.');
  // Keep all vintages; choose earliest version available near its own bar close.
  const bars=new Map();
  for(const row of barRows) {
    const body=row.body;
    if(body?.instrumentId!==instrument.id || body.intervalMs!==intervalMs)continue;
    const bar=body.bar,time=utcMillis(bar.time),end=time+intervalMs;
    let known;try {known=effectiveKnown(row);}catch{continue;}
    if(known>at || known<end || known>end+latency)continue;
    requireValue(['open','high','low','close'].every(k=>finite(bar[k])),'Invalid study OHLC.');
    requireValue(request.priceDomain==='signed' && instrument.group==='energy' || Math.min(bar.open,bar.high,bar.low,bar.close)>0,'Invalid study price domain.');
    const old=bars.get(time);
    if(!old || known<old.known || known===old.known && Number(row.sequence ?? 0)<Number(old.row.sequence ?? 0))bars.set(time,{bar,known,row});
  }
  const ordered=[...bars.entries()].sort(([a],[b])=>a-b),observations=[];
  for(let index=0;index<selected.length;index++) {
    if(index%8===0){await yieldEventLoop();abort(signal);}
    const {row,publication,known}=selected[index],e=row.body;
    for(const window of windows) {
      abort(signal);const start=Math.floor((publication-window.beforeMs)/intervalMs)*intervalMs;
      const end=Math.floor((publication+window.afterMs)/intervalMs)*intervalMs;
      const anchorEnd=Math.floor(publication/intervalMs)*intervalMs,anchor=bars.get(anchorEnd-intervalMs);
      const reject=reason=>exclude.push({eventId:e.eventId,window,reason});
      if(end>at){reject('POST_WINDOW_NOT_YET_AVAILABLE');continue;}
      if(utcMillis(calendar.from)>start || utcMillis(calendar.to)<end){reject('CALENDAR_COVERAGE_UNKNOWN');continue;}
      const expectedOpen=iso=>openAt(utcMillis(iso));
      if(!anchor || !expectedOpen(anchor.bar.time) || !openAt(publication,1)){reject('NO_FRESH_PRE_EVENT_MARKET_ANCHOR');continue;}
      if(anchor.known>known){reject('PRE_ANCHOR_NOT_KNOWN_AT_RELEASE_OBSERVATION');continue;}
      const slice=ordered.filter(([t])=>t>=start && t<end).map(([,r])=>r.bar);
      let quality;
      try {quality=assessBars({bars:slice,from:new Date(start).toISOString(),to:new Date(end).toISOString(),observedAt:asOf,
        intervalMs,maxAgeMs:86400000,isExpectedOpen:expectedOpen,delayMs:0});}
      catch {reject('INVALID_OHLC_OR_INTERVAL');continue;}
      if(!quality.coverage.complete){reject('EVENT_WINDOW_GAPS_OR_UNVERIFIED_VINTAGES');continue;}
      const before=slice.filter(b=>utcMillis(b.time)+intervalMs<=publication);
      const after=slice.filter(b=>utcMillis(b.time)>=publication);
      const last=slice.find(b=>utcMillis(b.time)+intervalMs===end);
      if(!before.length || !after.length || !last){reject('INSUFFICIENT_CLOSED_EVENT_BARS');continue;}
      const base=anchor.bar.close,change=last.close-base,returns=[];let previous=base;
      for(const bar of after){if(previous>0)returns.push((bar.close-previous)/previous);previous=bar.close;}
      const actual=finite(e.values?.actual)?e.values.actual:null;
      let expected=null;
      if(finite(e.values?.expected) && e.expectation?.asOf && ['compiled_consensus','forecaster_survey'].includes(e.expectation.class) && e.expectation.sourceURL && utcMillis(e.expectation.asOf)<publication)expected=e.values.expected;
      observations.push({eventId:e.eventId,versionId:e.versionId,family:eventFamily(e),seriesId:e.seriesId,unit:e.unit,
        publicationAt:e.published.at,originalZone:e.sourceTimezone,informationKnownAt:new Date(known).toISOString(),window,
        preAnchorAt:new Date(anchorEnd).toISOString(),postAnchorAt:new Date(end).toISOString(),timestampResolutionMs:intervalMs,
        preAnchorKnownAt:new Date(anchor.known).toISOString(),postAnchorKnownAt:new Date(bars.get(end-intervalMs).known).toISOString(),
        mixedPublicationBarExcluded:publication%intervalMs!==0,actual,expected,surprise:actual!==null && expected!==null?actual-expected:null,
        consensusUnavailableReason:expected===null?'NO_VERIFIED_PRE_RELEASE_CONSENSUS':null,
        beforeChange:base-before[0].close,afterChange:change,afterPercent:base>0?change/base*100:null,
        maximumUp:Math.max(0,Math.max(...after.map(b=>b.high))-base),maximumDown:Math.min(0,Math.min(...after.map(b=>b.low))-base),
        closeReturnVolatility:stats(returns)?.sampleStd ?? null,barCount:after.length,
        interpretation:'OBSERVED_ASSOCIATION_NOT_CAUSATION'});
      requireValue(observations.length<=500,'Study observation capacity exceeded.');
    }
  }
  const groups=new Map();
  for(const o of observations) {
    const key=JSON.stringify([o.family,o.seriesId,o.unit,o.window]);
    if(!groups.has(key))groups.set(key,[]);groups.get(key).push(o);
  }
  const summaries=[...groups.values()].map(rows=>({family:rows[0].family,seriesId:rows[0].seriesId,unit:rows[0].unit,window:rows[0].window,
    sampleSize:rows.length,smallSample:rows.length<minimum,priceChange:stats(rows.map(r=>r.afterChange)),
    percentChange:stats(rows.map(r=>r.afterPercent).filter(finite)),surprise:stats(rows.map(r=>r.surprise).filter(finite)),
    maxObservedUp:Math.max(...rows.map(r=>r.maximumUp)),maxObservedDown:Math.min(...rows.map(r=>r.maximumDown)),
    distribution:rows.map(r=>({eventId:r.eventId,change:r.afterChange,percent:r.afterPercent})),
    predictiveInferenceAvailable:false}));
  return {schemaVersion:'phase6.v1',category:'HISTORICAL_EVENT_STUDY',mode:instrument.provenance?.mode==='offline-fixture' || eventRows.some(r=>r.body?.mode==='offline-fixture') || barRows.some(r=>r.body?.provenance?.mode==='offline-fixture')?'offline-fixture':request.mode,instrumentId:instrument.id,asOf,
    inputHash:digest(request),observations,summaries,excluded:exclude,ignoredRevisionCount:ignoredRevisions,
    sampleSize:new Set(observations.map(o=>o.eventId)).size,smallSample:new Set(observations.map(o=>o.eventId)).size<minimum,
    assumptions:{pointInTime:'LOCAL_INGESTION_AND_ORIGINAL_VINTAGE_GATED',maxObservationLagMs:latency,
      overlappingEventWindowsMayBeDependent:true,confidenceIntervalsAvailable:false,publicReleaseIndependentlyVerified:false,scheduledTimeUsedAsRelease:false,causalityProven:false,forecastGuaranteed:false}};
}
