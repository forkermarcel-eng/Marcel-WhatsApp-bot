import {requireValue,utcMillis} from './instruments.js';
import {digest} from './news/events.js';
import {createAnalysisWorker} from './worker.js';
import {loadAnalysisRequest} from './analysis-service.js';
import {analyzeEventStudy} from './event-study.js';
import {ms} from './storage.js';

export async function readAnalysisRows(repository,{sourceId,kind,asOf,latest=false,maxRows=10000,signal}={}) {
  requireValue(Number.isInteger(maxRows) && maxRows>=1 && maxRows<=20000,'Invalid bounded source read.');
  const items=[];let cursor=null;
  do {
    if(signal?.aborted)throw Object.assign(new Error('ABORTED'),{code:'ABORTED'});
    const page=await repository.read({sourceId,kind,asOf,latest,cursor,limit:Math.min(500,maxRows-items.length+1)});
    items.push(...page.items);requireValue(items.length<=maxRows,'Source read budget exceeded.');cursor=page.hasMore?page.nextCursor:null;
  }while(cursor);
  return items;
}
export async function loadEventStudyRequest({repository,eventSources,barSource,request,signal}={}) {
  requireValue(Array.isArray(eventSources) && eventSources.length>=1 && eventSources.length<=10 && new Set(eventSources).size===eventSources.length,'Invalid event source list.');
  const eventRows=[];
  for(const sourceId of eventSources) {
    eventRows.push(...await readAnalysisRows(repository,{sourceId,kind:'macro',asOf:request.asOf,maxRows:2000,signal}));
    requireValue(eventRows.length<=2000,'Total event source budget exceeded.');
  }
  const instruments=await repository.read({sourceId:barSource,kind:'instrument',entityId:request.instrumentId,asOf:request.asOf,latest:true});
  requireValue(instruments.items.length===1,'Study instrument not found.');
  const barRows=await readAnalysisRows(repository,{sourceId:barSource,kind:'bar',asOf:request.asOf,maxRows:20000,signal});
  const hasFixture=eventRows.some(r=>r.body.mode==='offline-fixture') || barRows.some(r=>r.body.provenance?.mode==='offline-fixture') || instruments.items[0].body.provenance?.mode==='offline-fixture';
  return {...request,instrument:instruments.items[0].body,eventRows,barRows,mode:hasFixture?'offline-fixture':'historical'};
}
export async function loadAlertSnapshot({repository,scanner,options,authorization,signal}={}) {
  const input=await loadAnalysisRequest({...options,repository,signal});
  const last=input.bars.toSorted((a,b)=>utcMillis(a.time)-utcMillis(b.time)).at(-1);
  requireValue(last,'No closed alert bar.');
  const stored=await repository.read({sourceId:options.sourceId,kind:'bar',asOf:options.asOf,latest:true,
    entityId:JSON.stringify([input.instrument.id,input.intervalMs,last.time])});
  requireValue(stored.items.length===1,'Alert observation provenance missing.');
  const row=stored.items[0],status=await repository.sourceStatus(options.sourceId,{now:options.asOf,maxAgeMs:options.maxAgeMs});
  const dataAt=new Date(utcMillis(last.time)+input.intervalMs).toISOString();
  const result=scanner?await scanner.analyze([{...input,asOf:dataAt,to:dataAt}],{signal}):null;
  if(result)requireValue(result[0].ok,'Scanner alert preparation failed.');
  const provenance=row.body.provenance;
  return {instrument:input.instrument,price:last.close,priceBasis:row.body.quality.priceBasis,priceDomain:input.priceDomain,
    dataAt,receivedAt:new Date(ms(row.fetched_at)).toISOString(),delayMs:input.delayMs,calendar:input.calendar,
    mode:input.mode==='offline-fixture'?'offline-fixture':authorization && provenance?.mode==='network'?'authorised-cache':'historical',
    authorization,sourceError:status.stale?status.error_code ?? 'SOURCE_STALE_OR_PARTIAL':null,scanner:result?.[0].result};
}
export async function loadEconomicSnapshot({repository,instrument,sourceIds,asOf,authorization,signal}={}) {
  requireValue(Array.isArray(sourceIds) && sourceIds.length>=1 && sourceIds.length<=10 && new Set(sourceIds).size===sourceIds.length,'Invalid calendar source list.');
  const events=[];let received=0,sourceError=null,fixture=true;
  for(const sourceId of sourceIds) {
    const status=await repository.sourceStatus(sourceId,{now:asOf,maxAgeMs:86400000});
    if(!status.last_success_at || status.stale)sourceError='CALENDAR_SOURCE_UNAVAILABLE';
    // Oldest source check controls the freshness of a combined calendar snapshot.
    const checked=status.last_success_at?ms(status.last_success_at):0;
    received=received===0?checked:Math.min(received,checked);
    const rows=await readAnalysisRows(repository,{sourceId,kind:'calendar',asOf,latest:true,maxRows:250,signal});
    events.push(...rows);requireValue(events.length<=250,'Combined calendar budget exceeded.');
    fixture=fixture && status.state?.mode==='offline-fixture' && rows.every(r=>r.body.mode==='offline-fixture');
  }
  return {instrument,events,sourceError,mode:fixture?'offline-fixture':authorization?'authorised-cache':'historical',authorization,
    dataAt:new Date(received).toISOString(),receivedAt:new Date(received).toISOString()};
}

// Existing Phase-3 worker + exact claim filter. Commit through the alert repository
// so state/history/study AND job success are one fenced transaction.
export function createPhase6Task({jobs,alerts,request,clock=Date.now,timeoutMs=15000,api=null,jobId=null}={}) {
  requireValue(['alerts','event-study'].includes(request?.operation) && alerts.ownerId,'Invalid phase6 task.');
  const input=structuredClone(request),sourceId='analysis-local:phase6',key=digest(['phase6.v1',alerts.ownerId,input,request.operation==='alerts'?Math.floor(clock()/60000):null]);
  let id=jobId,result=null,running=false;
  const handler=async ({signal})=>{
    if(signal.aborted)throw Object.assign(new Error('ABORTED'),{code:'ABORTED'});
    return input.operation==='event-study'?{study:await analyzeEventStudy(input.study,{signal}),signal}:{ruleIds:input.ruleIds,snapshot:input.snapshot,signal};
  };
  const facade={async commitBatch(batch,{job}) {
    result=batch.study?await alerts.saveStudy(batch.study,{job,signal:batch.signal}):await alerts.check(batch.ruleIds,batch.snapshot,{job,signal:batch.signal});
  }};
  const scopedJobs={...jobs,claim:()=>{requireValue(id,'Enqueue phase6 task first.');return jobs.claim({jobId:id});}};
  const worker=createAnalysisWorker({jobs:scopedJobs,repository:facade,handlers:new Map([[sourceId+':source-check',handler]]),timeoutMs});
  return Object.freeze({
    async enqueue() {
      const queued=await jobs.enqueue({sourceId,type:'source-check',idempotencyKey:key,maxAttempts:1,api,
        policy:{sourceId,type:'source-check',intervalMs:60000,mode:'offline-fixture'}});id=queued.id;return queued;
    },
    async runOne(options={}) {
      if(running)return {status:'busy'};running=true;result=null;
      try {const status=await worker.runOne(options);return {...status,...(status.status==='succeeded'?{result:structuredClone(result)}:{})};}
      finally {running=false;result=null;}
    },
  });
}
