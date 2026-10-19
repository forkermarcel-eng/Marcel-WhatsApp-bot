import test from 'node:test';import assert from 'node:assert/strict';
import {selectFinanceEvents,importantFinanceNews,parseEurostatEvents,createFinanceService,FINANCE_FEEDS,FINANCE_MARKETS} from '../brain-world/finance.js';
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
 await service.syncNews();await service.syncNews();assert.equal(requests,FINANCE_FEEDS.length+1);const data=await service.read();assert.equal(data.news.length,0);assert.ok(data.sourceStatus.every(x=>x.error));assert.equal(data.markets.length,8);assert.ok(data.markets.every(m=>m.status==='unavailable'&&m.value===null&&m.chart.length===0));assert.equal(data.marketStatus.actualRefreshMinutes,null);
});

test('finance dashboard never reads Trading candles or substitutes futures for its eight instruments',async()=>{
 const reads=[];const repository={list:async(table)=>{reads.push(table);assert.equal(table,'events');return [];},get:async(table,id)=>{assert.equal(table,'settings');assert.equal(id,'providerSync');return null;},series:async()=>{throw Error('Must not read Trading market series');},candles:async()=>{throw Error('Must not read Trading candles');}};
 const data=await createFinanceService({pool:{query:async()=>({rows:[]})},repository}).read();assert.deepEqual(data.markets.map(m=>m.contract),['DAX','S&P 500','Nasdaq 100','Dow Jones','Goldpreis','Bitcoin / USD','EUR / USD','Brent-Öl']);assert.deepEqual(reads,['events']);assert.equal(data.markets.length,FINANCE_MARKETS.length);assert.ok(data.markets.every(m=>m.at===null&&m.change===null&&m.changePercent===null&&m.source===null&&m.reason));
});
test('finance topics select traceable original headlines without duplicate lists',async()=>{
 globalThis.document={createElement:()=>({}),head:{append(){}}};const {filterFinanceNews,financeHTML}=await import('../Brain/finance-view.js');delete globalThis.document;
 const items=[{title:'EZB senkt Zinsen',url:'https://example.org/a'},{title:'Bitcoin steigt',url:'https://example.org/b'},{title:'Verbraucherpreise und Inflation',url:'https://example.org/c'}];assert.deepEqual(filterFinanceNews(items,'rates'),[items[0]]);assert.deepEqual(filterFinanceNews(items,'crypto'),[items[1]]);assert.deepEqual(filterFinanceNews(items,'inflation'),[items[2]]);assert.equal(filterFinanceNews(items,'all').length,3);
 const esc=x=>String(x??'');const html=financeHTML({news:items},{esc,safe:x=>x});assert.equal((html.match(/class="finance-panel finance-news"/g)||[]).length,1);assert.ok(!html.includes('finance-important'));assert.ok(html.indexOf('finance-news')<html.indexOf('finance-calendar'));assert.equal((html.match(/Originalmeldung beim Anbieter lesen/g)||[]).length,3);
});
