import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {parseFeed,normalizePlace,normalizeWeather,createWorldService,TTL,hash} from '../brain-world/service.js';
import express from 'express';
import {registerWorldRoutes} from '../brain-world/routes.js';
import {relation,enrichLocations,placeIndex,preferredName,compactGerman,countryAt} from '../brain-world/geography.js';
import {presentItem} from '../brain-world/presentation.js';
import {clusterMarkers} from '../Brain/world-markers.js';
const now=Date.parse('2026-10-18T12:00:00Z');
const source={id:'test',name:'Testquelle',country:'KE',language:'de',category:'Welt'};
test('geographic evidence distinguishes mention, event, region and publisher; unknown countries never match',()=>{
 const place={id:'munich',name:'München',countryCode:'DE',region:'Bayern',lat:48.14,lon:11.58,level:'city'};
 const item={title:'München plant neue Straßenbahn',sourceCountry:'US'};item.geoRefs=enrichLocations(item,placeIndex([place]));assert.equal(relation(item,place),'place');assert.equal(item.geoRefs[0].role,'mentioned');
 assert.equal(relation({title:'Andere Stadt',geoRefs:[],sourceCountry:'DE'},place),null);
 assert.equal(relation({title:'Regionalnachrichten',coverage:{regions:['Bayern']}},place),'region');
 assert.equal(relation({title:'Ereignis',geoRefs:[{role:'event',lat:48.15,lon:11.6}]},place),'local');
 assert.equal(relation({geoRefs:[{countryCode:''}]},{name:'Meer',countryCode:'',lat:0,lon:0}),null);
 assert.equal(countryAt(48.14,11.58).countryCode,'DE');
});
test('readable genuine name variants and short German descriptions preserve meaning',()=>{
 assert.equal(preferredName({name:'Москва',namedetails:{'name:de':'Moskau','name:en':'Moscow'}}),'Moskau');
 assert.equal(preferredName({name:'ရန်ကုန်',namedetails:{'name:en':'Yangon'}}),'Yangon');
 assert.equal(compactGerman('München (standarddeutsch [ˈmʏnçn̩]) ist eine Stadt. Sie liegt in Bayern. Dritter Satz.',200),'München ist eine Stadt. Sie liegt in Bayern.');
 const quake=presentItem({sourceId:'usgs',title:'M 5.2 - Tonga',language:'en',location:{lat:-21,lon:-174}});assert.equal(quake.language,'de');assert.match(quake.title,/Magnitude 5,2/);assert.equal(quake.geoRole,'event');
});
test('zoom clusters preserve every article ID, event kind and actual member coordinate',()=>{
 const rows=[{lat:48.1,lon:11.1,kind:'news',ids:['a']},{lat:48.7,lon:11.7,kind:'news',ids:['b']},{lat:48.1,lon:11.1,kind:'earthquake',ids:['c']}];
 const wide=clusterMarkers(rows,4),close=clusterMarkers(rows,1.3);assert.equal(wide.length,2);assert.equal(close.length,3);assert.deepEqual(wide.find(x=>x.kind==='news').ids,['a','b']);assert.ok(rows.some(x=>x.lat===wide[0].lat&&x.lon===wide[0].lon));
});
test('German default, explicit originals, marker selection and persistent favorites work without memory writes',async()=>{
 const {db,pool}=await database();try{for(const language of ['de','en']){const id=hash(language),item={id,title:language==='de'?'Deutschland meldet Neues':'Germany news',language,sourceId:'test',sourceCountry:'US',category:'Welt'};await db.query("INSERT INTO marcel_world.news VALUES($1,$2,now(),now(),now()+interval '1 hour')",[id,item]);}
 const api=createWorldService({pool});assert.equal((await api.news()).items[0].language,'de');assert.equal((await api.news({language:'originals'})).items[0].language,'en');assert.equal((await api.news({ids:[hash('en')]})).total,0);
 const p={id:'munich',name:'München',lat:48.14,lon:11.58,countryCode:'DE'};await api.favorites(p);await api.favorites(p);assert.equal((await createWorldService({pool}).favorites()).length,1);assert.equal((await api.favorites(p,true)).length,0);assert.equal((await db.query('SELECT count(*) FROM marcel_knowledge.entries')).rows[0].count,0);assert.equal((await db.query('SELECT * FROM marcel_memory')).rows[0].human_verified,true);
 }finally{await db.close();}
});
test('RSS rejects expired/future/unsafe entries and preserves real geographic evidence',()=>{
 const raw=`<rss><channel><item><title><![CDATA[<b>Mombasa</b>]]></title><link>https://example.org/a</link><pubDate>Sun, 18 Oct 2026 10:00:00 GMT</pubDate><georss:point>-4.04 39.66</georss:point><media:thumbnail url="https://example.org/a.jpg"/></item><item><title>old</title><link>https://example.org/old</link><pubDate>Sun, 11 Oct 2026 10:00:00 GMT</pubDate></item><item><title>unsafe</title><link>javascript:alert(1)</link><pubDate>Sun, 18 Oct 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
 const rows=parseFeed(raw,source,now);assert.equal(rows.length,1);assert.equal(rows[0].title,'Mombasa');assert.equal(rows[0].sourceCountry,'KE');assert.deepEqual(rows[0].location,{lat:-4.04,lon:39.66});assert.ok(Date.parse(rows[0].expiresAt)<=now+TTL);
 assert.throws(()=>parseFeed('<html>blocked</html>',source,now));
 const central='<rss><channel><item><title>Aktuelle Meldung</title><link>https://example.org/cest</link><pubDate>Sun, 18 Oct 2026 13:00:00 CEST</pubDate></item></channel></rss>';
 assert.equal(parseFeed(central,source,now)[0].publishedAt,'2026-10-18T11:00:00.000Z');
});
test('places are arbitrary, keep geographic level and real timezone',()=>{
 for(const p of [{name:'Geithain',lat:'51.056',lon:'12.697',addresstype:'town',address:{country:'Deutschland',country_code:'de'}},{name:'Shanzu',lat:'-3.971',lon:'39.747',addresstype:'suburb',address:{country:'Kenia',country_code:'ke'}},{name:'Phuket',lat:'7.88',lon:'98.39',address:{country:'Thailand'}}]){const x=normalizePlace(p);assert.equal(x.name,p.name);assert.ok(x.timezone.includes('/'));assert.ok(Number.isFinite(x.lat));}assert.throws(()=>normalizePlace({lat:999,lon:0}));
});
test('official USGS Atom keeps event coordinates distinct from arbitrary place mentions',()=>{
 const raw='<feed><entry><title>M 5.2 - Tonga</title><link rel="alternate" href="https://earthquake.usgs.gov/example"/><updated>2026-10-18T10:00:00Z</updated><georss:point>-21.3 -174.3</georss:point></entry></feed>';
 const rows=parseFeed(raw,{...source,id:'usgs'},now);assert.equal(rows.length,1);assert.equal(rows[0].geoRole,'event');assert.deepEqual(rows[0].location,{lat:-21.3,lon:-174.3});
});
test('weather remains a timestamped forecast, not fabricated observations',()=>{
 const w=normalizeWeather({properties:{meta:{updated_at:'2026-10-18T10:00:00Z'},timeseries:[{time:'2026-10-18T12:00:00Z',data:{instant:{details:{air_temperature:24,relative_humidity:80,wind_speed:2}},next_1_hours:{summary:{symbol_code:'rain_day'},details:{precipitation_amount:1.2}}}}]}},-4,39,now);assert.equal(w.temperature,24);assert.equal(w.symbol,'rain_day');assert.equal(w.timezone,'Africa/Nairobi');assert.equal(w.kind,'Modellvorhersage');assert.throws(()=>normalizeWeather({},0,0,now));
});
async function database(){const db=new PGlite();await db.exec(readFileSync(new URL('../migrations/20261018_brain_world.sql',import.meta.url),'utf8'));await db.exec('CREATE SCHEMA marcel_knowledge; CREATE TABLE marcel_knowledge.meta(id text primary key,body jsonb); CREATE TABLE marcel_knowledge.entries(id text primary key,body jsonb); CREATE TABLE marcel_knowledge.documents(id text primary key,body jsonb); CREATE TABLE marcel_knowledge.evidence(id text primary key,body jsonb); CREATE TABLE marcel_memory(id int primary key, human_verified boolean); INSERT INTO marcel_memory VALUES(1,true);');const pool={query:(...args)=>db.query(...args),connect:async()=>({...pool,release(){}})};return {db,pool};}
test('bookmark is idempotent in existing archive and survives temporary cleanup without memory changes',async()=>{
 const {db,pool}=await database();try{const id=hash('https://example.org/test'),item={id,title:'Realer Quellenverweis',url:'https://example.org/test',source:'Testquelle',publishedAt:new Date().toISOString(),category:'Welt'};
 await db.query("INSERT INTO marcel_world.news VALUES($1,$2,now(),now(),now()+interval '1 hour')",[id,item]);
 const api=createWorldService({pool});const a=await api.bookmark(id,'Persönliche Notiz');assert.equal(a.kind,'source_reference');assert.equal((await api.bookmark(id)).id,a.id);
 await db.query("UPDATE marcel_world.news SET expires_at=now()-interval '1 second'");await api.cleanup();
 assert.equal((await db.query('SELECT * FROM marcel_world.news')).rows.length,0);assert.equal((await db.query('SELECT * FROM marcel_knowledge.entries')).rows.length,1);assert.deepEqual((await db.query('SELECT * FROM marcel_memory')).rows,[{id:1,human_verified:true}]);await assert.rejects(()=>api.bookmark(hash('missing')));
 }finally{await db.close();}
});
test('country-of-source never becomes a local event, failures preserve last weather with stale label',async()=>{
 const {db,pool}=await database();try{const item={id:'a',title:'Kenia allgemein',sourceCountry:'KE',language:'de',category:'Welt',location:null};await db.query("INSERT INTO marcel_world.news VALUES('a',$1,now(),now(),now()+interval '1 hour')",[item]);
 const api=createWorldService({pool,fetcher:async()=>{throw Error('outage');}});assert.equal((await api.news({scope:'local',name:'Mombasa',lat:-4,lon:39})).total,0);assert.equal((await api.news({scope:'source-country',country:'KE'})).total,1);
 await db.query("INSERT INTO marcel_world.cache VALUES('weather:-4.000,39.000',$1,now()-interval '1 second')",[{temperature:20,fetchedAt:new Date().toISOString()}]);assert.equal((await api.weather(-4,39)).stale,true);await assert.rejects(()=>api.weather(51,12));
 }finally{await db.close();}
});
test('world HTTP authorization blocks all operations before database access',async()=>{
 const app=express();const runtime=registerWorldRoutes({app,pool:{query(){throw Error('Must not touch database');}},authorized:()=>false});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{for(const method of ['GET','POST']){const r=await fetch(`http://127.0.0.1:${server.address().port}/dashboard-api/marcel-brain/world`,{method});assert.equal(r.status,401);assert.match(r.headers.get('cache-control'),/no-store/);}}finally{runtime.stop();await new Promise(r=>server.close(r));}
});
test('geocoding caches JSON arrays using explicit JSON encoding compatible with node-postgres',async()=>{
 const {db,pool}=await database();let calls=0,encoded=false;
 const wrapped={...pool,query(sql,args){if(sql.startsWith('INSERT INTO marcel_world.cache')&&args?.[0]?.startsWith('geo:')){assert.equal(typeof args[1],'string');assert.ok(Array.isArray(JSON.parse(args[1])));encoded=true;}return pool.query(sql,args);}};
 try{const service=createWorldService({pool:wrapped,fetcher:async()=>{calls++;return new Response(JSON.stringify([{name:'Geithain',lat:'51.054',lon:'12.694',address:{country:'Deutschland'}}]),{headers:{'Content-Type':'application/json'}});}});
 assert.equal((await service.search('Geithain'))[0].name,'Geithain');assert.equal((await service.search('Geithain'))[0].name,'Geithain');assert.equal(calls,1);assert.ok(encoded);
 }finally{await db.close();}
});
