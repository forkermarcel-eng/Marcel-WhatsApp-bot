/** Explainable context, not a prediction or order signal. Missing inputs stay unknown. */
import {DateTime} from 'luxon';
const DAY=86400000;
const TOPICS=[
 ['war/conflict',/\b(war|conflict|missile|airstrike|invasion|ceasefire|military strike)\b/i],
 ['sanctions',/\bsanctions?\b/i],['Middle East',/\b(Iran|Israel|Gaza|Lebanon|Middle East|Hormuz|Hamas|Hezbollah)\b/i],
 ['Russia/Ukraine',/\b(Russia|Russian|Ukraine|Ukrainian)\b/i],['China/Taiwan',/\b(China|Chinese|Taiwan)\b/i],
 ['North Korea',/\b(North Korea|Pyongyang)\b/i],['shipping',/\b(Red Sea|Suez|shipping|Houthi|Hormuz|tanker)\b/i],
 ['energy supply',/\b(oil|petroleum|energy supply|pipeline|refiner|gas supply)\b/i],['OPEC',/\bOPEC\b/i],
 ['banking stress',/\b(bank.*(?:failure|collapse|crisis|stress)|liquidity crisis)\b/i],
 ['sovereign risk',/\b(sovereign|debt default|debt ceiling|credit downgrade)\b/i],['trade tariffs',/\b(tariff|trade war|export control)\b/i],
 ['Fed/rates',/\b(Federal Reserve|FOMC|Fed|interest rate|monetary policy)\b/i],['inflation',/\b(inflation|CPI|PCE|consumer prices|producer prices)\b/i],
 ['employment',/\b(jobs|employment|payroll|unemployment|labor market)\b/i],['USD',/\b(dollar|USD)\b/i],
 ['Treasury',/\b(Treasury|bond yield|yields|government bonds)\b/i],['BoJ/JPY',/\b(Bank of Japan|BoJ|yen|JPY|Japan)\b/i],
 ['ECB/EUR',/\b(ECB|European Central Bank|eurozone|EUR)\b/i],['gold/precious metals',/\b(gold|silver|precious metals|bullion)\b/i]
];
const GEO=new Set(['war/conflict','sanctions','Middle East','Russia/Ukraine','China/Taiwan','North Korea','shipping','trade tariffs']);
export function classifyNews(n){
 const input=n.title+' '+(/Federal Reserve|EZB|Bank of Japan/.test(n.source||'')?n.source:'');
 const topics=TOPICS.filter(([,r])=>r.test(input)).map(([t])=>t),geopolitical=topics.some(t=>GEO.has(t));
 const relevance=topics.some(t=>['gold/precious metals','war/conflict','Fed/rates','inflation','banking stress','sovereign risk'].includes(t))?'HIGH':topics.length?'MEDIUM':'LOW';
 return {...n,topics,geopolitical,relevance,classification_basis:'INTERNAL_HEADLINE_RULES'};
}
export function prioritizeNews(news,now=new Date().toISOString()){
 const rank={HIGH:3,MEDIUM:2,LOW:1},seen=new Set();
 return news.map(classifyNews).filter(n=>{if(!n.url||seen.has(n.url))return false;seen.add(n.url);return true;}).sort((a,b)=>{
  const fresh=x=>Number.isFinite(Date.parse(x.publishedAt))&&Date.parse(now)-Date.parse(x.publishedAt)<=3*DAY&&Date.parse(x.publishedAt)<=Date.parse(now);
  return Number(fresh(b))-Number(fresh(a))||rank[b.relevance]-rank[a.relevance]||(b.publishedAt||'').localeCompare(a.publishedAt||'');
 });
}
export function eventBounds(e){
 if(e.at&&Number.isFinite(Date.parse(e.at)))return [Date.parse(e.at),Date.parse(e.at)];
 if(/^\d{4}-\d{2}-\d{2}$/.test(e.scheduled_date||'')){const d=DateTime.fromISO(e.scheduled_date,{zone:e.source_timezone||'America/New_York'});return [d.startOf('day').toMillis(),d.endOf('day').toMillis()];}
 return [NaN,NaN];
}
export function buildMarketContext({observations=[],events=[],news=[],sync=null,markets={}},now=new Date().toISOString()){
 const stamp=Date.parse(now),warnings=[];
 const get=id=>{const o=observations.find(x=>x.id===id),max=id==='DTWEXBGS'?11*DAY:5*DAY;
  if(!o||!Number.isFinite(o.value)||!Number.isFinite(Date.parse(o.at))||stamp-Date.parse(o.at)>max||Date.parse(o.at)>stamp){warnings.push(id+': fehlt/veraltet');return null;}return o;};
 const two=get('DGS2'),ten=get('DGS10'),real=get('DFII10'),usd=get('DTWEXBGS');
 const direction=(n,up,down,flat)=>typeof n!=='number'||!Number.isFinite(n)?'UNKNOWN':n>0?up:n<0?down:flat;
 const changes=[two?.change_bps,ten?.change_bps,real?.change_bps];
 const rates=changes.every(x=>typeof x==='number')?(changes.every(x=>x>0)?'RISING':changes.every(x=>x<0)?'FALLING':'MIXED'):'UNKNOWN';
 const freshMarket=root=>{const x=markets[root];return x&&stamp-Date.parse(x.at)<=4*DAY&&Date.parse(x.at)<=stamp?x:null;};
 const gold=freshMarket('MGC'),nasdaq=freshMarket('MNQ'),dow=freshMarket('MYM'),oil=freshMarket('MCL');
 if(!gold||!nasdaq||!dow||!oil)warnings.push('Cross-Asset-Kurse fehlen/veraltet; kein Livefeed vorausgesetzt.');
 const risk=nasdaq&&dow&&typeof nasdaq.change_pct==='number'&&typeof dow.change_pct==='number'?(nasdaq.change_pct>0&&dow.change_pct>0?'RISK-ON':nasdaq.change_pct<0&&dow.change_pct<0?'RISK-OFF':'MIXED'):'UNKNOWN';
 const reports=sync?.reports||[],newsReports=reports.filter(r=>r.kind==='news');
 const newsHealthy=newsReports.some(r=>r.name==='BBC Welt')&&newsReports.every(r=>r.healthy===true&&stamp-Date.parse(r.lastSuccessAt)<1800000);
 const recent=prioritizeNews(news,now).filter(n=>n.geopolitical&&Date.parse(n.publishedAt)<=stamp&&stamp-Date.parse(n.publishedAt)<2*DAY);
 // A headline mention is not proof of geopolitical severity. Flag the monitoring
 // category, with explicit evidence links, never claim verified conflict escalation.
 const activeConflict=recent.filter(n=>n.topics.includes('war/conflict')&&!/ceasefire|peace deal|truce|de-escalat/i.test(n.title));
 const geo=activeConflict.length>=3&&new Set(activeConflict.map(n=>n.source)).size>=2?'HIGH':recent.length?'ELEVATED':newsHealthy?'LOW':'UNKNOWN';
 const upcoming=events.filter(e=>{const [a,b]=eventBounds(e);return b>=stamp&&a<=stamp+DAY;});
 const calendarHealthy=sync?.calendarStatus==='OK'&&stamp-Date.parse(sync.lastSyncAt)<21600000;
 const calendar=upcoming.some(e=>e.impact==='HIGH')?'HIGH':upcoming.some(e=>e.impact==='MEDIUM')?'MEDIUM':calendarHealthy?'LOW':'UNKNOWN';
 if(!calendarHealthy)warnings.push('Kalenderabdeckung nicht vollständig aktuell bestätigt.');
 if(!newsHealthy)warnings.push('News-Abdeckung nicht aktuell bestätigt.');
 const usdDirection=direction(usd?.change,'STRONGER','WEAKER','NEUTRAL'),oilDirection=direction(oil?.change_pct,'RISING','FALLING','NEUTRAL');
 const signals=[];
 if(typeof real?.change_bps==='number'&&real.change_bps!==0)signals.push({sign:real.change_bps<0?1:-1,reason:`Reale 10Y-Rendite ${real.change_bps<0?'fällt':'steigt'} (${real.change_bps} bp).`});
 if(typeof usd?.change==='number'&&usd.change!==0)signals.push({sign:usd.change<0?1:-1,reason:`Broad USD ${usd.change<0?'schwächer':'stärker'} (Tageswerte, wöchentlich veröffentlicht).`});
 if(geo==='HIGH'||geo==='ELEVATED')signals.push({sign:1,reason:'Geopolitische Schlagzeilen erhöhen den Safe-Haven-Kontext; Meldungen sind keine bestätigten Tatsachen.'});
 if(risk==='RISK-ON')signals.push({sign:-1,reason:'Nasdaq und Dow steigen im verfügbaren Tagesvergleich.'});
 const mixed=signals.some(s=>s.sign===1)&&signals.some(s=>s.sign===-1),complete=!!real&&!!usd&&rates!=='UNKNOWN';
 const bias=complete&&signals.length>=2&&!mixed?(signals[0].sign===1?'BULLISH':'BEARISH'):'NEUTRAL';
 return {asOf:now,rates,usd:usdDirection,oil:oilDirection,risk,geopolitical:geo,calendar24h:calendar,goldBias:bias,
  reasons:[...signals.map(s=>s.reason),...(mixed?['Gemischte Signale: keine Richtung erzwungen.']:[]),...(!complete?['Unvollständige Makrodaten: keine Richtung abgeleitet.']:[])],warnings,
  spread2s10s:two&&ten&&two.observation_date===ten.observation_date?Math.round((ten.value-two.value)*100)/100:null,
  values:{two,ten,real,usd,gold,nasdaq,dow,oil},
  nextHigh:events.filter(e=>e.impact==='HIGH'&&eventBounds(e)[1]>=stamp).sort((a,b)=>eventBounds(a)[0]-eventBounds(b)[0])[0]||null,
  geopoliticalEvidence:recent.slice(0,8).map(n=>({title:n.title,url:n.url,source:n.source})),
  methodology:'Regelbasiert; Renditen/Index Tagesvergleich, Futures UTC-Tagesabschlussvergleich. Keine Prognose, keine Handelsempfehlung.'};
}
export async function marketInputs(repo,settings,series,now){
 const markets={};await Promise.all(['MGC','MNQ','MYM','MCL'].map(async root=>{
  const contract=settings.contracts?.[root];if(!contract)return;
  const s=series.filter(x=>x.contract===contract).sort((a,b)=>b.last.localeCompare(a.last)||a.resolution-b.resolution)[0];if(!s)return;
  const bars=await repo.candles(contract,{source:s.source,resolution:s.resolution,limit:10080,to:now}),days=new Map();
  for(const b of bars){const day=b.time.slice(0,10);if(day<now.slice(0,10))days.set(day,b);}
  const closes=[...days.values()].sort((a,b)=>a.time.localeCompare(b.time)),last=closes.at(-1),previous=closes.at(-2);
  if(last)markets[root]={contract,source:s.source,value:last.close,at:last.time,previous:previous?.close??null,change_pct:previous?(last.close/previous.close-1)*100:null,basis:'UTC_DAY_LAST_OBSERVED_CLOSE'};
 }));return markets;
}
