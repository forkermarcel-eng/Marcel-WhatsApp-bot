import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {normalizeInstrument} from '../market-analysis/instruments.js';
import {normalizeEvent} from '../market-analysis/news/events.js';
import {normalizeAlert,evaluateAlert,initialAlertState} from '../market-analysis/alerts.js';
import {eventFamily,EVENT_FAMILIES} from '../market-analysis/event-types.js';
import {analyzeEventStudy} from '../market-analysis/event-study.js';
import {createAlertRepository} from '../market-analysis/alert-repository.js';
import {createAnalysisRepository} from '../market-analysis/repository.js';
import {createAnalysisJobs} from '../market-analysis/jobs.js';
import {createPhase6Task,loadEventStudyRequest,loadAlertSnapshot,loadEconomicSnapshot,readAnalysisRows} from '../market-analysis/phase6-service.js';

const epoch=Date.parse('2026-10-22T12:00:00Z'),minute=60000,iso=n=>new Date(n).toISOString();
const instrument=normalizeInstrument({provider:'fixture',environment:'offline',symbol:'EURUSD',kind:'fx',group:'forex',active:true,base:'EUR',quote:'USD',metadata:{priceBasis:'mid',shortAllowed:true},provenance:{mode:'offline-fixture'}});
const calendar={from:iso(epoch-minute),to:iso(epoch+120*minute),reference:'synthetic open UTC calendar',windows:[{start:iso(epoch-minute),end:iso(epoch+120*minute)}]};
const rule=(changes={})=>normalizeAlert({instrumentId:instrument.id,type:'LEVEL',condition:{operator:'above',level:100},priceBasis:'mid',cooldownMs:0,...changes});
const snapshot=(price=99,offset=0,changes={})=>({instrument,price,priceBasis:'mid',dataAt:iso(epoch+offset),receivedAt:iso(epoch+offset),mode:'offline-fixture',delayMs:0,calendar,...changes});
const evaluate=(r,s,p,at=epoch)=>evaluateAlert(r,s,p,{now:iso(at),allowFixtures:true});
const scan=(at,observations=[],atr=1)=>({schemaVersion:'phase4.v1',instrumentId:instrument.id,asOf:iso(at),quality:{missingBars:0,reasons:[]},scan:{status:'READY',observations,indicators:{atrSma:atr}}});
function event(overrides={},at=epoch+10*minute) {
  return normalizeEvent({kind:'macro',externalId:'cpi-2026-10',title:'US CPI',seriesId:'CPI',period:'2026-09',unit:'percent',country:'US',currency:'USD',publishedAt:iso(at),actual:3.2,...overrides},
    {source:{id:'fixture-macro',name:'Fixture only',url:'https://example.invalid/macro',country:'US'},fetchedAt:iso(at),processedAt:iso(at),mode:'offline-fixture',instruments:[instrument]});
}
const row=(body,known=body.fetchedAt,sequence=1)=>({body,stored_at:known,fetched_at:known,processed_at:known,sequence});
function study() {
  const eventRows=[row(event())];
  const barRows=Array.from({length:6},(_,i)=>{
    const time=epoch+(7+i)*minute,close=100+i;
    return row({instrumentId:instrument.id,intervalMs:minute,bar:{time:iso(time),open:close,high:close+1,low:close-1,close},provenance:{mode:'offline-fixture'}},iso(time+minute),i+1);
  });
  return {instrument,eventRows,barRows,calendar,intervalMs:minute,windows:[{beforeMs:3*minute,afterMs:3*minute}],asOf:iso(epoch+30*minute),mode:'offline-fixture',families:['CPI'],minimumSample:5};
}
async function database(t) {
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(fs.readFileSync('migrations/20261022_brain_market_analysis.sql','utf8'));
  await db.exec(fs.readFileSync('migrations/20261022_brain_market_analysis_phase6.sql','utf8'));
  let now=epoch;const clock=()=>now;
  return {db,clock,set:n=>{now=n;},alerts:createAlertRepository({database:db,ownerId:'alice',clock,allowFixtures:true}),repository:createAnalysisRepository({database:db,clock}),jobs:createAnalysisJobs({database:db,clock})};
}

