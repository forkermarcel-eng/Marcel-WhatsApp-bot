import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createAnalysisRepository} from '../market-analysis/repository.js';
import {createAnalysisJobs,retryDelay,safeJobError} from '../market-analysis/jobs.js';
import {createAnalysisWorker,createNewsJobHandler,createCatalogJobHandler,createHistoryJobHandler} from '../market-analysis/worker.js';
import {normalizeEvent} from '../market-analysis/news/events.js';
import {analysisSource} from '../market-analysis/news/sources.js';
import {createNewsAdapter} from '../market-analysis/news/adapter.js';
import {normalizeInstrument} from '../market-analysis/instruments.js';
import {createMassiveAdapter} from '../market-analysis/providers/massive.js';
import {createInstrumentCatalog} from '../market-analysis/catalog.js';
import {assessStoredRecord} from '../market-analysis/freshness.js';

const sql = fs.readFileSync(new URL('../migrations/20261022_brain_market_analysis.sql',import.meta.url),'utf8');
const start = Date.parse('2026-10-22T12:00:00Z');
// ONLY synthetic OFFLINE fixtures, in new in-memory databases. No env/pg Pool.
async function fixture(t) {
  const db = new PGlite();t.after(()=>db.close());await db.exec(sql);
  let now = start;const clock=()=>now;
  const repository=createAnalysisRepository({database:db,clock});
  const jobs=createAnalysisJobs({database:db,clock});
  const at=()=>new Date(now).toISOString();
  return {db,clock,repository,jobs,at,advance:(ms)=>now+=ms,
    batch:(extra={})=>({sourceId:'fed',fetchedAt:at(),processedAt:at(),mode:'offline-fixture',...extra}),
    event:(extra={})=>normalizeEvent({kind:'macro',externalId:'fixture-cpi',title:'US CPI offline fixture',url:'https://www.federalreserve.gov/fixture',
      unit:'percent',actual:'3.2',publishedAt:'2026-10-22T11:00:00Z',...extra},{source:analysisSource('fed'),fetchedAt:at(),processedAt:at(),mode:'offline-fixture'}),
    enqueue:(extra={})=>jobs.enqueue({sourceId:'fed',type:'macro-sync',idempotencyKey:'fixture:1',
      policy:{sourceId:'fed',type:'macro-sync',intervalMs:60000,mode:'offline-fixture'},...extra})};
}
const instrument = ()=>normalizeInstrument({provider:'massive',environment:'reference',symbol:'C:EURUSD',kind:'fx',group:'forex',base:'EUR',quote:'USD',active:true,provenance:{mode:'offline-fixture'}});

test('migration is additive, repeatable and isolated from existing schemas',async t=>{
  const f=await fixture(t);await f.db.exec('CREATE SCHEMA protected;CREATE TABLE protected.items(id integer PRIMARY KEY);INSERT INTO protected.items VALUES(7)');
  await f.db.exec(sql);assert.deepEqual((await f.db.query('SELECT * FROM protected.items')).rows,[{id:7}]);
  const tables=await f.db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='marcel_market_analysis'");
  assert.equal(tables.rows.length,5);assert.doesNotMatch(sql,/\b(?:DROP|TRUNCATE|DELETE)\b/i);
  const alterations=sql.match(/ALTER TABLE[^;]+;/g);assert.equal(alterations.length,1);assert.match(alterations[0],/^ALTER TABLE marcel_market_analysis\.jobs ADD COLUMN IF NOT EXISTS api jsonb\s+CHECK\(api IS NULL OR \(jsonb_typeof\(api\)='object' AND octet_length\(api::text\)<=16000000\)\);$/);
  assert.equal((await f.db.query("SELECT data_type FROM information_schema.columns WHERE table_schema='marcel_market_analysis' AND table_name='jobs' AND column_name='api'")).rows[0].data_type,'jsonb');
});

