import {createHash} from 'node:crypto';
import {syncSources} from './context-sync.js';
import {EXTRA_NEWS,fetchNews} from './news-sources.js';
import {invariant,iso,text,validateCandle,contractValid,INSTRUMENTS} from '../../Trading/domain.js';
const hash=x=>createHash('sha256').update(x).digest('hex');
export const NEWS_FEEDS=[
 {name:'Federal Reserve',url:'https://www.federalreserve.gov/feeds/press_all.xml',topic:'Zentralbanken'},
 {name:'EZB',url:'https://www.ecb.europa.eu/rss/press.html',topic:'Zentralbanken'},
 {name:'BBC Welt',url:'https://feeds.bbci.co.uk/news/world/rss.xml',topic:'Geopolitik'},
 {name:'BBC Wirtschaft',url:'https://feeds.bbci.co.uk/news/business/rss.xml',topic:'Makro'},
 {name:'Fed Monetary Policy',url:'https://www.federalreserve.gov/feeds/press_monetary.xml',topic:'Fed/rates'},
 {name:'Fed Speeches',url:'https://www.federalreserve.gov/feeds/speeches.xml',topic:'Fed/rates'},
 {name:'EIA',url:'https://www.eia.gov/rss/todayinenergy.xml',topic:'energy supply'},
 {name:'Bank of Japan',url:'https://www.boj.or.jp/en/rss/whatsnew.xml',topic:'BoJ/JPY'},
 {name:'EIA Press',url:'https://www.eia.gov/rss/press_rss.xml',topic:'energy supply'},
 {name:'DOE',url:'https://www.energy.gov/rss/energygov/2193718',topic:'energy supply'},
 {name:'UN News',url:'https://news.un.org/feed/subscribe/en/news/topic/peace-and-security/feed/rss.xml',topic:'Geopolitik'}
];
export function providerStatus(env=process.env){return {news:{configured:env.TRADING_NEWS_ENABLED==='true',type:'RSS-Titel/Links · kein Volltextarchiv'},calendar:{configured:true,provider:'BLS / BEA / FOMC / Census / EIA / Treasury',optionalTradingEconomics:!!env.TRADING_ECONOMIC_CALENDAR_KEY},macro:{configured:true,provider:'U.S. Treasury / Fed H.10 · Tageswerte, nicht live',optionalFRED:!!env.TRADING_FRED_KEY},history:{configured:!!env.TRADING_DATABENTO_KEY&&env.TRADING_DATABENTO_ENABLED==='true',provider:'Databento · kostenpflichtig / Entitlement'},massive:{configured:!!env.TRADING_MASSIVE_API_KEY&&env.TRADING_MASSIVE_ENABLED==='true',provider:'Massive · Futures-Historie / Entitlement'},live:{configured:!!env.TRADING_INGEST_TOKEN,provider:'Separater Databento-Worker · letzter Datensatz entscheidet'},brain:{configured:!!env.TRADING_INTELLIGENCE_TOKEN,mode:'Read-only Export'},broker:{configured:false,mode:'KEINE VERBINDUNG'}};}
export async function boundedFetch(url,options={},fetcher=fetch,maxBytes=2_000_000){const r=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(12000)});if(!r.ok){const e=Error(`Datenanbieter antwortet HTTP ${r.status}.`);e.status=502;throw e;}if(Number(r.headers.get('content-length')||0)>maxBytes)throw Error('Datenanbieter-Antwort zu groß.');const chunks=[];let length=0;if(r.body?.getReader){const rd=r.body.getReader();try{for(;;){const {done,value}=await rd.read();if(done)break;length+=value.length;if(length>maxBytes){await rd.cancel();throw Error('Datenlimit überschritten.');}chunks.push(Buffer.from(value));}}finally{rd.releaseLock();}return Buffer.concat(chunks).toString('utf8');}const s=await r.text();if(Buffer.byteLength(s)>maxBytes)throw Error('Datenlimit überschritten.');return s;}
export function safeURL(x){try{const u=new URL(x);return u.protocol==='https:'&&!u.username&&!u.password?u.toString():'';}catch{return '';}}
const feedURL=(link,feed)=>{if(typeof link!=='string'||!link.trim())return '';try{return safeURL(new URL(link,feed.url).href);}catch{return safeURL(link);}};
const decode=x=>String(x||'').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').replace(/<[^>]*>/g,'').replace(/&(amp|lt|gt|quot|apos);/g,(_,n)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[n])).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Math.min(0x10ffff,Number(n)))).trim();
export function parseRSS(xml,feed,now=new Date().toISOString()){
 // BoJ publishes legacy HTTP links; their identical official HTTPS URLs were verified.
 if(feed.name==='Bank of Japan')xml=xml.replaceAll('http://www.boj.or.jp/','https://www.boj.or.jp/');
 if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('RSS mit DTD/Entities wird nicht verarbeitet.');
 const items=[...xml.matchAll(/<(?:item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/(?:item|entry)>/gi)].slice(0,30);
 return items.map(m=>{const body=m[1],get=k=>decode(body.match(new RegExp(`<${k}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${k}>`,'i'))?.[1]);const title=get('title'),url=feedURL(get('link')||body.match(/<link[^>]+href=["']([^"']+)/i)?.[1],feed);const date=get('pubDate')||get('published')||get('updated');return {id:hash(url||title.toLowerCase()),title:text(title,350),url,source:feed.name,topic:feed.topic,publishedAt:Number.isFinite(Date.parse(date))?new Date(date).toISOString():null,observedAt:now,createdAt:now,verification:'SOURCE_REPORT',note:'Quellenmeldung, keine eigenständig verifizierte Tatsache.'};}).filter(x=>x.title&&x.url);
}
const pendingSyncs=new WeakMap();
export async function syncContext(repo,env=process.env,fetcher=fetch){
 if(pendingSyncs.has(repo))return pendingSyncs.get(repo);
 const task=syncSources(repo,env,{read:url=>boundedFetch(url,{},fetcher),readNews:(url,prev)=>fetchNews(url,prev,fetcher),parseRSS,feeds:[...NEWS_FEEDS,...EXTRA_NEWS]});
 pendingSyncs.set(repo,task);try{return await task;}finally{pendingSyncs.delete(repo);}
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