test('level crossings latch, dedupe and rearm only on fresh neutral data with hysteresis',()=>{
  const r=rule({hysteresis:1});let out=evaluate(r,null,snapshot());assert.equal(out.status,'BASELINED');assert.equal(out.state.phase,'ARMED');
  out=evaluate(r,out.state,snapshot(100,1000),epoch+1000);assert.equal(out.status,'TRIGGERED');assert.equal(out.triggers.length,1);
  const latched=out.state;assert.equal(evaluate(r,latched,snapshot(100,1000),epoch+1000).reason,'DUPLICATE_OR_OUT_OF_ORDER');
  assert.equal(evaluate(r,latched,snapshot(98,2000),epoch+90000).reason,'STALE_DATA');
  assert.equal(evaluate(r,latched,snapshot(99.5,3000),epoch+3000).state.phase,'LATCHED');
  out=evaluate(r,latched,snapshot(98,4000),epoch+4000);assert.equal(out.state.phase,'ARMED');
  assert.equal(evaluate(r,out.state,snapshot(101,5000),epoch+5000).status,'TRIGGERED');
  assert.equal(evaluate(rule({condition:{operator:'below',level:100},triggerOnInitial:true}),null,snapshot(100)).status,'TRIGGERED');
});

test('baseline, zone entry, cooldown, disabled and explicit reset do not invent crossings',()=>{
  const r=rule({type:'ZONE_ENTER',condition:{min:100,max:105},cooldownMs:5000});
  let out=evaluate(r,null,snapshot(102));assert.equal(out.triggers.length,0);assert.equal(out.state.phase,'LATCHED');
  out=evaluate(r,out.state,snapshot(99,1000),epoch+1000);assert.equal(out.state.phase,'ARMED');
  out=evaluate(r,out.state,snapshot(106,2000),epoch+2000);assert.equal(out.triggers.length,0);
  out=evaluate(r,out.state,snapshot(103,3000),epoch+3000);assert.equal(out.status,'TRIGGERED');
  assert.equal(evaluate(r,out.state,snapshot(99,4000),epoch+4000).state.phase,'LATCHED');
  assert.equal(evaluate({...r,enabled:false},out.state,snapshot(99,5000),epoch+5000).status,'DISABLED');
  assert.equal(evaluate({...r,triggerOnInitial:true},{...out.state,phase:'BASELINE_REQUIRED'},snapshot(103,9000),epoch+9000).triggers.length,0);
  assert.equal(evaluate(r,{...out.state,lastEvaluationAt:iso(epoch+10000)},snapshot(),epoch).reason,'CLOCK_REGRESSION');
});

test('freshness, sessions, price basis, fixtures and entitlement gates fail closed',()=>{
  const r=rule({triggerOnInitial:true});
  for(const [change,expected] of [[{sourceError:'429'},'SOURCE_ERROR'],[{dataAt:iso(epoch+1)},'FUTURE_OR_INVALID_SOURCE_TIME'],[{delayMs:null},'DELAY_UNKNOWN'],[{priceBasis:'ask'},'PRICE_BASIS_MISMATCH'],[{price:NaN},'PRICE_INVALID'],[{calendar:{...calendar,windows:[]}},'SESSION_NOT_OPEN_OR_UNKNOWN'],[{mode:'historical'},'HISTORICAL_INPUT_NOT_CURRENT'],[{mode:'authorised-cache'},'AUTHORIZATION_NOT_CONFIRMED']]) {
    assert.equal(evaluate(r,null,snapshot(101,0,change)).reason,expected);
  }
  assert.equal(evaluateAlert(r,null,snapshot(101),{now:iso(epoch)}).reason,'FIXTURE_NOT_ENABLED');
  const authorization={verified:true,instrumentId:instrument.id,usage:'internal-analysis',reference:'fixture grant',checkedAt:iso(epoch-minute),expiresAt:iso(epoch+minute)};
  assert.equal(evaluate(r,null,snapshot(101,0,{mode:'authorised-cache',authorization})).status,'TRIGGERED');
  assert.equal(evaluate(r,null,snapshot(101,0,{mode:'authorised-cache',authorization:{...authorization,expiresAt:iso(epoch)}})).reason,'AUTHORIZATION_NOT_CONFIRMED');
  assert.throws(()=>rule({condition:{operator:'above',level:'100'}}));assert.throws(()=>rule({instrumentId:''}));
  assert.throws(()=>rule({condition:{operator:'above',level:100,payload:'x'.repeat(17000)}}),/large/);
});

