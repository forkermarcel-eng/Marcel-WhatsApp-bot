import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {PGlite} from '@electric-sql/pglite';
import {createLocalTimeMachine,createSimulationTask,loadSimulationRequest} from '../market-analysis/simulation-service.js';
import {createAnalysisRepository} from '../market-analysis/repository.js';
import {createAnalysisJobs} from '../market-analysis/jobs.js';
import {normalizeInstrument} from '../market-analysis/instruments.js';
const pythonPath=process.env.MARKET_ANALYSIS_TEST_PYTHON;
const start=Date.parse('2026-10-22T00:00:00Z'),at=n=>new Date(n).toISOString();
function fixture() {
  const from=at(start),to=at(start+80*60000);
  return {operation:'time-machine',mode:'offline-fixture',allowSmallFixtureSample:true,asOf:to,dataKnownAt:to,trainingEnd:to,from,to,intervalMs:60000,delayMs:0,
    instrument:normalizeInstrument({provider:'fixture',environment:'offline',symbol:'INDEX',kind:'cfd',group:'indices',active:true,
      metadata:{tickSize:.25,priceBasis:'mid',shortAllowed:true},provenance:{mode:'offline-fixture'}}),
    calendar:{from,to,reference:'synthetic UTC fixture',windows:[{id:'fixture',start:from,end:to}]},
    bars:Array.from({length:80},(_,i)=>({time:at(start+i*60000),open:100+i*.25,high:100.5+i*.25,low:99.5+i*.25,close:100.25+i*.25})),
    paths:100,horizonBars:10,seed:19,plan:{side:'LONG',entry:'120.00',stop:'118.00',target:'124.00'}};
}
test('all pure Phase 5 simulation and risk tests pass with an explicit existing interpreter',()=>{
  assert.ok(pythonPath,'Set MARKET_ANALYSIS_TEST_PYTHON.');
  const r=spawnSync(pythonPath,['-I','-B','-X','utf8','test/market-analysis-phase5.test.py'],{env:{},windowsHide:true,encoding:'utf8',timeout:10000});
  assert.equal(r.status,0,r.stderr);assert.match(r.stderr,/Ran 19 tests/);
});
test('time-machine bridge is reproducible, compatible with Phase 4 plans and does not invent net costs',async()=>{
  const engine=createLocalTimeMachine({pythonPath}),r=fixture();const a=await engine.analyze([r]),b=await engine.analyze([r]);
  assert.deepEqual(a,b);assert.equal(a[0].result.category,'MODEL_SIMULATION');assert.equal(a[0].result.net,null);
  assert.equal(a[0].result.mode,'offline-fixture');assert.match(a[0].result.training.sampleWarning,/FIXTURE/);
  await assert.rejects(engine.analyze([{...r,operation:'broker-execute'}]),/operation/);
});
test('10000 paths finish through the actual bounded Python bridge',async()=>{
  const r={...fixture(),paths:10000,horizonBars:60,plan:{side:'LONG',entry:120,stop:20,target:500}};
  const result=await createLocalTimeMachine({pythonPath,timeoutMs:10000}).analyze([r]);
  assert.equal(result[0].result.paths,10000);assert.equal(result[0].result.events.neither,10000);
});
test('work quotas are enforced across the entire batch, invalid samples and future knowledge are refused',async()=>{
  const engine=createLocalTimeMachine({pythonPath});
  await assert.rejects(engine.analyze(Array.from({length:5},()=>({...fixture(),paths:10000,horizonBars:60}))),{code:'SIMULATION_WORK_LIMIT'});
  const a=fixture();a.allowSmallFixtureSample=false;
  const b=fixture();b.dataKnownAt=at(start+86400000);
  const result=await engine.analyze([a,b,{...fixture(),mode:'network'}]);assert.equal(result[0].error,'TRAINING_SESSIONS_TOO_FEW');assert.equal(result[1].error,'SNAPSHOT_NOT_YET_KNOWN');
  assert.equal(result[2].error,'MODE_REQUIRED');
});
test('simulation process abort/timeout is bounded and a closed API cannot fetch external data',async()=>{
  const engine=createLocalTimeMachine({pythonPath}),controller=new AbortController();
  const running=engine.analyze([{...fixture(),paths:10000,horizonBars:240}],{signal:controller.signal});controller.abort();
  await assert.rejects(running,{code:'ABORTED'});
  await assert.rejects(createLocalTimeMachine({pythonPath,timeoutMs:10}).analyze([{...fixture(),paths:10000,horizonBars:240}]),{code:'TIMEOUT'});
  assert.throws(()=>createLocalTimeMachine());
});
async function isolated(t) {
  const db=new PGlite();t.after(()=>db.close());await db.exec(fs.readFileSync('migrations/20261022_brain_market_analysis.sql','utf8'));
  const input=fixture(),clock=()=>Date.parse(input.asOf),repository=createAnalysisRepository({database:db,clock}),jobs=createAnalysisJobs({database:db,clock});
  await repository.commitBatch({sourceId:'fixture',fetchedAt:input.asOf,processedAt:input.asOf,instruments:[input.instrument],histories:[{
    ...input,instrumentId:input.instrument.id,observedAt:input.asOf,maxAgeMs:120000,provenance:{mode:'offline-fixture'}}]});
  return {db,input,clock,repository,jobs};
}
test('Phase 1–4 repository/quality interfaces feed the new simulation without external access',async t=>{
  const f=await isolated(t),input=await loadSimulationRequest({repository:f.repository,sourceId:'fixture',instrumentId:f.input.instrument.id,
    ...f.input,maxAgeMs:120000,paths:100});
  assert.equal(input.bars.length,80);const result=await createLocalTimeMachine({pythonPath}).analyze([input]);assert.equal(result[0].ok,true);
  assert.equal(result[0].result.net,null);assert.equal((await f.repository.read({sourceId:'fixture',kind:'bar'})).items.length,80);
});
test('simulation job uses existing isolation, idempotence, fencing and protected source status',async t=>{
  const f=await isolated(t);
  const foreign=await f.jobs.enqueue({sourceId:'fed',type:'news-sync',idempotencyKey:'not-simulation',policy:{sourceId:'fed',type:'news-sync',intervalMs:60000,mode:'offline-fixture'}});
  const task=createSimulationTask({jobs:f.jobs,repository:f.repository,scanner:createLocalTimeMachine({pythonPath}),requests:[f.input],clock:f.clock});
  const job=await task.enqueue();assert.equal((await task.enqueue()).id,job.id);
  assert.equal(task.result(),null);const result=await task.runOne();assert.equal(result.status,'succeeded');assert.equal(result.results[0].result.paths,100);
  assert.equal((await f.jobs.get(foreign.id)).status,'queued');assert.equal((await f.jobs.get(job.id)).status,'succeeded');
  assert.equal((await f.repository.read({sourceId:'analysis-local:phase5',kind:'bar'})).items.length,0);
});
test('failed simulation and job cancellation publish no successful output',async t=>{
  const f=await isolated(t);const task=createSimulationTask({jobs:f.jobs,repository:f.repository,scanner:createLocalTimeMachine({pythonPath}),requests:[{...f.input,paths:10001}],clock:f.clock});
  const job=await task.enqueue();assert.equal((await task.runOne()).status,'failed');assert.equal(task.result(),null);assert.equal((await f.jobs.get(job.id)).error_code,'BATCH_INVALID');
  const cancelled=createSimulationTask({jobs:f.jobs,repository:f.repository,scanner:createLocalTimeMachine({pythonPath}),requests:[{...f.input,seed:20}],clock:f.clock});
  const q=await cancelled.enqueue();await f.jobs.cancel(q.id);assert.equal((await cancelled.runOne()).status,'idle');assert.equal(cancelled.result(),null);
});
