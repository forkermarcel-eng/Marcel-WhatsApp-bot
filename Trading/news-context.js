/** Shared server/browser headline rules. Scores select relevance, NEVER ordering. */
export const MARKET_NAMES={MGC:'GOLD',MNQ:'NASDAQ',MYM:'DOW',MCL:'OIL'};
export const CONTEXT_TIME_ZONE='Europe/Berlin';
const berlinFormatters={
 short:new Intl.DateTimeFormat('de-DE',{timeZone:CONTEXT_TIME_ZONE,day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),
 full:new Intl.DateTimeFormat('de-DE',{timeZone:CONTEXT_TIME_ZONE,day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}),
 clock:new Intl.DateTimeFormat('de-DE',{timeZone:CONTEXT_TIME_ZONE,hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
};
export function explicitTimestamp(value){
 if(typeof value!=='string'||!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value))return null;
 const stamp=Date.parse(value);return Number.isFinite(stamp)?stamp:null;
}
export function berlinTime(value,mode='short'){
 const stamp=typeof value==='number'&&Number.isFinite(value)?value:explicitTimestamp(value);
 return stamp===null?'Zeit unbekannt':(berlinFormatters[mode]||berlinFormatters.short).format(new Date(stamp));
}
// A date-only source observation is not a publication instant. Never invent its time.
export function sourceDateLabel(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return 'Datum unbekannt';
 const stamp=Date.parse(value+'T00:00:00Z');if(!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==value)return 'Datum unbekannt';
 return value.slice(8,10)+'.'+value.slice(5,7)+'.'+value.slice(0,4);
}
export function calendarTimestamp(e){
 for(const key of ['scheduled_at_utc','at','scheduled_at']){const stamp=explicitTimestamp(e[key]);if(stamp!==null)return stamp;}
 return null;
}
export function calendarTime(e){
 const stamp=calendarTimestamp(e);return stamp!==null?berlinTime(stamp):sourceDateLabel(e.scheduled_date)+' · Uhrzeit nicht veröffentlicht';
}
export function compareCalendar(a,b){
 // Date-only rows keep their nominal date position; this does not create an event time.
 const key=e=>calendarTimestamp(e)??(sourceDateLabel(e.scheduled_date)!=='Datum unbekannt'?Date.parse(e.scheduled_date+'T00:00:00Z'):0);
 return key(a)-key(b)||String(a.id||'').localeCompare(String(b.id||''));
}
export function newsTime(n){
 const published=newsTimestamp({published_at:n.published_at,publishedAt:n.publishedAt}),stamp=newsTimestamp(n);
 return stamp?(published?'':'Erfasst ')+berlinTime(stamp):'Zeit unbekannt';
}
const MACRO=/\b(Federal Reserve|FOMC|Fed|Powell|rates?|yields?|CPI|PCE|PPI|NFP|inflation|employment|payrolls?|unemployment|central banks?|Treasury|dollar|USD|ECB|EZB|Bank of Japan|BoJ|yen)\b/i;
const GEO=/\b(war|conflict|missiles?|airstrikes?|invasion|sanctions?|ceasefire|military|export controls?|tariffs?|Hormuz|Red Sea|Suez|Houthi)\b/i;
const ENERGY=/\b(oil|crude|WTI|Brent|OPEC|EIA|petroleum|inventor(?:y|ies)|production|refiner\w*|pipeline|tankers?|shipping|Hormuz|Red Sea|Suez|SPR|DOE|supply disruption|oil fields?|hurricane|energy infrastructure|Saudi Arabia|Iran|Iraq|Venezuela|Libya)\b/i;
const TECH=/\b(tech\w*|semiconductors?|chips?|AI|artificial intelligence|megacap|earnings|regulation|Taiwan|export controls?|Nvidia|Apple|Microsoft|Alphabet|Amazon|Meta)\b/i;
const INDUSTRY=/\b(industrials?|banks?|manufacturing|energy|trade|tariffs?|economic growth|GDP|ISM|PMI|recession|factory|factories)\b/i;
const GLOBAL=/\b(war|invasion|FOMC|Federal Reserve|CPI|PCE|inflation|banking crisis|bank collapse|sovereign default|financial crisis)\b/i;
const OFFICIAL=/Fed|Federal Reserve|EZB|ECB|Bank of Japan|Treasury|OFAC|EIA|DOE|OPEC|IEA|NATO|UN News/i;
export function newsTimestamp(n){
 for(const key of ['published_at','publishedAt','seen_at','seenAt','fetched_at','fetchedAt','observedAt']){
  const stamp=explicitTimestamp(n[key]);if(stamp!==null)return stamp;
 }return 0;
}
export const compareNews=(a,b)=>newsTimestamp(b)-newsTimestamp(a)||String(a.id||a.url||'').localeCompare(String(b.id||b.url||''));
export const normalizedHeadline=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/^(breaking|update(?:d)?(?:\s+\d+)?|live)\s*[:\-–—]\s*/,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
export function sortedNews(news){
 const urls=new Set(),titles=new Map();
 return [...news].sort(compareNews).filter(n=>{
  if(!n.url||urls.has(n.url))return false;urls.add(n.url);
  // Only collapse identical normalized headlines from the SAME publisher and day.
  // Different publishers and meaningful wording changes remain separate evidence.
  const key=String(n.source)+'|'+Math.floor(newsTimestamp(n)/86400000)+'|'+normalizedHeadline(n.title);
  if(n.source&&titles.has(key))return false;titles.set(key,true);return true;
 });
}
export function newsRelevance(n,instrument='MGC',now=Date.now()){
 const input=String(n.title||'')+' '+(OFFICIAL.test(n.source||'')?n.source:''),macro=MACRO.test(input),geo=GEO.test(input);
 const matched={MGC:macro||geo||/\b(gold|precious metals|bullion|China|risk.off|banking stress)\b/i.test(input),MCL:ENERGY.test(input)||/\b(sanctions?|Russia|Middle East)\b/i.test(input),MNQ:macro||TECH.test(input)||/\brisk[ -](on|off)\b/i.test(input),MYM:macro||INDUSTRY.test(input)||/\brisk[ -](on|off)\b/i.test(input)}[instrument]||false;
 const supplyRisk=ENERGY.test(input)&&/\b(attack\w*|disrupt\w*|missile\w*|drone\w*|shutdown|blockade)\b/i.test(input);
 const global=GLOBAL.test(input),age=now-newsTimestamp(n),parts={instrument:matched?40:0,macro:macro?15:0,geopolitical:geo?20:0,sourceAuthority:OFFICIAL.test(n.source||'')?10:5,recency:age>=0&&age<=86400000?10:0};
 const score=Object.values(parts).reduce((a,b)=>a+b,0),relevance=global||(instrument==='MCL'&&supplyRisk)||score>=65?'HIGH':matched||macro||geo?'MEDIUM':'LOW';
 return {relevance,score,parts,macro,geopolitical:geo,global,supplyRisk};
}
export function radarNews(news,instrument,mode='relevant',now=Date.now()){
 return sortedNews(news).map(n=>({...n,...newsRelevance(n,instrument,now)})).filter(n=>mode==='all'||mode==='macro'&&n.macro||mode==='geo'&&n.geopolitical||mode==='relevant'&&n.relevance!=='LOW');
}
export function eventRelevance(e,instrument){
 const title=e.title||'';
 if(/EIA|petroleum|crude oil|oil inventor/i.test(title))return instrument==='MCL'?'HIGH':'MEDIUM';
 if(/FOMC|Federal Reserve|CPI|PCE|consumer price|personal consumption|inflation/i.test(title))return instrument==='MCL'?'MEDIUM':'HIGH';
 return e.impact||e.importance||'UNKNOWN';
}
