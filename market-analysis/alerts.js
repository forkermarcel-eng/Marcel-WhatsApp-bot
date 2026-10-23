import {randomUUID} from 'node:crypto';
import {requireValue,utcMillis} from './instruments.js';
import {assessQuote} from './quality.js';
import {digest} from './news/events.js';
import {EVENT_FAMILIES,eventFamily} from './event-types.js';
import {ms} from './storage.js';

const types=new Set(['LEVEL','ZONE_ENTER','BREAKOUT','SETUP','MARKET_STRUCTURE','VOLATILITY_CHANGE','ECONOMIC_EVENT']);
const scannerRules=new Set(['CLOSE_BREAKOUT','SMA_RECLAIM','RSI_EXTREME','RSI_REBOUND','COMPRESSION_AFTER_RUN','EMA_CROSS','CONFIRMED_SWING_CROSS']);
const finite=x=>typeof x==='number' && Number.isFinite(x) && Math.abs(x)<=1e15;
export function normalizeAlert(input) {
  requireValue(input && types.has(input.type) && typeof input.instrumentId==='string' && input.instrumentId.length>0 && input.instrumentId.length<=700,'Invalid alert identity/type.');
  const condition=structuredClone(input.condition ?? {});
  const rule={id:input.id ?? randomUUID(),instrumentId:input.instrumentId,type:input.type,
    label:typeof input.label==='string'?input.label.slice(0,200):input.type,condition,enabled:input.enabled!==false,
    maxAgeMs:input.maxAgeMs ?? 60000,cooldownMs:input.cooldownMs ?? 30000,hysteresis:input.hysteresis ?? 0,
    autoRearm:input.autoRearm!==false,triggerOnInitial:input.triggerOnInitial===true,priceBasis:input.priceBasis ?? null};
  requireValue(/^[a-f0-9-]{36}$/i.test(rule.id),'UUID required.');
  requireValue(Number.isInteger(rule.maxAgeMs) && rule.maxAgeMs>=1000 && rule.maxAgeMs<=86400000 && Number.isInteger(rule.cooldownMs) && rule.cooldownMs>=0 && rule.cooldownMs<=86400000 && finite(rule.hysteresis) && rule.hysteresis>=0,'Invalid alert limits.');
  if(rule.type!=='ECONOMIC_EVENT') requireValue(['mid','bid','ask','last','provider-quotes'].includes(rule.priceBasis),'Explicit price basis required.');
  if(rule.type==='LEVEL') requireValue(['above','below'].includes(condition.operator) && finite(condition.level),'Invalid level.');
  if(rule.type==='ZONE_ENTER') requireValue(finite(condition.min) && finite(condition.max) && condition.min<condition.max,'Invalid zone.');
  if(['BREAKOUT','SETUP','MARKET_STRUCTURE'].includes(rule.type)) {
    condition.rule=rule.type==='BREAKOUT'?'CLOSE_BREAKOUT':rule.type==='MARKET_STRUCTURE'?'CONFIRMED_SWING_CROSS':condition.rule;
    requireValue(scannerRules.has(condition.rule) && ['LONG','SHORT'].includes(condition.side),'Invalid setup condition.');
  }
  if(rule.type==='VOLATILITY_CHANGE') requireValue(['increase','decrease'].includes(condition.direction) && finite(condition.fraction) && condition.fraction>0 && condition.fraction<=10,'Invalid volatility condition.');
  if(rule.type==='ECONOMIC_EVENT') {
    requireValue(Array.isArray(condition.families) && condition.families.length>0 && condition.families.length<=EVENT_FAMILIES.length && condition.families.every(x=>EVENT_FAMILIES.includes(x)),'Invalid event families.');
    condition.leadMs ??= 900000;condition.maxLateMs ??= 60000;
    requireValue([condition.leadMs,condition.maxLateMs].every(x=>Number.isInteger(x) && x>=0 && x<=604800000),'Invalid event timing.');
  }
  requireValue(Buffer.byteLength(JSON.stringify(rule))<=16384,'Alert configuration too large.');
  return rule;
}
export const initialAlertState=()=>({phase:'BASELINE_REQUIRED',lastDataAt:null,lastTriggeredAt:null,previousMetric:null});
function quality(rule,snapshot,now,allowFixtures) {
  if(snapshot.instrument?.id!==rule.instrumentId || snapshot.instrument?.active!==true)return 'INSTRUMENT_MISMATCH';
  if(snapshot.sourceError)return 'SOURCE_ERROR';
  const fixture=snapshot.mode==='offline-fixture';
  if(fixture && !allowFixtures)return 'FIXTURE_NOT_ENABLED';
  if(!fixture && snapshot.mode!=='authorised-cache')return 'HISTORICAL_INPUT_NOT_CURRENT';
  if(!fixture) {
    const grant=snapshot.authorization;
    try {if(grant?.verified!==true || grant.instrumentId!==rule.instrumentId || grant.usage!=='internal-analysis' || !grant.reference?.trim() || utcMillis(grant.checkedAt)>now || utcMillis(grant.expiresAt)<=now)return 'AUTHORIZATION_NOT_CONFIRMED';}
    catch {return 'AUTHORIZATION_NOT_CONFIRMED';}
    if(snapshot.instrument.provenance?.authorizationExpiresAt && utcMillis(snapshot.instrument.provenance.authorizationExpiresAt)<=now)return 'ENTITLEMENT_EXPIRED';
  }
  let source,received;
  try {source=utcMillis(snapshot.dataAt);received=utcMillis(snapshot.receivedAt);}catch{return 'SOURCE_TIME_UNKNOWN';}
  if(source>received || received>now)return 'FUTURE_OR_INVALID_SOURCE_TIME';
  if(now-source>rule.maxAgeMs || now-received>rule.maxAgeMs)return 'STALE_DATA';
  if(rule.type==='ECONOMIC_EVENT')return null;
  if(snapshot.priceBasis!==rule.priceBasis)return 'PRICE_BASIS_MISMATCH';
  const knownBasis=snapshot.instrument.metadata?.priceBasis;
  if(knownBasis && knownBasis!==snapshot.priceBasis)return 'PRICE_BASIS_MISMATCH';
  if(!finite(snapshot.price) || snapshot.price<=0 && !(snapshot.priceDomain==='signed' && snapshot.instrument.group==='energy'))return 'PRICE_INVALID';
  const calendar=snapshot.calendar;
  try {
    if(!calendar?.reference || utcMillis(calendar.from)>now || utcMillis(calendar.to)<=now || !calendar.windows.some(w=>utcMillis(w.start)<=now && now<utcMillis(w.end)))return 'SESSION_NOT_OPEN_OR_UNKNOWN';
  }catch{return 'SESSION_NOT_OPEN_OR_UNKNOWN';}
  const quote=assessQuote({last:snapshot.price,sourceAt:snapshot.dataAt,receivedAt:new Date(now).toISOString(),maxAgeMs:rule.maxAgeMs,
    delayMs:snapshot.delayMs,marketStatus:'open'});
  if(!quote.usableForCurrentMonitoring)return quote.reasons[0];
  return null;
}

