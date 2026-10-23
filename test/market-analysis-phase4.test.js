import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import {normalizeInstrument} from '../market-analysis/instruments.js';
import {normalizeAnalysisCalendar} from '../market-analysis/sessions.js';
import {createLocalScanner} from '../market-analysis/scanner.js';
import {loadAnalysisRequest,createLocalAnalysisTask} from '../market-analysis/analysis-service.js';
import {createAnalysisRepository} from '../market-analysis/repository.js';
import {createAnalysisJobs} from '../market-analysis/jobs.js';

const pythonPath=process.env.MARKET_ANALYSIS_TEST_PYTHON;
const start=Date.parse('2026-10-22T12:00:00Z'),step=60000;
const iso=n=>new Date(n).toISOString();
function request() {
  const instrument=normalizeInstrument({provider:'fixture',environment:'offline',symbol:'EURUSD',kind:'fx',group:'forex',active:true,base:'EUR',quote:'USD',
    metadata:{tickSize:.00001,priceBasis:'mid',shortAllowed:true},provenance:{mode:'offline-fixture'}});
  const from=iso(start),to=iso(start+40*step);
  const bars=Array.from({length:40},(_,i)=>({time:iso(start+i*step),open:1+i/1000,high:1.001+i/1000,low:.999+i/1000,close:1+i/1000}));
  return {instrument,bars,from,to,asOf:to,intervalMs:step,delayMs:0,mode:'offline-fixture',calendar:{from,to,reference:'synthetic UTC fixture',windows:[{id:'fixture',start:from,end:to}]}};
}

