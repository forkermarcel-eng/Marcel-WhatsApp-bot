import {PgRepository} from '../trading-core/server/repository.js';
import {dedupeEvents} from '../trading-core/server/official-context.js';
import {fetchNews} from '../trading-core/server/news-sources.js';
import {parseFeed} from './service.js';
import {DateTime} from 'luxon';

// Separate presentation channel. These sources never enter general world news.
export const FINANCE_FEEDS=[
 {id:'finance-news',name:'finanzen.net',url:'https://www.finanzen.net/rss/news',country:'DE',language:'de',category:'Wirtschaft'},
 {id:'finance-analysis',name:'finanzen.net · Analysen',url:'https://www.finanzen.net/rss/analysen',country:'DE',language:'de',category:'Finanzen'},
 {id:'fn-economy',name:'FinanzNachrichten.de · Wirtschaft',url:'https://www.finanznachrichten.de/rss-nachrichten-wirtschaft-konjunktur',country:'DE',language:'de',category:'Wirtschaft'},
 {id:'fn-markets',name:'FinanzNachrichten.de · Märkte',url:'https://www.finanznachrichten.de/rss-marktberichte',country:'DE',language:'de',category:'Finanzen'}
];
// Exact dashboard instruments. Never substitute Trading contracts or ETFs.
export const FINANCE_MARKETS=[
 ['dax','DAX','Deutschland'],['sp500','S&P 500','USA'],['nasdaq100','Nasdaq 100','USA Technologie'],['dow','Dow Jones','USA'],['gold','Goldpreis','Edelmetalle'],['bitcoin','Bitcoin / USD','Kryptowährungen'],['eurusd','EUR / USD','Devisen'],['brent','Brent-Öl','Energie']
].map(([id,contract,region])=>({id,contract,region}));
export function unavailableFinanceMarkets(){return FINANCE_MARKETS.map(m=>({...m,status:'unavailable',value:null,change:null,changePercent:null,at:null,chart:[],source:null,reason:'Keine freigegebene Kursanbindung für dieses Instrument. Neue Datenversorgung zurückgestellt.'}));}
const KEY='finance-headlines:v1',TTL=72*3600000;
export function parseEurostatEvents(rows,at){
 if(!Array.isArray(rows))throw Error('Ungültiger Eurostat-Kalender');
 return rows.filter(x=>x.recordid&&x.title&&Number.isFinite(Date.parse(x.start))).map(x=>({id:'finance-eurostat-'+x.recordid,source:'Eurostat',country:'EU',title:x.title+(x.period?' · '+x.period:''),at:x.allDay?null:new Date(x.start).toISOString(),scheduled_date:x.start.slice(0,10),time_precision:x.allDay?'DATE':'MINUTE',source_timezone:'Europe/Luxembourg',importance:/GDP|inflation|unemployment/i.test(x.title)?'HIGH':'MEDIUM',importance_basis:'Redaktionelle Regel: BIP, Inflation, Arbeitslosigkeit hoch; andere Euroindikatoren mittel',actual:null,previous:null,forecast:null,url:'https://ec.europa.eu/eurostat/news/euro-indicators/release-calendar',updated_at:at,preliminary:x.preliminary===true}));
}
export function selectFinanceEvents(events,sync,now=Date.now()){
 const active=sync?.activeEventIds?new Set(sync.activeEventIds):null;
 return dedupeEvents(events.filter(e=>!active||!e.id.startsWith('official-')||active.has(e.id))).filter(e=>{
  const at=Date.parse(e.at||e.scheduled_at_utc||e.scheduled_date+'T23:59:59Z');
  return Number.isFinite(at)&&at>=DateTime.fromMillis(now,{zone:'Europe/Berlin'}).startOf('day').toMillis()&&at<=now+7*86400000;
 }).sort((a,b)=>String(a.at||a.scheduled_date).localeCompare(String(b.at||b.scheduled_date))).map(e=>({...e,
  status:Date.parse(e.at||e.scheduled_date+'T23:59:59Z')<now?'Veröffentlichungstermin vergangen':'Geplant',
  importanceBasis:e.importance_basis||'Einstufung der gespeicherten Quelle',
  stale:!(e.source==='Eurostat'?e.updated_at:sync?.lastSyncAt)||now-Date.parse(e.source==='Eurostat'?e.updated_at:sync.lastSyncAt)>6*3600000
 }));
}
export function importantFinanceNews(items){
 const rules=[[/inflation|verbraucherpreis|zinspolitik|notenbank|\bfed\b|\bezb\b|zins/i,'Inflation & Zinspolitik'],[/ölpreis|rohstoff|energie|gaspreis|gold/i,'Rohstoffe & Energie'],[/konjunktur|bip|arbeitsmarkt|industrie|unternehmen|gewinn|umsatz|aktie|börse|dax|nasdaq/i,'Wirtschaft & Unternehmen']];
 const chosen=[],seen=new Set();for(const [rule,topic] of rules){const item=items.find(x=>rule.test(x.title)&&!seen.has(x.url));if(item){seen.add(item.url);chosen.push({...item,topic});}}return chosen;
}
export function createFinanceService({pool,repository=new PgRepository(pool),fetcher=fetch,clock=Date.now}){
 let running=null;
 async function cache(){return (await pool.query('SELECT body FROM marcel_world.cache WHERE id=$1',[KEY])).rows[0]?.body||{sources:{}};}
 async function syncNews(){if(running)return running;running=(async()=>{
  const now=clock(),state=await cache();
  await Promise.all(FINANCE_FEEDS.map(async source=>{const previous=state.sources[source.id]||{};if(previous.nextAt>now)return;
   try{const result=await fetchNews(source.url,previous,fetcher);const items=result.notModified?previous.items||[]:parseFeed(result.raw,source,now).map(item=>({id:item.id,title:item.title,url:item.url,source:item.source,publishedAt:item.publishedAt,language:'de',rights:'headline-link-only'}));
    state.sources[source.id]={...result,raw:undefined,items,checkedAt:new Date(now).toISOString(),nextAt:now+10*60000,error:null};
   }catch(error){state.sources[source.id]={...previous,error:'Abruf fehlgeschlagen'+(error.httpStatus?' (HTTP '+error.httpStatus+')':''),checkedAt:new Date(now).toISOString(),nextAt:now+Math.max(10*60000,error.retryMs||0)};}
  }));
  if(!(state.calendar?.nextAt>now)){
   try{const url=new URL('https://ec.europa.eu/eurostat/o/calendars/eventsJson');url.search=new URLSearchParams({start:new Date(now-86400000).toISOString(),end:new Date(now+8*86400000).toISOString(),isEuroindicator:'true',timeZone:'Europe/Luxembourg'});const response=await fetchNews(url.href,{},fetcher);state.calendar={events:parseEurostatEvents(JSON.parse(response.raw),new Date(now).toISOString()),checkedAt:new Date(now).toISOString(),nextAt:now+30*60000,error:null};}
   catch(error){state.calendar={...state.calendar,checkedAt:new Date(now).toISOString(),nextAt:now+30*60000,error:'Eurostat-Kalender vorübergehend nicht erreichbar'};}
  }
  state.updatedAt=new Date(now).toISOString();
  for(const source of Object.values(state.sources||{}))source.items=(source.items||[]).filter(n=>Date.parse(n.publishedAt)>now-TTL);
  await pool.query("INSERT INTO marcel_world.cache(id,body,expires_at) VALUES($1,$2,now()+interval '72 hours') ON CONFLICT(id) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at",[KEY,JSON.stringify(state)]);
 })().finally(()=>running=null);return running;}
 async function read(){
  const now=clock(),warnings=[];
  const settled=await Promise.allSettled([repository.list('events',10000),repository.get('settings','providerSync'),cache()]);
  const value=(i,fallback)=>{if(settled[i].status==='fulfilled')return settled[i].value;warnings.push(['Wirtschaftskalender','Quellenstatus','Finanznachrichten'][i]+' derzeit nicht erreichbar.');return fallback;};
  const events=value(0,[]),sync=value(1,null),state=value(2,{sources:{}});
  const seenTitles=new Set();
  const news=[...new Map(Object.values(state.sources||{}).flatMap(s=>(s.items||[]).map(n=>({...n,cached:!!s.error,checkedAt:s.checkedAt}))).filter(n=>Date.parse(n.publishedAt)>now-TTL&&Date.parse(n.publishedAt)<=now+300000).map(n=>[n.url,n])).values()].sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)).filter(n=>{const title=n.title.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu,' ').trim();if(seenTitles.has(title))return false;seenTitles.add(title);return true;});
  return {at:new Date(now).toISOString(),markets:unavailableFinanceMarkets(),marketStatus:{configured:false,targetRefreshMinutes:30,actualRefreshMinutes:null,reasonCode:'ADAPTER_PENDING_APPROVAL'},events:selectFinanceEvents([...events,...(state.calendar?.events||[])],sync,now),calendarStatus:sync?.calendarStatus||'UNKNOWN',calendarUpdatedAt:sync?.lastSyncAt||state.calendar?.checkedAt||null,news:news.slice(0,32),important:importantFinanceNews(news),sourceStatus:[...FINANCE_FEEDS.map(s=>({name:s.name,url:s.url,checkedAt:state.sources?.[s.id]?.checkedAt||null,error:state.sources?.[s.id]?.error||null})),{name:'Eurostat',checkedAt:state.calendar?.checkedAt||null,error:state.calendar?.error||null}],warnings};
 }
 return {read,syncNews};
}
