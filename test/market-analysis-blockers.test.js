import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {mintAnalysisSession,analysisIdentity,mintAnalysisAssertion,verifyAnalysisAssertion,secureBearer} from '../market-analysis/auth.js';
import {assessDataPermission} from '../market-analysis/data-permissions.js';
import {analysisSource,sourceIds} from '../market-analysis/news/sources.js';
import {createNewsAdapter} from '../market-analysis/news/adapter.js';
import {createMassiveAdapter} from '../market-analysis/providers/massive.js';
import {phase7Fixture} from './market-analysis-phase7-fixture.js';
import {createMarketAnalysisRuntime} from '../market-analysis/api-runtime.js';
import proxy,{validDashboardSession} from '../api/dashboard/marcel-brain.js';
import login from '../api/login.js';
import {registerMarketAnalysisRoutes} from '../market-analysis/routes.js';
const now=Date.parse('2026-10-22T12:00:00Z'),password='OFFLINE-PASSWORD',key='OFFLINE-BACKEND';
function session(at=now){const token='fixture',signature=crypto.createHmac('sha256',password).update(token).digest('hex'),dashboardSession=token+'.'+signature;const capability=mintAnalysisSession({username:'alice',dashboardSession,password,now:at});return {dashboardSession,capability,req:{headers:{cookie:'marcel_dashboard_session='+dashboardSession+'; marcel_analysis_session='+capability}}};}
const response=()=>({statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(data){this.data=data;return this;}});
test('analysis session has an absolute server expiry and is bound to the existing dashboard session',()=>{
 const s=session();const identity=analysisIdentity(s.req,{password,now});assert.ok(identity);
 assert.equal(analysisIdentity(s.req,{password,now:now+86400000}),null);assert.equal(analysisIdentity(s.req,{password,now:now-1}),null);
 assert.equal(analysisIdentity(s.req,{password:'wrong',now}),null);
 assert.equal(analysisIdentity({headers:{cookie:s.req.headers.cookie.replace('marcel_dashboard_session=fixture','marcel_dashboard_session=other')}},{password,now}),null);
 const assertion=mintAnalysisAssertion(identity,key,now),req={headers:{'x-marcel-analysis-session':assertion,authorization:'Bearer '+key}};
 assert.equal(verifyAnalysisAssertion(req,{key,now}).sub,identity.sub);assert.equal(verifyAnalysisAssertion(req,{key,now:now+30000}),null);
 assert.equal(verifyAnalysisAssertion(req,{key:'wrong',now}),null);assert.equal(verifyAnalysisAssertion({headers:{'x-marcel-analysis-session':assertion+'x'}},{key,now}),null);
 assert.equal(secureBearer(req,key),true);assert.equal(secureBearer({headers:{authorization:'Bearer '+key+'x'}},key),false);assert.equal(secureBearer({headers:{authorization:'é'.repeat(key.length+7)}},key),false);
});
test('existing Brain session remains valid but cannot access analysis without a current analysis capability',async t=>{
 const saved={...process.env};t.after(()=>{process.env=saved;});process.env.DASHBOARD_PASSWORD=password;process.env.RAILWAY_BACKEND_URL='https://example.invalid';process.env.DASHBOARD_API_SECRET=key;
 const s=session(Date.now()-86400001);assert.equal(validDashboardSession(s.req),true);
 let res=response();await proxy({...s.req,method:'GET',query:{resource:'market-analysis',op:'catalog'}},res);assert.equal(res.statusCode,401);assert.equal(res.data.code,'ANALYSIS_SESSION_REQUIRED');
 res=response();await proxy({headers:{cookie:'marcel_dashboard_session='+s.dashboardSession},method:'GET',query:{resource:'market-analysis'}},res);assert.equal(res.statusCode,401);
});
test('login preserves the original cookie and issues a separate bounded analysis capability without logging credentials',async t=>{
 const saved={...process.env};t.after(()=>{process.env=saved;});process.env.DASHBOARD_USERNAME='alice';process.env.DASHBOARD_PASSWORD=password;
 const res=response();login({method:'POST',body:{username:'alice',password}},res);assert.equal(res.statusCode,200);
 const cookies=res.headers['Set-Cookie'];assert.equal(cookies.length,2);assert.match(cookies[0],/^marcel_dashboard_session=/);assert.match(cookies[1],/^marcel_analysis_session=/);
 for(const c of cookies)assert.match(c,/HttpOnly; Secure; SameSite=Strict; Max-Age=86400/);
 const req={headers:{cookie:cookies.map(c=>c.split(';')[0]).join('; ')}};assert.equal(validDashboardSession(req),true);assert.ok(analysisIdentity(req,{password}));
});
test('source permissions distinguish documented/implemented, entitlement, usage and activation and expire independently',async()=>{
 for(const id of sourceIds){const state=assessDataPermission(analysisSource(id),null,now);assert.equal(state.enabled,false);assert.equal(state.documented,false);}
 const grant={confirmed:true,reference:'OFFLINE-ONLY',checkedAt:new Date(now-1).toISOString(),expiresAt:new Date(now+1000).toISOString()};
 const evidence={sourceId:'fed',documentation:grant,entitlement:grant,usageRights:grant,activation:grant},source=analysisSource('fed');assert.equal(assessDataPermission(source,evidence,now).enabled,true);
 assert.equal(assessDataPermission(source,{...evidence,activation:null},now).productionAllowed,true);assert.equal(assessDataPermission(source,{...evidence,activation:null},now).enabled,false);
 assert.equal(assessDataPermission(source,evidence,now+1000).enabled,false);assert.equal(assessDataPermission(analysisSource('fred'),{...evidence,sourceId:'fred'},now).productionAllowed,false);
 let calls=0;await assert.rejects(createNewsAdapter({sourceId:'fed',mode:'network',clock:()=>now,fetcher:()=>{calls++;},authorization:{sourceId:'fed',verified:true,usage:'internal-headline-calendar',reference:'OFFLINE',checkedAt:grant.checkedAt,expiresAt:grant.expiresAt}}).read(),{code:'SOURCE_RELEASE_NOT_CONFIRMED'});
 await assert.rejects(createMassiveAdapter({mode:'network',clock:()=>now,apiKey:'OFFLINE',fetcher:()=>{calls++;},authorization:{provider:'massive',product:'forex',verified:true,usage:'personal-internal',reference:'OFFLINE',checkedAt:grant.checkedAt,expiresAt:grant.expiresAt,capabilities:{catalog:true}}}).discover(),{code:'SOURCE_RELEASE_NOT_CONFIRMED'});assert.equal(calls,0);
});
test('fresh runtime restores durable input/result, idempotence and owner protections without a local handle map',async t=>{
 const f=await phase7Fixture({pythonPath:process.env.MARKET_ANALYSIS_TEST_PYTHON});t.after(()=>f.close());
 const runtime=()=>createMarketAnalysisRuntime({database:f.database,clock:f.clock,pythonPath:process.env.MARKET_ANALYSIS_TEST_PYTHON,allowFixtures:true,calendars:new Map([[f.instrument.id,f.calendar]]),specifications:new Map([[f.instrument.id,{contract:f.contract,costs:f.costs}]])});
 const q=await f.runtime.createJob('alice',{...f.base,operation:'scan'});assert.equal((await runtime().createJob('alice',{...f.base,operation:'scan'})).id,q.id);
 await assert.rejects(runtime().job('bob',q.id),{code:'JOB_NOT_FOUND'});await assert.rejects(runtime().run('bob',q.id),{code:'JOB_NOT_FOUND'});await assert.rejects(runtime().cancel('bob',q.id),{code:'JOB_NOT_FOUND'});
 const done=await runtime().run('alice',q.id);assert.equal(done.status,'succeeded');assert.deepEqual((await runtime().job('alice',q.id)).result,done.result);assert.deepEqual((await runtime().run('alice',q.id)).result,done.result);
 assert.equal((await f.database.query("SELECT count(*)::int AS n FROM marcel_market_analysis.job_log WHERE job_id=$1 AND status='running'",[q.id])).rows[0].n,1);
 const other=await f.runtime.createJob('carol',{...f.base,operation:'scan'});assert.notEqual(q.id,other.id);assert.equal((await runtime().cancel('carol',other.id)).status,'cancelled');assert.equal((await runtime().run('carol',other.id)).result,null);
 await assert.rejects(runtime().job('alice','not-a-uuid'));
});
test('backend requires both signed session assertion and exact bearer, with a shared request budget',async t=>{
 const f=await phase7Fixture();t.after(()=>f.close());const handlers=[];
 for(let i=0;i<2;i++)registerMarketAnalysisRoutes({app:{all:(_path,fn)=>handlers.push(fn)},pool:f.database,runtime:f.runtime,authorized:()=>true,sessionKey:key,clock:f.clock});
 const identity={sub:'a'.repeat(64),sid:'b'.repeat(64),exp:f.clock()+86400000};
 const valid={'x-marcel-analysis-session':mintAnalysisAssertion(identity,key,f.clock()),authorization:'Bearer '+key};
 for(const headers of [{},{...valid,authorization:'Bearer wrong'},{...valid,'x-marcel-analysis-session':'forged'},{...valid,'x-marcel-analysis-session':mintAnalysisAssertion({...identity,exp:f.clock()-1},key,f.clock()-30001)}]){
  const res=response();await handlers[0]({method:'GET',headers,query:{op:'catalog'}},res);assert.equal(res.statusCode,401);
 }
 for(let i=0;i<61;i++){const res=response();await handlers[i%2]({method:'GET',headers:valid,query:{op:'invalid'}},res);assert.equal(res.statusCode,i<60?400:429);}
 const raw=(await f.database.query("SELECT state FROM marcel_market_analysis.sources WHERE id='analysis-api-budget'")).rows[0].state;assert.equal(raw.apiBudget.reads,60);
});
