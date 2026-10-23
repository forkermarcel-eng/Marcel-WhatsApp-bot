import {mintAnalysisSession} from '../market-analysis/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import proxy from '../api/dashboard/marcel-brain.js';
const originalFetch=globalThis.fetch,env={...process.env};
const headers={host:'fixture.local',origin:'https://fixture.local'};
function request({method='GET',authenticated=true,origin='https://fixture.local',query={op:'catalog'},body={}}={}){
 const token='OFFLINE-FIXTURE',signature=crypto.createHmac('sha256','LOCAL-FIXTURE-ONLY').update(token).digest('hex');
 return {method,headers:{...headers,origin,...(authenticated?{cookie:'marcel_dashboard_session='+token+'.'+signature+'; marcel_analysis_session='+mintAnalysisSession({username:'offline',dashboardSession:token+'.'+signature,password:'LOCAL-FIXTURE-ONLY'})}:{})},query:{resource:'market-analysis',...query},body};
}
function response(){return {statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v;},status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};}
test('existing signed session, bearer proxy and strict market-analysis allowlist work together',async t=>{
 process.env.DASHBOARD_PASSWORD='LOCAL-FIXTURE-ONLY';process.env.DASHBOARD_API_SECRET='LOCAL-FIXTURE-BEARER';process.env.RAILWAY_BACKEND_URL='https://example.invalid';
 t.after(()=>{globalThis.fetch=originalFetch;process.env=env;});let outgoing;
 globalThis.fetch=async(url,options)=>{outgoing={url,options};return {ok:true,status:200,headers:new Headers({'Content-Type':'application/json'}),text:async()=>JSON.stringify({ok:true,result:{items:[]}})};};
 let res=response();await proxy(request({authenticated:false}),res);assert.equal(res.statusCode,401);assert.equal(outgoing,undefined);
 for(const origin of ['https://evil.invalid','not a URL',null]){res=response();await proxy(request({method:'POST',origin,body:{op:'job-create'}}),res);assert.equal(res.statusCode,403);}
 res=response();await proxy(request({query:{op:'catalog',q:'EUR/USD',ownerId:'victim',providerURL:'https://evil.invalid'}}),res);assert.equal(res.statusCode,200);assert.match(outgoing.url,/market-analysis\?op=catalog&q=EUR%2FUSD/);assert.ok(!outgoing.url.includes('victim'));assert.equal(outgoing.options.headers.Authorization,'Bearer LOCAL-FIXTURE-BEARER');assert.equal(res.headers['Cache-Control'],'no-store, private');
 res=response();await proxy(request({method:'POST',body:{op:'job-create',operation:'scan'}}),res);assert.equal(res.statusCode,200);assert.equal(outgoing.options.method,'POST');assert.equal(JSON.parse(outgoing.options.body).operation,'scan');
 res=response();await proxy(request({method:'PATCH'}),res);assert.equal(res.statusCode,405);
});
