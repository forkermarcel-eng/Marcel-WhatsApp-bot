import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {newsTimestamp,sortedNews,radarNews,newsRelevance,eventRelevance} from '../../Trading/news-context.js';
import {buildInstrumentContexts,prioritizeNews} from '../server/market-context.js';
import {FileRepository,PgRepository} from '../server/repository.js';
import {fetchNews,parseNewsSource,EXTRA_NEWS} from '../server/news-sources.js';
import {syncSources} from '../server/context-sync.js';
import {parseRSS} from '../server/providers.js';
import {startContextWorker} from '../workers/context.js';
const now='2026-10-15T10:00:00Z';
const n=(id,publishedAt,source='BBC Welt',title=id)=>({id,publishedAt,source,title,url:'https://example.org/'+id});
test('Official EIA relative links resolve to HTTPS; full article stays absent',()=>{
 const [row]=parseRSS('<rss><item><title>EIA oil supply</title><link>/pressroom/releases/press593.php</link><description>DO NOT STORE</description></item></rss>',{name:'EIA Press',url:'https://www.eia.gov/rss/press_rss.xml'},now);
 assert.equal(row.url,'https://www.eia.gov/pressroom/releases/press593.php');assert.ok(!JSON.stringify(row).includes('DO NOT STORE'));
 assert.equal(parseRSS('<rss><item><title>Missing link</title></item></rss>',{url:'https://www.eia.gov/rss/press_rss.xml'},now).length,0);
});
test('22:17 before 17:26, source/relevance never override publication order',()=>{
 const rows=[n('earlier','2026-10-14T17:26:00+02:00','Federal Reserve','Fed inflation'),n('latest','2026-10-14T22:17:00+02:00','BBC Welt','Oil production'),n('first','2026-10-14T15:11:00+02:00')];
 assert.deepEqual(prioritizeNews(rows).map(x=>x.id),['latest','earlier','first']);
});
test('UTC offsets, cross-day, DST repeated hour and stable equal-time IDs',()=>{
 const rows=[n('a','2026-10-25T02:30:00+02:00'),n('b','2026-10-25T02:15:00+01:00'),n('c','2026-10-26T00:00:00Z'),n('d','2026-10-25T01:15:00Z')];
 assert.deepEqual(sortedNews(rows).map(x=>x.id),['c','b','d','a']);
});
test('Canonical published_at, seen_at/fetched_at fallback; no insertion or timezone-free fallback',()=>{
 assert.equal(newsTimestamp({published_at:'invalid',seen_at:now,createdAt:'2099-01-01T00:00:00Z'}),Date.parse(now));
 assert.equal(newsTimestamp({published_at:'2026-10-15T10:00:00',fetched_at:now}),Date.parse(now));
 assert.equal(newsTimestamp({createdAt:now}),0);
});
test('Same publisher normalized headline dedupe; independent publishers retained',()=>{
 const a=n('a',now,'BBC','BREAKING: Oil — supply disrupted!'),b=n('b',now,'BBC','Oil supply disrupted'),c=n('c',now,'UN News','Oil supply disrupted');
 assert.equal(sortedNews([a,b,c]).length,2);assert.equal(sortedNews([a,{...b,title:'Oil supply restored'},c]).length,3);
});
test('Oil infrastructure attacks HIGH; gold rates relevant; global override across all instruments',()=>{
 assert.equal(newsRelevance(n('a',now,'BBC','Drone attack on refinery and tanker'),'MCL').relevance,'HIGH');
 assert.notEqual(newsRelevance(n('b',now,'BBC','Real yields fall'),'MGC').relevance,'LOW');
 for(const i of ['MGC','MCL','MNQ','MYM'])assert.equal(newsRelevance(n('c',now,'BBC','Banking crisis and war'),i).global,true);
 assert.equal(newsRelevance(n('d',now,'BBC','China paid companions tackle loneliness')).geopolitical,false);
});
test('Filters select by instrument without reordering; no relevant items fabricated',()=>{
 const rows=[n('a',now,'BBC','Semiconductor earnings'),n('b','2026-10-14T22:00:00Z','BBC','OPEC crude cuts'),n('c','2026-10-14T21:00:00Z','BBC','FOMC inflation')];
 assert.deepEqual(radarNews(rows,'MCL').map(x=>x.id),['b','c']);
 assert.deepEqual(radarNews(rows,'MNQ').map(x=>x.id),['a','c']);
 assert.equal(radarNews(rows,'MCL','all').length,3);assert.equal(radarNews(rows,'MCL','macro').length,1);
});
test('Four contexts have independent rules, real inputs only, inventories unknown',()=>{
 const observations=[['DGS2',4,-2],['DGS10',5,-2],['DFII10',2,-2],['DTWEXBGS',120,-.2]].map(([id,value,delta])=>({id,value,at:now,change_bps:delta,change:delta}));
 const markets={MNQ:{at:now,change_pct:-1},MYM:{at:now,change_pct:-1},MCL:{at:now,value:90,change_pct:1}};
 const r=buildInstrumentContexts({observations,markets},now);
 assert.equal(r.MGC.bias,'BULLISH');assert.equal(r.MNQ.bias,'NEUTRAL');assert.equal(r.MYM.bias,'NEUTRAL');
 assert.equal(r.MCL.name,'OIL');assert.equal(r.MNQ.name,'NASDAQ');assert.equal(r.MYM.name,'DOW');
 assert.ok(r.MCL.regimes.some(([k,v])=>k==='Inventories'&&v==='Nicht verfügbar'));
 assert.ok(!r.MCL.observationIds.includes('DFII10'));assert.ok(r.MNQ.observationIds.includes('DFII10'));
 assert.equal(buildInstrumentContexts({},now).MCL.bias,'NEUTRAL');
});
test('Calendar relevance does not remove any events',()=>{
 assert.equal(eventRelevance({title:'EIA Petroleum Report',impact:'MEDIUM'},'MCL'),'HIGH');
 assert.equal(eventRelevance({title:'EIA Petroleum Report'},'MGC'),'MEDIUM');
 for(const i of ['MGC','MNQ','MYM'])assert.equal(eventRelevance({title:'CPI / FOMC'},i),'HIGH');
});
test('File and PostgreSQL news ordering match with malformed dates, before LIMIT',async()=>{
 const db=new PGlite();try{await db.exec(await readFile(new URL('../schema.sql',import.meta.url),'utf8'));const pg=new PgRepository(db),file=new FileRepository();
  const rows=[n('a','2026-10-14T22:17:00+02:00'),n('b','2026-10-14T17:26:00+02:00'),{...n('c','bad'),seen_at:now},n('d',null)];
  for(const row of rows){await pg.put('news',row);await file.put('news',row);}
  assert.deepEqual((await pg.list('news',3)).map(x=>x.id),['c','a','b']);
  assert.deepEqual(await pg.list('news'),await file.list('news'));
 }finally{await db.close();}
});
test('Conditional fetch sends validators; 304 does not require body',async()=>{
 let headers;const r=await fetchNews('https://example.org',{etag:'etag',lastModified:'date'},async(u,o)=>{headers=o.headers;return new Response(null,{status:304});});
 assert.equal(headers['If-None-Match'],'etag');assert.equal(headers['If-Modified-Since'],'date');assert.equal(r.notModified,true);
});
test('GDELT 429 exposes only status/retry and does not consume an article',async()=>{
 await assert.rejects(()=>fetchNews('https://example.org',{},async()=>new Response('private upstream body',{status:429,headers:{'retry-after':'7200'}})),e=>e.httpStatus===429&&e.retryMs===7200000&&!e.message.includes('private'));
});
test('Discovery stores headline/link only; seen is not published; indexes do not invent time',()=>{
 const g=EXTRA_NEWS.find(x=>x.format==='gdelt'),[a]=parseNewsSource(JSON.stringify({articles:[{title:'Oil supply',url:'https://example.org/a',domain:'example.org',seendate:'20261015T090000Z',content:'FORBIDDEN ARTICLE'}]}),g,now);
 assert.equal(a.publishedAt,null);assert.equal(a.seen_at,'2026-10-15T09:00:00Z');assert.equal(a.content,undefined);
 const [b]=parseNewsSource('<a href="/recent-actions/20261015">Sanctions action</a>',EXTRA_NEWS[1],now);assert.equal(b.publishedAt,null);assert.equal(b.published_date_label,'20261015');
});
test('Source outage/429 retains persisted news and backs off across worker restarts',async()=>{
 const repo=new FileRepository();await repo.put('news',n('existing',now));
 const feed=EXTRA_NEWS.find(x=>x.format==='gdelt');let calls=0;
 const deps={parseRSS,feeds:[feed],read:async()=>{throw Error('fixture offline');},readNews:async()=>{calls++;const e=Error('secret must not appear');e.httpStatus=429;throw e;}};
 await syncSources(repo,{TRADING_NEWS_ENABLED:'true'},deps,now);
 await syncSources(repo,{TRADING_NEWS_ENABLED:'true'},deps,'2026-10-15T10:10:00Z');
 assert.equal(calls,1);assert.ok(await repo.get('news','existing'));
 const cache=await repo.get('settings','contextSourceCache');assert.equal(cache.sources['news:GDELT Discovery'].nextAttemptAt,'2026-10-15T11:00:00.000Z');assert.ok(!JSON.stringify(cache).includes('secret'));
 await syncSources(repo,{TRADING_NEWS_ENABLED:'true'},deps,'2026-10-15T11:00:00Z');
 assert.equal((await repo.get('settings','contextSourceCache')).sources['news:GDELT Discovery'].nextAttemptAt,'2026-10-15T13:00:00.000Z');
});
test('304 keeps first-seen and rows, ten minute cadence avoids repeat requests',async()=>{
 const repo=new FileRepository(),feed={name:'fixture',url:'https://example.org/rss'};let calls=0;
 const deps={parseRSS,feeds:[feed],read:async()=>{throw Error('fixture offline');},readNews:async()=>{calls++;return calls===1?{raw:'<rss><item><title>Oil</title><link>https://example.org/oil</link></item></rss>',etag:'x'}:{notModified:true};}};
 await syncSources(repo,{TRADING_NEWS_ENABLED:'true'},deps,now);await syncSources(repo,{TRADING_NEWS_ENABLED:'true'},deps,'2026-10-15T10:05:00Z');assert.equal(calls,1);
 await syncSources(repo,{TRADING_NEWS_ENABLED:'true'},deps,'2026-10-15T10:09:59Z');assert.equal(calls,2,'one-second timer jitter must not delay news another ten minutes');assert.equal((await repo.list('news'))[0].observedAt,now);
});
test('Worker timer non-overlap, outage retry, stop and schema readiness',async()=>{
 let scheduled,delay,calls=0,release;const repo={health:async()=>({ready:true})};
 const worker=startContextWorker({repo,immediate:false,setTimer:(fn,ms)=>{scheduled=fn;delay=ms;return 1;},clearTimer:()=>{},log:()=>{},sync:async()=>{calls++;await new Promise(r=>release=r);return {reports:[],at:now};}});
 assert.equal(delay,600000);const first=scheduled();await new Promise(r=>setImmediate(r));const duplicate=scheduled();assert.equal(calls,1);release();await first;await duplicate;
 const second=scheduled();await new Promise(r=>setImmediate(r));assert.equal(calls,2);release();await second;await worker.stop();await scheduled();assert.equal(calls,2);
});