test('Phase 4 breakout, setup, market structure and volatility feed token-free alerts',()=>{
  for(const [type,name] of [['BREAKOUT','CLOSE_BREAKOUT'],['SETUP','EMA_CROSS'],['MARKET_STRUCTURE','CONFIRMED_SWING_CROSS']]) {
    const r=rule({type,condition:{rule:name,side:'LONG'}});
    let out=evaluate(r,null,snapshot(99,0,{scanner:scan(epoch)}));
    out=evaluate(r,out.state,snapshot(101,1000,{scanner:scan(epoch+1000,[{rule:name,side:'LONG',knownAt:iso(epoch+1000)}])}),epoch+1000);
    assert.equal(out.status,'TRIGGERED');
    assert.equal(evaluate(r,null,snapshot(101,0,{scanner:scan(epoch+1)})).reason,'SCANNER_DATA_NOT_CURRENT_OR_COMPLETE');
  }
  const short=rule({type:'SETUP',condition:{rule:'EMA_CROSS',side:'SHORT'},triggerOnInitial:true});
  assert.equal(evaluate(short,null,snapshot(101,0,{instrument:{...instrument,metadata:{...instrument.metadata,shortAllowed:null}},scanner:scan(epoch)})).reason,'SHORT_PERMISSION_UNKNOWN_OR_FALSE');
  for(const direction of ['increase','decrease']) {
    const r=rule({type:'VOLATILITY_CHANGE',condition:{direction,fraction:.2}});
    const base=evaluate(r,null,snapshot(100,0,{scanner:scan(epoch,[],10)}));
    assert.equal(evaluate(r,base.state,snapshot(100,1000,{scanner:scan(epoch+1000,[],direction==='increase'?13:7)}),epoch+1000).status,'TRIGGERED');
  }
});

test('calendar alerts require precise times, fresh source and deduplicated latest event versions',()=>{
  const r=rule({type:'ECONOMIC_EVENT',condition:{families:['CPI'],leadMs:minute,maxLateMs:minute}});
  const e=event({kind:'calendar',publishedAt:null,actual:null,scheduledAt:iso(epoch+minute)} ,epoch);
  const s=snapshot(null,0,{events:[row(e)]});
  const out=evaluate(r,null,s);assert.equal(out.status,'TRIGGERED');
  assert.equal(evaluateAlert(r,out.state,s,{now:iso(epoch),allowFixtures:true,seenOccurrences:[out.triggers[0].occurrence]}).triggers.length,0);
  assert.equal(evaluate(r,null,{...s,events:[row({...e,scheduled:{precision:'DATE',date:'2026-10-22',at:null}})]}).triggers.length,0);
  assert.equal(evaluate(r,null,{...s,events:[row(e),row({...e,status:'CANCELLED'},iso(epoch),2)]}).triggers.length,0);
  assert.equal(evaluate(r,null,s,epoch+2*minute).reason,'STALE_DATA');
  assert.equal(evaluate(r,null,{...s,events:[row(e,iso(epoch+minute))]}).triggers.length,0);
});

test('all requested event families are explicitly classified',()=>{
  const titles=['US PCE','US CPI','NFP','FOMC','ECB rate decision','BoJ policy decision','ISM manufacturing','PMI services','GDP','EIA crude inventories'];
  assert.deepEqual(titles.map(title=>eventFamily({title})),EVENT_FAMILIES);assert.equal(eventFamily({title:'unrelated'}),null);
});

