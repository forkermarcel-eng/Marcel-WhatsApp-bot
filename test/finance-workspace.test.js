import test from 'node:test';import assert from 'node:assert/strict';
import {selectFinanceEvents,importantFinanceNews,parseEurostatEvents,createFinanceService,FINANCE_FEEDS} from '../brain-world/finance.js';
test('Eurostat all-day records never turn an incidental timestamp into a confirmed release time',()=>{
 const [event]=parseEurostatEvents([{recordid:'a',title:'GDP',start:'2026-10-20T11:00Z',allDay:true}], '2026-10-19T12:00Z');assert.equal(event.at,null);assert.equal(event.time_precision,'DATE');assert.equal(event.forecast,null);assert.equal(event.importance,'HIGH');
});
test('calendar keeps current official IDs, date precision and Berlin day boundaries',()=>{
 const now=Date.parse('2026-10-19T10:00Z'),sync={activeEventIds:['official-current'],lastSyncAt:new Date(now).toISOString()};const events=[{id:'official-current',at:'2026-10-19T00:00Z'},{id:'official-old',at:'2026-10-20T12:00Z'},{id:'other',at:'2026-10-17T12:00Z'}];const list=selectFinanceEvents(events,sync,now);assert.equal(list.length,1);assert.equal(list[0].id,'official-current');assert.equal(list[0].stale,false);
});
test('important stories remain traceable original headlines without fabricated analysis',()=>{
 const news=[{title:'EZB: Zinsen im Fokus',url:'https://example.org/a'},{title:'Energie und Ölpreis',url:'https://example.org/b'},{title:'Promi heiratet',url:'https://example.org/c'}];const result=importantFinanceNews(news);assert.deepEqual(result.map(x=>x.url),['https://example.org/a','https://example.org/b']);assert.ok(result.every(x=>!x.description));
});
test('finance feed refresh is bounded and preserves source errors without trading writes',async()=>{
 let requests=0,body={sources:{}};const now=Date.parse('2026-10-19T12:00Z');const pool={query:async(sql,args)=>{assert.ok(sql.includes('marcel_world.cache'));if(sql.startsWith('SELECT'))return {rows:[{body}]};body=JSON.parse(args[1]);return {rows:[]};}};
 const service=createFinanceService({pool,clock:()=>now,fetcher:async()=>{requests++;return new Response('',{status:403})},repository:{series:async()=>[],list:async()=>[],get:async()=>null}});
 await service.syncNews();await service.syncNews();assert.equal(requests,FINANCE_FEEDS.length+1);const data=await service.read();assert.equal(data.news.length,0);assert.ok(data.sourceStatus.every(x=>x.error));assert.equal(data.markets.length,0);
});