test('Phase 1 instruments and exact mappings persist; repeats are idempotent',async t=>{
  const f=await fixture(t),i=instrument();i.provenance.observedAt=f.at();const b=f.batch({sourceId:'massive',instruments:[i],mappings:[{mappingId:'EURUSD-provider',instrumentId:i.id,provider:i.provider,symbol:i.symbol}]});
  await f.repository.commitBatch(b);await f.repository.commitBatch(b);
  f.advance(1000);await f.repository.commitBatch(f.batch({...b,instruments:[{...i,provenance:{...i.provenance,observedAt:f.at()}}]}));
  assert.equal((await f.repository.read({sourceId:'massive',kind:'instrument'})).items.length,1);
  assert.equal((await f.repository.read({sourceId:'massive',kind:'mapping'})).items[0].body.instrumentId,i.id);
  await assert.rejects(f.repository.commitBatch({...b,mappings:[{...b.mappings[0],symbol:'C:GBPUSD'}]}),/exact verified/);
});

test('bar histories validate OHLC, retain corrections and explicit non-live quality',async t=>{
  const f=await fixture(t),i=instrument();await f.repository.commitBatch(f.batch({sourceId:'massive',instruments:[i]}));
  const bar={time:'2026-10-22T11:59:00.000Z',open:1,high:2,low:1,close:1.5};
  const h={instrumentId:i.id,from:bar.time,to:f.at(),observedAt:f.at(),intervalMs:60000,maxAgeMs:120000,delayMs:0,bars:[bar]};
  await f.repository.commitBatch(f.batch({sourceId:'massive',histories:[h]}));
  await f.repository.commitBatch(f.batch({sourceId:'massive',histories:[h]}));
  await f.repository.commitBatch(f.batch({sourceId:'massive',histories:[{...h,bars:[{...bar,close:1.6}]}]}));
  const result=await f.repository.read({sourceId:'massive',kind:'bar'});assert.equal(result.items.length,2);
  assert.equal(result.items[0].body.quality.usableForCurrentMonitoring,false);
  await assert.rejects(f.repository.commitBatch(f.batch({sourceId:'massive',histories:[{...h,bars:[{...bar,high:0}]}]})),/OHLC/);
});

test('macro vintages are immutable and as-of excludes late arrivals even with old publication time',async t=>{
  const f=await fixture(t),original=f.event();await f.repository.commitBatch(f.batch({events:[original]}));
  const earlier=f.at();f.advance(60000);
  const revised=f.event({actual:'3.4',revisedAt:f.at(),revisionOf:original.versionId});
  await f.repository.commitBatch(f.batch({events:[revised]}));
  await f.repository.commitBatch(f.batch({events:[revised]}));
  const versions=await f.repository.read({sourceId:'fed',kind:'macro'});assert.equal(versions.items.length,2);
  assert.equal(versions.items[0].body.values.actual,3.2);assert.equal(versions.items[1].body.quality.revisionLinkVerified,true);
  const asof=await f.repository.read({sourceId:'fed',kind:'macro',asOf:earlier,latest:true});
  assert.equal(asof.items.length,1);assert.equal(asof.items[0].body.values.actual,3.2);assert.equal(asof.historicalTimingVerified,false);
});

test('same-clock calendar versions use insertion order, retain civil dates and cancellation',async t=>{
  const f=await fixture(t),a=f.event({kind:'calendar',externalId:'fixture-term',scheduledAt:'2026-10-29',unit:null,actual:null});
  const b=f.event({kind:'calendar',externalId:'fixture-term',scheduledAt:'2026-10-30',unit:null,actual:null,cancelled:true});
  await f.repository.commitBatch(f.batch({events:[a,b]}));
  const versions=await f.repository.read({sourceId:'fed',kind:'calendar'});assert.equal(versions.items.length,2);
  const last=(await f.repository.read({sourceId:'fed',kind:'calendar',latest:true})).items[0].body;
  assert.equal(last.scheduled.date,'2026-10-30');assert.equal(last.scheduled.at,null);assert.equal(last.status,'CANCELLED');
  // A status-only cancellation must not collide with Phase-2 content hash.
  const cancelled={...a,status:'CANCELLED'};await f.repository.commitBatch(f.batch({events:[cancelled]}));
  assert.equal((await f.repository.read({sourceId:'fed',kind:'calendar'})).items.length,3);
});

