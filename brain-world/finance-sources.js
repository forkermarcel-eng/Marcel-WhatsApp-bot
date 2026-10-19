import {load} from 'cheerio';
import {createHash} from 'node:crypto';
import ical from 'node-ical';
import {DateTime} from 'luxon';
const digest=x=>createHash('sha256').update(x).digest('hex');
const clean=x=>String(x??'').replace(/\s+/g,' ').trim();
export const CALENDAR_FEEDS=[
 {id:'bls',name:'BLS',country:'US',zone:'America/New_York',format:'ics',url:'https://www.bls.gov/schedule/news_release/bls.ics'},
 {id:'bea',name:'BEA',country:'US',zone:'America/New_York',format:'ics',url:'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics'},
 {id:'fed',name:'Federal Reserve',country:'US',zone:'America/New_York',format:'fed',url:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm'},
 {id:'ecb',name:'EZB',country:'EU',zone:'Europe/Berlin',format:'ecb',url:'https://www.ecb.europa.eu/press/calendars/mgcgc/html/index.en.html'}
];
export function calendarEvent(feed,title,date,at,updatedAt,key=title+'|'+date){
 const high=/inflation|consumer price|employment situation|gross domestic|\bgdp\b|personal income|monetary policy|fomc/i.test(title);
 return {id:'finance-'+feed.id+'-'+digest(key),source:feed.name,country:feed.country,title:clean(title).slice(0,350),at,scheduled_date:date,time_precision:at?'MINUTE':'DATE',source_timezone:feed.zone,importance:high?'HIGH':'MEDIUM',importance_basis:'Redaktionelle Wirtschaftsregel: Inflation, Arbeitsmarkt, BIP und Geldpolitik hoch; übrige Veröffentlichungen mittel',actual:null,forecast:null,previous:null,url:feed.url,updated_at:updatedAt};
}
export async function parseOfficialCalendar(raw,feed,updatedAt){
 const out=[];
 if(feed.format==='ics'){
  if(!raw.includes('BEGIN:VCALENDAR')||/<!DOCTYPE|<!ENTITY/.test(raw))throw Error('Ungültiger Behördenkalender');
  raw=raw.replace(/TZID([=:])US-Eastern(?=[:;\r\n])/g,'TZID$1America/New_York').replace(/X-WR-TIMEZONE:US-Eastern/g,'X-WR-TIMEZONE:America/New_York');
  for(const line of [...raw.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)].flatMap(m=>m[0].match(/^DTSTART[^\r\n]*/gm)||[]))if(!/;VALUE=DATE:/.test(line)&&!/;TZID="?(?:America\/New_York|UTC)"?:/.test(line)&&!/Z$/.test(line))throw Error('Unbestätigte Kalenderzeitzone');
  const entries=await ical.async.parseICS(raw);
  for(const x of Object.values(entries)){
   if(x.type!=='VEVENT'||x.status==='CANCELLED')continue;
   if(x.rrule||!(x.start instanceof Date)||!Number.isFinite(+x.start))throw Error('Unerwarteter Kalendereintrag');
   const title=clean(typeof x.summary==='object'?x.summary.val:x.summary);if(!title)continue;
   const date=x.start.dateOnly?x.start.toISOString().slice(0,10):DateTime.fromJSDate(x.start,{zone:feed.zone}).toISODate();
   out.push(calendarEvent(feed,title,date,x.start.dateOnly?null:x.start.toISOString(),updatedAt,x.uid||title+'|'+date));
  }
 }else if(feed.format==='ecb'){
  const $=load(raw);$('dt').each((_,el)=>{const date=DateTime.fromFormat(clean($(el).text()),'dd/MM/yyyy',{zone:'Europe/Berlin'}),title=clean($(el).next('dd').text());if(date.isValid&&title&&/monetary policy|press conference/i.test(title))out.push(calendarEvent(feed,title,date.toISODate(),null,updatedAt));});
 }else if(feed.format==='fed'){
  const $=load(raw);$('.panel').each((_,panel)=>{const year=$(panel).find('h4').first().text().match(/(\d{4}) FOMC Meetings/)?.[1];if(!year)return;$(panel).find('.fomc-meeting').each((_,el)=>{const month=clean($(el).find('.fomc-meeting__month').text()),range=clean($(el).find('.fomc-meeting__date').text()),m=range.match(/^(\d{1,2})-(\d{1,2})(\*)?$/);if(!m)return;const date=DateTime.fromFormat(month+' '+m[2]+', '+year,'MMMM d, yyyy',{locale:'en',zone:feed.zone});if(date.isValid)out.push(calendarEvent(feed,'FOMC: Sitzung und geldpolitische Entscheidung',date.toISODate(),null,updatedAt));});});
 }
 if(!out.length)throw Error('Keine bestätigten Kalenderdaten erkannt');return out;
}
export function parseFinanceHeadlines(raw,source,now){
 if(/<!DOCTYPE|<!ENTITY/i.test(raw))throw Error('RSS mit DTD nicht unterstützt');
 const $=load(raw,{xmlMode:true});if(!$('rss,feed,rdf\\:RDF').length)throw Error('Ungültiger Fachfeed');const out=[];
 $('item,entry').slice(0,80).each((_,el)=>{const row=$(el),title=clean(load(row.find('title').first().text()).text()).slice(0,350),url=row.find('link[rel="alternate"]').attr('href')||row.find('link').first().attr('href')||row.find('link').first().text();
  let parsed;try{parsed=new URL(url);}catch{return;}if(parsed.protocol!=='https:'||parsed.username||parsed.password)return;
  const stamp=row.find('pubDate,published,updated,dc\\:date').first().text().replace(/\bCEST\b/,'+0200').replace(/\bCET\b/,'+0100'),at=Date.parse(stamp);if(!title||!Number.isFinite(at)||at>now+300000||at<=now-72*3600000)return;
  out.push({id:digest(parsed.href),title,url:parsed.href,source:source.name,publishedAt:new Date(at).toISOString(),language:source.language||'de',rights:'headline-link-only'});
 });return out;
}
// Bounded conditional public reads; no credentials or Trading modules involved.
export async function fetchFinanceSource(url,previous={},fetcher=fetch){
 const headers={};if(previous.etag)headers['If-None-Match']=previous.etag;if(previous.lastModified)headers['If-Modified-Since']=previous.lastModified;
 const r=await fetcher(url,{headers,redirect:'error',signal:AbortSignal.timeout(12000)});
 if(r.status===304)return {notModified:true,httpStatus:304,etag:r.headers.get('etag')||previous.etag,lastModified:r.headers.get('last-modified')||previous.lastModified};
 if(!r.ok){const e=Error('Öffentliche Finanzquelle nicht erreichbar');e.httpStatus=r.status;const retry=r.headers.get('retry-after');e.retryMs=/^\d+$/.test(retry||'')?Number(retry)*1000:Math.max(0,Date.parse(retry)-Date.now())||0;throw e;}
 const cap=2_000_000;if(Number(r.headers.get('content-length')||0)>cap)throw Error('Quellenantwort zu groß');
 let raw;if(r.body?.getReader){const reader=r.body.getReader(),chunks=[];let size=0;try{for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>cap){await reader.cancel();throw Error('Quellenantwort zu groß');}chunks.push(Buffer.from(x.value));}raw=Buffer.concat(chunks).toString('utf8');}finally{reader.releaseLock();}}else{raw=await r.text();if(Buffer.byteLength(raw)>cap)throw Error('Quellenantwort zu groß');}
 return {raw,httpStatus:r.status,etag:r.headers.get('etag')?.slice(0,512)||null,lastModified:r.headers.get('last-modified')?.slice(0,128)||null};
}
