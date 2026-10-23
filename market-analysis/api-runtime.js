import {randomUUID,createHash} from 'node:crypto';
import {createAnalysisRepository} from './repository.js';
import {createAnalysisJobs} from './jobs.js';
import {createAlertRepository} from './alert-repository.js';
import {createLocalScanner} from './scanner.js';
import {loadAnalysisRequest,createLocalAnalysisTask} from './analysis-service.js';
import {loadSimulationRequest,createSimulationTask} from './simulation-service.js';
import {loadEventStudyRequest,loadAlertSnapshot,loadEconomicSnapshot,createPhase6Task,readAnalysisRows} from './phase6-service.js';
import {utcMillis} from './instruments.js';
import {ms} from './storage.js';

export const apiError=(code,status=400)=>Object.assign(new Error(code),{code,status});
const need=(v,code='INVALID_INPUT')=>{if(!v)throw apiError(code);};
const text=(v,max=700)=>{need(typeof v==='string'&&v.length>0&&v.length<=max);return v;};
const integer=(v,min,max)=>{need(Number.isInteger(v)&&v>=min&&v<=max);return v;};
// No environment access, transport, schema installation or background loop.
export function createMarketAnalysisRuntime({database,clock=Date.now,pythonPath,scanner:injectedScanner,allowFixtures=false,calendars=new Map(),specifications=new Map(),authorizations=new Map()}={}) {
 const repository=createAnalysisRepository({database,clock}),jobs=createAnalysisJobs({database,clock});
 const scanner=injectedScanner ?? (pythonPath?createLocalScanner({pythonPath,timeoutMs:10000}):null);
 let busy=false,preparing=false;
 const now=()=>new Date(clock()).toISOString();
 const owned=owner=>createAlertRepository({database,ownerId:owner,clock,allowFixtures});
 async function catalog(q='',group='all') {
  need(typeof q==='string'&&q.length<=100);need(['all','forex','metals','indices','energy','commodities','cfd'].includes(group));
  const sources=(await database.query("SELECT DISTINCT source_id FROM marcel_market_analysis.records WHERE kind='instrument' AND stored_at<=$1 ORDER BY source_id LIMIT 21",[now()])).rows;
  need(sources.length<=20,'CATALOG_SOURCE_LIMIT');const items=[];
  for(const {source_id:sourceId} of sources) {
   const rows=await readAnalysisRows(repository,{sourceId,kind:'instrument',asOf:now(),latest:true,maxRows:1000});
   const health=await repository.sourceStatus(sourceId,{now:now(),maxAgeMs:60000});
   const quote=await database.query("SELECT DISTINCT ON (body->>'instrumentId') body,fetched_at,stored_at FROM marcel_market_analysis.records WHERE source_id=$1 AND kind='bar' AND stored_at<=$2 ORDER BY body->>'instrumentId', ((body->'bar'->>'time')::timestamptz + (body->>'intervalMs')::double precision * interval '1 millisecond') DESC,stored_at DESC,sequence DESC LIMIT 251",[sourceId,now()]);
   need(quote.rows.length<=250,'CATALOG_LIMIT');
   for(const row of rows) {
    const i=row.body;if(!i.active || group!=='all'&&(group==='cfd'?i.kind!=='cfd':i.group!==group) || !(i.symbol+' '+i.name+' '+i.id).toLowerCase().includes(q.toLowerCase()))continue;
    const last=quote.rows.find(x=>x.body.instrumentId===i.id);
    const fixture=i.provenance?.mode==='offline-fixture'||last?.body.provenance?.mode==='offline-fixture';
    const delay=last?.body.quality?.delayMs ?? null,sourceAt=last?new Date(Date.parse(last.body.bar.time)+last.body.intervalMs).toISOString():null;
    const granted=authorizations.get(i.id),authorized=granted?.verified===true&&granted.instrumentId===i.id&&granted.usage==='internal-analysis'&&granted.reference&&ms(granted.checkedAt)<=clock()&&ms(granted.expiresAt)>clock();
    const current=calendars.get(i.id)?.windows.some(w=>ms(w.start)<=clock()&&clock()<ms(w.end))&&last&&last.body.provenance?.mode==='network'&&delay===0&&!health.stale&&clock()-Date.parse(sourceAt)<=60000&&clock()>=Date.parse(sourceAt)&&authorized;
    items.push({instrument:i,sourceId,sourceAt,receivedAt:last?.fetched_at ?? null,delayMs:delay,last:last?.body.bar.close ?? null,
     dataState:fixture?'offline-fixture':!authorized?'unauthorized':!last?'missing':health.error_code?'error':current?'current':last&&delay>0&&!health.stale&&clock()-ms(sourceAt)<=delay+60000?'delayed':'historical',
     marketStatus:calendars.get(i.id)?.windows.some(w=>ms(w.start)<=clock()&&clock()<ms(w.end))?'open':'unknown',contractAvailable:specifications.has(i.id),sourceError:health.error_code ?? null});
    need(items.length<=250,'CATALOG_LIMIT');
   }
  }
  return {items,at:now(),pythonAvailable:!!scanner,fixtureEnabled:allowFixtures};
 }
 async function selected(sourceId,instrumentId) {
  text(sourceId);text(instrumentId);const result=await repository.read({sourceId,kind:'instrument',entityId:instrumentId,latest:true,asOf:now()});
  need(result.items.length===1,'INSTRUMENT_NOT_FOUND');return result.items[0].body;
 }
 async function context(body,signal) {
  const instrument=await selected(body.sourceId,body.instrumentId),from=text(body.from,40),to=text(body.to,40);
  const start=utcMillis(from),end=utcMillis(to);const eventStudy=body.operation==='event-study';need(start<end&&end<=clock()&&end-start<=(eventStudy?3660:31)*86400000,'INVALID_WINDOW');
  const intervalMs=integer(typeof body.intervalMs==='string'&&/^\d+$/.test(body.intervalMs)?Number(body.intervalMs):body.intervalMs ?? 60000,60000,86400000);need(eventStudy||(end-start)/intervalMs<=10000,'WINDOW_LIMIT');
  const calendar=calendars.get(instrument.id);if(!calendar)throw apiError('SESSION_CALENDAR_NOT_CONFIGURED',409);
  const cached=await database.query("SELECT body FROM marcel_market_analysis.records WHERE source_id=$1 AND kind='bar' AND stored_at<=$2 AND body->>'instrumentId'=$3 AND (body->>'intervalMs')::integer=$4 AND (body->'bar'->>'time')::timestamptz>=$5 AND (body->'bar'->>'time')::timestamptz<$6 ORDER BY (body->'bar'->>'time')::timestamptz DESC,stored_at DESC,sequence DESC LIMIT 1",[body.sourceId,now(),instrument.id,intervalMs,from,to]);
  const latest=cached.rows[0];
  const delayMs=latest?.body.quality?.delayMs ?? null;
  return {repository,sourceId:body.sourceId,instrumentId:instrument.id,from,to,asOf:now(),intervalMs,calendar,maxAgeMs:60000,
   delayMs,maxReadRows:20000,signal};
 }
 async function fundamentals(instrumentId) {
  text(instrumentId);const sources=(await database.query("SELECT DISTINCT source_id FROM marcel_market_analysis.records WHERE kind IN ('news','macro','calendar') ORDER BY source_id LIMIT 11")).rows;
  need(sources.length<=10,'EVENT_SOURCE_LIMIT');const items=[];
  for(const {source_id:sourceId} of sources)for(const kind of ['news','macro','calendar']) {
   const rows=await repository.read({sourceId,kind,asOf:now(),latest:true,limit:100});
   for(const row of rows.items)if(row.body.affectedMarkets?.some(m=>m.instrumentId===instrumentId)&&(!row.body.expiresAt||ms(row.body.expiresAt)>clock()))items.push({...row.body,knownAt:row.stored_at});
  }
  need(items.length<=300,'EVENT_RESULT_LIMIT');return {items,sources:sources.map(x=>x.source_id),at:now()};
 }
 async function prepare(owner,body,signal) {
  need(body&&typeof body==='object'&&!Array.isArray(body));
  const allowed=new Set(['operation','sourceId','instrumentId','from','to','intervalMs','delayMs','side','entry','stop','target','paths','horizonBars','seed','quantity','accountCurrency','equity','holdingDays','riskBudget','method','trainingEnd','evaluationStart','parametersKnownAt','setupRule','eventId','family','beforeMs','afterMs','maxObservationLagMs','ruleIds']);
  need(Object.keys(body).every(k=>allowed.has(k)),'UNTRUSTED_FIELDS');
  need(['scan','time-machine','historical-setups','risk','event-study','alert-check'].includes(body.operation),'INVALID_OPERATION');
  if(!['event-study','alert-check'].includes(body.operation)&&!scanner)throw apiError('PYTHON_NOT_CONFIGURED',503);
  const ctx=await context(body,signal),instrument=await selected(body.sourceId,body.instrumentId),hash=createHash('sha256').update(owner).digest('hex'),source='analysis-local:p7_'+hash;
  let task,weight=0,presentation=null,envelope;
  if(body.operation==='event-study') {
   const data=await fundamentals(instrument.id);need(data.sources.length,'EVENTS_UNAVAILABLE');
   const families=[text(body.family,30)],request={instrumentId:instrument.id,asOf:now(),intervalMs:ctx.intervalMs,calendar:ctx.calendar,families,
    windows:[{beforeMs:integer(body.beforeMs,60000,86400000),afterMs:integer(body.afterMs,60000,86400000)}],maxObservationLagMs:integer(body.maxObservationLagMs ?? 0,0,3600000)};
   const input=await loadEventStudyRequest({repository,eventSources:data.sources,barSource:body.sourceId,request,signal});
   if(body.eventId)input.eventRows=input.eventRows.filter(r=>r.body.eventId===body.eventId);
   input.eventRows=input.eventRows.filter(r=>r.body.published?.at&&ms(r.body.published.at)>=ms(ctx.from)&&ms(r.body.published.at)<=ms(ctx.to));
   if(input.mode==='offline-fixture'&&!allowFixtures)throw apiError('FIXTURE_INPUT_DISABLED',409);weight=Buffer.byteLength(JSON.stringify(input));envelope={v:1,owner,operation:body.operation,kind:'phase6',payload:{operation:'event-study',study:input}};task=createPhase6Task({jobs,alerts:owned(owner),request:envelope.payload,api:envelope,clock});
  } else if(body.operation==='alert-check') {
   need(Array.isArray(body.ruleIds)&&body.ruleIds.length>0&&body.ruleIds.length<=25,'INVALID_RULES');
   const rules=(await owned(owner).list({limit:500})).items.filter(r=>body.ruleIds.includes(r.id));need(rules.length===body.ruleIds.length&&rules.every(r=>r.body.instrumentId===instrument.id),'ALERT_NOT_OWNED');
   need(rules.every(r=>r.body.type==='ECONOMIC_EVENT')||rules.every(r=>r.body.type!=='ECONOMIC_EVENT'),'SPLIT_CALENDAR_AND_PRICE_BATCH');
   const snapshot=rules.every(r=>r.body.type==='ECONOMIC_EVENT')?await loadEconomicSnapshot({repository,instrument,sourceIds:(await fundamentals(instrument.id)).sources,asOf:now(),authorization:authorizations.get(instrument.id),signal}):await loadAlertSnapshot({repository,scanner,options:ctx,authorization:authorizations.get(instrument.id),signal});
   if(snapshot.mode==='offline-fixture'&&!allowFixtures)throw apiError('FIXTURE_INPUT_DISABLED',409);weight=Buffer.byteLength(JSON.stringify(snapshot));envelope={v:1,owner,operation:body.operation,kind:'phase6',payload:{operation:'alerts',ruleIds:body.ruleIds,snapshot}};task=createPhase6Task({jobs,alerts:owned(owner),request:envelope.payload,api:envelope,clock});
  } else {
   const plan={side:body.side ?? 'LONG',entry:body.entry,stop:body.stop,target:body.target};need(['LONG','SHORT'].includes(plan.side),'INVALID_SIDE');
   if(body.operation!=='scan')need([plan.entry,plan.stop,plan.target].every(x=>x!==''&&Number.isFinite(Number(x))),'INVALID_PLAN');
   const spec=specifications.get(instrument.id) ?? {};
   const pick=(object,keys)=>object?Object.fromEntries(keys.filter(k=>k in object).map(k=>[k,object[k]])):null;
   presentation={side:plan.side,contract:pick(spec.contract,['broker','reference','asOf','validUntil','kind','quoteCurrency','unitsPerQuantity','tickSize','pipSize','quantityStep','minQuantity']),costs:pick(spec.costs,['currency','reference','asOf','validUntil','spreadPrice','entrySlippagePrice','exitSlippagePrice','commissionPerQuantityRoundTrip','commissionFlatRoundTrip','fundingPerQuantityPerDay'])};
   const common={...ctx,plan,trainingEnd:body.trainingEnd ?? ctx.to,paths:integer(body.paths ?? 1000,1,10000),horizonBars:integer(body.horizonBars ?? 60,1,240),seed:integer(body.seed ?? 19,0,2147483647),
    method:body.method ?? 'block-delta',quantity:body.quantity,accountCurrency:body.accountCurrency,equity:body.equity,holdingDays:body.holdingDays ?? '0',...spec,allowSmallFixtureSample:allowFixtures};
   let input;
   if(body.operation==='time-machine')input={...await loadSimulationRequest(common),equity:body.equity,holdingDays:body.holdingDays ?? '0'};
   else {input={...await loadAnalysisRequest(ctx),...spec,operation:body.operation==='scan'?'analyze':body.operation,plan,quantity:body.quantity,accountCurrency:body.accountCurrency,equity:body.equity,holdingDays:body.holdingDays ?? '0',riskBudget:body.riskBudget};
    if(body.operation==='scan')input.exit=body.entry!==undefined?{side:plan.side,entry:plan.entry,stop:{kind:'price',value:plan.stop},target:{kind:'price',value:plan.target}}:undefined;
    if(body.operation==='scan'&&body.entry!==undefined)input.entry={setup:'level',side:plan.side,level:Number(plan.entry),levelKnownAt:ctx.asOf,sessionId:ctx.calendar.windows[0]?.id};
    if(body.operation==='historical-setups') {
     input.trainingEnd=text(body.trainingEnd,40);input.evaluationStart=text(body.evaluationStart,40);input.parametersKnownAt=text(body.parametersKnownAt,40);input.horizonBars=common.horizonBars;input.setup={side:plan.side,rule:text(body.setupRule,60)};input.exitTemplate={stop:{kind:'price',value:plan.stop},target:{kind:'price',value:plan.target}};
     const rows=await readAnalysisRows(repository,{sourceId:ctx.sourceId,kind:'bar',asOf:ctx.asOf,maxRows:20000,signal});
     input.bars=input.bars.map(b=>{const candidates=rows.filter(r=>r.body.instrumentId===instrument.id&&r.body.intervalMs===ctx.intervalMs&&r.body.bar.time===b.time).map(r=>({r,known:Math.max(ms(r.stored_at),ms(r.fetched_at),ms(r.processed_at))})).filter(x=>x.known<=ms(b.time)+ctx.intervalMs).sort((a,b)=>a.known-b.known);if(candidates[0]?.r.body.provenance?.mode==='offline-fixture'){input.mode='offline-fixture';input.qualityReasons=[...new Set([...input.qualityReasons,'OFFLINE_FIXTURE'])];}return candidates.length?{...candidates[0].r.body.bar,knownAt:new Date(candidates[0].known).toISOString()}:b;});
    }
   }
   if(input.mode==='offline-fixture'&&!allowFixtures)throw apiError('FIXTURE_INPUT_DISABLED',409);weight=Buffer.byteLength(JSON.stringify(input));envelope={v:1,owner,operation:body.operation,kind:'scanner',payload:[input],sourceId:source,presentation};task=createLocalAnalysisTask({jobs,repository,scanner,requests:envelope.payload,sourceId:source,api:envelope,clock});
  }
  need(weight<=8000000,'LOCAL_JOB_LIMIT');const queued=await task.enqueue();return queued.id;
 }
 const get=async(owner,id)=>{text(owner,700);if(typeof id!=='string'||!(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(id))throw apiError('JOB_NOT_FOUND',404);const row=await jobs.get(id);if(!row?.api||row.api.owner!==owner)throw apiError('JOB_NOT_FOUND',404);return row;};
 return Object.freeze({catalog,fundamentals,
  async series(body){const ctx=await context(body);const input=await loadAnalysisRequest(ctx);return {bars:input.bars,mode:input.mode,quality:input.qualityReasons,asOf:input.asOf};},
  async alerts(owner,op,body={}) {const store=owned(owner);
   if(op==='list')return store.list({limit:100});
   if(op==='create'){need(body.rule&&!body.rule.ownerId,'UNTRUSTED_FIELDS');await selected(body.sourceId,body.rule.instrumentId);return store.create(body.rule);}
   if(op==='history')return store.history(text(body.id,50),{limit:50,before:body.before ?? null});
   if(op==='reset')return store.reset(text(body.id,50),{expectedVersion:integer(body.version,1,1000000)});
   if(op==='toggle'){need(typeof body.enabled==='boolean');return store.update(text(body.id,50),{enabled:body.enabled},{expectedVersion:integer(body.version,1,1000000)});}
   throw apiError('INVALID_OPERATION');
  },
  async createJob(owner,body,signal){if(preparing)throw apiError('ANALYSIS_BUSY',409);preparing=true;try{return {id:await prepare(owner,body,signal)};}finally{preparing=false;}},
  async job(owner,id){const row=await get(owner,id);return {id:row.id,operation:row.api.operation,status:row.status,error:row.error_code,result:row.api.result ?? null};},
  async run(owner,id) {
   const row=await get(owner,id);if(['succeeded','failed','cancelled','blocked'].includes(row.status))return this.job(owner,id);
   if(busy)throw apiError('ANALYSIS_BUSY',409);busy=true;
   const controller=new AbortController();let poll;
   try {
    const api=row.api;
    if(api.kind==='scanner'&&!scanner)throw apiError('PYTHON_NOT_CONFIGURED',503);
    const fixture=api.kind==='scanner'?api.payload.some(r=>r.mode==='offline-fixture'):(api.payload.study ?? api.payload.snapshot)?.mode==='offline-fixture';
    if(fixture&&!allowFixtures)throw apiError('FIXTURE_INPUT_DISABLED',409);
    const task=api.kind==='scanner'?createLocalAnalysisTask({jobs,repository,scanner,requests:api.payload,sourceId:row.source_id,clock,api,jobId:row.id}):createPhase6Task({jobs,alerts:owned(owner),request:api.payload,clock,api,jobId:row.id});
    // A cancellation on another process also stops local computation promptly.
    poll=setInterval(()=>{jobs.get(row.id).then(j=>{if(j?.status==='cancelled')controller.abort();}).catch(()=>controller.abort());},100);
    await task.runOne({signal:controller.signal});return this.job(owner,id);
   }finally{clearInterval(poll);busy=false;}
  },
  async cancel(owner,id){await get(owner,id);await jobs.cancel(id);return this.job(owner,id);},
 });
}
