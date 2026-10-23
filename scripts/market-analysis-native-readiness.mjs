import {createConfiguredAnalysisRuntime} from '../market-analysis/runtime-config.js';
import {phase7Fixture} from '../test/market-analysis-phase7-fixture.js';
import {createMarketAnalysisRuntime} from '../market-analysis/api-runtime.js';
import {consumeBudget} from '../market-analysis/api-storage.js';
import {normalizeInstrument} from '../market-analysis/instruments.js';import {normalizeEvent} from '../market-analysis/news/events.js';
import {randomUUID} from 'node:crypto';import {fileURLToPath} from 'node:url';import fs from 'node:fs';import path from 'node:path';import net from 'node:net';
import {spawnSync,spawn,fork} from 'node:child_process';import {once} from 'node:events';import assert from 'node:assert/strict';import pg from 'pg';
import {createAnalysisJobs} from '../market-analysis/jobs.js';import {createAnalysisRepository} from '../market-analysis/repository.js';import {createAlertRepository} from '../market-analysis/alert-repository.js';

// Isolated installed PostgreSQL only. Never reads DATABASE_URL or production env.
const base=path.resolve('tmp/market-analysis-readiness/native-postgres-'+randomUUID().slice(0,8)),bin='C:/Program Files/PostgreSQL/18/bin';
const env=Object.fromEntries(['SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','APPDATA','LOCALAPPDATA','COMSPEC','USERNAME','USERDOMAIN','SYSTEMDRIVE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));env.PATH=bin+';'+process.env.SystemRoot+'/System32';
const resultsPath=process.argv.includes('--runtime-only')?'tmp/market-analysis-runtime/native-results.json':process.argv.includes('--extra-only')?'tmp/market-analysis-readiness/native-extra-results.json':'tmp/market-analysis-readiness/native-results.json';
const time=Date.parse('2026-10-22T12:00:00Z'),iso=n=>new Date(n).toISOString();
const batch=(sourceId,at)=>({sourceId,fetchedAt:iso(at),processedAt:iso(at),mode:'offline-fixture'});
async function connect(config){const pool=new pg.Pool({...config,max:2,connectionTimeoutMillis:3000,query_timeout:10000});const r=await pool.query('SHOW data_directory');assert.equal(path.resolve(r.rows[0].data_directory),config.expectedDirectory);return pool;}
if(process.argv.includes('--child')) {
 process.on('message',async msg=>{if(msg.action==='setup'){globalThis.testConfig=msg.config;process.send({ready:true});return;}
  const database=await connect(globalThis.testConfig),clock=()=>msg.time,jobs=createAnalysisJobs({database,clock});
  try {let result;
   if(msg.action==='enqueue')result=await jobs.enqueue({sourceId:'native-race',type:'source-check',idempotencyKey:'same',policy:{sourceId:'native-race',type:'source-check',mode:'offline-fixture',intervalMs:60000}});
   if(msg.action==='claim')result=await jobs.claim({jobId:msg.id});
   if(msg.action.startsWith('api-')){const f=msg.fixture,runtime=createConfiguredAnalysisRuntime({database,clock:()=>f.at,config:{schemaVersion:1,mode:msg.allowFixtures===false?'production':'offline-fixture',pythonPath:msg.pythonPath,calendars:[{instrumentId:f.instrumentId,calendar:f.calendar}]},env:{NODE_ENV:'test'}});if(msg.action==='api-create')result=await runtime.createJob(msg.owner,{...f.base,operation:'scan',...msg.body});if(msg.action==='api-run')result=await runtime.run(msg.owner,msg.id);if(msg.action==='api-get')result=await runtime.job(msg.owner,msg.id);if(msg.action==='api-cancel')result=await runtime.cancel(msg.owner,msg.id);}
   if(msg.action==='budget')result=await consumeBudget(database,'owner',true,clock);
   if(msg.action==='alert')result=await createAlertRepository({database,clock,ownerId:'native-owner',allowFixtures:true}).check([msg.id],msg.snapshot);
   process.send({result});
  }catch(e){process.send({error:e.code||e.message});}finally{await database.end();process.disconnect();}
 });
} else {
 assert.equal(path.resolve(process.cwd()),path.resolve(fileURLToPath(new URL('../',import.meta.url))),'Run only from this worktree');
 const results=[],started=Date.now();let postmaster,pool,log,config;
 const check=async(name,fn)=>{if(process.argv.includes('--runtime-only')&&!/migration|durable API|backup/.test(name))return;if(process.argv.includes('--extra-only')&&!/migration|globally|JSON|durable API|shared request|backup/.test(name))return;const t=performance.now();await fn();results.push({name,ok:true,ms:Math.round((performance.now()-t)*10)/10});console.log('PASS '+name);};
 const command=(name,args)=>{const r=spawnSync(path.join(bin,name+'.exe'),args,{env,windowsHide:true,encoding:'utf8',timeout:30000});if(r.status!==0)throw Error(name+' failed '+r.status+'/'+(r.error?.code ?? '')+': '+(r.stdout||'').slice(-1000)+(r.stderr||'').slice(-1200));return r.stdout;};
 async function race(action,count,extra={}){
  const children=Array.from({length:count},()=>fork(new URL(import.meta.url),['--child'],{env,windowsHide:true,silent:true}));
  const ready=children.map(child=>new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.send({action:'setup',config});}));await Promise.all(ready);
  const pending=children.map(child=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Native child timeout'));},15000);child.once('message',m=>{clearTimeout(timer);m.error?reject(Error(m.error)):resolve(m.result);});child.once('error',reject);}));
  children.forEach(child=>child.send({action,time,...extra}));return Promise.all(pending);
 }
 try {
  assert.ok(fs.existsSync(path.join(bin,'postgres.exe')),'Installed PostgreSQL not found');assert.ok(!fs.existsSync(base),'Refusing to reuse an existing cluster directory');fs.mkdirSync(base,{recursive:true});
  const data=path.join(base,'data');command('initdb',['-D',data,'--username=analysis_test','--auth=trust','--encoding=UTF8','--no-locale']);
  const listener=net.createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=listener.address().port;await new Promise(r=>listener.close(r));
  log=fs.openSync(path.join(base,'server.log'),'a');postmaster=spawn(path.join(bin,'postgres.exe'),['-D',data,'-h','127.0.0.1','-p',String(port),'-c','max_connections=20','-c','shared_buffers=16MB','-c','fsync=on'],{env,windowsHide:true,stdio:['ignore',log,log]});
  config={host:'127.0.0.1',port,user:'analysis_test',database:'postgres',expectedDirectory:data};
  for(let i=0;i<50;i++){try{pool=await connect(config);break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.ok(pool,'Isolated PostgreSQL did not start');await pool.query('CREATE DATABASE analysis_readiness');await pool.end();config.database='analysis_readiness';pool=await connect(config);
  const version=(await pool.query('SELECT version(),host(inet_server_addr()) AS address')).rows[0];assert.equal(version.address,'127.0.0.1');
  await pool.query("CREATE TABLE public.protected_fixture(id integer PRIMARY KEY,body text NOT NULL);INSERT INTO public.protected_fixture VALUES(1,'preserved synthetic sentinel')");
  await check('additive SQL, schema isolation and repeatable migration',async()=>{
   for(let i=0;i<2;i++)for(const name of ['20261022_brain_market_analysis.sql','20261022_brain_market_analysis_phase6.sql'])await pool.query(fs.readFileSync('migrations/'+name,'utf8'));
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='marcel_market_analysis'")).rows[0].n,9);
   assert.equal((await pool.query('SELECT body FROM public.protected_fixture')).rows[0].body,'preserved synthetic sentinel');
  });
  let job;
  await check('four OS processes enqueue one idempotent job',async()=>{const rows=await race('enqueue',4);assert.equal(new Set(rows.map(r=>r.id)).size,1);job=rows[0];assert.equal((await pool.query('SELECT count(*)::int AS n FROM marcel_market_analysis.jobs')).rows[0].n,1);});
  let old;
  await check('four competing processes claim exactly one lease',async()=>{const rows=await race('claim',4,{id:job.id});assert.equal(rows.filter(Boolean).length,1);old=rows.find(Boolean);assert.equal(old.attempts,1);});
  await check('expired lease recovery fences old process and bounds retry',async()=>{
   let at=time+61000;const clock=()=>at,jobs=createAnalysisJobs({database:pool,clock}),repo=createAnalysisRepository({database:pool,clock});
   assert.equal(await jobs.claim({jobId:job.id}),null);assert.equal((await jobs.get(job.id)).error_code,'LEASE_EXPIRED');at+=4000;
   const next=await jobs.claim({jobId:job.id});assert.equal(next.attempts,2);assert.notEqual(next.lease_token,old.lease_token);
   await assert.rejects(repo.commitBatch(batch(job.source_id,at),{job:old}),/JOB_LEASE_LOST/);await repo.commitBatch(batch(job.source_id,at),{job:next});assert.equal((await jobs.get(job.id)).status,'succeeded');
  });
  await check('four processes claim only one job globally across different sources',async()=>{
   const clock=()=>time+120000,jobs=createAnalysisJobs({database:pool,clock}),ids=[];
   for(let i=0;i<4;i++)ids.push((await jobs.enqueue({sourceId:'native-global-'+i,type:'source-check',idempotencyKey:'global',policy:{sourceId:'native-global-'+i,type:'source-check',mode:'offline-fixture',intervalMs:60000}})).id);
   const rows=await race('claim',4,{time:clock()});assert.equal(rows.filter(Boolean).length,1);for(const id of ids)await jobs.cancel(id);
  });
  await check('native JSON records, original as-of vintages and constraints',async()=>{
   let at=time;const clock=()=>at,repo=createAnalysisRepository({database:pool,clock});
   const instrument=normalizeInstrument({provider:'native-fixture',environment:'offline',symbol:'EURUSD',kind:'fx',group:'forex',active:true,quote:'USD',base:'EUR',provenance:{mode:'offline-fixture'}});
   const event=normalizeEvent({kind:'macro',title:'OFFLINE-FIXTURE CPI',externalId:'native-cpi',seriesId:'CPI',period:'2026-09',publishedAt:iso(time),actual:3.2,unit:'percent',country:'US',currency:'USD'},{source:{id:'native-records',name:'OFFLINE-FIXTURE',url:'https://example.invalid/native'},fetchedAt:iso(time),processedAt:iso(time),instruments:[instrument],mode:'offline-fixture'});
   await repo.commitBatch({...batch('native-records',at),instruments:[instrument],events:[event],histories:[{instrumentId:instrument.id,from:iso(time-60000),to:iso(time),observedAt:iso(time),intervalMs:60000,delayMs:0,maxAgeMs:60000,bars:[{time:iso(time-60000),open:1.1,high:1.2,low:1,close:1.1}],provenance:{mode:'offline-fixture'}}]});
   at+=1000;await repo.commitBatch({...batch('native-records',at),events:[normalizeEvent({kind:'macro',title:'OFFLINE-FIXTURE CPI',externalId:'native-cpi',seriesId:'CPI',period:'2026-09',publishedAt:iso(time),actual:9.9,unit:'percent',country:'US',currency:'USD',revisedAt:iso(at),revisionOf:event.versionId},{source:{id:'native-records',name:'OFFLINE-FIXTURE',url:'https://example.invalid/native'},fetchedAt:iso(at),processedAt:iso(at),instruments:[instrument],mode:'offline-fixture'})]});
   assert.equal((await repo.read({sourceId:'native-records',kind:'macro',asOf:iso(time),latest:true})).items[0].body.values.actual,3.2);
   assert.equal((await repo.read({sourceId:'native-records',kind:'macro',asOf:iso(at),latest:true})).items[0].body.values.actual,9.9);
   await assert.rejects(pool.query("INSERT INTO marcel_market_analysis.records(source_id,kind,entity_id,version_id,ingestion_id,body,fetched_at,processed_at,stored_at) VALUES('native-records','bar','invalid','invalid','00000000-0000-4000-8000-000000000001','[]',$1,$1,$1)",[iso(at)]),e=>e.code==='23514');
  });
  await check('native transaction rollback and source freshness preservation',async()=>{
   const repo=createAnalysisRepository({database:pool,clock:()=>time+180000});
   await assert.rejects(repo.commitBatch({...batch('native-invalid',time+180000),events:[{kind:'macro',source:{id:'wrong'},eventId:'bad',versionId:'bad'}]}));
   assert.equal((await pool.query("SELECT count(*)::int AS n FROM marcel_market_analysis.sources WHERE id='native-invalid'")).rows[0].n,0);
  });
  await check('cancelled running job cannot commit records or success',async()=>{
   const clock=()=>time+180000,jobs=createAnalysisJobs({database:pool,clock});const j=await jobs.enqueue({sourceId:'native-cancel',type:'source-check',idempotencyKey:'cancel',policy:{sourceId:'native-cancel',type:'source-check',mode:'offline-fixture',intervalMs:60000}}),lease=await jobs.claim({jobId:j.id});
   assert.ok(lease);await jobs.cancel(j.id);await assert.rejects(createAnalysisRepository({database:pool,clock}).commitBatch(batch(j.source_id,clock()),{job:lease}),/JOB_LEASE_LOST/);assert.equal((await jobs.get(j.id)).status,'cancelled');
  });
  await check('parallel native alert checks persist one atomic trigger',async()=>{
   const alerts=createAlertRepository({database:pool,ownerId:'native-owner',clock:()=>time,allowFixtures:true});
   const instrument={id:'native:fixture:fx:EURUSD',active:true,kind:'fx',group:'forex',metadata:{priceBasis:'mid'},provenance:{mode:'offline-fixture'}};
   const rule=await alerts.create({instrumentId:instrument.id,type:'LEVEL',priceBasis:'mid',condition:{operator:'above',level:100},triggerOnInitial:true});
   const snapshot={instrument,price:101,priceBasis:'mid',mode:'offline-fixture',dataAt:iso(time),receivedAt:iso(time),delayMs:0,calendar:{reference:'synthetic native session',from:iso(time-60000),to:iso(time+60000),windows:[{start:iso(time-60000),end:iso(time+60000)}]}};
   const rows=await race('alert',4,{id:rule.id,snapshot});assert.equal(rows.flat().filter(r=>r.status==='TRIGGERED').length,1);assert.equal((await alerts.history(rule.id)).items.length,1);
  });
  await check('least privilege analysis role cannot change protected public data',async()=>{
   await pool.query("CREATE ROLE analysis_runtime LOGIN;GRANT USAGE ON SCHEMA marcel_market_analysis TO analysis_runtime;GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA marcel_market_analysis TO analysis_runtime;GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA marcel_market_analysis TO analysis_runtime");
   const scoped=new pg.Pool({...config,user:'analysis_runtime',max:1});try{const alerts=createAlertRepository({database:scoped,ownerId:'scoped-owner',clock:()=>time,allowFixtures:true});await alerts.create({instrumentId:'native-fixture',type:'LEVEL',priceBasis:'mid',condition:{operator:'below',level:100}});await assert.rejects(scoped.query("UPDATE public.protected_fixture SET body='changed'"),e=>e.code==='42501');assert.equal((await pool.query('SELECT body FROM public.protected_fixture')).rows[0].body,'preserved synthetic sentinel');}finally{await scoped.end();}
  });
  await check('durable API jobs survive four processes and restart with owner isolation',async()=>{
   const bridge={query:(...args)=>pool.query(...args),connect:()=>pool.connect(),exec:s=>pool.query(s)};
   const f=await phase7Fixture({database:bridge}),fixture={at:f.clock(),instrumentId:f.instrument.id,calendar:f.calendar,base:f.base};
   const pythonPath='C:/Users/annem/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
   const common={fixture,pythonPath,owner:'native-alice'};
   const queued=await race('api-create',4,common);assert.equal(new Set(queued.map(x=>x.id)).size,1);const id=queued[0].id;
   await assert.rejects(race('api-get',1,{...common,id,owner:'native-bob'}),/JOB_NOT_FOUND/);
   await assert.rejects(race('api-cancel',1,{...common,id,owner:'native-bob'}),/JOB_NOT_FOUND/);
   await assert.rejects(race('api-run',1,{...common,id,owner:'native-bob'}),/JOB_NOT_FOUND/);
   await assert.rejects(race('api-run',1,{...common,id,allowFixtures:false}),/FIXTURE_INPUT_DISABLED/);
   const runs=await race('api-run',4,{...common,id});assert.ok(runs.some(r=>r.status==='succeeded'));
   const fresh=(await race('api-get',1,{...common,id}))[0];assert.equal(fresh.status,'succeeded');assert.equal(fresh.result[0].result.mode,'offline-fixture');
   const logs=(await pool.query("SELECT * FROM marcel_market_analysis.job_log WHERE job_id=$1 AND status='running'",[id])).rows;assert.equal(logs.length,1);
   const again=(await race('api-create',1,common))[0];assert.equal(again.id,id);
   const cancelled=await race('api-create',1,{...common,owner:'native-cancel-owner'});const cid=cancelled[0].id;
   assert.equal((await race('api-cancel',1,{...common,owner:'native-cancel-owner',id:cid}))[0].status,'cancelled');
   assert.equal((await race('api-run',1,{...common,owner:'native-cancel-owner',id:cid}))[0].result,null);
   const runningCommon={...common,owner:'native-running-owner',body:{operation:'time-machine',paths:10000,horizonBars:60}};
   const rq=(await race('api-create',1,runningCommon))[0],executing=race('api-run',1,{...runningCommon,id:rq.id});
   let active=false;for(let i=0;i<80;i++){if((await pool.query('SELECT status FROM marcel_market_analysis.jobs WHERE id=$1',[rq.id])).rows[0].status==='running'){active=true;break;}await new Promise(r=>setTimeout(r,25));}assert.equal(active,true);
   assert.equal((await race('api-cancel',1,{...runningCommon,id:rq.id}))[0].status,'cancelled');await executing;
   const after=(await race('api-get',1,{...runningCommon,id:rq.id}))[0];assert.equal(after.status,'cancelled');assert.equal(after.result,null);

  });
  await check('shared request budgets stay bounded across four processes',async()=>{
   await pool.query("DELETE FROM marcel_market_analysis.sources WHERE id='analysis-api-budget'");
   const values=[];for(let i=0;i<6;i++)values.push(...await race('budget',4));assert.equal(values.filter(Boolean).length,20);
  });
  const counts=async db=>{const tables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='marcel_market_analysis' ORDER BY tablename")).rows;const result={};for(const {tablename}of tables)result[tablename]=Number((await db.query('SELECT count(*) AS n FROM marcel_market_analysis.'+tablename)).rows[0].n);return result;};
  await check('native custom-format backup completely restores into separate local database',async()=>{
   const before=await counts(pool),dump=path.join(base,'fixture.dump');command('pg_dump',['-h','127.0.0.1','-p',String(port),'-U','analysis_test','-d','analysis_readiness','-Fc','-f',dump]);assert.ok(command('pg_restore',['-l',dump]).includes('marcel_market_analysis'));
   await pool.query('CREATE DATABASE analysis_restored');command('pg_restore',['-h','127.0.0.1','-p',String(port),'-U','analysis_test','-d','analysis_restored','--exit-on-error','--no-owner','--no-privileges',dump]);
   const restored=new pg.Pool({...config,database:'analysis_restored',max:1});try{assert.deepEqual(await counts(restored),before);assert.deepEqual((await restored.query('SELECT id,api FROM marcel_market_analysis.jobs WHERE api IS NOT NULL ORDER BY id')).rows,(await pool.query('SELECT id,api FROM marcel_market_analysis.jobs WHERE api IS NOT NULL ORDER BY id')).rows);assert.equal((await restored.query('SELECT body FROM public.protected_fixture')).rows[0].body,'preserved synthetic sentinel');}finally{await restored.end();}
  });
  fs.writeFileSync(resultsPath,JSON.stringify({ok:true,version:version.version,bind:version.address,processIsolation:true,productionAccess:false,results,tableCounts:await counts(pool),durationMs:Date.now()-started},null,2));
 }catch(error){fs.writeFileSync(resultsPath,JSON.stringify({ok:false,results,error:error.message},null,2));console.error(error);process.exitCode=1;}
 finally{await pool?.end();if(postmaster){command('pg_ctl',['-D',path.join(base,'data'),'-m','fast','-w','stop']);}if(log)fs.closeSync(log);if(fs.existsSync(resultsPath)){const result=JSON.parse(fs.readFileSync(resultsPath,'utf8'));result.serverStopped=!fs.existsSync(path.join(base,'data','postmaster.pid'));fs.writeFileSync(resultsPath,JSON.stringify(result,null,2));}}
}