test('event study computes reference statistics from original locally known vintages',async()=>{
  const input=study(),out=await analyzeEventStudy(input);assert.equal(out.observations.length,1,JSON.stringify(out.excluded));
  const o=out.observations[0];assert.equal(o.afterChange,3);assert.equal(o.beforeChange,2);assert.equal(o.afterPercent,3/102*100);assert.equal(o.barCount,3);
  assert.equal(o.maximumUp,4);assert.equal(o.maximumDown,0);assert.equal(o.expected,null);assert.equal(o.surprise,null);
  assert.equal(out.summaries[0].priceChange.mean,3);assert.equal(out.summaries[0].priceChange.median,3);assert.equal(out.summaries[0].priceChange.sampleStd,null);
  assert.equal(out.smallSample,true);assert.equal(out.assumptions.causalityProven,false);assert.equal(out.assumptions.scheduledTimeUsedAsRelease,false);
  const revision={...input.eventRows[0].body,versionId:'later',revised:{precision:'INSTANT',at:iso(epoch+20*minute)},revisionOf:input.eventRows[0].body.versionId,values:{actual:99,expected:98}};
  input.eventRows.push(row(revision,iso(epoch+20*minute),2));
  input.barRows.push(row({...input.barRows.at(-1).body,bar:{...input.barRows.at(-1).body.bar,close:500,high:501}},iso(epoch+25*minute),100));
  const revised=await analyzeEventStudy(input);assert.equal(revised.observations[0].afterChange,3);assert.equal(revised.observations[0].actual,3.2);assert.equal(revised.ignoredRevisionCount,1);
});

test('event study rejects scheduled substitutes, date-only, late originals and missing market bars',async()=>{
  for(const [mutate,reason] of [
    [x=>{x.eventRows[0].body.kind='calendar';},'NOT_AN_ACTUAL_MACRO_RELEASE'],
    [x=>{x.eventRows[0].body.published={at:null,precision:'DATE'};},'PUBLICATION_TIME_NOT_PRECISE'],
    [x=>{x.eventRows[0].stored_at=iso(epoch+11*minute);},'ORIGINAL_NOT_KNOWN_NEAR_RELEASE'],
    [x=>{x.barRows.splice(4,1);},'EVENT_WINDOW_GAPS_OR_UNVERIFIED_VINTAGES'],
    [x=>{x.calendar={...calendar,windows:[]};},'NO_FRESH_PRE_EVENT_MARKET_ANCHOR'],
    [x=>{x.asOf=iso(epoch+11*minute);},'POST_WINDOW_NOT_YET_AVAILABLE'],
    [x=>{x.eventRows[0].body.revised={precision:'INSTANT'};},'ORIGINAL_VINTAGE_UNAVAILABLE'],
  ]) {const input=study();mutate(input);const out=await analyzeEventStudy(input);assert.equal(out.observations.length,0);assert.ok(out.excluded.some(e=>e.reason===reason),JSON.stringify(out.excluded));}
});

test('consensus provenance, offset timestamps, revision boundaries and resource limits are explicit',async()=>{
  const input=study();input.eventRows[0].body=event({publishedAt:'2026-10-22T14:10:00+02:00',expected:3,expectation:{class:'compiled_consensus',sourceURL:'https://example.invalid/survey',asOf:iso(epoch+9*minute)}});
  const out=await analyzeEventStudy(input);assert.ok(Math.abs(out.observations[0].surprise-.2)<1e-12);
  input.eventRows[0].body.expectation.asOf=iso(epoch+11*minute);assert.equal((await analyzeEventStudy(input)).observations[0].expected,null);
  const controller=new AbortController();controller.abort();await assert.rejects(analyzeEventStudy(study(),{signal:controller.signal}),{code:'ABORTED'});
  await assert.rejects(analyzeEventStudy({...study(),eventRows:Array(2001).fill(study().eventRows[0])}),/limit/);
  await assert.rejects(analyzeEventStudy({...study(),windows:[{beforeMs:10,afterMs:minute}]}),/window/);
});

