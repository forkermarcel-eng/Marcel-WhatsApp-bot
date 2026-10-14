/** Shared, side-effect-free trading calculations. Prices in USD per exchange quote.
 * Gold's "Pip" is Marcel's DISPLAY convention (0.1), not a universal CFD pip.
 * Nothing in this module sends or represents broker orders.
 */
export const INSTRUMENTS = Object.freeze({
 MGC:{name:'Gold',description:'Micro Gold · COMEX',tick:0.1,multiplier:10,pip:0.1,unit:'Pips',currency:'USD',exchange:'COMEX',color:'#dcbb73'},
 MNQ:{name:'Nasdaq 100',description:'Micro E-mini Nasdaq · CME',tick:0.25,multiplier:2,pip:1,unit:'Punkte',currency:'USD',exchange:'CME',color:'#93acff'},
 MYM:{name:'Dow Jones',description:'Micro E-mini Dow · CBOT',tick:1,multiplier:0.5,pip:1,unit:'Punkte',currency:'USD',exchange:'CBOT',color:'#7ac9c1'},
 MCL:{name:'WTI-Öl',description:'Micro WTI · NYMEX',tick:0.01,multiplier:100,pip:0.01,unit:'Cents',currency:'USD',exchange:'NYMEX',color:'#b1c582'},
 MBT:{name:'Bitcoin',description:'Micro Bitcoin · CME',tick:5,multiplier:0.1,pip:1,unit:'USD Preisweg',currency:'USD',exchange:'CME',color:'#e9a465'},
 NKD:{name:'Nikkei 225',description:'USD Nikkei · CME',tick:5,multiplier:5,pip:1,unit:'Punkte',currency:'USD',exchange:'CME',color:'#bf9fde'}
});
export const DEFAULT_PLAYBOOK = Object.freeze({id:'gold-retest-limit',name:'Gold · 48h Retest Limit',description:'Manuelle Analyse. Nachts Gold; tagsüber Gold, Nasdaq oder Dow. Keine Market-Entries. Ältere Blöcke vor dem Entscheidungszeitpunkt berücksichtigen.',rules:['Retest-Level vorab definiert','Strukturelle Invalidierung festgelegt','Größe aus SL und Risikobudget','Nachrichten und kommende Termine geprüft','Mindestens 1:3 bis zum strukturellen Ziel','Kein Retest = kein Trade'],session:'Nacht / Asien',version:1});
export const DEFAULT_SETTINGS = Object.freeze({timezone:'Europe/Berlin',riskBudget:300,maxConcurrentRisk:500,lossBudget:2000,phaseTarget:6000,challengeLabel:'Manueller Challenge-Plan',phase:'Runde 1',sessionEnd:'19:00',maxPositionContracts:6,newsMinutes:30,primary:['MGC','MNQ','MYM'],contracts:{},note:'Eigene Planungswerte – keine automatisch geprüften Prop-Regeln.'});
export function invariant(ok,message){if(!ok){const e=new Error(message); e.status=400; throw e;}}
export function num(x,label){invariant(x!==''&&x!==null&&x!==undefined&&Number.isFinite(Number(x)),`${label}: gültige Zahl erforderlich.`);return Number(x);}
export function text(x,max=2000){return String(x??'').trim().slice(0,max);}
export function iso(x,label='Zeit'){invariant(typeof x==='string'&&/(Z|[+-]\d{2}:\d{2})$/.test(x)&&Number.isFinite(Date.parse(x)),`${label}: ISO-Zeit mit Zeitzone erforderlich.`);return new Date(x).toISOString();}
export function round(x,n=2){return Math.round((x+Number.EPSILON)*10**n)/10**n;}
export function contractValid(root,contract){return typeof contract==='string'&&new RegExp(`^${root}[FGHJKMNQUVXZ]\\d{1,4}$`).test(contract);}
export function validatePlan(input,{now=new Date().toISOString(),retrospective=false}={}){
 const instrument=text(input.instrument,8), spec=INSTRUMENTS[instrument]; invariant(spec,'Unbekanntes Instrument.');
 const contract=text(input.contract,24).toUpperCase(); invariant(contractValid(instrument,contract),'Exakten Future-Monat verwenden, z. B. MGCZ6. Kein 1!- oder CFD-Symbol.');
 const side=text(input.side,5).toUpperCase(); invariant(['LONG','SHORT'].includes(side),'Long oder Short wählen.');
 invariant(!input.orderType||input.orderType==='LIMIT','Nur Limit-Pläne sind erlaubt.');
 const entry=num(input.entry,'Entry'),stop=num(input.stop,'SL'),target=num(input.target,'TP'),quantity=num(input.quantity,'Kontrakte');
 invariant([entry,stop,target].every(x=>x>0),'Preise müssen positiv sein.');
 invariant(Number.isInteger(quantity)&&quantity>=1&&quantity<=100,'1–100 ganze Kontrakte erforderlich.');
 for(const [k,v] of Object.entries({Entry:entry,SL:stop,TP:target}))invariant(Math.abs(v/spec.tick-Math.round(v/spec.tick))<0.00001,`${k} muss auf dem ${spec.tick}-Tick liegen.`);
 invariant(side==='LONG'?stop<entry&&target>entry:target<entry&&entry<stop,'SL und TP liegen auf der falschen Seite des Entry.');
 const plannedAt=iso(input.plannedAt||now),expiresAt=iso(input.expiresAt,'Ablauf');
 invariant(Date.parse(expiresAt)>Date.parse(plannedAt),'Ablauf muss nach Entscheidung liegen.');
 invariant(Date.parse(expiresAt)-Date.parse(plannedAt)<=7*86400000,'Ablauf maximal sieben Tage nach Entscheidung.');
 if(!retrospective)invariant(Math.abs(Date.parse(plannedAt)-Date.parse(now))<5*60000,'Historische Pläne bitte ausdrücklich als Rückblick erfassen.');
 const zoneLow=num(input.zoneLow??entry,'Block-Unterkante'),zoneHigh=num(input.zoneHigh??entry,'Block-Oberkante');
 invariant(zoneLow<=zoneHigh,'Block-Unterkante liegt über Oberkante.');
 const knownAt=input.knownAt?iso(input.knownAt):plannedAt;
 invariant(Date.parse(knownAt)<=Date.parse(plannedAt),'Der Block war zum Entscheidungszeitpunkt noch nicht bekannt.');
 return {instrument,contract,side,orderType:'LIMIT',entry,stop,target,quantity,zoneLow,zoneHigh,knownAt,plannedAt,expiresAt,retrospective,
 playbookId:text(input.playbookId||'gold-retest-limit',80),session:text(input.session||'Nacht / Asien',40),bias:text(input.bias||'NEUTRAL',20),reason:text(input.reason,5000),invalidation:text(input.invalidation,2000),newsNote:text(input.newsNote,3000),counterArgument:text(input.counterArgument,2000),overrideReason:text(input.overrideReason,1000),tags:Array.isArray(input.tags)?input.tags.map(x=>text(x,40)).slice(0,15):[],checks:Array.isArray(input.checks)?input.checks.map(x=>text(x,120)).slice(0,12):[],attachmentIds:Array.isArray(input.attachmentIds)?input.attachmentIds.slice(0,8).map(x=>text(x,64)):[],costPerContract:Math.max(0,num(input.costPerContract??0,'Kosten'))};
}
export function risk(p){const s=INSTRUMENTS[p.instrument];if(!s)return null;const d=Math.abs(p.entry-p.stop),g=Math.abs(p.target-p.entry),fees=p.quantity*(p.costPerContract||0);return {stopUnits:round(d/s.pip,2),targetUnits:round(g/s.pip,2),risk:round(d*s.multiplier*p.quantity),reward:round(g*s.multiplier*p.quantity),fees:round(fees),riskWithCosts:round(d*s.multiplier*p.quantity+fees),netReward:round(g*s.multiplier*p.quantity-fees),rr:round(g/d,3),netRR:round((g*s.multiplier*p.quantity-fees)/(d*s.multiplier*p.quantity+fees),3),unit:s.unit,multiplier:s.multiplier};}
export function sizeForRisk(instrument,distance,budget,cost=0){const s=INSTRUMENTS[instrument];return s&&distance>0?Math.max(0,Math.floor(budget/(distance*s.multiplier+cost))):0;}
export function planWarnings(p,settings=DEFAULT_SETTINGS,context={}){const r=risk(p),w=[];if(r.rr<3)w.push('CRV unter 1:3.');if(r.riskWithCosts>settings.riskBudget)w.push('Geplantes Risiko über deinem Budget.');if(p.quantity>settings.maxPositionContracts)w.push('Größe über deinem gespeicherten persönlichen Limit.');if(!p.costPerContract)w.push('Gebühren nicht berücksichtigt.');if(context.calendarStatus!=='OK')w.push('Wirtschaftskalender nicht vollständig bestätigt.');const event=(context.events||[]).find(x=>x.impact==='HIGH'&&Date.parse(x.at)>=Date.parse(p.plannedAt)&&Date.parse(x.at)<=Date.parse(p.expiresAt));if(event)w.push(`Hochrisiko-Termin während der Laufzeit: ${event.title}`);return w;}
export function validateCandle(c){const t=iso(c.time||c.ts_event,'Kerzenzeit');const o=num(c.open,'Open'),h=num(c.high,'High'),l=num(c.low,'Low'),cl=num(c.close,'Close'),v=num(c.volume??0,'Volume');invariant(l>0&&h>=l&&h>=o&&h>=cl&&l<=o&&l<=cl&&v>=0,'Ungültige OHLCV-Werte.');return {time:t,open:o,high:h,low:l,close:cl,volume:v};}
export function aggregateCandles(candles,minutes){const step=minutes*60000,buckets=new Map();for(const c of [...candles].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time))){const t=Math.floor(Date.parse(c.time)/step)*step;const q=buckets.get(t);if(q){q.high=Math.max(q.high,c.high);q.low=Math.min(q.low,c.low);q.close=c.close;q.volume+=c.volume;}else buckets.set(t,{...c,time:new Date(t).toISOString()});}return [...buckets.values()];}
export function ema(candles,length){let v=null;const k=2/(length+1);return candles.map(c=>{v=v===null?c.close:c.close*k+v*(1-k);return v;});}
/** Conservative OHLC estimation. Touch is not an exchange fill; same-bar ordering is UNKNOWN.
 * No bars before decision; no continuous-contract conversion; no synthetic broker status.
 */