test('GUID variations deduplicate news and 72h tombstones survive repository restart/cleanup',async t=>{
  const f=await fixture(t);const a=f.event({kind:'news',externalId:'guid1',publishedAt:null});
  const b=f.event({kind:'news',externalId:'guid2',publishedAt:null});
  await f.repository.commitBatch(f.batch({events:[a,b]}));assert.equal((await f.repository.read({sourceId:'fed',kind:'news'})).items.length,1);
  f.advance(72*3600000+1);assert.equal((await f.repository.read({sourceId:'fed',kind:'news'})).items.length,0);
  await f.repository.expireNews();
  const restarted=createAnalysisRepository({database:f.db,clock:f.clock});
  await restarted.commitBatch(f.batch({events:[f.event({kind:'news',externalId:'new-guid',publishedAt:null})]}));
  assert.equal((await restarted.read({sourceId:'fed',kind:'news'})).items.length,0);
  assert.equal((await f.db.query('SELECT * FROM marcel_market_analysis.news_seen')).rows.length,1);
});

test('entire transaction rolls back on invalid row, retaining old source validators/data',async t=>{
  const f=await fixture(t),a=f.event();await f.repository.commitBatch(f.batch({events:[a],validators:{etag:'old'}}));
  await assert.rejects(f.repository.commitBatch(f.batch({events:[f.event({actual:'4'}),{...a,source:{id:'wrong'}}],validators:{etag:'new'}})),/normalized event/);
  assert.equal((await f.repository.read({sourceId:'fed',kind:'macro'})).items.length,1);
  assert.equal((await f.repository.sourceStatus('fed',{maxAgeMs:60000})).state.validators.etag,'old');
  await assert.rejects(f.repository.commitBatch(f.batch({fetchedAt:'2026-10-23T12:00:00Z'})),/chronology/);
});

test('bounded reads explicitly report more data and reject unsafe limits',async t=>{
  const f=await fixture(t);await f.repository.commitBatch(f.batch({events:[f.event(),f.event({externalId:'fixture2'})]}));
  const result=await f.repository.read({sourceId:'fed',kind:'macro',limit:1});assert.equal(result.hasMore,true);assert.equal(result.items.length,1);
  const page=await f.repository.read({sourceId:'fed',kind:'macro',limit:1,asOf:result.asOf,cursor:result.nextCursor});
  assert.equal(page.hasMore,false);assert.notEqual(page.items[0].entity_id,result.items[0].entity_id);
  const latest=await f.repository.read({sourceId:'fed',kind:'macro',latest:true,limit:1});
  const next=await f.repository.read({sourceId:'fed',kind:'macro',latest:true,limit:1,asOf:latest.asOf,cursor:latest.nextCursor});
  assert.notEqual(latest.items[0].entity_id,next.items[0].entity_id);
  await assert.rejects(f.repository.read({sourceId:'fed',kind:'macro',limit:10000}));
});

test('enqueue is idempotent across instances; claims are exclusive and audited',async t=>{
  const f=await fixture(t),a=await f.enqueue(),b=await f.enqueue();assert.equal(a.id,b.id);
  const peer=createAnalysisJobs({database:f.db,clock:f.clock});
  const claims=await Promise.all([f.jobs.claim(),peer.claim()]);assert.equal(claims.filter(Boolean).length,1);
  const job=claims.find(Boolean);assert.equal(job.attempts,1);assert.ok(job.lease_token);
  await f.jobs.heartbeat(job);assert.equal((await f.jobs.log(job.id))[0].status,'running');
  await assert.rejects(f.db.query("INSERT INTO marcel_market_analysis.jobs(id,source_id,type,idempotency_key,status,created_at,due_at,max_attempts,interval_ms,lease_token,lease_until) VALUES('10000000-0000-4000-8000-000000000001','fed','macro-sync','other','running',$1,$1,3,60000,'10000000-0000-4000-8000-000000000002',$1)",[f.at()]),/unique/i);
});