test('additive local SQL is repeatable and leaves existing tables/data intact',async t=>{
  const f=await database(t);await f.db.exec("CREATE TABLE public.phase6_sentinel(id integer PRIMARY KEY, body text); INSERT INTO public.phase6_sentinel VALUES(1,'preserved');");
  const before=await f.db.query("SELECT tablename FROM pg_tables WHERE schemaname='marcel_market_analysis' ORDER BY tablename");
  await f.db.exec(fs.readFileSync('migrations/20261022_brain_market_analysis_phase6.sql','utf8'));
  assert.deepEqual((await f.db.query('SELECT * FROM public.phase6_sentinel')).rows,[{id:1,body:'preserved'}]);
  assert.deepEqual((await f.db.query("SELECT tablename FROM pg_tables WHERE schemaname='marcel_market_analysis' ORDER BY tablename")).rows,before.rows);
  for(const name of ['alert_rules','alert_states','alert_history','event_studies'])assert.ok(before.rows.some(r=>r.tablename===name));
});

test('owned persistence keeps trigger/state atomic, deduplicates, resets and records configuration',async t=>{
  const f=await database(t),r=await f.alerts.create(rule());await f.alerts.check([r.id],snapshot());
  f.set(epoch+1000);await Promise.all([f.alerts.check([r.id],snapshot(101,1000)),f.alerts.check([r.id],snapshot(101,1000))]);
  let history=await f.alerts.history(r.id);assert.equal(history.items.length,1);assert.equal(history.items[0].configuration.condition.level,100);
  await f.alerts.reset(r.id,{expectedVersion:1});assert.equal((await f.alerts.check([r.id],snapshot(101,1000)))[0].reason,'DUPLICATE_OR_OUT_OF_ORDER');
  await assert.rejects(f.alerts.update(r.id,{label:'new'},{expectedVersion:2}),/version/);
  assert.equal((await f.alerts.update(r.id,{label:'new'},{expectedVersion:1})).version,2);
  const bob=createAlertRepository({database:f.db,ownerId:'bob',clock:f.clock,allowFixtures:true});
  assert.equal((await bob.list()).items.length,0);assert.equal((await bob.history(r.id)).items.length,0);await assert.rejects(bob.reset(r.id,{expectedVersion:2}),/scope/);
  f.set(epoch+2000);const stateBefore=(await f.alerts.list()).items[0].state;
  await assert.rejects(f.alerts.check([r.id,'11111111-1111-4111-8111-111111111111'],snapshot(99,2000)),/scope/);
  assert.deepEqual((await f.alerts.list()).items[0].state,stateBefore);
  const aborted=new AbortController();aborted.abort();await assert.rejects(f.alerts.check([r.id],snapshot(99,2000),{signal:aborted.signal}),{code:'ABORTED'});
});

test('history pagination retains distinct rearmed triggers and study storage is owner scoped/idempotent',async t=>{
  const f=await database(t),r=await f.alerts.create(rule());
  for(const [i,p] of [99,101,99,102].entries()){f.set(epoch+i*1000);await f.alerts.check([r.id],snapshot(p,i*1000));}
  const page=await f.alerts.history(r.id,{limit:1});assert.equal(page.items.length,1);assert.ok(page.nextCursor);
  const next=await f.alerts.history(r.id,{limit:1,before:page.nextCursor});assert.equal(next.items.length,1);assert.notEqual(next.items[0].id,page.items[0].id);assert.equal(next.nextCursor,null);
  const result=await analyzeEventStudy(study());const saved=await f.alerts.saveStudy(result);assert.equal((await f.alerts.saveStudy(result)).id,saved.id);assert.deepEqual(await f.alerts.getStudy(saved.id),result);
  assert.equal(await createAlertRepository({database:f.db,ownerId:'bob'}).getStudy(saved.id),null);
});

test('Phase 3 queue executes exact Phase 6 task and atomically commits in-app trigger and job',async t=>{
  const f=await database(t),r=await f.alerts.create(rule({triggerOnInitial:true}));
  const other=await f.jobs.enqueue({sourceId:'fixture-other',type:'source-check',idempotencyKey:'other',policy:{sourceId:'fixture-other',type:'source-check',mode:'offline-fixture',intervalMs:minute}});
  const task=createPhase6Task({jobs:f.jobs,alerts:f.alerts,clock:f.clock,request:{operation:'alerts',ruleIds:[r.id],snapshot:snapshot(101)}});
  const queued=await task.enqueue();assert.equal((await task.enqueue()).id,queued.id);
  const out=await task.runOne();assert.equal(out.status,'succeeded');assert.equal(out.result[0].status,'TRIGGERED');
  assert.equal((await f.jobs.get(queued.id)).status,'succeeded');assert.equal((await f.jobs.get(other.id)).status,'queued');assert.equal((await f.alerts.history(r.id)).items.length,1);
  assert.equal((await task.runOne()).status,'idle');
  const status=await f.repository.sourceStatus('fixture-other',{now:iso(epoch),maxAgeMs:minute});assert.equal(status.last_success_at,null);
});

