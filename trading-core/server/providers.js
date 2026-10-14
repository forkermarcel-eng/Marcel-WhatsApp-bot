import {createHash} from 'node:crypto';
import {invariant,iso,text,validateCandle,contractValid,INSTRUMENTS} from '../../Trading/domain.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
export const NEWS_FEEDS=[
 {name:'Federal Reserve',url:'https://www.federalreserve.gov/feeds/press_all.xml',topic:'Zentralbanken'},
 {name:'EZB',url:'https://www.ecb.europa.eu/rss/press.html',topic:'Zentralbanken'},
 {name:'BBC Welt',url:'https://feeds.bbci.co.uk/news/world/rss.xml',topic:'Geopolitik'},
 {name:'BBC Wirtschaft',url:'https://feeds.bbci.co.uk/news/business/rss.xml',topic:'Makro'}
];
export function providerStatus(env=process.env){return {news:{configured:env.TRADING_NEWS_ENABLED==='true',type:'RSS-Titel/Links · kein Volltextarchiv'},calendar:{configured:!!env.TRADING_ECONOMIC_CALENDAR_KEY,provider:'Trading Economics'},macro:{configured:!!env.TRADING_FRED_KEY,provider:'FRED · Tageswerte, nicht live'},history:{configured:!!env.TRADING_DATABENTO_KEY&&env.TRADING_DATABENTO_ENABLED==='true',provider:'Databento · kostenpflichtig / Entitlement'},massive:{configured:!!env.TRADING_MASSIVE_API_KEY&&env.TRADING_MASSIVE_ENABLED==='true',provider:'Massive · Futures-Historie / Entitlement'},live:{configured:!!env.TRADING_INGEST_TOKEN,provider:'Separater Databento-Worker · letzter Datensatz entscheidet'},brain:{configured:!!env.TRADING_INTELLIGENCE_TOKEN,mode:'Read-only Export'},broker:{configured:false,mode:'KEINE VERBINDUNG'}};}
export async function boundedFetch(url,options={},fetcher=fetch,maxBytes=2_000_000){const r=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(12000)});if(!r.ok){const e=Error(`Datenanbieter antwortet HTTP ${r.status}.`);e.status=502;throw e;}if(Number(r.headers.get('content-length')||0)>maxBytes)throw Error('Datenanbieter-Antwort zu groß.');const chunks=[];let length=0;if(r.body?.getReader){const rd=r.body.getReader();try{for(;;){const {done,value}=await rd.read();if(done)break;length+=value.length;if(length>maxBytes){await rd.cancel();throw Error('Datenlimit überschritten.');}chunks.push(Buffer.from(value));}}finally{rd.releaseLock();}return Buffer.concat(chunks).toString('utf8');}const s=await r.text();if(Buffer.byteLength(s)>maxBytes)throw Error('Datenlimit überschritten.');return s;}
export function safeURL(x){try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password?u.toString():'';}catch{return '';}}
const decode=x=>String(x||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|apos);/g,(_,n)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[n])).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,Number(n)))).trim();
export function parseRSS(xml,feed,now=new Date().toISOString()){
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('RSS mit DTD/Entities wird nicht verarbeitet.');
 const items=[...xml.matchAll(/<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi)].slice(0,30);
 return items.map(m=>{const body=m[1],get=k=>decode(body.match(new RegExp(`<${k}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${k}>`,'i'))?.[1]);const title=get('title'),url=safeURL(get('link')||body.match(/<link[^>]+href=["']([^"']+)/i)?.[1]);const date=get('pubDate')||get('published')||get('updated');return {id:hash(url||title.toLowerCase()),title:text(title,350),url,source:feed.name,topic:feed.topic,publishedAt:Number.isFinite(Date.parse(date))?new Date(date).toISOString():null,observedAt:now,createdAt:now,verification:'SOURCE_REPORT',note:'Quellenmeldung, keine eigenständig verifizierte Tatsache.'};}).filter(x=>x.title&&x.url);
}
export async function syncContext(repo,env=process.env,fetcher=fetch){const at=new Date().toISOString();const reports=[];let news=[],events=[],observations=[];
 if(env.TRADING_NEWS_ENABLED==='true')await Promise.all(NEWS_FEEDS.map(async f=>{try{news.push(...parseRSS(await boundedFetch(f.url,{},fetcher,800000),f,at));reports.push({name:f.name,status:'OK',at});}catch(e){reports.push({name:f.name,status:'ERROR',at,message:e.message});}}));
 else reports.push({name:'News',status:'NOT_CONFIGURED',at});
 let calendarStatus='NOT_CONFIGURED';
 if(env.TRADING_ECONOMIC_CALENDAR_KEY){try{const from=at.slice(0,10),to=new Date(Date.now()+7*86400000).toISOString().slice(0,10);const url=new URL(`https://api.tradingeconomics.com/calendar/country/All/${from}/${to}`);url.searchParams.set('c',env.TRADING_ECONOMIC_CALENDAR_KEY);url.searchParams.set('f','json');const data=JSON.parse(await boundedFetch(url,{},fetcher));invariant(Array.isArray(data),'Kalenderformat ungültig.');events=data.slice(0,500).map(x=>{const d=String(x.Date||'');return {id:'te-'+x.CalendarId,title:text(x.Event,250),at:iso(/(Z|[+-]\d\d:\d\d)$/.test(d)?d:d+'Z'),country:text(x.Country,80),impact:Number(x.Importance)===3?'HIGH':Number(x.Importance)===2?'MEDIUM':'LOW',actual:text(x.Actual,80),forecast:text(x.Forecast,80),previous:text(x.Previous,80),source:'Trading Economics',url:safeURL(x.URL?.startsWith('http')?x.URL:'https://tradingeconomics.com'+(x.URL||'')),observedAt:at,createdAt:at};});calendarStatus='OK';reports.push({name:'Kalender',status:'OK',at});}catch(e){calendarStatus='ERROR';reports.push({name:'Kalender',status:'ERROR',at,message:e.message});}}
 if(env.TRADING_FRED_KEY)await Promise.all([['DGS2','US 2Y','%'],['DGS10','US 10Y','%'],['DFII10','US Real 10Y','%'],['DTWEXBGS','USD breit (NICHT DXY)','Index']].map(async([code,label,unit])=>{try{const u=new URL('https://api.stlouisfed.org/fred/series/observations');for(const [k,v]of Object.entries({api_key:env.TRADING_FRED_KEY,series_id:code,file_type:'json',sort_order:'desc',limit:'10'}))u.searchParams.set(k,v);const rows=JSON.parse(await boundedFetch(u,{},fetcher)).observations;const point=rows?.find(x=>x.value!=='.'&&Number.isFinite(+x.value));if(!point)throw Error('Keine gültige Beobachtung.');observations.push({id:code,label,value:+point.value,unit,at:point.date+'T00:00:00.000Z',observedAt:at,source:'FRED · Tageswert',url:`https://fred.stlouisfed.org/series/${code}`,frequency:'DAILY',createdAt:at});reports.push({name:label,status:'OK',at});}catch(e){reports.push({name:label,status:'ERROR',at,message:e.message});}}));
 else reports.push({name:'FRED',status:'NOT_CONFIGURED',at});
 await repo.transaction(async tx=>{for(const n of news){const old=await tx.get('news',n.id);if(!old)await tx.put('news',n);}for(const e of events)await tx.put('events',e,{update:true});for(const o of observations)await tx.put('observations',o,{update:true});await tx.put('settings',{id:'providerSync',reports,calendarStatus,lastSyncAt:at,createdAt:at},{update:true});});
 return {reports,calendarStatus,newsCount:news.length,eventCount:events.length,observations:observations.length,at};
}
export function parseDatabentoJSON(raw){const records=raw.trim().startsWith('[')?JSON.parse(raw):raw.trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));return records.map(x=>{let time=x.ts_event??x.hd?.ts_event;if(typeof time==='number'||/^\d+$/.test(String(time)))time=new Date(Number(BigInt(String(time))/1000000n)).toISOString();return validateCandle({...x,time});});}
export async function historyFromDatabento(body,env=process.env,fetcher=fetch){invariant(env.TRADING_DATABENTO_ENABLED==='true'&&env.TRADING_DATABENTO_KEY,'Databento nicht konfiguriert/freigegeben.');const root=text(body.instrument,8),contract=text(body.contract,24);invariant(INSTRUMENTS[root]&&contractValid(root,contract),'Exakter Kontrakt fehlt.');const start=iso(body.from),end=iso(body.to);invariant(Date.parse(end)>Date.parse(start)&&Date.parse(end)-Date.parse(start)<=7*86400000,'Ein Abruf umfasst maximal sieben Tage.');invariant(Date.parse(end)<=Date.now(),'Historischer Endzeitpunkt darf nicht in der Zukunft liegen.');
 const args={dataset:'GLBX.MDP3',symbols:contract,stype_in:'raw_symbol',schema:'ohlcv-1m',start,end};const headers={Authorization:'Basic '+Buffer.from(env.TRADING_DATABENTO_KEY+':').toString('base64')};
 const costURL=new URL('https://hist.databento.com/v0/metadata.get_cost');for(const[k,v]of Object.entries(args))costURL.searchParams.set(k,v);
 const price=JSON.parse(await boundedFetch(costURL,{headers},fetcher)),cost=Number(typeof price==='number'?price:price.cost_usd??price.cost);
 invariant(Number.isFinite(cost)&&cost>=0,'Datenkosten konnten nicht verifiziert werden; Abruf gestoppt.');const cap=Number(env.TRADING_HISTORY_MAX_COST_USD||0.5);invariant(cost<=cap,`Geschätzte Datenkosten ${cost} USD überschreiten Limit ${cap} USD.`);
 const url=new URL('https://hist.databento.com/v0/timeseries.get_range');for(const[k,v]of Object.entries({...args,encoding:'json',compression:'none',pretty_px:'true',pretty_ts:'true',limit:'11000'}))url.searchParams.set(k,v);
 return {contract,source:'databento-historical',resolution:60,bars:parseDatabentoJSON(await boundedFetch(url,{headers},fetcher,8_000_000)),estimatedCostUSD:cost};
}

// Explicit provider selection; omitted provider retains the existing Databento API contract.
export async function historyFromProvider(body,env=process.env,fetcher=fetch){
 const provider=body.provider??'databento';
 invariant(provider==='databento'||provider==='massive','Unbekannter History-Provider.');
 return provider==='massive'?historyFromMassive(body,env,fetcher):historyFromDatabento(body,env,fetcher);
}

export function normalizeMassiveBars(records,{contract,start,end}){
 invariant(Array.isArray(records),'Massive-Antwort enthält keine Kerzenliste.');
 return records.map(row=>{
  invariant(row.ticker===contract,'Massive-Kontrakt stimmt nicht mit der Anfrage überein.');
  const raw=row.window_start;
  invariant((typeof raw==='number'&&Number.isInteger(raw))||(typeof raw==='string'&&/^\d+$/.test(raw)),'Massive-Zeitstempel ungültig.');
  const ns=BigInt(raw);
  invariant(ns>0n&&ns%60000000000n===0n,'Massive-Zeitstempel ist keine UTC-Minute.');
  const ms=Number(ns/1000000n);
  invariant(Number.isSafeInteger(ms)&&ms>=Date.parse(start)&&ms<Date.parse(end),'Massive-Kerze außerhalb des angefragten Zeitraums.');
  invariant(row.volume!==null&&row.volume!==undefined,'Massive-Volumen fehlt.');
  return validateCandle({...row,time:new Date(ms).toISOString()});
 });
}

export async function historyFromMassive(body,env=process.env,fetcher=fetch){
 invariant(env.TRADING_MASSIVE_ENABLED==='true'&&env.TRADING_MASSIVE_API_KEY,'Massive nicht konfiguriert/freigegeben.');
 const root=text(body.instrument,8),contract=text(body.contract,24);
 invariant(INSTRUMENTS[root]&&contractValid(root,contract),'Exakter Kontrakt fehlt.');
 const start=iso(body.from),end=iso(body.to),duration=Date.parse(end)-Date.parse(start);
 invariant(duration>0&&duration<=7*86400000,'Ein Abruf umfasst maximal sieben Tage.');
 invariant(Date.parse(start)%60000===0&&Date.parse(end)%60000===0,'History-Zeitraum muss auf vollständigen UTC-Minuten liegen.');
 invariant(Date.parse(end)<=Date.now(),'Historischer Endzeitpunkt darf nicht in der Zukunft liegen.');
 const path='/futures/v1/aggs/'+contract;
 let url=new URL(path,'https://api.massive.com');
 // Seven days contain at most 10,080 minute bars: avoid needless pagination on Basic.
 url.search=new URLSearchParams({resolution:'1min','window_start.gte':String(BigInt(Date.parse(start))*1000000n),'window_start.lt':String(BigInt(Date.parse(end))*1000000n),limit:'10080',sort:'window_start.asc'});
 const headers={Authorization:'Bearer '+env.TRADING_MASSIVE_API_KEY},bars=new Map(),seen=new Set();
 for(let page=0;url;page++){
  invariant(page<12&&!seen.has(url.href),'Massive-Pagination unvollständig oder wiederholt.');
  seen.add(url.href);
  let data;
  try{data=JSON.parse(await boundedFetch(url,{headers},fetcher,8_000_000));}
  catch(error){const safe=Error(/^Datenanbieter antwortet HTTP \d+\.$/.test(error.message)?error.message:'Massive-Abruf fehlgeschlagen; keine Daten gespeichert.');safe.status=502;throw safe;}
  invariant(data.status==='OK','Massive meldet keinen erfolgreichen Abruf.');
  for(const bar of normalizeMassiveBars(data.results,{contract,start,end})){
   const old=bars.get(bar.time);
   invariant(!old||JSON.stringify(old)===JSON.stringify(bar),'Widersprüchliche Massive-Kerzen zur gleichen Minute.');
   bars.set(bar.time,bar);
  }
  invariant(bars.size<=10080,'Massive-Kerzenlimit überschritten.');
  if(!data.next_url){url=null;continue;}
  let next;try{next=new URL(data.next_url);}catch{invariant(false,'Massive-Pagination ungültig.');}
  invariant(next.origin==='https://api.massive.com'&&next.pathname===path&&!next.username&&!next.password&&!next.hash,'Massive-Pagination verlässt den angefragten Endpunkt.');
  // Never forward an API key from a returned URL or send our bearer to another host.
  next.searchParams.delete('apiKey');next.searchParams.delete('api_key');
  url=next;
 }
 return {contract,source:'massive-historical',resolution:60,bars:[...bars.values()].sort((a,b)=>a.time.localeCompare(b.time))};
}
