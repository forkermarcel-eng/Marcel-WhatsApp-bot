import {requireValue,utcMillis,normalizeInstrument} from './instruments.js';
import {assessBars} from './quality.js';
import {assessStoredRecord} from './freshness.js';
import {digest} from './news/events.js';
import {createAnalysisWorker} from './worker.js';

// Read only through Phase-3 repository. Does not fetch, modify bars or bypass rights.
export async function loadAnalysisRequest({repository,sourceId,instrumentId,from,to,asOf,intervalMs,calendar,
  maxAgeMs,delayMs = null,rules,entry,exit,priceDomain = 'positive',maxReadRows = 10000,signal} = {}) {
  const start=utcMillis(from),end=utcMillis(to);utcMillis(asOf);
  requireValue(Number.isInteger(maxReadRows) && maxReadRows>=1 && maxReadRows<=100000,'Invalid repository read budget.');
  requireValue(utcMillis(calendar.from)<=start && utcMillis(calendar.to)>=end,'Calendar coverage required.');
  const records=await repository.read({sourceId,kind:'instrument',entityId:instrumentId,latest:true,asOf});
  requireValue(records.items.length===1,'Stored instrument missing.');
  const instrument=normalizeInstrument(records.items[0].body);
  requireValue(instrument.id===instrumentId,'Instrument mapping mismatch.');
  let cursor=null,count=0;const rows=[];
  do {
    if(signal?.aborted) throw Object.assign(new Error(),{code:'ABORTED'});
    const page=await repository.read({sourceId,kind:'bar',latest:true,asOf,limit:Math.min(500,maxReadRows-count+1),cursor});
    count+=page.items.length;requireValue(count<=maxReadRows,'Repository scan budget exceeded.');
    for(const row of page.items) {
      const body=row.body;
      if(body.instrumentId===instrumentId && body.intervalMs===intervalMs && utcMillis(body.bar.time)>=start && utcMillis(body.bar.time)<end) rows.push(row);
    }
    cursor=page.hasMore?page.nextCursor:null;
  } while(cursor);
  const isExpectedOpen=at=>calendar.windows.some(w=>utcMillis(w.start)<=utcMillis(at) && utcMillis(at)+intervalMs<=utcMillis(w.end));
  const quality=assessBars({bars:rows.map(r=>r.body.bar),from,to,observedAt:asOf,intervalMs,delayMs,maxAgeMs,isExpectedOpen});
  const reasons=new Set(quality.reasons);
  const newest=rows.toSorted((a,b)=>utcMillis(a.body.bar.time)-utcMillis(b.body.bar.time)).at(-1);
  if(newest) for(const reason of assessStoredRecord(newest,{now:asOf,maxAgeMs}).reasons) reasons.add(reason);
  if(rows.some(r=>r.body.provenance?.authorizationExpiresAt && utcMillis(r.body.provenance.authorizationExpiresAt)<=utcMillis(asOf))) reasons.add('ENTITLEMENT_EXPIRED');
  const fixture=rows.some(r=>r.body.provenance?.mode==='offline-fixture') || instrument.provenance?.mode==='offline-fixture';
  if(fixture)reasons.add('OFFLINE_FIXTURE');
  const mode=fixture?'offline-fixture':'historical';
  return {instrument,from,to,asOf,intervalMs,calendar,bars:quality.bars,mode,delayMs,rules,entry,exit,priceDomain,
    qualityReasons:[...reasons].sort(),inputFingerprint:digest(rows.map(r=>[String(r.sequence),r.version_id]))};
}

// Uses an EXISTING source-check envelope for a derived, local analysis source.
// No provider source status is refreshed. No new job enum or migration needed.
export function createLocalAnalysisTask({jobs,repository,scanner,requests,clock = Date.now,sourceId = 'analysis-local',timeoutMs = 15000,api=null,jobId:existingId=null} = {}) {
  requireValue(/^analysis-local(?::[a-z0-9_-]{1,80})?$/.test(sourceId) && Array.isArray(requests) && requests.length>=1 && requests.length<=12,'Invalid local analysis task.');
  const inputs=structuredClone(requests),key=digest(['phase4.v1',inputs]);
  let candidate=null,successful=null,jobId=existingId,running=false;
  const handler=async ({signal})=>{
    candidate=await scanner.analyze(inputs,{signal});
    if(candidate.some(r=>!r.ok)) throw Object.assign(new Error(),{code:'BATCH_INVALID'});
    const at=new Date(clock()).toISOString();
    return {sourceId,fetchedAt:at,processedAt:at,mode:'local-computation',apiResult:candidate};
  };
  const scopedJobs={...jobs,claim:()=>{requireValue(jobId,'Enqueue this analysis task first.');return jobs.claim({jobId});}};
  const worker=createAnalysisWorker({jobs:scopedJobs,repository,handlers:new Map([[sourceId+':source-check',handler]]),timeoutMs});
  return Object.freeze({
    async enqueue() {
      const job=await jobs.enqueue({sourceId,type:'source-check',idempotencyKey:key,maxAttempts:1,api,
        policy:{sourceId,type:'source-check',intervalMs:60000,mode:'offline-fixture'}});
      jobId=job.id;return job;
    },
    async runOne(options={}) {
      if(running) return {status:'busy'};
      running=true;candidate=null;
      try {
        const status=await worker.runOne(options);
        if(status.status==='succeeded') successful=structuredClone(candidate);
        return {...status,...(status.status==='succeeded'?{results:structuredClone(successful)}:{})};
      } finally {candidate=null;running=false;}
    },
    result() {return structuredClone(successful);},
  });
}