test('cancelled and expired leases cannot publish Phase 6 state/history',async t=>{
  const f=await database(t),r=await f.alerts.create(rule({triggerOnInitial:true}));
  const task=createPhase6Task({jobs:f.jobs,alerts:f.alerts,clock:f.clock,request:{operation:'alerts',ruleIds:[r.id],snapshot:snapshot(101)}});
  const queued=await task.enqueue();await f.jobs.cancel(queued.id);assert.equal((await task.runOne()).status,'idle');
  f.set(epoch+minute);const task2=createPhase6Task({jobs:f.jobs,alerts:f.alerts,clock:f.clock,request:{operation:'alerts',ruleIds:[r.id],snapshot:snapshot(101,minute)}});
  const q=await task2.enqueue(),lease=await f.jobs.claim({jobId:q.id});assert.ok(lease);f.set(epoch+2*minute);
  await assert.rejects(f.alerts.check([r.id],snapshot(101,2*minute),{job:lease}),/JOB_LEASE_LOST/);
  assert.equal((await f.alerts.history(r.id)).items.length,0);assert.equal((await f.alerts.list()).items[0].state.phase,'BASELINE_REQUIRED');
});

test('Phase 3 as-of loader retains vintages and bounds all source reads',async t=>{
  const f=await database(t),input=study();
  // Real Phase 3 records with original local availability; no network/provider calls.
  f.set(epoch+8*minute);
  await f.repository.commitBatch({sourceId:'fixture-bars',fetchedAt:iso(f.clock()),processedAt:iso(f.clock()),mode:'offline-fixture',instruments:[{...instrument,metadata:{...instrument.metadata,priceBasis:'provider-quotes'}}]});
  for(const b of input.barRows){f.set(Date.parse(b.stored_at));await f.repository.commitBatch({sourceId:'fixture-bars',fetchedAt:b.fetched_at,processedAt:b.processed_at,mode:'offline-fixture',histories:[{instrumentId:instrument.id,bars:[b.body.bar],from:b.body.bar.time,to:b.stored_at,observedAt:b.stored_at,intervalMs:minute,delayMs:0,maxAgeMs:minute,provenance:{mode:'offline-fixture'}}]});}
  f.set(epoch+10*minute);await f.repository.commitBatch({sourceId:'fixture-macro',fetchedAt:iso(f.clock()),processedAt:iso(f.clock()),mode:'offline-fixture',events:[input.eventRows[0].body]});
  f.set(epoch+30*minute);
  const loaded=await loadEventStudyRequest({repository:f.repository,eventSources:['fixture-macro'],barSource:'fixture-bars',request:{...input,instrument:undefined,eventRows:undefined,barRows:undefined,instrumentId:instrument.id}});
  assert.equal(loaded.mode,'offline-fixture');const integrated=await analyzeEventStudy(loaded);assert.equal(integrated.observations.length,1,JSON.stringify({excluded:integrated.excluded,bars:loaded.barRows.length,events:loaded.eventRows}));
  await assert.rejects(readAnalysisRows(f.repository,{sourceId:'fixture-bars',kind:'bar',asOf:input.asOf,maxRows:2}),/budget/);
  const freshAt=epoch+13*minute;f.set(freshAt);
  const s=await loadAlertSnapshot({repository:f.repository,options:{sourceId:'fixture-bars',instrumentId:instrument.id,from:iso(epoch+7*minute),to:iso(freshAt),asOf:iso(freshAt),intervalMs:minute,maxAgeMs:minute,delayMs:0,calendar}});
  assert.equal(s.dataAt,iso(freshAt));assert.equal(s.receivedAt,iso(freshAt));assert.equal(s.priceBasis,'provider-quotes');
  assert.equal(evaluate(rule({priceBasis:'provider-quotes',triggerOnInitial:true}),null,s,freshAt).status,'TRIGGERED');
  const econ=await loadEconomicSnapshot({repository:f.repository,instrument,sourceIds:['missing'],asOf:iso(freshAt)});assert.equal(econ.sourceError,'CALENDAR_SOURCE_UNAVAILABLE');
});

