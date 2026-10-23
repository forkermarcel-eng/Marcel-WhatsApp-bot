import test from 'node:test';import assert from 'node:assert/strict';
import {phase7Fixture}from'./market-analysis-phase7-fixture.js';
import {loadAnalysisRequest}from'../market-analysis/analysis-service.js';
import {createMarketAnalysisRuntime}from'../market-analysis/api-runtime.js';
const pythonPath=process.env.MARKET_ANALYSIS_TEST_PYTHON;
test('mixed fixture bars never lose their fixture label in loader or API series',async t=>{
 const f=await phase7Fixture();t.after(()=>f.close());const at=new Date(f.clock()).toISOString();
 await f.repository.commitBatch({sourceId:f.sourceId,fetchedAt:at,processedAt:at,mode:'offline-fixture',instruments:[{...f.instrument,provenance:{mode:'network',reference:'CLAIMED NETWORK PROVENANCE IN OFFLINE ADVERSARIAL TEST'}}],histories:[{instrumentId:f.instrument.id,from:'2026-10-22T01:19:00Z',to:f.base.to,observedAt:at,intervalMs:60000,delayMs:0,maxAgeMs:60000,bars:[{time:'2026-10-22T01:19:00.000Z',open:119,high:120,low:118,close:119}],provenance:{mode:'network',reference:'ADVERSARIAL OFFLINE TEST ONLY'}}]});
 const input=await loadAnalysisRequest({...f.base,repository:f.repository,asOf:at,calendar:f.calendar,maxAgeMs:60000,delayMs:0});assert.equal(input.mode,'offline-fixture');assert.ok(input.qualityReasons.includes('OFFLINE_FIXTURE'));assert.equal((await f.runtime.series(f.base)).mode,'offline-fixture');
});
test('production-default runtime refuses fixture computations before enqueue',async t=>{
 const f=await phase7Fixture();t.after(()=>f.close());const runtime=createMarketAnalysisRuntime({database:f.database,clock:f.clock,pythonPath,calendars:new Map([[f.instrument.id,f.calendar]])});
 for(const operation of ['scan','time-machine','risk','event-study'])await assert.rejects(runtime.createJob('owner',{...f.base,operation,paths:100,family:'CPI',beforeMs:300000,afterMs:300000}),e=>e.code==='FIXTURE_INPUT_DISABLED');
 assert.equal((await f.database.query('SELECT count(*)::int AS n FROM marcel_market_analysis.jobs')).rows[0].n,0);
});
test('explicit local test mode still permits marked fixture calculations',async t=>{
 const f=await phase7Fixture({pythonPath});t.after(()=>f.close());const job=await f.runtime.createJob('owner',{...f.base,operation:'scan'}),result=await f.runtime.run('owner',job.id);assert.equal(result.status,'succeeded');assert.equal(result.result[0].result.mode,'offline-fixture');
});
