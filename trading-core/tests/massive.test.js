import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {historyFromMassive,historyFromProvider,normalizeMassiveBars,providerStatus} from '../server/providers.js';
import {createTradingHandler} from '../server/api.js';
import {FileRepository,PgRepository,KINDS} from '../server/repository.js';

const env={TRADING_MASSIVE_ENABLED:'true',TRADING_MASSIVE_API_KEY:'synthetic-unit-test-only'};
const request={provider:'massive',instrument:'MGC',contract:'MGCZ6',from:'2026-09-16T14:00:00Z',to:'2026-09-16T15:00:00Z'};
const window={contract:request.contract,start:request.from,end:request.to};
const row=(minute=0)=>({ticker:'MGCZ6',window_start:String(BigInt(Date.parse(request.from)+minute*60000)*1000000n),open:4400,high:4402,low:4399,close:4401,volume:12});
const response=(results=[row()],extra={})=>new Response(JSON.stringify({status:'OK',results,...extra}));
const never=()=>{throw Error('Network must not be called');};

test('Massive requires both flag and key, never falls back to another provider',async()=>{
 for(const e of [{},{TRADING_MASSIVE_ENABLED:'true'},{TRADING_MASSIVE_API_KEY:'test'}, {...env,TRADING_MASSIVE_ENABLED:'false'}])await assert.rejects(()=>historyFromMassive(request,e,never),/nicht konfiguriert/);
 assert.equal(providerStatus(env).massive.configured,true);
 assert.equal(providerStatus(env).history.configured,false);
 assert.ok(!JSON.stringify(providerStatus(env)).includes(env.TRADING_MASSIVE_API_KEY));
});
test('Massive exact futures endpoint, bearer, UTC nanoseconds, explicit half-open minute interval',async()=>{
 const result=await historyFromProvider(request,env,async(u,o)=>{
  const url=new URL(u);assert.equal(url.origin,'https://api.massive.com');assert.equal(url.pathname,'/futures/v1/aggs/MGCZ6');
  assert.equal(url.searchParams.get('resolution'),'1min');assert.equal(url.searchParams.get('window_start.gte'),row().window_start);
  assert.equal(url.searchParams.get('window_start.lt'),row(60).window_start);assert.equal(url.searchParams.get('sort'),'window_start.asc');
  assert.equal(url.searchParams.has('apiKey'),false);assert.equal(o.headers.Authorization,'Bearer '+env.TRADING_MASSIVE_API_KEY);assert.equal(o.redirect,'error');
  return response();
 });
 assert.equal(result.source,'massive-historical');assert.equal(result.contract,'MGCZ6');assert.equal(result.resolution,60);
 assert.deepEqual(result.bars,[{time:'2026-09-16T14:00:00.000Z',open:4400,high:4402,low:4399,close:4401,volume:12}]);
 assert.equal(result.estimatedCostUSD,undefined,'Do not invent a Massive cost quote');
});
test('numeric and string nanosecond timestamps normalize identically',()=>{
 assert.deepEqual(normalizeMassiveBars([row()],window),normalizeMassiveBars([{...row(),window_start:Number(row().window_start)}],window));
});
test('contract validation prevents continuous, GC substitution and XAU/USD',async()=>{
 for(const contract of ['GCZ6','MGC1!','XAU/USD','MGC.c.0','mgcz6','MGCZ6/evil'])await assert.rejects(()=>historyFromMassive({...request,contract},env,never));
});
test('invalid ranges fail before any request',async()=>{
 for(const change of [{to:request.from},{from:'2026-09-01T00:00:00Z'},{from:'2026-09-16T14:00:01Z'},{to:'2099-01-01T00:00:00Z'},{from:'2026-09-16T14:00:00'}])await assert.rejects(()=>historyFromMassive({...request,...change},env,never));
});
test('empty successful response yields no invented candles',async()=>{
 assert.deepEqual((await historyFromMassive(request,env,async()=>response([]))).bars,[]);
});
for(const status of [401,403,429,500])test('Massive HTTP '+status+' fails with safe error without response secrets',async()=>{
 await assert.rejects(()=>historyFromMassive(request,env,async()=>new Response(env.TRADING_MASSIVE_API_KEY,{status})),e=>e.status===502&&e.message==='Datenanbieter antwortet HTTP '+status+'.');
});
test('malformed JSON and transport errors cannot expose credentials even in debug error messages',async()=>{
 for(const fetcher of [async()=>new Response(env.TRADING_MASSIVE_API_KEY),async()=>{throw Error('Bearer '+env.TRADING_MASSIVE_API_KEY);},async()=>new Response('x',{headers:{'content-length':'9000000'}})])await assert.rejects(()=>historyFromMassive(request,env,fetcher),e=>!e.message.includes(env.TRADING_MASSIVE_API_KEY)&&e.status===502);
});
test('provider status error or malformed results never becomes empty success',async()=>{
 for(const data of [{status:'ERROR',message:env.TRADING_MASSIVE_API_KEY},{status:'OK'}, {status:'OK',results:{}}])await assert.rejects(()=>historyFromMassive(request,env,async()=>new Response(JSON.stringify(data))));
});
test('reject wrong ticker, missing volume, wrong timestamp units, unaligned/out-of-range and invalid OHLC',()=>{
 for(const change of [{ticker:'GCZ6'},{volume:null},{window_start:Date.parse(request.from)},{window_start:'0'},{window_start:String(BigInt(row().window_start)+1n)},{window_start:row(60).window_start},{low:4405},{volume:-1},{open:'n/a'}])assert.throws(()=>normalizeMassiveBars([{...row(),...change}],window));
});
test('pagination normalizes sorted candles and identical overlap only once',async()=>{
 let calls=0;const result=await historyFromMassive(request,env,async(u,o)=>{
  calls++;assert.equal(o.headers.Authorization,'Bearer '+env.TRADING_MASSIVE_API_KEY);
  if(calls===1)return response([row(1),row()],{next_url:'https://api.massive.com/futures/v1/aggs/MGCZ6?cursor=next&apiKey=synthetic-untrusted'});
  assert.equal(new URL(u).searchParams.has('apiKey'),false);return response([row(1),row(2)]);
 });assert.equal(calls,2);assert.deepEqual(result.bars.map(b=>b.time),[0,1,2].map(m=>new Date(Date.parse(request.from)+m*60000).toISOString()));
});
test('conflicting duplicate candles abort before storage',async()=>{
 await assert.rejects(()=>historyFromMassive(request,env,async()=>response([row(),{...row(),close:4402}])),/Widersprüchliche/);
});
test('pagination cannot leak bearer to another origin, path, credentials or insecure URL',async()=>{
 for(const next_url of ['https://example.org/steal','http://api.massive.com/futures/v1/aggs/MGCZ6','https://user:pass@api.massive.com/futures/v1/aggs/MGCZ6','https://api.massive.com/futures/v1/aggs/GCZ6','not-a-url']){
  let calls=0;await assert.rejects(()=>historyFromMassive(request,env,async()=>{calls++;return response([row()],{next_url});}));assert.equal(calls,1);
 }
});
test('repeated next page aborts rather than silently importing partial history',async()=>{
 let calls=0;await assert.rejects(()=>historyFromMassive(request,env,async()=>{calls++;return response([row()],{next_url:'https://api.massive.com/futures/v1/aggs/MGCZ6?cursor=repeat'});}),/Pagination/);assert.equal(calls,2);
});
test('bounded pagination aborts at twelve pages',async()=>{
 let calls=0;await assert.rejects(()=>historyFromMassive(request,env,async()=>response([row()],{next_url:'https://api.massive.com/futures/v1/aggs/MGCZ6?cursor='+ ++calls})),/Pagination/);assert.equal(calls,12);
});
test('unknown explicit provider rejected; Databento explicit and legacy behavior retain cost check',async()=>{
 await assert.rejects(()=>historyFromProvider({...request,provider:'unknown'},env,never));
 for(const provider of [undefined,'databento']){
  const calls=[];const r=await historyFromProvider({...request,provider},{TRADING_DATABENTO_ENABLED:'true',TRADING_DATABENTO_KEY:'synthetic-databento'},async(u,o)=>{
   calls.push(new URL(u).pathname);assert.ok(o.headers.Authorization.startsWith('Basic '));
   return new Response(calls.length===1?'0.01':JSON.stringify({...row(),ts_event:request.from}));
  });assert.equal(r.source,'databento-historical');assert.equal(r.estimatedCostUSD,.01);assert.deepEqual(calls,['/v0/metadata.get_cost','/v0/timeseries.get_range']);
 }
});