test('event studies compute multi-event distribution, sample volatility and both reaction directions',async()=>{
  const base=study(),input={...base,eventRows:[],barRows:[]};
  for(const [i,delta] of [3,-3,6,-6,0].entries()) {
    const shift=i*15*minute,release=epoch+10*minute+shift;
    const e=event({externalId:'cpi-'+i},release);input.eventRows.push(row(e));
    for(const original of base.barRows) {
      const b=structuredClone(original),t=Date.parse(b.body.bar.time)+shift,j=(t-release)/minute;
      const close=j<0?100:100+delta*(j+1)/3;
      b.body.bar={time:iso(t),open:close,high:close+1,low:close-1,close};
      b.stored_at=b.fetched_at=b.processed_at=iso(t+minute);input.barRows.push(b);
    }
  }
  input.asOf=iso(epoch+90*minute);
  const out=await analyzeEventStudy(input),s=out.summaries[0];
  assert.equal(out.sampleSize,5);assert.equal(s.smallSample,false);assert.equal(s.priceChange.mean,0);assert.equal(s.priceChange.median,0);
  assert.ok(Math.abs(s.priceChange.sampleStd-Math.sqrt(22.5))<1e-12);
  assert.equal(s.priceChange.positive,2);assert.equal(s.priceChange.negative,2);assert.equal(s.priceChange.zero,1);assert.equal(s.distribution.length,5);
  assert.ok(out.observations.every(x=>Number.isFinite(x.closeReturnVolatility)));
});

test('overnight sessions, UTC offsets across DST and mixed publication bars are explicit',async()=>{
  const input=study(),shift=Date.parse('2026-10-24T23:50:00Z')-epoch;
  const shiftedCalendar={reference:'synthetic overnight UTC from explicit local offsets',from:'2026-10-24T22:00:00Z',to:'2026-10-25T04:00:00Z',windows:[{start:'2026-10-24T22:00:00Z',end:'2026-10-25T04:00:00Z'}]};
  const e=event({publishedAt:'2026-10-25T02:00:00+02:00'},epoch+10*minute+shift);input.eventRows=[row(e)];
  for(const b of input.barRows){b.body.bar.time=iso(Date.parse(b.body.bar.time)+shift);b.stored_at=b.fetched_at=b.processed_at=iso(Date.parse(b.stored_at)+shift);}
  input.calendar=shiftedCalendar;input.asOf='2026-10-25T02:30:00+01:00';
  assert.equal((await analyzeEventStudy(input)).observations.length,1);
  const r=rule({triggerOnInitial:true});assert.equal(evaluate(r,null,snapshot(101,shift+10*minute,{calendar:shiftedCalendar}),epoch+shift+10*minute).status,'TRIGGERED');
  const mixed=study();mixed.eventRows=[row(event({},epoch+10*minute+30000))];
  const out=await analyzeEventStudy(mixed);assert.equal(out.observations.length,1);assert.equal(out.observations[0].mixedPublicationBarExcluded,true);assert.equal(out.observations[0].barCount,2);
  assert.equal(out.observations[0].preAnchorAt,iso(epoch+10*minute));
  // Unzoned times never become an assumed UTC release.
  mixed.eventRows[0].body.published.at='2026-10-22T12:10:30';await assert.rejects(analyzeEventStudy(mixed),/timezone/);
});