test('transient failures retry within configured bounds, honor cadence/Retry-After and redact secrets',async t=>{
  const f=await fixture(t),q=await f.enqueue({maxAttempts:2});let job=await f.jobs.claim();
  assert.equal(await f.jobs.fail(job,{code:'RATE_LIMITED',retryMs:120000,message:'apiKey=private'}),'retry');
  assert.equal(await f.jobs.claim(),null);f.advance(120000);job=await f.jobs.claim();assert.equal(job.attempts,2);
  assert.equal(await f.jobs.fail(job,{code:'TIMEOUT'}),'failed');f.advance(4000000);assert.equal(await f.jobs.claim(),null);
  assert.doesNotMatch(JSON.stringify(await f.jobs.log(q.id)),/private|apiKey/);
  assert.equal(retryDelay(999,Infinity),1024000);assert.equal(retryDelay(2,999999999),3600000);assert.equal(safeJobError(new Error('secret')),'JOB_FAILED');
});

test('expired leases recover with a new fence; former owner cannot commit or fail recovered work',async t=>{
  const f=await fixture(t);await f.enqueue();const old=await f.jobs.claim();f.advance(60000);
  assert.equal(await f.jobs.claim(),null); // recovery schedules bounded backoff
  f.advance(2000);const recovered=await f.jobs.claim();assert.ok(recovered);assert.notEqual(recovered.lease_token,old.lease_token);
  await assert.rejects(f.repository.commitBatch(f.batch({events:[f.event()]}),{job:old}),/JOB_LEASE_LOST/);
  await assert.rejects(f.jobs.fail(old,{code:'TIMEOUT'}),/JOB_LEASE_LOST/);
  await f.repository.commitBatch(f.batch({events:[f.event()]}),{job:recovered});
  assert.equal((await f.jobs.get(recovered.id)).status,'succeeded');assert.equal((await f.repository.read({sourceId:'fed',kind:'macro'})).items.length,1);
});

test('cancellation fences active work and failed storage cannot report job success',async t=>{
  const f=await fixture(t);const q=await f.enqueue();const job=await f.jobs.claim();
  await assert.rejects(f.repository.commitBatch(f.batch({events:[{invalid:true}]}),{job}));
  assert.equal((await f.jobs.get(q.id)).status,'running');await f.jobs.cancel(q.id);
  await assert.rejects(f.repository.commitBatch(f.batch({events:[f.event()]}),{job}),/JOB_LEASE_LOST/);
  assert.equal((await f.jobs.get(q.id)).status,'cancelled');
});

test('different job keys cannot bypass per-source polling intervals',async t=>{
  const f=await fixture(t);await f.enqueue();await f.enqueue({idempotencyKey:'fixture:2'});const job=await f.jobs.claim();
  await f.repository.commitBatch(f.batch(),{job});assert.equal(await f.jobs.claim(),null);
  f.advance(60000);assert.ok(await f.jobs.claim());
  await assert.rejects(f.enqueue({policy:{sourceId:'fed',type:'macro-sync',intervalMs:1,mode:'offline-fixture'}}));
  await assert.rejects(f.enqueue({policy:{sourceId:'fed',type:'macro-sync',intervalMs:60000,mode:'network'}}));
});

test('source freshness separates fetch/process/storage/success/error; never labels data realtime',async t=>{
  const f=await fixture(t);assert.equal((await f.repository.sourceStatus('fed',{maxAgeMs:60000})).stale,true);
  const event=f.event();f.advance(1000);await f.repository.commitBatch(f.batch({fetchedAt:event.fetchedAt,events:[event]}));
  let s=await f.repository.sourceStatus('fed',{maxAgeMs:60000});assert.equal(s.stale,false);assert.equal(s.realtimeConfirmed,false);
  assert.notEqual(s.state.fetchedAt,s.state.storedAt);f.advance(60001);assert.equal((await f.repository.sourceStatus('fed',{maxAgeMs:60000})).stale,true);
  await f.enqueue();const job=await f.jobs.claim();await f.jobs.fail(job,{code:'TIMEOUT'});
  s=await f.repository.sourceStatus('fed',{maxAgeMs:1000000});assert.equal(s.stale,true);assert.ok(s.last_error_at);assert.ok(s.last_success_at);
  const row=(await f.repository.read({sourceId:'fed',kind:'macro'})).items[0];
  const quality=assessStoredRecord(row,{now:f.at(),maxAgeMs:60000});assert.ok(quality.reasons.includes('DATA_OLD'));assert.ok(quality.reasons.includes('OFFLINE_FIXTURE'));
  assert.equal(quality.usableForCurrentMonitoring,false);
});