async function invoke(handler,body,resource='history',method='POST'){
 const res={headers:{},setHeader(k,v){this.headers[k]=v;},end(s){this.body=JSON.parse(s);}};
 await handler({url:'/?resource='+resource,method,headers:{'content-type':'application/json'},body},res);return res;
}
test('API repeated Massive history import uses only existing candles, dedupes and reads same source',async()=>{
 const repo=new FileRepository();const handler=createTradingHandler({repo,env,authorize:()=>true,fetcher:async()=>response([row(),row(),row(1)])});
 for(let n=0;n<2;n++){const r=await invoke(handler,request);assert.equal(r.statusCode,200);assert.equal(r.body.count,2);assert.equal(r.body.source,'massive-historical');}
 const r=await invoke(handler,undefined,'candles&contract=MGCZ6&source=massive-historical&resolution=60','GET');assert.equal(r.body.bars.length,2);assert.ok(r.body.bars.every(b=>b.contract==='MGCZ6'&&b.source==='massive-historical'&&b.resolution===60));
 for(const kind of KINDS)assert.equal((await repo.list(kind)).length,0,kind+' untouched');
});
test('API provider failure causes no write or secret disclosure',async()=>{
 const repo=new FileRepository();let writes=0;repo.transaction=()=>{writes++;throw Error('Unexpected write');};
 const handler=createTradingHandler({repo,env,authorize:()=>true,fetcher:async()=>{throw Error(env.TRADING_MASSIVE_API_KEY);}});
 const r=await invoke(handler,request);assert.equal(r.statusCode,502);assert.equal(writes,0);assert.ok(!JSON.stringify(r.body).includes(env.TRADING_MASSIVE_API_KEY));
});
test('PGlite Massive repeat import respects existing unique key without schema changes or other writes',async()=>{
 const db=new PGlite();try{
  await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));
  const repo=new PgRepository(db),result=await historyFromMassive(request,env,async()=>response([row(),row(),row(1)]));
  await repo.storeCandles(result);await repo.storeCandles(result);
  assert.equal((await repo.candles('MGCZ6',{source:'massive-historical',resolution:60})).length,2);
  for(const kind of KINDS)assert.equal((await repo.list(kind)).length,0);
 }finally{await db.close();}
});
test('existing UI forwards selected source/contract and offers explicit provider without hardcoded key',async()=>{
 const src=await readFile(new URL('../../Trading/trading.js',import.meta.url),'utf8');
 assert.match(src,/select\('provider','Provider'/);assert.match(src,/\['massive','Massive'\]/);
 assert.match(src,/contract:s.contract,source:s.source,resolution:String\(s.resolution\)/);
 assert.match(src,/api\('history',\{\.\.\.d,from:formTime/);
 assert.ok(!src.includes('TRADING_MASSIVE_API_KEY'));
});