// Comparisons/re-arm adapted from audited trader-alerts:evaluate (NOTICE).
// Never mutates inputs; suppression does not consume a quote or clear a latch.
export function evaluateAlert(ruleInput,stateInput,snapshot,{now,allowFixtures=false,seenOccurrences=[]}={}) {
  const rule=normalizeAlert(ruleInput),state=structuredClone(stateInput ?? initialAlertState()),at=utcMillis(now);
  const suppress=reason=>({state:{...state,lastEvaluationAt:state.lastEvaluationAt && utcMillis(state.lastEvaluationAt)>at?state.lastEvaluationAt:now,lastSuppression:reason},status:'SUPPRESSED',reason,triggers:[]});
  if(state.lastEvaluationAt && utcMillis(state.lastEvaluationAt)>at)return suppress('CLOCK_REGRESSION');
  if(!rule.enabled)return {state:{...state,phase:'DISABLED',lastEvaluationAt:now},status:'DISABLED',triggers:[]};
  const problem=quality(rule,snapshot,at,allowFixtures);if(problem)return suppress(problem);
  const cooling=state.lastTriggeredAt && at-utcMillis(state.lastTriggeredAt)<rule.cooldownMs;
  if(rule.type==='ECONOMIC_EVENT') {
    requireValue(Array.isArray(snapshot.events) && snapshot.events.length<=250,'Event check limit exceeded.');
    if(cooling)return {state:{...state,lastEvaluationAt:now},status:'COOLDOWN',triggers:[]};
    const latest=new Map();
    for(const row of snapshot.events) {
      const e=row.body;let known;
      try {known=Math.max(ms(row.stored_at),ms(e.fetchedAt),ms(e.processedAt));}catch{continue;}
      if(known>at)continue;
      const old=latest.get(e.eventId);
      if(!old || ms(row.stored_at)>ms(old.stored_at) || ms(row.stored_at)===ms(old.stored_at) && Number(row.sequence ?? 0)>Number(old.sequence ?? 0))latest.set(e.eventId,row);
    }
    const triggers=[];
    for(const row of latest.values()) {
      const e=row.body,family=eventFamily(e);
      if(e.status==='CANCELLED' || !rule.condition.families.includes(family) || e.scheduled?.precision!=='INSTANT' || !e.affectedMarkets?.some(m=>m.instrumentId===rule.instrumentId))continue;
      if(snapshot.mode!=='offline-fixture' && e.mode==='offline-fixture')continue;
      const scheduled=utcMillis(e.scheduled.at),key=digest([e.eventId,e.scheduled.at]);
      if(at<scheduled-rule.condition.leadMs || at>scheduled+rule.condition.maxLateMs || seenOccurrences.includes(key))continue;
      triggers.push({occurrence:key,reason:'ECONOMIC_EVENT_DUE',eventId:e.eventId,versionId:e.versionId,family,scheduledAt:e.scheduled.at,knownAt:new Date(ms(row.stored_at)).toISOString()});
    }
    requireValue(triggers.length<=20,'Due event capacity exceeded.');
    return {state:{...state,phase:triggers.length?'LATCHED':'ARMED',lastEvaluationAt:now,lastDataAt:snapshot.dataAt,
      lastTriggeredAt:triggers.length?now:state.lastTriggeredAt,lastSuppression:null},status:triggers.length?'TRIGGERED':'ARMED',triggers};
  }
  if(state.lastDataAt && utcMillis(snapshot.dataAt)<=utcMillis(state.lastDataAt))return suppress('DUPLICATE_OR_OUT_OF_ORDER');
  let hit=false,neutral=false,metric=null,evidence;
  const c=rule.condition,p=snapshot.price;
  if(rule.type==='LEVEL') {hit=c.operator==='above'?p>=c.level:p<=c.level;neutral=c.operator==='above'?p<c.level-rule.hysteresis:p>c.level+rule.hysteresis;evidence={price:p,level:c.level,operator:c.operator};}
  if(rule.type==='ZONE_ENTER') {hit=p>=c.min && p<=c.max;neutral=p<c.min-rule.hysteresis || p>c.max+rule.hysteresis;evidence={price:p,min:c.min,max:c.max};}
  if(['BREAKOUT','SETUP','MARKET_STRUCTURE','VOLATILITY_CHANGE'].includes(rule.type)) {
    const scan=snapshot.scanner;
    if(scan?.schemaVersion!=='phase4.v1' || scan.instrumentId!==rule.instrumentId || scan.scan?.status!=='READY' || scan.asOf!==snapshot.dataAt || scan.quality?.missingBars>0)return suppress('SCANNER_DATA_NOT_CURRENT_OR_COMPLETE');
    if(['SESSION_GAPS','NO_CLOSED_BARS','ENTITLEMENT_EXPIRED'].some(x=>scan.quality?.reasons?.includes(x)))return suppress('SCANNER_DATA_NOT_CURRENT_OR_COMPLETE');
    if(c.side==='SHORT' && snapshot.instrument.metadata?.shortAllowed!==true)return suppress('SHORT_PERMISSION_UNKNOWN_OR_FALSE');
    if(rule.type==='VOLATILITY_CHANGE') {
      metric=scan.scan.indicators?.atrSma;if(!finite(metric) || metric<0)return suppress('VOLATILITY_MISSING');
      if(state.previousMetric!==null && state.previousMetric>0) {
        const change=(metric-state.previousMetric)/state.previousMetric;
        hit=c.direction==='increase'?change>=c.fraction:change<=-c.fraction;neutral=!hit;evidence={previous:state.previousMetric,current:metric,fraction:change};
      }else {neutral=true;evidence={current:metric,baselineOnly:true};}
    } else {
      evidence=scan.scan.observations.find(o=>o.rule===c.rule && o.side===c.side && o.knownAt===snapshot.dataAt);
      hit=!!evidence;neutral=!hit;
    }
  }
  const freshState={...state,lastDataAt:snapshot.dataAt,lastEvaluationAt:now,lastSuppression:null,previousMetric:metric ?? state.previousMetric};
  if(state.phase==='BASELINE_REQUIRED' || state.phase==='DISABLED') {
    if(!(rule.triggerOnInitial && !state.lastDataAt && hit))return {state:{...freshState,phase:hit?'LATCHED':'ARMED'},status:'BASELINED',triggers:[]};
  }
  const armed=state.phase==='ARMED' || state.phase==='BASELINE_REQUIRED' && rule.triggerOnInitial && !state.lastDataAt;
  if(hit && armed && !cooling)return {state:{...freshState,phase:'LATCHED',lastTriggeredAt:now},status:'TRIGGERED',
    triggers:[{occurrence:digest([snapshot.dataAt,rule.type,evidence]),reason:rule.type,evidence}]};
  const nextPhase=hit && cooling?'LATCHED':neutral && rule.autoRearm && !cooling?'ARMED':state.phase==='BASELINE_REQUIRED'?'LATCHED':state.phase;
  return {state:{...freshState,phase:nextPhase},status:cooling?'COOLDOWN':nextPhase,triggers:[]};
}