test('real Phase 2 adapter handler persists valid rows, quarantines bad rows and reuses 304 validators after restart',async t=>{
  const f=await fixture(t);let reads=0;
  const adapter=createNewsAdapter({sourceId:'fed',clock:f.clock,fetcher:async (url,options)=>{
    reads++;if(reads>1){assert.equal(options.headers['If-None-Match'],'fixture');return new Response(null,{status:304,headers:{etag:'fixture'}});}
    return new Response('<rss><channel><item><guid>valid</guid><title>US CPI fixture</title><link>https://www.federalreserve.gov/fixture</link></item><item><guid>invalid</guid><title>Bad time fixture</title><link>https://www.federalreserve.gov/invalid</link><pubDate>wrong</pubDate></item></channel></rss>',{headers:{etag:'fixture'}});
  }});
  const handler=createNewsJobHandler({adapter,repository:f.repository,clock:f.clock});
  const worker=createAnalysisWorker({jobs:f.jobs,repository:f.repository,handlers:new Map([['fed:macro-sync',handler]])});
  await f.enqueue();assert.equal((await worker.runOne()).status,'succeeded');assert.equal((await f.repository.read({sourceId:'fed',kind:'news'})).items.length,1);
  assert.equal((await f.repository.sourceStatus('fed',{maxAgeMs:60000})).state.quarantined.length,1);
  f.advance(60000);await f.enqueue({idempotencyKey:'304'});assert.equal((await worker.runOne()).status,'succeeded');assert.equal(reads,2);
  assert.equal((await f.repository.read({sourceId:'fed',kind:'news'})).items.length,1);
  assert.equal((await f.repository.sourceStatus('fed',{maxAgeMs:60000})).stale,true); // 304 does not repair invalid rows
});

test('network permission failures are blocked without a fetch or repeat loop',async t=>{
  const f=await fixture(t);let calls=0;
  const adapter=createNewsAdapter({sourceId:'fed',mode:'network',clock:f.clock,fetcher:async()=>{calls++;throw Error('should not call');}});
  const worker=createAnalysisWorker({jobs:f.jobs,repository:f.repository,handlers:new Map([['fed:macro-sync',createNewsJobHandler({adapter,repository:f.repository,clock:f.clock})]])});
  const job=await f.enqueue();assert.equal((await worker.runOne()).status,'blocked');assert.equal(calls,0);
  assert.equal((await f.jobs.get(job.id)).error_code,'SOURCE_PERMISSION_NOT_CONFIRMED');assert.equal((await worker.runOne()).status,'idle');
});

test('manual worker bounds execution, suppresses parallel local run, and does not commit late responses',async t=>{
  const f=await fixture(t);await f.enqueue();let resolve;
  const handler=()=>new Promise(r=>{resolve=r;});
  const worker=createAnalysisWorker({jobs:f.jobs,repository:f.repository,handlers:new Map([['fed:macro-sync',handler]]),timeoutMs:30});
  const pending=worker.runOne();assert.equal((await worker.runOne()).status,'busy');assert.equal((await pending).status,'retry');
  resolve(f.batch({events:[f.event()]}));await Promise.resolve();assert.equal((await f.repository.read({sourceId:'fed',kind:'macro'})).items.length,0);
});

