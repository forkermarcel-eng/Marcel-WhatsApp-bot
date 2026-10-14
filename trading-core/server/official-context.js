/** Official public schedules/rates. No consensus estimates, synthetic market prices or AI. */
import {createHash} from 'node:crypto';
import {load} from 'cheerio';
import ical from 'node-ical';
import {DateTime} from 'luxon';

export const SOURCES={
 nominal:'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve',
 real:'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_real_yield_curve',
 h10:'https://www.federalreserve.gov/releases/h10/summary/jrxwtfb_nb.htm',
 bls:'https://www.bls.gov/schedule/news_release/bls.ics',
 bea:'https://www.bea.gov/news/schedule/ics/online-calendar-subscription.ics',
 fomc:'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm',
 census:'https://www.census.gov/economic-indicators/calendar-listview',
 eia:'https://www.eia.gov/petroleum/supply/weekly/schedule.php',
 auctions:'https://www.treasurydirect.gov/TA_WS/securities/upcoming?format=json'
};
export const CALENDAR_SOURCES=['BLS','BEA','FOMC','Census','EIA','Treasury Auctions'];
const digest=x=>createHash('sha256').update(x).digest('hex');
const clean=x=>String(x??'').replace(/\s+/g,' ').trim();
const numeric=x=>clean(x)!==''&&Number.isFinite(Number(x))?Number(x):null;
const assert=(x,message)=>{if(!x)throw Error(message);};
const rounded=x=>Math.round(x*1e6)/1e6;
export function eastern(date,time){
 const normalized=clean(time).replace(/a\.m\./ig,'AM').replace(/p\.m\./ig,'PM');
 const d=DateTime.fromFormat(`${date} ${normalized}`,'yyyy-MM-dd h:mm a',{zone:'America/New_York',locale:'en'});
 assert(d.isValid,'Ungültige Eastern-Kalenderzeit.');return d.toUTC().toISO();
}
const englishDate=x=>DateTime.fromFormat(clean(x),'MMMM d, yyyy',{zone:'America/New_York',locale:'en'}).toISODate();
export function classifyEvent(title){
 const rules=[
  [/FOMC|Federal Open Market|Policy Decision|Summary of Economic Projections/i,'FOMC','HIGH'],
  [/Consumer Price Index|\bCPI\b/i,'CPI','HIGH'],[/Producer Price Index|\bPPI\b/i,'PPI','HIGH'],
  [/^Employment Situation\b|Nonfarm Payroll/i,'NFP','HIGH'],
  [/Personal Income and Outlays|\bPCE\b/i,'PCE','HIGH'],[/Gross Domestic Product|\bGDP\b/i,'GDP','HIGH'],
  [/Job Openings|\bJOLTS\b/i,'JOLTS','MEDIUM'],[/Employment Cost/i,'ECI','MEDIUM'],
  [/Productivity.*Costs/i,'PRODUCTIVITY','MEDIUM'],[/Retail|Food Services/i,'RETAIL','MEDIUM'],
  [/Durable/i,'DURABLE_GOODS','MEDIUM'],[/Residential|Housing/i,'HOUSING','MEDIUM'],
  [/Construction Spending/i,'CONSTRUCTION','MEDIUM'],[/International Trade in Goods and Services/i,'INTERNATIONAL_TRADE','MEDIUM'],
  [/Inventor|Manufacturers.*Orders|Wholesale/i,'INVENTORIES','MEDIUM'],
  [/Petroleum Status/i,'EIA_OIL','MEDIUM'],[/Auction/i,'TREASURY_AUCTION','MEDIUM']
 ];
 const r=rules.find(([re])=>re.test(title));return r?{event_type:r[1],importance:r[2]}:null;
}
export function event({source,source_id,title,at=null,date=null,url,period=null,event_type,importance,extra={}},now){
 assert(at||/^\d{4}-\d{2}-\d{2}$/.test(date),'Kalenderdatum fehlt.');
 const classification=classifyEvent(title)||{event_type:'OFFICIAL_RELEASE',importance:'LOW'};
 const type=event_type||classification.event_type;
 const identity=type==='INTERNATIONAL_TRADE'&&['BEA','Census'].includes(source)&&period&&at
  ?type+'|'+at+'|'+clean(period).toLowerCase():source+'|'+source_id;
 return {id:'official-'+digest(identity),source,source_id:String(source_id),title:clean(title).slice(0,350),
  event_type:event_type||classification.event_type,country:'US',scheduled_at_utc:at,at,
  scheduled_date:date||at.slice(0,10),time_precision:at?'MINUTE':'DATE',source_timezone:'America/New_York',
  importance:importance||classification.importance,impact:importance||classification.importance,
  importance_basis:'INTERNAL_TRADING_RELEVANCE',actual:null,forecast:null,previous:null,
  source_url:url,url,reference_period:period,updated_at:now,observedAt:now,createdAt:now,...extra};
}
function observation(id,label,points,url,source,now,unit='%',frequency='DAILY'){
 const p=points.filter(p=>p.date<=now.slice(0,10)&&p.value!==null).sort((a,b)=>a.date.localeCompare(b.date));
 assert(p.length,'Keine gültigen offiziellen Beobachtungen.');
 const last=p.at(-1),prev=p.at(-2),five=p.at(-6),change=prev?rounded(last.value-prev.value):null;
 return {id,label,value:last.value,previous:prev?.value??null,previous_at:prev?.date??null,change,
  change_bps:unit==='%'&&change!==null?rounded(change*100):null,
  five_day_change:five?rounded(last.value-five.value):null,
  at:last.date+'T00:00:00.000Z',observation_date:last.date,date_precision:'DAY',unit,frequency,
  source,url,observedAt:now,createdAt:now,points:p.slice(-6)};
}
export function parseTreasury(xml,kind,now,url){
 assert(!/<!DOCTYPE|<!ENTITY/i.test(xml),'Treasury XML enthält DTD/Entities.');
 const $=load(xml,{xml:true}),rows=[];
 $('entry').each((_,el)=>{const p=$(el).find('m\\:properties'),date=p.find('d\\:NEW_DATE').text().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return;const row={date};p.children().each((_,v)=>row[v.name.replace(/^d:/,'')]=numeric($(v).text()));rows.push(row);});
 const fields=kind==='real'?[['DFII10','US Real 10Y','TC_10YEAR']]:[['DGS2','US 2Y','BC_2YEAR'],['DGS10','US 10Y','BC_10YEAR'],['DGS5','US 5Y','BC_5YEAR'],['DGS30','US 30Y','BC_30YEAR']];
 return fields.map(([id,label,key])=>observation(id,label,rows.map(r=>({date:r.date,value:r[key]??null})),url,'U.S. Treasury · offizieller Tageswert',now));
}
export function parseH10(html,now){
 const $=load(html),table=$('table[title*="Nominal Broad Dollar"]');assert(table.length===1,'H.10 Broad-Dollar-Tabelle nicht eindeutig.');
 const points=[];table.find('tr').each((_,r)=>{const d=clean($(r).find('th').text()),v=numeric($(r).find('td').first().text());const date=DateTime.fromFormat(d,'d-LLL-yy',{locale:'en',zone:'UTC'});if(date.isValid&&v!==null)points.push({date:date.toISODate(),value:v});});
 return [observation('DTWEXBGS','Fed Broad Dollar Index (nicht DXY)',points,SOURCES.h10,'Federal Reserve H.10',now,'Index','DAILY_VALUES_WEEKLY_RELEASE')];
}
export async function parseICS(raw,source,now){
 assert(raw.includes('BEGIN:VCALENDAR')&&!raw.includes('<!DOCTYPE'),'Keine ICS-Antwort.');
 // BLS's VTIMEZONE uses the non-IANA alias US-Eastern. node-ical otherwise falls
 // back to the host timezone. Its published EST/EDT rules are America/New_York.
 const normalized=raw.replace(/TZID([=:])US-Eastern(?=[:;\r\n])/g,'TZID$1America/New_York').replace(/X-WR-TIMEZONE:US-Eastern/g,'X-WR-TIMEZONE:America/New_York');
 // Validate every DTSTART, not a global "some event has Z" check. A mixed feed
 // must never let one floating local timestamp inherit the host timezone.
 for(const line of [...normalized.matchAll(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g)].flatMap(m=>m[0].split(/\r?\n/)).filter(x=>x.startsWith('DTSTART'))){
  assert(/;VALUE=DATE:/.test(line)||/;TZID=(?:"?America\/New_York"?|"?UTC"?):/.test(line)||/Z$/.test(line),'ICS-Zeitzone fehlt/ist unbekannt.');
 }
 const objects=await ical.async.parseICS(normalized),out=[];
 for(const x of Object.values(objects)){
  if(x.type!=='VEVENT'||x.status==='CANCELLED')continue;
  const title=clean(typeof x.summary==='object'?x.summary.val:x.summary),classification=classifyEvent(title);
  if(!classification)continue;
  assert(x.start instanceof Date&&Number.isFinite(+x.start),'ICS-Datum ungültig.');
  assert(!x.rrule,'Unerwartete wiederkehrende Behördenveröffentlichung.');
  // Both agencies expose explicit zones/UTC. Do not interpret a floating time as server-local time.
  const period=title.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{4}/)?.[0]||null;
  out.push(event({source,source_id:title+'|'+x.start.toISOString(),title,period,at:x.start.dateOnly?null:x.start.toISOString(),date:x.start.toISOString().slice(0,10),url:SOURCES[source.toLowerCase()],extra:{upstream_uid:x.uid},...classification},now));
 }
 assert(out.length,'Keine relevanten ICS-Termine erkannt.');return out;
}
export function parseCensus(html,now){
 const $=load(html),out=[];assert($('#calendar').length,'Census-Kalender fehlt.');
 $('#calendar tr').each((_,r)=>{const cells=$(r).children('td'),key=cells.filter('[sorttable_customkey]').first().attr('sorttable_customkey');if(!/^\d{12}$/.test(key||''))return;
  const title=clean(cells.eq(0).text()),classification=classifyEvent(title);if(!classification)return;
  const d=DateTime.fromFormat(key,'yyyyMMddHHmm',{zone:'America/New_York'});assert(d.isValid,'Census-Datum ungültig.');const period=clean(cells.eq(3).text());
  out.push(event({source:'Census',source_id:key+'|'+title+'|'+period,title,at:d.toUTC().toISO(),period,url:new URL(cells.eq(0).find('a').attr('href')||SOURCES.census,'https://www.census.gov').href,...classification},now));
 });assert(out.length,'Keine Census-Termine erkannt.');return out;
}
export function parseFOMC(html,now){
 const $=load(html),out=[];
 $('.panel').each((_,p)=>{const year=Number($(p).find('h4').first().text().match(/(\d{4}) FOMC Meetings/)?.[1]);if(!year)return;
  $(p).find('.fomc-meeting').each((_,r)=>{const month=clean($(r).find('.fomc-meeting__month').text()),range=clean($(r).find('.fomc-meeting__date').text());
   // Emergency/multi-month formats are not silently guessed.
   const m=range.match(/^(\d{1,2})-(\d{1,2})(\*)?$/);if(!m)return;
   const date=DateTime.fromFormat(`${month} ${m[2]}, ${year}`,'MMMM d, yyyy',{locale:'en',zone:'America/New_York'}).toISODate();if(!date)return;
   const start=DateTime.fromFormat(`${month} ${m[1]}, ${year}`,'MMMM d, yyyy',{locale:'en'}).toISODate();
   const base={source:'FOMC',date,url:SOURCES.fomc,importance:'HIGH',extra:{meeting_start_date:start,meeting_end_date:date,sep:!!m[3]}};
   // The annual calendar publishes dates, not times. Keep UTC null rather than assume 14:00.
   out.push(event({...base,source_id:date+'-meeting',title:'FOMC Meeting / Policy decision & Statement',event_type:'FOMC_DECISION'},now));
   if(m[3])out.push(event({...base,source_id:date+'-sep',title:'FOMC Summary of Economic Projections',event_type:'FOMC_SEP'},now));
   if($(r).find('a').toArray().some(a=>/Press Conference/i.test($(a).text())))out.push(event({...base,source_id:date+'-press',title:'FOMC Press conference',event_type:'FOMC_PRESS'},now));
   const released=clean($(r).find('.fomc-meeting__minutes').text()).match(/Released (\w+ \d{1,2}, \d{4})/);
   // Future minutes follow the explicitly published three-week rule, marked as rule-derived.
   const minutes=released?englishDate(released[1]):DateTime.fromISO(date).plus({days:21}).toISODate();
   out.push(event({...base,date:minutes,source_id:date+'-minutes',title:'FOMC Minutes',event_type:'FOMC_MINUTES',extra:{schedule_basis:released?'PUBLISHED_DATE':'OFFICIAL_THREE_WEEK_RULE'}},now));
  });
 });assert(out.length,'Keine FOMC-Termine erkannt.');return out;
}
export function mergeFedCalendar(annual,raw,now){
 const rows=JSON.parse(raw.replace(/^\uFEFF/,'')).events;assert(Array.isArray(rows),'Fed-Kalenderformat ungültig.');
 const out=[...annual];
 for(const x of rows){
  const title=clean(x.title),policySpeech=x.type==='Speeches'&&/monetary|economic outlook|central banking|Chairman/i.test(title+' '+x.description);
  if(x.type!=='FOMC'&&!policySpeech)continue;
  if(!/^\d{4}-\d{2}$/.test(x.month)||!/^\d{1,2}$/.test(x.days)||!x.time)continue;
  const date=x.month+'-'+x.days.padStart(2,'0'),at=eastern(date,x.time);
  const type=policySpeech?'FED_COMMUNICATION':/Minutes/i.test(title)?'FOMC_MINUTES':/Press Conference/i.test(title)?'FOMC_PRESS':'FOMC_DECISION';
  const existing=out.find(e=>e.scheduled_date===date&&e.event_type===type);
  if(existing){Object.assign(existing,{at,scheduled_at_utc:at,time_precision:'MINUTE',time_source_url:'https://www.federalreserve.gov/newsevents/calendar.htm'});}
  else out.push(event({source:'FOMC',source_id:date+'|'+title,title,at,url:'https://www.federalreserve.gov/newsevents/calendar.htm',event_type:type,importance:'HIGH'},now));
  if(type==='FOMC_DECISION')for(const sep of out.filter(e=>e.event_type==='FOMC_SEP'&&e.scheduled_date===date))Object.assign(sep,{at,scheduled_at_utc:at,time_precision:'MINUTE',time_source_url:'https://www.federalreserve.gov/newsevents/calendar.htm'});
 }return out;
}
export function parseEIA(html,now){
 const $=load(html),body=clean($('body').text());
 assert(/Wednesday/i.test(body)&&/10:30/.test(body)&&/Eastern/i.test(body),'EIA-Regel nicht bestätigt.');
 const exceptions=new Map();$('tr').each((_,r)=>{const c=$(r).children('th,td').toArray().map(e=>clean($(e).text()));if(c.length!==5)return;const week=englishDate(c[0]),date=englishDate(c[1]);if(week&&date&&/\d+:\d+/.test(c[3]))exceptions.set(week,{date,time:c[3]});});
 const today=DateTime.fromISO(now,{zone:'America/New_York'}).startOf('day'),out=[];
 // A short published-rule horizon avoids assuming next year's holiday exceptions.
 for(let n=-7;n<=14;n++){const d=today.plus({days:n});if(d.weekday!==3)continue;const week=d.minus({days:5}).toISODate(),exception=exceptions.get(week),date=exception?.date||d.toISODate();
  out.push(event({source:'EIA',source_id:week,title:'EIA Weekly Petroleum Status Report',at:eastern(date,exception?.time||'10:30 AM'),url:SOURCES.eia,extra:{report_week_ending:week,schedule_basis:exception?'PUBLISHED_HOLIDAY_EXCEPTION':'PUBLISHED_WEEKLY_RULE'}},now));
 }return out;
}
export function parseAuctions(raw,now){
 const rows=JSON.parse(raw);assert(Array.isArray(rows),'Treasury-Auktionsformat ungültig.');
 return rows.filter(x=>x.securityType!=='Bill'&&x.floatingRate!=='Yes'&&(x.tips==='Yes'||/^(2|5|7|10|20|30)-Year$/.test(x.originalSecurityTerm||x.securityTerm))).map(x=>{
  const date=x.auctionDate?.slice(0,10);return event({source:'Treasury Auctions',source_id:x.cusip+'|'+date,title:`Treasury ${x.originalSecurityTerm||x.securityTerm}${x.tips==='Yes'?' TIPS':''} Auction`,date,at:x.closingTimeCompetitive?eastern(date,x.closingTimeCompetitive):null,url:'https://www.treasurydirect.gov/auctions/upcoming/',extra:{cusip:x.cusip,security_type:x.securityType}},now);
 });
}
export function dedupeEvents(events){
 const seen=new Map();for(const e of events){
  // Only the exact jointly published BEA/Census trade release is cross-source deduplicated.
  const joint=e.event_type==='INTERNATIONAL_TRADE'&&['BEA','Census'].includes(e.source);
  const key=joint&&e.reference_period?`${e.event_type}|${e.at}|${e.reference_period.toLowerCase()}`:e.id;
  const old=seen.get(key);if(old)old.also_reported_by=[...new Set([...(old.also_reported_by||[]),e.source])];else seen.set(key,{...e});
 }return [...seen.values()];
}
export function nextSourceAttempt(name,now,ttl){
 if(name!=='Fed H10')return new Date(Date.parse(now)+ttl).toISOString();
 const current=DateTime.fromISO(now,{zone:'America/New_York'});
 // Official Monday publication, with Tuesday holiday retry; no weekly drift from first fetch.
 for(let days=0;days<=8;days++){const d=current.plus({days}).set({hour:16,minute:30,second:0,millisecond:0});if([1,2].includes(d.weekday)&&d>current)return d.toUTC().toISO();}
 throw Error('H.10-Publikationsfenster fehlt.');
}
export function officialJobs(now){
 const year=Number(now.slice(0,4)),nominal=SOURCES.nominal+'&field_tdr_date_value='+year,real=SOURCES.real+'&field_tdr_date_value='+year;
 return [
  {name:'Treasury Nominal',kind:'observations',ttl:86400000,url:nominal,parse:s=>parseTreasury(s,'nominal',now,nominal)},
  {name:'Treasury Real',kind:'observations',ttl:86400000,url:real,parse:s=>parseTreasury(s,'real',now,real)},
  {name:'Fed H10',kind:'observations',ttl:7*86400000,url:SOURCES.h10,parse:s=>parseH10(s,now)},
  ...['BLS','BEA'].map(name=>({name,kind:'events',ttl:21600000,url:SOURCES[name.toLowerCase()],parse:s=>parseICS(s,name,now)})),
  {name:'FOMC',kind:'events',ttl:21600000,url:[SOURCES.fomc,'https://www.federalreserve.gov/json/calendar.json'],parse:([annual,timed])=>mergeFedCalendar(parseFOMC(annual,now),timed,now)},
  {name:'Census',kind:'events',ttl:21600000,url:SOURCES.census+'-'+year+'.html',parse:s=>parseCensus(s,now)},
  {name:'EIA',kind:'events',ttl:21600000,url:SOURCES.eia,parse:s=>parseEIA(s,now)},
  {name:'Treasury Auctions',kind:'events',ttl:21600000,url:SOURCES.auctions,parse:s=>parseAuctions(s,now)}
 ];
}
