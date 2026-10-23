import test,{before,after}from'node:test';import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import {spawnSync}from'node:child_process';import express from'express';
import {phase7Fixture}from'./market-analysis-phase7-fixture.js';import{registerMarketAnalysisRoutes}from'../market-analysis/routes.js';
import{loadAnalysisConfiguration,createConfiguredAnalysisRuntime}from'../market-analysis/runtime-config.js';import{createLocalScanner}from'../market-analysis/scanner.js';import{mintAnalysisAssertion}from'../market-analysis/auth.js';import{normalizeInstrument}from'../market-analysis/instruments.js';
const pythonPath=process.env.MARKET_ANALYSIS_TEST_PYTHON,key='OFFLINE-RUNTIME-ONLY';let f,server,url,configuration,configPath,fx;
const res=()=>({statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(data){this.data=data;return this;}});
before(async()=>{
 f=await phase7Fixture();fx=normalizeInstrument({provider:'offline-fixture',environment:'test',symbol:'FX-FIXTURE',name:'OFFLINE synthetic FX',kind:'fx',group:'forex',base:'EUR',quote:'USD',active:true,metadata:{tickSize:.0001,priceBasis:'mid',shortAllowed:true},provenance:{mode:'offline-fixture'}});
 const now=new Date(f.clock()).toISOString(),bars=Array.from({length:80},(_,i)=>{const close=Number((1.1+i*.0001).toFixed(4));return{time:new Date(Date.parse(f.base.from)+i*60000).toISOString(),open:close,high:Number((close+.0002).toFixed(4)),low:Number((close-.0002).toFixed(4)),close};});
 await f.repository.commitBatch({sourceId:f.sourceId,fetchedAt:now,processedAt:now,mode:'offline-fixture',instruments:[fx],histories:[{instrumentId:fx.id,bars,from:f.base.from,to:f.base.to,observedAt:now,intervalMs:60000,delayMs:0,maxAgeMs:60000,provenance:{mode:'offline-fixture'}}]});
 const fxContract={...f.contract,instrumentId:fx.id,kind:'fx',unitsPerQuantity:'100000',tickSize:'.0001',pipSize:'.0001',quantityStep:'.01',minQuantity:'.01'};
 configuration={schemaVersion:1,mode:'offline-fixture',pythonPath,memoryMb:256,calendars:[{instrumentId:f.instrument.id,calendar:f.calendar},{instrumentId:fx.id,calendar:f.calendar}],specifications:[{instrumentId:f.instrument.id,contract:f.contract,costs:f.costs},{instrumentId:fx.id,contract:fxContract,costs:f.costs}]};
 fs.mkdirSync('tmp/market-analysis-runtime',{recursive:true});configPath=path.resolve('tmp/market-analysis-runtime/offline-config.json');fs.writeFileSync(configPath,JSON.stringify(configuration));
 const app=express();app.use(express.json({limit:'64kb'}));registerMarketAnalysisRoutes({app,pool:f.database,authorized:req=>req.headers.authorization==='Bearer '+key,sessionKey:key,clock:f.clock,env:{NODE_ENV:'test',MARCEL_ANALYSIS_CONFIG_PATH:configPath}});
 server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));url='http://127.0.0.1:'+server.address().port+'/dashboard-api/marcel-brain/market-analysis';
});
after(async()=>{await new Promise(r=>server?.close(r));await f?.close();});
async function call(op,body,{owner='a',auth=true}={}){const response=await fetch(url+(body?'':'?'+new URLSearchParams({op,...(typeof op==='object'?op:{})})),{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer '+key,'X-Marcel-Analysis-Session':mintAnalysisAssertion({sub:owner.repeat(64),sid:'c'.repeat(64),exp:f.clock()+60000},key,f.clock())}:{})},...(body?{body:JSON.stringify({op,...body})}:{})});return{status:response.status,body:await response.json()};}
async function run(input){f.advance();const q=await call('job-create',input);assert.equal(q.status,202,JSON.stringify(q));const r=await call('job-run',{id:q.body.result.id});assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.body.result.status,'succeeded',JSON.stringify(r));return r.body.result;}
test('actual production registration loads an operator file and exposes an authenticated bounded interpreter probe',async()=>{
 assert.equal((await call('runtime-status',null,{auth:false})).status,401);const r=await call('runtime-status');assert.equal(r.status,200);assert.equal(r.body.result.ready,true);assert.match(r.body.result.runtime.pythonVersion,/^3\./);assert.equal(r.body.result.runtime.memoryLimitMb,256);assert.ok(r.body.result.runtime.peakWorkingSetBytes>0);assert.equal(r.body.result.configured.calendars,2);assert.equal(r.body.result.fixtureEnabled,true);assert.ok(!JSON.stringify(r).includes(pythonPath));
});
test('Long and Short scanners, entry and exit pass through authenticated persistent jobs',async()=>{
 const long=await run({...f.base,operation:'scan'});assert.equal(long.result[0].result.scan.status,'READY');assert.equal(long.result[0].result.exit.status,'HYPOTHETICAL');assert.ok(long.result[0].result.entry);
 const short=await run({...f.base,operation:'scan',side:'SHORT',stop:'122',target:'116'});assert.equal(short.result[0].result.scan.status,'READY');assert.equal(short.result[0].result.exit.status,'HYPOTHETICAL');
 const forbidden=await call({op:'job',id:long.id},null,{owner:'b'});assert.equal(forbidden.status,404);
 const cancelled=await call('job-cancel',{id:long.id},{owner:'b'});assert.equal(cancelled.status,404);
});
test('Time Machine and historical setups use the same configured Python bridge and queue',async()=>{
 const started=performance.now(),time=await run({...f.base,operation:'time-machine',paths:10000,horizonBars:60});assert.equal(time.result[0].result.paths,10000);const elapsedMs=performance.now()-started,metrics=(await call('runtime-status')).body.result;fs.writeFileSync('tmp/market-analysis-runtime/runtime-metrics.json',JSON.stringify({offlineFixture:true,paths:10000,horizonBars:60,elapsedMs,runtime:metrics.runtime,limits:metrics.limits,productionMeasurement:false},null,2));
 const historical=await run({...f.base,operation:'historical-setups',trainingEnd:'2026-10-22T00:30:00Z',evaluationStart:'2026-10-22T00:31:00Z',parametersKnownAt:'2026-10-22T00:29:00Z',setupRule:'EMA_CROSS',horizonBars:5});assert.equal(historical.result[0].result.category,'HISTORICAL_OHLC_REPLAY');
});
test('CFD and Forex risk use explicit separate contract specifications over the authenticated API',async()=>{
 const cfd=await run({...f.base,operation:'risk'});assert.equal(cfd.result[0].result.status,'COMPLETE');
 const forex=await run({...f.base,instrumentId:fx.id,operation:'risk',entry:'1.1080',stop:'1.1060',target:'1.1120',quantity:'.1'});assert.equal(forex.result[0].result.status,'COMPLETE');assert.equal(forex.result[0].result.pipValueAccount,'1.00000');
});
test('production configuration rejects fixture calculations before enqueue and deployed fixture mode is impossible',async()=>{
 assert.throws(()=>loadAnalysisConfiguration({config:configuration,env:{NODE_ENV:'production'}}),{code:'ANALYSIS_CONFIGURATION_INVALID'});
 assert.throws(()=>loadAnalysisConfiguration({config:configuration,env:{NODE_ENV:'test',RAILWAY_ENVIRONMENT_NAME:'production'}}),{code:'ANALYSIS_CONFIGURATION_INVALID'});
 const prod=createConfiguredAnalysisRuntime({database:f.database,clock:f.clock,env:{NODE_ENV:'production'},config:{...configuration,mode:'production'}}),before=Number((await f.database.query('SELECT count(*) AS n FROM marcel_market_analysis.jobs')).rows[0].n);
 await assert.rejects(prod.createJob('prod',{...f.base,operation:'scan'}),{code:'FIXTURE_INPUT_DISABLED'});assert.equal(Number((await f.database.query('SELECT count(*) AS n FROM marcel_market_analysis.jobs')).rows[0].n),before);
});
test('invalid operator config is isolated to analysis and never breaks route registration',async()=>{
 let handler;assert.doesNotThrow(()=>registerMarketAnalysisRoutes({app:{all:(_p,h)=>{handler=h;}},pool:f.database,authorized:()=>true,sessionKey:key,clock:f.clock,env:{MARCEL_ANALYSIS_CONFIG_PATH:'relative/untrusted.json'}}));const response=res();await handler({method:'GET',headers:{authorization:'Bearer '+key,'x-marcel-analysis-session':mintAnalysisAssertion({sub:'a'.repeat(64),sid:'c'.repeat(64),exp:f.clock()+60000},key,f.clock())},query:{op:'catalog'}},response);assert.equal(response.statusCode,503);assert.equal(response.data.code,'ANALYSIS_CONFIGURATION_INVALID');
 assert.throws(()=>loadAnalysisConfiguration({config:{...configuration,authorizations:[{instrumentId:'x',verified:true,usage:'internal-analysis',reference:'OFFLINE',checkedAt:f.base.from,expiresAt:f.base.to,apiKey:'DO-NOT-PASS'}]},env:{NODE_ENV:'test'}}));
});
test('process start failure is safe, timeout/abort terminate children, and concurrent launches are refused',async()=>{
 const engine=createLocalScanner({pythonPath});const running=engine.probe();await assert.rejects(engine.probe(),{code:'SCANNER_BUSY'});await running;
 await assert.rejects(createLocalScanner({pythonPath:path.resolve('does-not-exist.exe')}).probe(),{code:'PYTHON_UNAVAILABLE'});
 await assert.rejects(createLocalScanner({pythonPath,timeoutMs:10}).probe(),{code:'TIMEOUT'});
 const controller=new AbortController(),pending=engine.probe({signal:controller.signal});controller.abort();await assert.rejects(pending,{code:'ABORTED'});assert.ok((await engine.probe()).memoryEnforcement);
 const invalid=createConfiguredAnalysisRuntime({database:f.database,config:{schemaVersion:1,pythonPath:path.resolve('missing.exe')},env:{}});await assert.rejects(invalid.runtimeStatus(),{code:'PYTHON_UNAVAILABLE'});
});
test('operating-system memory cap rejects an actual allocation beyond the budget',()=>{
 const dir=path.resolve('market-analysis/python'),code=`import sys\nsys.path.insert(0,${JSON.stringify(dir)})\nfrom runtime_limits import install_limits\ninstall_limits(64)\ntry:\n x=bytearray(128*1024*1024)\n print('UNBOUNDED')\nexcept MemoryError:\n print('MEMORY_BLOCKED')`;
 const child=spawnSync(pythonPath,['-I','-B','-c',code],{env:{},encoding:'utf8',windowsHide:true,timeout:5000});assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'MEMORY_BLOCKED');
});