test('as-of boundaries, delayed bars and missing original vintages prevent future leakage',async()=>{
  let input=study();input.eventRows[0].stored_at=iso(epoch+40*minute);assert.equal((await analyzeEventStudy(input)).sampleSize,0);
  input=study();const anchor=input.barRows[2];anchor.stored_at=anchor.fetched_at=anchor.processed_at=iso(epoch+10*minute+5000);
  input.maxObservationLagMs=10000;assert.ok((await analyzeEventStudy(input)).excluded.some(x=>x.reason==='PRE_ANCHOR_NOT_KNOWN_AT_RELEASE_OBSERVATION'));
  input=study();input.barRows[4].stored_at=iso(epoch+20*minute);assert.equal((await analyzeEventStudy(input)).observations.length,0);
  input=study();input.eventRows[0].body.expectation=null;input.eventRows[0].body.values.expected=3;assert.equal((await analyzeEventStudy(input)).observations[0].expected,null);
  const e=event({kind:'calendar',actual:null,scheduledAt:iso(epoch+minute)},epoch),r=rule({type:'ECONOMIC_EVENT',condition:{families:['CPI']}});
  assert.equal(evaluate(r,null,snapshot(null,0,{events:[row({...e,fetchedAt:iso(epoch+1)})]})).triggers.length,0);
  const active=row(e,iso(epoch),1),cancelled=row({...e,status:'CANCELLED'},iso(epoch),2);
  assert.equal(evaluate(r,null,snapshot(null,0,{events:[cancelled,active]})).triggers.length,0);
});

test('abort after an attempted trigger insert rolls back history and state together',async t=>{
  const f=await database(t),r=await f.alerts.create(rule({triggerOnInitial:true})),controller=new AbortController();
  const proxy={query:(...args)=>f.db.query(...args),transaction:fn=>f.db.transaction(tx=>fn({query:async(...args)=>{const result=await tx.query(...args);if(args[0].startsWith('INSERT INTO marcel_market_analysis.alert_history'))controller.abort();return result;}}))};
  const alerts=createAlertRepository({database:proxy,ownerId:'alice',clock:f.clock,allowFixtures:true});
  await assert.rejects(alerts.check([r.id],snapshot(101),{signal:controller.signal}),{code:'ABORTED'});
  assert.equal((await f.alerts.history(r.id)).items.length,0);assert.equal((await f.alerts.list()).items[0].state.phase,'BASELINE_REQUIRED');
});

test('study job uses existing queue, stores only completed result and supports idempotent rereads',async t=>{
  const f=await database(t);f.set(epoch+30*minute);
  const task=createPhase6Task({jobs:f.jobs,alerts:f.alerts,clock:f.clock,request:{operation:'event-study',study:study()}});
  const q=await task.enqueue(),out=await task.runOne();assert.equal(out.status,'succeeded');assert.equal(out.result.result.sampleSize,1);
  assert.equal((await f.alerts.getStudy(out.result.id)).sampleSize,1);assert.equal((await f.jobs.get(q.id)).status,'succeeded');
  const repeated=createPhase6Task({jobs:f.jobs,alerts:f.alerts,clock:f.clock,request:{operation:'event-study',study:study()}});assert.equal((await repeated.enqueue()).id,q.id);
});

test('bounded event-study workload yields to cancellation and records empirical runtime',async t=>{
  const base=study(),input={...base,eventRows:Array.from({length:250},(_,i)=>row({...base.eventRows[0].body,eventId:'fixture-'+i})),windows:Array.from({length:2},(_,i)=>({beforeMs:(2+i)*minute,afterMs:3*minute}))};
  const begun=performance.now(),out=await analyzeEventStudy(input);const elapsed=performance.now()-begun;
  assert.equal(out.observations.length,500);assert.equal(out.sampleSize,250);assert.equal(out.assumptions.overlappingEventWindowsMayBeDependent,true);
  t.diagnostic('500 fixture observations: '+elapsed.toFixed(1)+' ms; JS heap '+Math.round(process.memoryUsage().heapUsed/1048576)+' MiB (whole test process, not incremental)');
  const controller=new AbortController(),pending=analyzeEventStudy(input,{signal:controller.signal});setImmediate(()=>controller.abort());await assert.rejects(pending,{code:'ABORTED'});
  const excessive={...input,windows:Array.from({length:5},()=>({beforeMs:1000*minute,afterMs:1000*minute}))};await assert.rejects(analyzeEventStudy(excessive),/budget/);
});