test('explicit Python runtime runs all pure scanner/entry/exit unit tests',()=>{
  assert.ok(pythonPath,'Set MARKET_ANALYSIS_TEST_PYTHON to an existing local interpreter.');
  const result=spawnSync(pythonPath,['-I','-B','-X','utf8','test/market-analysis-phase4.test.py'],{env:{},encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr);assert.match(result.stderr,/Ran 18 tests/);
});

test('session adapter handles DST, holidays and explicit overnight close dates',()=>{
  const calendar=normalizeAnalysisCalendar({from:'2026-03-06T00:00:00Z',to:'2026-03-10T00:00:00Z',zone:'America/New_York',reference:'synthetic dated calendar',intervalMs:300000,
    days:[{date:'2026-03-05',closed:true},{date:'2026-03-06',closed:false,open:'09:30',close:'16:00'},
      {date:'2026-03-07',closed:true},{date:'2026-03-08',closed:true},{date:'2026-03-09',closed:false,open:'09:30',close:'16:00'}]});
  assert.equal(calendar.windows[0].start,'2026-03-06T14:30:00.000Z');assert.equal(calendar.windows[1].start,'2026-03-09T13:30:00.000Z');
  const overnight=normalizeAnalysisCalendar({from:'2026-10-22T22:00:00Z',to:'2026-10-23T06:00:00Z',zone:'UTC',reference:'synthetic overnight',intervalMs:step,
    days:[{date:'2026-10-22',closed:false,open:'22:00',close:'06:00',closeDate:'2026-10-23'},{date:'2026-10-23',closed:true}]});
  assert.equal(overnight.windows[0].end,'2026-10-23T06:00:00.000Z');
});

test('ambiguous/nonexistent session times and unclassified dates fail closed',()=>{
  const base={from:'2026-10-25T00:00:00Z',to:'2026-10-25T03:00:00Z',zone:'Europe/London',reference:'synthetic DST fixture',intervalMs:step};
  assert.throws(()=>normalizeAnalysisCalendar({...base,days:[{date:'2026-10-25',closed:false,open:'01:30',close:'03:00'}]}),/Ambiguous/);
  assert.equal(normalizeAnalysisCalendar({...base,days:[{date:'2026-10-25',closed:false,open:'01:30',openOffsetMinutes:60,close:'03:00'}]}).windows[0].start,'2026-10-25T00:30:00.000Z');
  assert.throws(()=>normalizeAnalysisCalendar({...base,days:[]}),/unclassified/);
  assert.throws(()=>normalizeAnalysisCalendar({...base,from:'2026-03-08T05:00:00Z',to:'2026-03-09T00:00:00Z',zone:'America/New_York',days:[{date:'2026-03-08',closed:false,open:'02:30',close:'04:00'}]}),/nonexistent/);
});

test('bounded bridge preserves independent results and rejects ambient/default runtime',async()=>{
  assert.throws(()=>createLocalScanner());const scanner=createLocalScanner({pythonPath});
  const bad=request();bad.instrument.active=false;
  const result=await scanner.analyze([request(),bad]);assert.equal(result[0].result.scan.status,'READY');assert.equal(result[1].error,'INSTRUMENT_REQUIRED');
  assert.equal(result[0].result.mode,'offline-fixture');assert.equal(result[0].result.quality.usableForCurrentMonitoring,false);
  await assert.rejects(scanner.analyze(Array(13).fill(request())),/limit/);
  await assert.rejects(createLocalScanner({pythonPath:pythonPath+'.missing'}).analyze([request()]),{code:'PYTHON_UNAVAILABLE'});
});

test('bridge cancellation and timeout terminate the one-shot process',async()=>{
  const controller=new AbortController();controller.abort();
  await assert.rejects(createLocalScanner({pythonPath}).analyze([request()],{signal:controller.signal}),{code:'ABORTED'});
  const scanner=createLocalScanner({pythonPath});const active=new AbortController();const running=scanner.analyze([request()],{signal:active.signal});active.abort();
  await assert.rejects(running,{code:'ABORTED'});
  // Finite 12-request work deliberately exceeds a 10ms interpreter startup budget.
  await assert.rejects(createLocalScanner({pythonPath,timeoutMs:10}).analyze(Array.from({length:12},()=>request())),{code:'TIMEOUT'});
});

async function store(t) {
  const db=new PGlite();t.after(()=>db.close());await db.exec(fs.readFileSync('migrations/20261022_brain_market_analysis.sql','utf8'));
  const input=request(),clock=()=>Date.parse(input.asOf),repository=createAnalysisRepository({database:db,clock});
  await repository.commitBatch({sourceId:'fixture',fetchedAt:input.asOf,processedAt:input.asOf,mode:'offline-fixture',instruments:[input.instrument],histories:[{
    instrumentId:input.instrument.id,bars:input.bars,from:input.from,to:input.to,observedAt:input.asOf,intervalMs:step,delayMs:0,maxAgeMs:120000,provenance:{mode:'offline-fixture'}}]});
  return {db,input,clock,repository,jobs:createAnalysisJobs({database:db,clock})};
}

test('Phase 3 versioned repository feeds Phase 4 without changes or fabricated data',async t=>{
  const f=await store(t),input=await loadAnalysisRequest({repository:f.repository,sourceId:'fixture',instrumentId:f.input.instrument.id,
    from:f.input.from,to:f.input.to,asOf:f.input.asOf,intervalMs:step,calendar:f.input.calendar,maxAgeMs:120000,delayMs:0});
  assert.equal(input.bars.length,40);assert.equal(input.mode,'offline-fixture');assert.match(input.inputFingerprint,/^[a-f\d]{64}$/);
  const result=await createLocalScanner({pythonPath}).analyze([input]);assert.equal(result[0].result.scan.status,'READY');
  await assert.rejects(loadAnalysisRequest({repository:f.repository,sourceId:'fixture',instrumentId:f.input.instrument.id,
    from:f.input.from,to:f.input.to,asOf:f.input.asOf,intervalMs:step,calendar:f.input.calendar,maxAgeMs:120000,maxReadRows:2}),/budget/);
});

test('analysis task reuses Phase 3 leases/idempotence and never claims another source job',async t=>{
  const f=await store(t);
  const other=await f.jobs.enqueue({sourceId:'fed',type:'news-sync',idempotencyKey:'offline-other',policy:{sourceId:'fed',type:'news-sync',mode:'offline-fixture',intervalMs:60000}});
  const task=createLocalAnalysisTask({jobs:f.jobs,repository:f.repository,scanner:createLocalScanner({pythonPath}),requests:[f.input],clock:f.clock});
  const job=await task.enqueue();assert.equal((await task.enqueue()).id,job.id);assert.equal(task.result(),null);
  const pending=task.runOne();assert.equal((await task.runOne()).status,'busy');
  const output=await pending;assert.equal(output.status,'succeeded');assert.equal(output.results[0].result.scan.status,'READY');
  assert.equal((await f.jobs.get(job.id)).status,'succeeded');assert.equal((await f.jobs.get(other.id)).status,'queued');
  const providerState=await f.repository.sourceStatus('fixture',{maxAgeMs:120000});assert.equal(providerState.state.mode,'offline-fixture');
  assert.equal((await f.repository.read({sourceId:'analysis-local',kind:'bar'})).items.length,0);
  assert.equal((await task.runOne()).status,'idle');
});

test('invalid computation fails its local job without replacing data or exposing results',async t=>{
  const f=await store(t),bad=request();bad.bars[0].low=99;
  const task=createLocalAnalysisTask({jobs:f.jobs,repository:f.repository,scanner:createLocalScanner({pythonPath}),requests:[bad],clock:f.clock});
  const job=await task.enqueue();assert.equal((await task.runOne()).status,'failed');assert.equal(task.result(),null);
  assert.equal((await f.jobs.get(job.id)).error_code,'BATCH_INVALID');assert.equal((await f.repository.read({sourceId:'fixture',kind:'bar'})).items.length,40);
});

test('new module graph has no broker/API clients, scheduler, LLM or production database access',()=>{
  const files=['sessions.js','scanner.js','analysis-service.js'].map(x=>'market-analysis/'+x);
  const python=fs.readdirSync('market-analysis/python').filter(x=>x.endsWith('.py')).map(x=>'market-analysis/python/'+x);
  for(const p of [...files,...python]) {
    const text=fs.readFileSync(p,'utf8');assert.doesNotMatch(text,/from ['"].*(?:Trading|broker|openai)|import (?:requests|urllib)|setInterval|new Pool|DATABASE_URL|fetch\(/,p);
  }
});
