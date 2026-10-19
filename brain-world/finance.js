import {CALENDAR_FEEDS,parseOfficialCalendar,parseFinanceHeadlines,fetchFinanceSource} from './finance-sources.js';
import {DateTime} from 'luxon';

// Separate presentation channel. These sources never enter general world news.
export const FINANCE_FEEDS=[
 {id:'finance-news',name:'finanzen.net',url:'https://www.finanzen.net/rss/news',country:'DE',language:'de',category:'Wirtschaft'},
 {id:'finance-analysis',name:'finanzen.net · Analysen',url:'https://www.finanzen.net/rss/analysen',country:'DE',language:'de',category:'Finanzen'},
 {id:'fn-economy',name:'FinanzNachrichten.de · Wirtschaft',url:'https://www.finanznachrichten.de/rss-nachrichten-wirtschaft-konjunktur',country:'DE',language:'de',category:'Wirtschaft'},
 {id:'fn-markets',name:'FinanzNachrichten.de · Märkte',url:'https://www.finanznachrichten.de/rss-marktberichte',country:'DE',language:'de',category:'Finanzen'}
];
const KEY='finance-portal:v2',TTL=72*3600000;
export function parseEurostatEvents(rows,at){
 if(!Array.isArray(rows))throw Error('Ungültiger Eurostat-Kalender');
 return rows.filter(x=>x.recordid&&x.title&&Number.isFinite(Date.parse(x.start))).map(x=>({id:'finance-eurostat-'+x.recordid,source:'Eurostat',country:'EU',title:x.title+(x.period?' · '+x.period:''),at:x.allDay?null:new Date(x.start).toISOString(),scheduled_date:x.start.slice(0,10),time_precision:x.allDay?'DATE':'MINUTE',source_timezone:'Europe/Luxembourg',importance:/GDP|inflation|unemployment/i.test(x.title)?'HIGH':'MEDIUM',importance_basis:'Redaktionelle Regel: BIP, Inflation, Arbeitslosigkeit hoch; andere Euroindikatoren mittel',actual:null,previous:null,forecast:null,url:'https://ec.europa.eu/eurostat/news/euro-indicators/release-calendar',updated_at:at,preliminary:x.preliminary===true}));
}
export function selectFinanceEvents(events,now=Date.now()){
 const start=DateTime.fromMillis(now,{zone:'Europe/Berlin'}).startOf('day').toMillis(),seen=new Set();
 return events.filter(e=>{const at=e.at?Date.parse(e.at):DateTime.fromISO(e.scheduled_date,{zone:'Europe/Berlin'}).endOf('day').toMillis();return Number.isFinite(at)&&at>=start&&at<=now+30*86400000;}).sort((a,b)=>(a.scheduled_date||a.at.slice(0,10)).localeCompare(b.scheduled_date||b.at.slice(0,10))||String(a.at||'').localeCompare(String(b.at||''))).filter(e=>{const key=e.source+'|'+e.title+'|'+(e.at||e.scheduled_date);if(seen.has(key))return false;seen.add(key);return true;}).map(e=>({...e,status:e.at&&Date.parse(e.at)<now?'Veröffentlichungstermin vergangen':'Geplant',importanceBasis:e.importance_basis,stale:!e.updated_at||now-Date.parse(e.updated_at)>6*3600000}));
}
export function importantFinanceNews(items){
 const rules=[[/inflation|verbraucherpreis|zinspolitik|notenbank|\bfed\b|\bezb\b|zins/i,'Inflation & Zinspolitik'],[/ölpreis|rohstoff|energie|gaspreis|gold/i,'Rohstoffe & Energie'],[/konjunktur|bip|arbeitsmarkt|industrie|unternehmen|gewinn|umsatz|aktie|börse|dax|nasdaq/i,'Wirtschaft & Unternehmen']];
 const chosen=[],seen=new Set();for(const [rule,topic] of rules){const item=items.find(x=>rule.test(x.title)&&!seen.has(x.url));if(item){seen.add(item.url);chosen.push({...item,topic});}}return chosen;
}
export function createFinanceService({pool,fetcher=fetch,clock=Date.now}){
 let running=null;
 async function cache(){return (await pool.query('SELECT body FROM marcel_world.cache WHERE id=$1',[KEY])).rows[0]?.body||{sources:{},calendars:{}};}
 async function syncNews(){if(running)return running;running=(async()=>{
  const now=clock(),state=await cache();
  await Promise.all(FINANCE_FEEDS.map(async source=>{const previous=state.sources[source.id]||{};if(previous.nextAt>now)return;
   try{const result=await fetchFinanceSource(source.url,previous,fetcher);const items=result.notModified?previous.items||[]:parseFinanceHeadlines(result.raw,source,now);
    state.sources[source.id]={...result,raw:undefined,items,checkedAt:new Date(now).toISOString(),nextAt:now+10*60000,error:null};
   }catch(error){state.sources[source.id]={...previous,error:'Abruf fehlgeschlagen'+(error.httpStatus?' (HTTP '+error.httpStatus+')':''),checkedAt:new Date(now).toISOString(),nextAt:now+Math.max(10*60000,error.retryMs||0)};}
  }));
  state.calendars||={};
  const eurostat={id:'eurostat',name:'Eurostat',url:'https://ec.europa.eu/eurostat/o/calendars/eventsJson'};
  await Promise.all([...CALENDAR_FEEDS,eurostat].map(async feed=>{
   const previous=state.calendars[feed.id]||{};if(previous.nextAt>now)return;
   try{let url=feed.url;if(feed.id==='eurostat'){const u=new URL(url);u.search=new URLSearchParams({start:new Date(now-86400000).toISOString(),end:new Date(now+31*86400000).toISOString(),isEuroindicator:'true',timeZone:'Europe/Luxembourg'});url=u.href;}
    const result=await fetchFinanceSource(url,previous,fetcher),stamp=new Date(now).toISOString();const events=result.notModified?(previous.events||[]).map(e=>({...e,updated_at:stamp})):feed.id==='eurostat'?parseEurostatEvents(JSON.parse(result.raw),stamp):await parseOfficialCalendar(result.raw,feed,stamp);
    state.calendars[feed.id]={...result,raw:undefined,events,checkedAt:stamp,successAt:stamp,nextAt:now+30*60000,error:null};
   }catch(error){state.calendars[feed.id]={...previous,checkedAt:new Date(now).toISOString(),nextAt:now+Math.max(30*60000,error.retryMs||0),error:'Kalenderabruf fehlgeschlagen'+(error.httpStatus?' (HTTP '+error.httpStatus+')':'')};}
  }));
  state.updatedAt=new Date(now).toISOString();
  for(const source of Object.values(state.sources||{}))source.items=(source.items||[]).filter(n=>Date.parse(n.publishedAt)>now-TTL);
  await pool.query("INSERT INTO marcel_world.cache(id,body,expires_at) VALUES($1,$2,now()+interval '72 hours') ON CONFLICT(id) DO UPDATE SET body=excluded.body,expires_at=excluded.expires_at",[KEY,JSON.stringify(state)]);
 })().finally(()=>running=null);return running;}
 async function read(){
  const now=clock(),warnings=[];
  let state;try{state=await cache();}catch{state={sources:{},calendars:{}};warnings.push('Finanzcache derzeit nicht erreichbar.');}
  const seenTitles=new Set();
  const news=[...new Map(Object.values(state.sources||{}).flatMap(s=>(s.items||[]).map(n=>({...n,cached:!!s.error,checkedAt:s.checkedAt}))).filter(n=>Date.parse(n.publishedAt)>now-TTL&&Date.parse(n.publishedAt)<=now+300000).map(n=>[n.url,n])).values()].sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)).filter(n=>{const title=n.title.toLocaleLowerCase('de-DE').replace(/[^\p{L}\p{N}]+/gu,' ').trim();if(seenTitles.has(title))return false;seenTitles.add(title);return true;});
  const calendars=state.calendars||{},healthy=Object.values(calendars).filter(c=>c.successAt&&!c.error).length;
  const statuses=[...FINANCE_FEEDS.map(feed=>({...feed,kind:'news',...state.sources?.[feed.id]})),...[...CALENDAR_FEEDS,{id:'eurostat',name:'Eurostat'}].map(feed=>({...feed,kind:'calendar',...calendars[feed.id]}))].map(({id,name,kind,checkedAt,error,successAt})=>({id,name,kind,checkedAt:checkedAt||null,error:error||null,successAt:successAt||null}));
  return {at:new Date(now).toISOString(),events:selectFinanceEvents(Object.values(calendars).flatMap(c=>c.events||[]),now),calendarStatus:healthy+' von '+(CALENDAR_FEEDS.length+1)+' Quellen erreichbar',calendarUpdatedAt:Object.values(calendars).map(c=>c.successAt).filter(Boolean).sort().at(-1)||null,news:news.slice(0,60),important:importantFinanceNews(news),sourceStatus:statuses,warnings};
 }
 return {read,syncNews};
}
