import {officialJobs,CALENDAR_SOURCES,dedupeEvents,nextSourceAttempt} from './official-context.js';
import {classifyNews} from './market-context.js';
import {newsRelevance,sortedNews,normalizedHeadline,newsTimestamp} from '../../Trading/news-context.js';
import {parseNewsSource} from './news-sources.js';

export function newsPollInterval(feed){
 if(feed.format==='gdelt')return Math.max(600000,feed.ttl||3600000);
 return /Federal Reserve|Fed |EZB|ECB|Bank of Japan|BoJ|EIA|DOE|Treasury|OFAC|IEA/i.test(feed.name)?120000:240000;
}
/** Per-source persisted fetch cadence in the EXISTING settings collection. No scheduler/service. */
export async function syncSources(repo,env,{read,readNews,parseRSS,feeds},now=new Date().toISOString()){
 const at=now,stamp=Date.parse(at),old=await repo.get('settings','contextSourceCache'),cache={...(old?.sources||{})};
 const reports=[],data={news:[],events:[],observations:[]};let newNewsCount=0;
 const jobs=officialJobs(at);
 if(env.TRADING_NEWS_ENABLED==='true')jobs.push(...feeds.map(feed=>({name:feed.name,kind:'news',ttl:newsPollInterval(feed),url:feed.url,parse:s=>{const rows=(feed.format?parseNewsSource(s,feed,at):parseRSS(s,feed,at)).map(classifyNews);if(!rows.length&&feed.format!=='gdelt')throw Error('Kein gültiger RSS-Inhalt.');return rows;}})));
 else reports.push({name:'News',kind:'news',status:'NOT_CONFIGURED',healthy:false,at});
 if(env.TRADING_ECONOMIC_CALENDAR_KEY){
  const url=new URL(`https://api.tradingeconomics.com/calendar/country/All/${at.slice(0,10)}/${new Date(stamp+7*86400000).toISOString().slice(0,10)}`);url.searchParams.set('c',env.TRADING_ECONOMIC_CALENDAR_KEY);url.searchParams.set('f','json');
  jobs.push({name:'Trading Economics',kind:'events',ttl:1800000,url,parse:s=>{const rows=JSON.parse(s);if(!Array.isArray(rows))throw Error('Kalenderformat ungültig.');return rows.slice(0,500).map(x=>{const raw=String(x.Date||''),d=new Date(/(Z|[+-]\d\d:\d\d)$/.test(raw)?raw:raw+'Z').toISOString(),importance=+x.Importance===3?'HIGH':+x.Importance===2?'MEDIUM':'LOW';return {id:'te-'+x.CalendarId,source_id:String(x.CalendarId),title:String(x.Event||'').slice(0,250),at:d,scheduled_at_utc:d,scheduled_date:d.slice(0,10),country:x.Country,importance,impact:importance,actual:x.Actual||null,forecast:x.Forecast||null,previous:x.Previous||null,source:'Trading Economics',url:'https://tradingeconomics.com',observedAt:at,updated_at:at,createdAt:at};});}});
 }
 if(env.TRADING_FRED_KEY)for(const [code,label,unit]of [['DGS2','US 2Y','%'],['DGS10','US 10Y','%'],['DFII10','US Real 10Y','%'],['DTWEXBGS','Broad USD (NICHT DXY)','Index']]){
  const u=new URL('https://api.stlouisfed.org/fred/series/observations');for(const[k,v]of Object.entries({api_key:env.TRADING_FRED_KEY,series_id:code,file_type:'json',sort_order:'desc',limit:'10'}))u.searchParams.set(k,v);
  // Separate IDs: optional FRED never overwrites the authoritative Treasury/H.10 series.
  jobs.push({name:'FRED '+code,kind:'observations',ttl:86400000,url:u,parse:s=>{const p=JSON.parse(s).observations?.find(x=>x.value!=='.'&&Number.isFinite(+x.value));if(!p)throw Error('Keine FRED-Beobachtung.');return [{id:'FRED_'+code,label,value:+p.value,unit,at:p.date+'T00:00:00.000Z',observation_date:p.date,source:'FRED',url:'https://fred.stlouisfed.org/series/'+code,frequency:'DAILY',observedAt:at,createdAt:at}];}});
 }
 // Prioritize official news; at most four requests, including multi-URL calendars.
 jobs.sort((a,b)=>(a.kind==='news'?(a.ttl===120000?0:a.name==='GDELT Discovery'?3:1):2)-(b.kind==='news'?(b.ttl===120000?0:b.name==='GDELT Discovery'?3:1):2));
 async function poll(j){
  const cacheKey=j.kind+':'+j.name,prev=cache[cacheKey];
  // One-second timer jitter must not add another worker tick to a due news poll.
  // Never shorten outage/429 backoff or the slower discovery/calendar cadence.
  const dueTolerance=j.kind==='news'&&j.ttl<=600000&&prev?.report.healthy?5000:0;
  const nextPoll=prev?.report.healthy?Math.min(Date.parse(prev.next_allowed_poll_at||prev.nextAttemptAt),Date.parse(prev.last_checked_at||prev.report.at)+j.ttl):Date.parse(prev?.next_allowed_poll_at||prev?.nextAttemptAt);
  if(prev&&nextPoll>stamp+dueTolerance){reports.push({...prev.report,status:prev.report.healthy?'CACHED':prev.report.status,cached:true});return;}
  let httpStatus=null;
  try{
   const response=j.kind==='news'&&readNews?await readNews(j.url,prev):null;
   httpStatus=response?.httpStatus||(response?.notModified?304:response?200:null);
   if(response?.notModified){
    if(!prev?.ids)throw Error('304 without cached rows');
    const report={...prev.report,status:'NOT_MODIFIED',healthy:true,at,lastSuccessAt:at,httpStatus:304,newCount:0};reports.push(report);
    cache[cacheKey]={...prev,report,etag:response.etag||prev.etag,last_modified:response.lastModified||prev.last_modified||prev.lastModified||null,last_checked_at:at,last_success_at:at,last_new_item_at:prev.last_new_item_at||null,last_http_status:304,consecutive_failures:0,failures:0,next_allowed_poll_at:new Date(stamp+j.ttl).toISOString(),nextAttemptAt:new Date(stamp+j.ttl).toISOString()};return;
   }
   let raw=response?.raw;
   if(!response){if(Array.isArray(j.url)){raw=[];for(const url of j.url)raw.push(await read(url));}else raw=await read(j.url);}
   const parsed=await j.parse(raw);
   const rows=j.kind==='events'?dedupeEvents(parsed).filter(e=>{const d=e.at||e.scheduled_date;return d>=new Date(stamp-7*86400000).toISOString().slice(0,10)&&d<=new Date(stamp+400*86400000).toISOString().slice(0,10);}):parsed;
   data[j.kind].push(...rows);
   let newCount=0;
   if(j.kind==='news')await repo.transaction(async tx=>{
    // Commit a completed source immediately, even while another source is timing out.
    const existing=await tx.list('news',10000),known=new Map(existing.map(n=>[n.id,n]));
    const headlineKey=n=>String(n.source)+'|'+Math.floor(newsTimestamp(n)/86400000)+'|'+normalizedHeadline(n.title);
    const urls=new Set(existing.map(n=>n.url)),headlines=new Set(existing.map(headlineKey));
    for(const n of sortedNews(rows)){
     if(!known.has(n.id)&&(urls.has(n.url)||n.source&&headlines.has(headlineKey(n))))continue;
     const previous=known.get(n.id),relevance=Object.fromEntries(['MGC','MCL','MNQ','MYM'].map(i=>[i,newsRelevance(n,i,stamp)]));
     const next=previous?{...previous,...n,seen_at:previous.seen_at||previous.observedAt,createdAt:previous.createdAt,observedAt:previous.observedAt}:{...n,instrumentRelevance:relevance};
     const stable=x=>JSON.stringify(Object.fromEntries(Object.entries(x).filter(([k])=>!['seen_at','createdAt','observedAt','instrumentRelevance'].includes(k)).sort(([a],[b])=>a.localeCompare(b))));
     if(!previous||stable(previous)!==stable(next))await tx.put('news',next,{update:true});
     if(!previous){newCount++;known.set(n.id,next);urls.add(n.url);headlines.add(headlineKey(n));}
    }
   });
   newNewsCount+=newCount;
   const report={name:j.name,kind:j.kind,status:'OK',healthy:true,at,lastSuccessAt:at,count:rows.length,newCount,httpStatus:response?.httpStatus||200};reports.push(report);
   cache[cacheKey]={report,ids:rows.map(x=>x.id),etag:response?.etag||null,lastModified:response?.lastModified||null,last_modified:response?.lastModified||null,last_checked_at:at,last_success_at:at,last_new_item_at:newCount?at:prev?.last_new_item_at||null,last_http_status:response?.httpStatus||200,consecutive_failures:0,failures:0,next_allowed_poll_at:nextSourceAttempt(j.name,at,j.ttl),nextAttemptAt:nextSourceAttempt(j.name,at,j.ttl)};
  }catch(error){
   // Never expose optional-provider URL/query credentials in errors or logs.
   httpStatus=error.httpStatus||httpStatus;
   const report={name:j.name,kind:j.kind,status:httpStatus===429?'RATE_LIMITED':'ERROR',healthy:false,at,lastSuccessAt:prev?.report.lastSuccessAt||null,message:'Quellenabruf/Formatprüfung fehlgeschlagen; vorhandene Meldungen bleiben erhalten.',errorClass:error.name,httpStatus,newCount:0};reports.push(report);
   const failures=Math.min(8,(prev?.failures||0)+1),delay=Math.max(error.retryMs||0,Math.min(86400000,Math.max(j.ttl,900000)*2**(failures-1)));
   cache[cacheKey]={...prev,report,ids:prev?.ids||[],failures,consecutive_failures:failures,last_checked_at:at,last_success_at:prev?.last_success_at||prev?.report.lastSuccessAt||null,last_new_item_at:prev?.last_new_item_at||null,last_http_status:httpStatus,etag:prev?.etag||null,last_modified:prev?.last_modified||prev?.lastModified||null,next_allowed_poll_at:new Date(stamp+delay).toISOString(),nextAttemptAt:new Date(stamp+delay).toISOString()};
  }
  }
 let cursor=0;
 await Promise.all(Array.from({length:Math.min(4,jobs.length)},async()=>{while(cursor<jobs.length)await poll(jobs[cursor++]);}));
 const calendarStatus=CALENDAR_SOURCES.every(name=>reports.some(r=>r.name===name&&r.kind==='events'&&r.healthy))?'OK':reports.some(r=>r.kind==='events'&&r.healthy)?'PARTIAL':'ERROR';
 if(reports.every(r=>r.cached||r.status==='NOT_CONFIGURED'))return {reports,calendarStatus,newNewsCount:0,newsCount:0,eventCount:0,observations:0,at};
 const activeEventIds=[...new Set(Object.values(cache).filter(c=>c.report.kind==='events').flatMap(c=>c.ids))];
 await repo.transaction(async tx=>{
  for(const e of dedupeEvents(data.events))await tx.put('events',e,{update:true});
  for(const o of data.observations)await tx.put('observations',o,{update:true});
  const two=await tx.get('observations','DGS2'),ten=await tx.get('observations','DGS10');
  if(data.observations.length&&two&&ten&&two.observation_date===ten.observation_date)await tx.put('observations',{id:'T2S10S',label:'2s10s Spread',value:Math.round((ten.value-two.value)*100)/100,unit:'Prozentpunkte',change_bps:typeof two.change_bps==='number'&&typeof ten.change_bps==='number'?Math.round((ten.change_bps-two.change_bps)*1e6)/1e6:null,at:ten.at,observation_date:ten.observation_date,source:'Berechnet aus U.S. Treasury 10Y − 2Y',url:ten.url,frequency:'DAILY',observedAt:at,createdAt:at},{update:true});
  await tx.put('settings',{id:'contextSourceCache',sources:cache,createdAt:at},{update:true});
  await tx.put('settings',{id:'providerSync',reports,calendarStatus,lastSyncAt:at,activeEventIds,createdAt:at},{update:true});
 });
 return {reports,calendarStatus,newNewsCount,newsCount:new Set(data.news.map(n=>n.id)).size,eventCount:dedupeEvents(data.events).length,observations:data.observations.length,at};
}
