import {officialJobs,CALENDAR_SOURCES,dedupeEvents,nextSourceAttempt} from './official-context.js';
import {classifyNews} from './market-context.js';

/** Per-source persisted fetch cadence in the EXISTING settings collection. No scheduler/service. */
export async function syncSources(repo,env,{read,parseRSS,feeds},now=new Date().toISOString()){
 const at=now,stamp=Date.parse(at),old=await repo.get('settings','contextSourceCache'),cache={...(old?.sources||{})};
 const reports=[],data={news:[],events:[],observations:[]};
 const jobs=officialJobs(at);
 if(env.TRADING_NEWS_ENABLED==='true')jobs.push(...feeds.map(feed=>({name:feed.name,kind:'news',ttl:900000,url:feed.url,parse:s=>{const rows=parseRSS(s,feed,at).map(classifyNews);if(!rows.length)throw Error('Kein gültiger RSS-Inhalt.');return rows;}})));
 else reports.push({name:'News',kind:'news',status:'NOT_CONFIGURED',healthy:false,at});
 if(env.TRADING_ECONOMIC_CALENDAR_KEY){
  const url=new URL(`https://api.tradingeconomics.com/calendar/country/All/${at.slice(0,10)}/${new Date(stamp+7*86400000).toISOString().slice(0,10)}`);url.searchParams.set('c',env.TRADING_ECONOMIC_CALENDAR_KEY);url.searchParams.set('f','json');
  jobs.push({name:'Trading Economics',kind:'events',ttl:21600000,url,parse:s=>{const rows=JSON.parse(s);if(!Array.isArray(rows))throw Error('Kalenderformat ungültig.');return rows.slice(0,500).map(x=>{const raw=String(x.Date||''),d=new Date(/(Z|[+-]\d\d:\d\d)$/.test(raw)?raw:raw+'Z').toISOString(),importance=+x.Importance===3?'HIGH':+x.Importance===2?'MEDIUM':'LOW';return {id:'te-'+x.CalendarId,source_id:String(x.CalendarId),title:String(x.Event||'').slice(0,250),at:d,scheduled_at_utc:d,scheduled_date:d.slice(0,10),country:x.Country,importance,impact:importance,actual:x.Actual||null,forecast:x.Forecast||null,previous:x.Previous||null,source:'Trading Economics',url:'https://tradingeconomics.com',observedAt:at,updated_at:at,createdAt:at};});}});
 }
 if(env.TRADING_FRED_KEY)for(const [code,label,unit]of [['DGS2','US 2Y','%'],['DGS10','US 10Y','%'],['DFII10','US Real 10Y','%'],['DTWEXBGS','Broad USD (NICHT DXY)','Index']]){
  const u=new URL('https://api.stlouisfed.org/fred/series/observations');for(const[k,v]of Object.entries({api_key:env.TRADING_FRED_KEY,series_id:code,file_type:'json',sort_order:'desc',limit:'10'}))u.searchParams.set(k,v);
  // Separate IDs: optional FRED never overwrites the authoritative Treasury/H.10 series.
  jobs.push({name:'FRED '+code,kind:'observations',ttl:86400000,url:u,parse:s=>{const p=JSON.parse(s).observations?.find(x=>x.value!=='.'&&Number.isFinite(+x.value));if(!p)throw Error('Keine FRED-Beobachtung.');return [{id:'FRED_'+code,label,value:+p.value,unit,at:p.date+'T00:00:00.000Z',observation_date:p.date,source:'FRED',url:'https://fred.stlouisfed.org/series/'+code,frequency:'DAILY',observedAt:at,createdAt:at}];}});
 }
 await Promise.all(jobs.map(async j=>{
  const cacheKey=j.kind+':'+j.name,prev=cache[cacheKey];
  if(prev&&Date.parse(prev.nextAttemptAt)>stamp){reports.push({...prev.report,status:prev.report.healthy?'CACHED':prev.report.status,cached:true});return;}
  try{
   const parsed=await j.parse(Array.isArray(j.url)?await Promise.all(j.url.map(read)):await read(j.url));
   const rows=j.kind==='events'?dedupeEvents(parsed).filter(e=>{const d=e.at||e.scheduled_date;return d>=new Date(stamp-7*86400000).toISOString().slice(0,10)&&d<=new Date(stamp+400*86400000).toISOString().slice(0,10);}):parsed;
   data[j.kind].push(...rows);
   const report={name:j.name,kind:j.kind,status:'OK',healthy:true,at,lastSuccessAt:at,count:rows.length};reports.push(report);
   cache[cacheKey]={report,ids:rows.map(x=>x.id),nextAttemptAt:nextSourceAttempt(j.name,at,j.ttl)};
  }catch(error){
   // Never expose optional-provider URL/query credentials in errors or logs.
   const report={name:j.name,kind:j.kind,status:'ERROR',healthy:false,at,lastSuccessAt:prev?.report.lastSuccessAt||null,message:'Quellenabruf/Formatprüfung fehlgeschlagen; kein synthetischer Ersatz.',errorClass:error.name};reports.push(report);
   cache[cacheKey]={report,ids:prev?.ids||[],nextAttemptAt:new Date(stamp+900000).toISOString()};
  }
 }));
 const calendarStatus=CALENDAR_SOURCES.every(name=>reports.some(r=>r.name===name&&r.kind==='events'&&r.healthy))?'OK':reports.some(r=>r.kind==='events'&&r.healthy)?'PARTIAL':'ERROR';
 const activeEventIds=[...new Set(Object.values(cache).filter(c=>c.report.kind==='events').flatMap(c=>c.ids))];
 await repo.transaction(async tx=>{
  for(const n of new Map(data.news.map(n=>[n.id,n])).values()){
   const old=await tx.get('news',n.id);await tx.put('news',old?{...old,...n,createdAt:old.createdAt,observedAt:old.observedAt}:n,{update:true});
  }
  for(const e of dedupeEvents(data.events))await tx.put('events',e,{update:true});
  for(const o of data.observations)await tx.put('observations',o,{update:true});
  const two=await tx.get('observations','DGS2'),ten=await tx.get('observations','DGS10');
  if(two&&ten&&two.observation_date===ten.observation_date)await tx.put('observations',{id:'T2S10S',label:'2s10s Spread',value:Math.round((ten.value-two.value)*100)/100,unit:'Prozentpunkte',change_bps:typeof two.change_bps==='number'&&typeof ten.change_bps==='number'?Math.round((ten.change_bps-two.change_bps)*1e6)/1e6:null,at:ten.at,observation_date:ten.observation_date,source:'Berechnet aus U.S. Treasury 10Y − 2Y',url:ten.url,frequency:'DAILY',observedAt:at,createdAt:at},{update:true});
  await tx.put('settings',{id:'contextSourceCache',sources:cache,createdAt:at},{update:true});
  await tx.put('settings',{id:'providerSync',reports,calendarStatus,lastSyncAt:at,activeEventIds,createdAt:at},{update:true});
 });
 return {reports,calendarStatus,newsCount:new Set(data.news.map(n=>n.id)).size,eventCount:dedupeEvents(data.events).length,observations:data.observations.length,at};
}