export function evaluatePlan(plan,candles,{resolution=60,asOf=Date.now(),source='import',contract=plan.contract}={}){
 const empty={status:'NO_DATA',fill:null,exit:null,estimatedPnl:null,mae:null,mfe:null,r:null,source,contract,coverage:'UNKNOWN',note:'OHLC-Schätzung, kein Ausführungsnachweis.'};
 if(contract!==plan.contract)return {...empty,status:'CONTRACT_MISMATCH'};
 const start=Date.parse(plan.plannedAt),end=Math.min(Date.parse(plan.expiresAt),asOf),bars=candles.filter(c=>Date.parse(c.time)>=start&&Date.parse(c.time)+resolution*1000<=end).sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
 if(!bars.length)return empty;
 let gap=Date.parse(bars[0].time)-start>resolution*2000,fill=null,mae=0,mfe=0;
 const sign=plan.side==='LONG'?1:-1, qty=plan.quantity,spec=INSTRUMENTS[plan.instrument];
 for(let i=0;i<bars.length;i++){
  const b=bars[i];if(i&&Date.parse(b.time)-Date.parse(bars[i-1].time)>resolution*1500)gap=true;
  if(!fill){const touched=sign===1?b.low<=plan.entry:b.high>=plan.entry;if(!touched)continue;
   fill={time:b.time,price:plan.entry,quality:'POSSIBLE_LIMIT_TOUCH'};
   const stopHit=sign===1?b.low<=plan.stop:b.high>=plan.stop,targetHit=sign===1?b.high>=plan.target:b.low<=plan.target;
   // Any exit in the entry bar has an unknown sequence. Do not award a win.
   if(stopHit||targetHit)return {...empty,status:'AMBIGUOUS',fill,coverage:gap?'GAPS':'OBSERVED',note:'Entry und SL/TP in derselben Kerze. Reihenfolge und Queue unbekannt.'};
   continue; // Do not count pre-entry extremes of the entry bar as MFE/MAE.
  }
  const adverse=sign===1?plan.entry-b.low:b.high-plan.entry,favorable=sign===1?b.high-plan.entry:plan.entry-b.low;
  const stopHit=sign===1?b.low<=plan.stop:b.high>=plan.stop,targetHit=sign===1?b.high>=plan.target:b.low<=plan.target;
  if(stopHit&&targetHit)return {...empty,status:'AMBIGUOUS',fill,mae:round(mae/spec.pip),mfe:round(mfe/spec.pip),coverage:gap?'GAPS':'OBSERVED',note:'SL und TP in derselben Kerze – keine gesicherte Reihenfolge.'};
  if(stopHit||targetHit){const gapStop=stopHit&&(sign===1?b.open<plan.stop:b.open>plan.stop);const price=stopHit?(gapStop?b.open:plan.stop):plan.target;const pnl=sign*(price-plan.entry)*spec.multiplier*qty-qty*(plan.costPerContract||0);return {...empty,status:gap?'INCOMPLETE':stopHit?'ESTIMATED_SL':'ESTIMATED_TP',fill,exit:{time:b.time,price,reason:stopHit?'SL':'TP',gapStop},estimatedPnl:round(pnl),mae:round(Math.max(mae,stopHit?Math.abs(price-plan.entry):0)/spec.pip),mfe:round(Math.max(mfe,targetHit?Math.abs(price-plan.entry):0)/spec.pip),r:round(pnl/risk(plan).riskWithCosts,3),coverage:gap?'GAPS':'OBSERVED',note:'Barweise Schätzung, kein Fill-Beleg. MAE/MFE sind konservative Untergrenzen: unklare Entry-/Exitkerzen-Extrema fehlen. Gebühren gemäß Plan, weitere Slippage unbekannt.'};}
  mae=Math.max(mae,adverse);mfe=Math.max(mfe,favorable);
 }
 const last=bars.at(-1);if(end-Date.parse(last.time)>resolution*2000)gap=true;
 return {...empty,status:gap?'INCOMPLETE':fill?'POSSIBLE_FILL':asOf>=Date.parse(plan.expiresAt)?'NO_TOUCH':'WAITING',fill,mae:fill?round(mae/spec.pip):null,mfe:fill?round(mfe/spec.pip):null,coverage:gap?'GAPS':'OBSERVED'};
}
export function executionSummary(plan,executions=[]){const s=INSTRUMENTS[plan.instrument],sign=plan.side==='LONG'?1:-1;let qty=0,cost=0,gross=0,fees=0,entered=0,exited=0;let closedAt=null;for(const e of [...executions].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.createdAt.localeCompare(b.createdAt))){fees+=e.fee||0;if(e.action==='ENTRY'){qty+=e.quantity;entered+=e.quantity;cost+=e.quantity*e.price;}else{invariant(e.quantity<=qty,'Exit größer als offene Stückzahl.');const avg=cost/qty;gross+=sign*(e.price-avg)*s.multiplier*e.quantity;cost-=avg*e.quantity;qty-=e.quantity;exited+=e.quantity;if(qty===0)closedAt=e.at;}}return {status:entered===0?'NOT_CONFIRMED':qty?'OPEN':'CLOSED',openQuantity:qty,entered,exited,averageEntry:qty?cost/qty:null,gross:round(gross),fees:round(fees),net:round(gross-fees),r:entered?round((gross-fees)/risk(plan).riskWithCosts,3):null,closedAt};}
export function analytics(plans,executions,estimates=[]){const closed=plans.map(p=>({plan:p,...executionSummary(p,executions.filter(e=>e.planId===p.id))})).filter(t=>t.status==='CLOSED'&&!t.plan.retrospective).sort((a,b)=>a.closedAt.localeCompare(b.closedAt));const wins=closed.filter(t=>t.net>0),losses=closed.filter(t=>t.net<0),sum=a=>a.reduce((s,x)=>s+x.net,0);let eq=0,high=0,maxDD=0;const curve=closed.map(t=>{eq+=t.net;high=Math.max(high,eq);maxDD=Math.max(maxDD,high-eq);return {time:t.closedAt,value:round(eq)};});const validPlans=plans.filter(p=>!p.retrospective),filled=validPlans.filter(p=>executions.some(e=>e.planId===p.id&&e.action==='ENTRY'));const groups={};for(const t of closed){const k=`${t.plan.instrument} · ${t.plan.session}`;groups[k]??={count:0,net:0,r:0};groups[k].count++;groups[k].net+=t.net;groups[k].r+=t.r;}return {closed:closed.length,wins:wins.length,losses:losses.length,winrate:closed.length?round(wins.length/closed.length*100,1):null,net:round(sum(closed)),profitFactor:losses.length?round(sum(wins)/-sum(losses),2):null,averageR:closed.length?round(closed.reduce((s,t)=>s+t.r,0)/closed.length,2):null,expectancy:closed.length?round(sum(closed)/closed.length):null,maxDrawdown:round(maxDD),fillRate:validPlans.length?round(filled.length/validPlans.length*100,1):null,planned:validPlans.length,confirmedFills:filled.length,curve,groups,estimateCount:estimates.length,note:'Nur manuell bestätigte abgeschlossene Trades; Rückblicke und Schätzungen ausgeschlossen. Drawdown aus abgeschlossenen Trades, nicht Intraday-Equity.'};}
export function parseCSV(raw){const lines=[];let row=[],cell='',quoted=false;for(let i=0;i<raw.length;i++){const c=raw[i];if(c==='"'){if(quoted&&raw[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if(c==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));if(row.some(x=>x.trim()))lines.push(row);row=[];cell='';}else cell+=c;}invariant(!quoted,'CSV: offenes Anführungszeichen.');row.push(cell.replace(/\r$/,''));if(row.some(x=>x.trim()))lines.push(row);const head=(lines.shift()||[]).map(x=>x.trim().replace(/^\uFEFF/,''));return lines.map((a,i)=>{invariant(a.length===head.length,`CSV Zeile ${i+2}: Spaltenanzahl stimmt nicht.`);return Object.fromEntries(head.map((k,j)=>[k,a[j]]));});}
export function candleCSV(raw){return parseCSV(raw).map(validateCandle);}
export function safeCSV(rows,fields){const enc=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';return [fields.map(enc).join(','),...rows.map(r=>fields.map(k=>enc(r[k])).join(','))].join('\r\n');}
export function similarPlans(query,plans,executions){return plans.filter(p=>p.id!==query.id&&!p.retrospective&&p.instrument===query.instrument).map(p=>{let score=0;for(const k of ['side','playbookId','session','bias'])if(p[k]===query[k])score++;const r1=risk(p),r2=risk(query);if(Math.abs(r1.rr-r2.rr)<1)score++;return {id:p.id,score,side:p.side,session:p.session,rr:r1.rr,actual:executionSummary(p,executions.filter(e=>e.planId===p.id)),reason:p.reason};}).sort((a,b)=>b.score-a.score).slice(0,8);}
