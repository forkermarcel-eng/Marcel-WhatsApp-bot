import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {FileRepository} from '../server/repository.js';
import {syncSources,newsPollInterval} from '../server/context-sync.js';
import {parseRSS} from '../server/providers.js';
import {EXTRA_NEWS} from '../server/news-sources.js';
import {officialJobs} from '../server/official-context.js';
import {createTradingHandler} from '../server/api.js';

const now='2026-10-15T10:00:00Z',env={TRADING_NEWS_ENABLED:'true'};
const xml=(id='one',title='Oil supply')=>'<rss><item><title>'+title+'</title><link>https://example.org/'+id+'</link><pubDate>Thu, 15 Oct 2026 10:00:00 GMT</pubDate></item></rss>';
const offline=async()=>{throw Error('fixture timeout');};
const feed={name:'Federal Reserve',url:'https://example.org/fed'};
const deps=(readNews,feeds=[feed])=>({feeds,readNews,read:offline,parseRSS});
test('All official news 120s; normal RSS 240s; discovery >=600s; calendars 30m; daily/weekly unchanged',()=>{
 for(const name of ['Federal Reserve','Fed Monetary Policy','Fed Speeches','EZB','Bank of Japan','EIA','EIA Press','DOE','IEA','Treasury OFAC'])assert.equal(newsPollInterval({name}),120000,name);
 for(const name of ['BBC Welt','BBC Wirtschaft','UN News','Other RSS'])assert.equal(newsPollInterval({name}),240000,name);
 assert.ok(newsPollInterval(EXTRA_NEWS.find(x=>x.format==='gdelt'))>=600000);
 const jobs=officialJobs(now);assert.ok(jobs.filter(x=>x.kind==='events').every(x=>x.ttl===1800000));
 assert.ok(jobs.filter(x=>x.name.startsWith('Treasury ')&&x.kind==='observations').every(x=>x.ttl===86400000));
 assert.equal(jobs.find(x=>x.name==='Fed H10').ttl,7*86400000);
});
test('Four request limit includes two-URL calendar; timeout is isolated; official news persists before slow tail',async()=>{
 const repo=new FileRepository();let inFlight=0,max=0,release,slowStarted;
 const started=new Promise(r=>slowStarted=r),blocked=new Promise(r=>release=r);
 const request=async(url,news=false)=>{
  inFlight++;max=Math.max(max,inFlight);
  try{
   if(String(url).endsWith('/slow')){slowStarted();await blocked;throw Object.assign(Error('timeout'),{name:'TimeoutError'});}
   await new Promise(r=>setTimeout(r,1));
   if(news)return {raw:xml(String(url).split('/').at(-1)),httpStatus:200};
   throw Error('fixture offline');
  }finally{inFlight--;}
 };
 const feeds=[feed,...Array.from({length:5},(_,i)=>({name:'Normal '+i,url:'https://example.org/rss'+i})),{name:'GDELT Discovery',format:'gdelt',url:'https://example.org/slow'}];
 const run=syncSources(repo,env,{feeds,parseRSS,read:u=>request(u),readNews:u=>request(u,true)},now);
 await started;assert.ok((await repo.list('news')).some(x=>x.source==='Federal Reserve'),'news visible while slow source pending');
 release();const result=await run;
 assert.ok(max<=4);assert.equal(max,4);assert.equal(result.reports.find(x=>x.name==='GDELT Discovery').healthy,false);
 assert.equal(result.reports.filter(x=>x.kind==='news'&&x.healthy).length,6);
 assert.ok((await repo.list('news'))[0].instrumentRelevance.MGC);
});
test('304 performs no parsing/content writes; persists only check metadata; cached tick writes nothing',async()=>{
 const repo=new FileRepository();let parses=0;
 const dependencies={...deps(async()=>({raw:xml(),etag:'tag',lastModified:'date',httpStatus:200})),parseRSS:(...x)=>{parses++;return parseRSS(...x);}};
 await syncSources(repo,env,dependencies,now);
 const before=await repo.list('news');const original=repo.transaction.bind(repo),writes=[];
 repo.transaction=fn=>original(tx=>fn(new Proxy(tx,{get:(target,key)=>key==='put'?async(kind,row,opts)=>{writes.push(kind);return target.put(kind,row,opts);}:typeof target[key]==='function'?target[key].bind(target):target[key]})));
 dependencies.readNews=async()=>({notModified:true,httpStatus:304});
 const result=await syncSources(repo,env,dependencies,'2026-10-15T10:02:00Z');
 assert.equal(result.reports.find(x=>x.name===feed.name).httpStatus,304);assert.equal(parses,1);assert.deepEqual(await repo.list('news'),before);
 assert.ok(writes.every(k=>k==='settings'));assert.equal(result.newNewsCount,0);
 const state=(await repo.get('settings','contextSourceCache')).sources['news:'+feed.name];
 assert.equal(state.last_checked_at,'2026-10-15T10:02:00Z');assert.equal(state.last_success_at,state.last_checked_at);
 assert.equal(state.last_new_item_at,now);assert.equal(state.last_http_status,304);assert.equal(state.etag,'tag');assert.equal(state.last_modified,'date');assert.equal(state.consecutive_failures,0);assert.equal(state.next_allowed_poll_at,'2026-10-15T10:04:00.000Z');
 writes.length=0;await syncSources(repo,env,dependencies,'2026-10-15T10:03:00Z');assert.equal(writes.length,0);
});
test('Repeated 200 creates no duplicates, does not rewrite identical news or advance last_new_item_at',async()=>{
 const repo=new FileRepository(),d=deps(async()=>({raw:xml(),httpStatus:200}));
 assert.equal((await syncSources(repo,env,d,now)).newNewsCount,1);
 const before=await repo.list('news');let newsWrites=0;const original=repo.transaction.bind(repo);
 repo.transaction=fn=>original(tx=>fn(new Proxy(tx,{get:(target,key)=>key==='put'?async(kind,...args)=>{if(kind==='news')newsWrites++;return target.put(kind,...args);}:typeof target[key]==='function'?target[key].bind(target):target[key]})));
 assert.equal((await syncSources(repo,env,d,'2026-10-15T10:02:00Z')).newNewsCount,0);
 assert.equal(newsWrites,0);assert.deepEqual(await repo.list('news'),before);
 assert.equal((await repo.get('settings','contextSourceCache')).sources['news:'+feed.name].last_new_item_at,now);
});
test('GDELT Retry-After/backoff never reduces interval or blocks official poll',async()=>{
 const repo=new FileRepository();let fed=0,gdelt=0;
 const d=deps(async u=>{if(String(u).endsWith('/g')){gdelt++;throw Object.assign(Error('429'),{httpStatus:429,retryMs:7200000});}fed++;return {raw:xml()};},[feed,{name:'GDELT Discovery',format:'gdelt',url:'https://example.org/g',ttl:600000}]);
 await syncSources(repo,env,d,now);await syncSources(repo,env,d,'2026-10-15T10:02:00Z');
 assert.equal(fed,2);assert.equal(gdelt,1);
 const state=(await repo.get('settings','contextSourceCache')).sources['news:GDELT Discovery'];assert.equal(state.next_allowed_poll_at,'2026-10-15T12:00:00.000Z');assert.equal(state.consecutive_failures,1);
});
test('Same-source same-day headline with changed URL/timestamp is not reinserted',async()=>{
 const repo=new FileRepository();await syncSources(repo,env,deps(async()=>({raw:xml('old')})),now);
 const result=await syncSources(repo,env,deps(async()=>({raw:xml('new').replace('10:00:00','10:01:00')})),'2026-10-15T10:02:00Z');
 assert.equal(result.newNewsCount,0);assert.equal((await repo.list('news')).length,1);
});
test('HTTP 200 parser failure retains actual HTTP status without losing prior data',async()=>{
 const repo=new FileRepository();await syncSources(repo,env,deps(async()=>({raw:xml()})),now);
 const result=await syncSources(repo,env,deps(async()=>({raw:'not a feed',httpStatus:200})),'2026-10-15T10:02:00Z');
 const r=result.reports.find(r=>r.name===feed.name);assert.equal(r.healthy,false);assert.equal(r.httpStatus,200);
 assert.equal((await repo.get('settings','contextSourceCache')).sources['news:'+feed.name].last_http_status,200);
 assert.equal((await repo.list('news')).length,1);
});
test('Existing healthy ten-minute cache adopts 120s without shortening failure backoff',async()=>{
 const repo=new FileRepository();await syncSources(repo,env,deps(async()=>({raw:xml()})),now);
 const cache=await repo.get('settings','contextSourceCache');const c=cache.sources['news:'+feed.name];c.nextAttemptAt=c.next_allowed_poll_at='2026-10-15T10:10:00Z';await repo.put('settings',cache,{update:true});
 let calls=0;await syncSources(repo,env,deps(async()=>{calls++;return {notModified:true};}),'2026-10-15T10:02:00Z');assert.equal(calls,1);
});
test('GET news returns saved context only, with existing auth, no journal writes or provider requests',async t=>{
 const repo=new FileRepository();await repo.put('news',{id:'n',title:'Oil supply',source:'EIA',url:'https://example.org/n',publishedAt:now});
 const oldList=repo.list.bind(repo);repo.list=async kind=>{assert.ok(['news','events','observations','context'].includes(kind));return oldList(kind);};
 repo.put=()=>{throw Error('GET must not write');};
 const server=http.createServer(createTradingHandler({repo,env:{TRADING_API_SECRET:'fixture-only'}}));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/?resource=news';
 assert.equal((await fetch(url)).status,401);
 const r=await fetch(url,{headers:{Authorization:'Bearer fixture-only'}}),b=await r.json();assert.equal(r.status,200);
 for(const key of ['news','events','observations','context','sync','marketContext','marketContexts'])assert.ok(key in b,key);
 for(const key of ['plans','executions','reviews','drawings','attachments','series','metrics'])assert.ok(!(key in b),key);
 assert.equal(b.news.length,1);
});
