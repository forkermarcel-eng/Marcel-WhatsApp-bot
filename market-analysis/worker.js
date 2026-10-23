import {requireValue} from './instruments.js';
import {normalizeEvent} from './news/events.js';
import {iso} from './storage.js';

// One explicit bounded call. No scheduler, loop, startup hook or ambient network.
export function createAnalysisWorker({jobs,repository,handlers,timeoutMs = 15000} = {}) {
  requireValue(jobs && repository && handlers instanceof Map && Number.isInteger(timeoutMs) && timeoutMs>0 && timeoutMs<jobs.leaseMs,'Invalid worker configuration.');
  let pending = false;
  return Object.freeze({async runOne({signal} = {}) {
    if(pending || signal?.aborted) return {status:signal?.aborted?'aborted':'busy'};
    pending = true;let timer,job;
    const controller = new AbortController();
    const abort = ()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});
    try {
      job = await jobs.claim();if(!job) return {status:'idle'};
      const handler = handlers.get(job.source_id+':'+job.type);
      if(!handler) throw Object.assign(new Error(),{code:'SOURCE_NOT_IMPLEMENTED'});
      const timed = new Promise((_,reject)=>{
        timer = setTimeout(()=>{controller.abort();reject(Object.assign(new Error(),{code:'TIMEOUT'}));},timeoutMs);
        controller.signal.addEventListener('abort',()=>reject(Object.assign(new Error(),{code:signal?.aborted?'ABORTED':'TIMEOUT'})),{once:true});
      });
      const batch = await Promise.race([handler({job,signal:controller.signal}),timed]);
      requireValue(!controller.signal.aborted,'Aborted job.');
      await repository.commitBatch(batch,{job});
      return {status:'succeeded',id:job.id};
    } catch(error) {
      if(!job) throw error;
      try {return {status:await jobs.fail(job,error),id:job.id};}
      catch(failure) {
        if(failure?.message === 'JOB_LEASE_LOST') return {status:'lease-lost',id:job.id};
        throw failure;
      }
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);pending = false;}
  }});
}

export function createNewsJobHandler({adapter,repository,instruments = [],clock = Date.now} = {}) {
  return async ({job,signal})=>{
    const status = await repository.sourceStatus(job.source_id,{maxAgeMs:job.interval_ms});
    const data = await adapter.read({signal,previous:status.state?.validators ?? {}});
    requireValue((data.source?.id ?? adapter.source?.id) === job.source_id,'Adapter source mismatch.');
    const processedAt = iso(clock),events = [],quarantined = [];
    if(!data.notModified) {
      requireValue(Array.isArray(data.records) && data.records.length<=250,'Invalid bounded source batch.');
      for(let index=0;index<data.records.length;index++) {
        try {events.push(normalizeEvent(data.records[index],{...data,processedAt,instruments}));}
        catch {quarantined.push({index,reason:'EVENT_INVALID'});}
      }
      requireValue(!data.records.length || events.length>0,'No valid source records.');
    }
    return {...data,sourceId:job.source_id,processedAt,events,quarantined};
  };
}

export function createCatalogJobHandler({catalog,clock = Date.now} = {}) {
  return async ({job,signal})=>{
    const result = await catalog.read({refresh:true,signal});
    if(result.error || result.stale) throw Object.assign(new Error(),{code:result.error ?? 'BATCH_INVALID'});
    return {sourceId:job.source_id,instruments:result.items,fetchedAt:result.fetchedAt,processedAt:iso(clock),mode:result.provenance?.mode};
  };
}

export function createHistoryJobHandler({adapter,request,clock = Date.now} = {}) {
  return async ({job,signal})=>{
    const result = await adapter.history({...request,signal});
    return {sourceId:job.source_id,fetchedAt:iso(clock),processedAt:iso(clock),mode:result.provenance?.mode,
      histories:[{...request,...result}]};
  };
}