test('Phase 1 Massive catalog/history adapter results connect without changing Trading code',async t=>{
  const f=await fixture(t),i=instrument();
  const adapter=createMassiveAdapter({clock:f.clock,fetcher:async url=>new Response(JSON.stringify({status:'OK',results:url.includes('/reference/')?[{ticker:'C:EURUSD',market:'fx',active:true,base_currency_symbol:'EUR',currency_symbol:'USD'}]:[{t:start-60000,o:1,h:2,l:1,c:1.5}]}))});
  const catalog=createInstrumentCatalog({adapter,clock:f.clock});
  const catalogHandler=createCatalogJobHandler({catalog,clock:f.clock});
  const historyHandler=createHistoryJobHandler({adapter,clock:f.clock,request:{instrument:i,from:'2026-10-22T11:59:00Z',to:f.at(),intervalMs:60000,maxAgeMs:120000,delayMs:0}});
  const batch=await catalogHandler({job:{source_id:'massive'},signal:new AbortController().signal});await f.repository.commitBatch(batch);
  const history=await historyHandler({job:{source_id:'massive'},signal:new AbortController().signal});await f.repository.commitBatch(history);
  const records=await f.repository.read({sourceId:'massive',kind:'bar'});assert.equal(records.items.length,1);assert.equal(records.items[0].body.provenance.mode,'offline-fixture');
});

test('quotas fail atomically without breaking idempotent replay at capacity',async t=>{
  const f=await fixture(t),repo=createAnalysisRepository({database:f.db,clock:f.clock,maxSourceRecords:1,maxSourceNewsSeen:1});
  const a=f.event();await repo.commitBatch(f.batch({events:[a]}));await repo.commitBatch(f.batch({events:[a]}));
  await assert.rejects(repo.commitBatch(f.batch({events:[f.event({externalId:'overflow'})]})),/quota/);
  assert.equal((await repo.read({sourceId:'fed',kind:'macro'})).items.length,1);
});

test('pg Pool transaction path commits, rolls back and releases its dedicated client',async t=>{
  const f=await fixture(t),commands=[];let releases=0;
  const pool={query:(...args)=>f.db.query(...args),connect:async()=>({query:async(sql,args)=>{commands.push(sql);return f.db.query(sql,args);},release:()=>releases++})};
  const repo=createAnalysisRepository({database:pool,clock:f.clock});
  await repo.commitBatch(f.batch({events:[f.event()]}));
  await assert.rejects(repo.commitBatch(f.batch({events:[{bad:true}]})));
  assert.equal(releases,2);assert.ok(commands.includes('BEGIN'));assert.ok(commands.includes('COMMIT'));assert.ok(commands.includes('ROLLBACK'));
  assert.ok(commands.includes("SET LOCAL statement_timeout='20s'"));assert.equal((await repo.read({sourceId:'fed',kind:'macro'})).items.length,1);
});

test('worker preserves earlier data on an entirely invalid batch and blocks missing handlers',async t=>{
  const f=await fixture(t);await f.repository.commitBatch(f.batch({events:[f.event()],validators:{etag:'good'}}));
  const adapter={read:async()=>({source:analysisSource('fed'),fetchedAt:f.at(),mode:'offline-fixture',records:[{kind:'macro'}]})};
  const worker=createAnalysisWorker({jobs:f.jobs,repository:f.repository,handlers:new Map([['fed:macro-sync',createNewsJobHandler({adapter,repository:f.repository,clock:f.clock})]])});
  await f.enqueue();assert.equal((await worker.runOne()).status,'failed');
  assert.equal((await f.repository.read({sourceId:'fed',kind:'macro'})).items.length,1);
  assert.equal((await f.repository.sourceStatus('fed',{maxAgeMs:60000})).state.validators.etag,'good');
  f.advance(60000);await f.enqueue({idempotencyKey:'unwired'});
  const unwired=createAnalysisWorker({jobs:f.jobs,repository:f.repository,handlers:new Map()});assert.equal((await unwired.runOne()).status,'blocked');
});

test('final attempt interruption becomes terminal and source status exposes lease recovery',async t=>{
  const f=await fixture(t);await f.repository.commitBatch(f.batch());const job=await f.enqueue({maxAttempts:1});await f.jobs.claim();f.advance(60000);
  assert.equal(await f.jobs.claim(),null);assert.equal((await f.jobs.get(job.id)).status,'failed');
  const state=await f.repository.sourceStatus('fed',{maxAgeMs:1000000});assert.equal(state.error_code,'LEASE_EXPIRED');assert.equal(state.stale,true);
});
