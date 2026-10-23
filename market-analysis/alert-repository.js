import {transaction,lockSource,fence,logJob,iso,identity} from './storage.js';
import {requireValue,utcMillis} from './instruments.js';
import {digest} from './news/events.js';
import {normalizeAlert,evaluateAlert,initialAlertState} from './alerts.js';
import {saveAPIResult} from './api-storage.js';

export function createAlertRepository({database,ownerId,clock=Date.now,allowFixtures=false}={}) {
  identity(ownerId);requireValue(database && typeof database.query==='function','Explicit database required.');
  async function begin(tx,job) {
    await lockSource(tx,'__job_control__');
    if(job){requireValue(job.source_id==='analysis-local:phase6','Invalid phase6 job source.');await lockSource(tx,job.source_id);await fence(tx,job,iso(clock),clock);}
  }
  async function finish(tx,job,signal,result) {
    if(signal?.aborted)throw Object.assign(new Error('ABORTED'),{code:'ABORTED'});
    if(!job)return;
    const now=iso(clock);await fence(tx,job,now,clock);
    await saveAPIResult(tx,job,result);
    await tx.query("UPDATE marcel_market_analysis.jobs SET status='succeeded',ended_at=$2,lease_token=NULL,lease_until=NULL,error_code=NULL WHERE id=$1",[job.id,now]);
    await tx.query("UPDATE marcel_market_analysis.sources SET last_success_at=$2,error_code=NULL,state=$3::jsonb WHERE id=$1",[job.source_id,now,JSON.stringify({mode:'local-analysis',storedAt:now})]);
    await logJob(tx,job,now,'succeeded');
  }
  async function get(tx,id) {
    const row=(await tx.query('SELECT * FROM marcel_market_analysis.alert_rules WHERE owner_id=$1 AND id=$2 FOR UPDATE',[ownerId,id])).rows[0];
    requireValue(row,'Alert not found in owner scope.');return row;
  }
  async function writeState(tx,id,state) {
    await tx.query('INSERT INTO marcel_market_analysis.alert_states(owner_id,rule_id,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(owner_id,rule_id) DO UPDATE SET body=excluded.body',[ownerId,id,JSON.stringify(state)]);
  }
  return Object.freeze({
    ownerId,
    async create(input) {
      const rule=normalizeAlert(input);
      return transaction(database,async tx=>{
        await begin(tx);
        const count=(await tx.query('SELECT count(*)::int AS n FROM marcel_market_analysis.alert_rules WHERE owner_id=$1',[ownerId])).rows[0].n;
        requireValue(count<500,'Owner alert quota exceeded.');
        const now=iso(clock);
        await tx.query('INSERT INTO marcel_market_analysis.alert_rules(owner_id,id,version,body,created_at,updated_at) VALUES($1,$2,1,$3::jsonb,$4,$4)',[ownerId,rule.id,JSON.stringify(rule),now]);
        await writeState(tx,rule.id,initialAlertState());return {...rule,version:1};
      });
    },
    async update(id,input,{expectedVersion}={}) {
      return transaction(database,async tx=>{
        await begin(tx);const old=await get(tx,id);requireValue(old.version===expectedVersion,'Alert version conflict.');
        const rule=normalizeAlert({...old.body,...input,id});
        const previous=(await tx.query('SELECT body FROM marcel_market_analysis.alert_states WHERE owner_id=$1 AND rule_id=$2',[ownerId,id])).rows[0]?.body ?? initialAlertState();
        await tx.query('UPDATE marcel_market_analysis.alert_rules SET body=$3::jsonb,version=version+1,updated_at=$4 WHERE owner_id=$1 AND id=$2',[ownerId,id,JSON.stringify(rule),iso(clock)]);
        await writeState(tx,id,{...previous,phase:'BASELINE_REQUIRED',previousMetric:null,resetAt:iso(clock)});
        return {...rule,version:old.version+1};
      });
    },
    async reset(id,{expectedVersion}={}) {
      return transaction(database,async tx=>{
        await begin(tx);const rule=await get(tx,id);requireValue(rule.version===expectedVersion,'Alert version conflict.');
        const state=(await tx.query('SELECT body FROM marcel_market_analysis.alert_states WHERE owner_id=$1 AND rule_id=$2',[ownerId,id])).rows[0].body;
        await writeState(tx,id,{...state,phase:'BASELINE_REQUIRED',previousMetric:null,resetAt:iso(clock)});
        return {status:'BASELINE_REQUIRED',lastDataAt:state.lastDataAt};
      });
    },
    async check(ruleIds,snapshot,{job=null,signal}={}) {
      requireValue(Array.isArray(ruleIds) && ruleIds.length>=1 && ruleIds.length<=25 && new Set(ruleIds).size===ruleIds.length,'Invalid alert batch.');
      return transaction(database,async tx=>{
        await begin(tx,job);const results=[];
        for(const id of ruleIds) {
          if(signal?.aborted)throw Object.assign(new Error('ABORTED'),{code:'ABORTED'});
          const stored=await get(tx,id),state=(await tx.query('SELECT body FROM marcel_market_analysis.alert_states WHERE owner_id=$1 AND rule_id=$2 FOR UPDATE',[ownerId,id])).rows[0].body;
          const prior=stored.body.type==='ECONOMIC_EVENT'?(await tx.query("SELECT body->>'occurrence' AS occurrence FROM marcel_market_analysis.alert_history WHERE owner_id=$1 AND rule_id=$2 ORDER BY sequence DESC LIMIT 20001",[ownerId,id])).rows:[];
          requireValue(prior.length<=20000,'Alert history quota exceeded.');
          const result=evaluateAlert(stored.body,state,snapshot,{now:iso(clock),allowFixtures,seenOccurrences:prior.map(r=>r.occurrence)});
          for(const trigger of result.triggers) {
            const at=iso(clock),history={...trigger,id:digest([ownerId,id,trigger.occurrence]),ruleId:id,ruleVersion:stored.version,configuration:stored.body,instrumentId:stored.body.instrumentId,
              status:'TRIGGERED',mode:snapshot.mode,triggeredAt:at,dataAt:snapshot.dataAt,priceBasis:snapshot.priceBasis ?? null,delayMs:snapshot.delayMs ?? null};
            await tx.query('INSERT INTO marcel_market_analysis.alert_history(owner_id,id,rule_id,triggered_at,data_at,body) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING',[ownerId,history.id,id,at,snapshot.dataAt,JSON.stringify(history)]);
          }
          await writeState(tx,id,result.state);results.push({ruleId:id,...result});
        }
        const count=(await tx.query('SELECT count(*)::int AS n FROM marcel_market_analysis.alert_history WHERE owner_id=$1',[ownerId])).rows[0].n;
        requireValue(count<=20000,'Owner history quota exceeded.');await finish(tx,job,signal,results);return results;
      });
    },
    async list({limit=100,afterId=null}={}) {
      requireValue(Number.isInteger(limit) && limit>0 && limit<=500,'Invalid list limit.');
      const rows=(await database.query('SELECT r.id,r.version,r.body,s.body AS state FROM marcel_market_analysis.alert_rules r JOIN marcel_market_analysis.alert_states s ON r.owner_id=s.owner_id AND r.id=s.rule_id WHERE r.owner_id=$1 AND ($3::uuid IS NULL OR r.id>$3) ORDER BY r.id LIMIT $2',[ownerId,limit+1,afterId])).rows;
      return {items:rows.slice(0,limit),nextCursor:rows.length>limit?rows[limit-1].id:null};
    },
    async history(id,{limit=100,before=null}={}) {
      requireValue(Number.isInteger(limit) && limit>0 && limit<=500,'Invalid history limit.');
      if(before!==null)requireValue(/^\d{1,18}$/.test(String(before)),'Invalid history cursor.');
      const rows=(await database.query('SELECT sequence,body FROM marcel_market_analysis.alert_history WHERE owner_id=$1 AND rule_id=$2 AND ($4::bigint IS NULL OR sequence<$4) ORDER BY sequence DESC LIMIT $3',[ownerId,id,limit+1,before])).rows;
      return {items:rows.slice(0,limit).map(r=>({...r.body,sequence:String(r.sequence)})),nextCursor:rows.length>limit?String(rows[limit-1].sequence):null};
    },
    async saveStudy(result,{job=null,signal}={}) {
      requireValue(result?.category==='HISTORICAL_EVENT_STUDY' && result.inputHash,'Invalid study result.');
      const raw=JSON.stringify(result);requireValue(Buffer.byteLength(raw)<=524288,'Study result storage limit exceeded.');
      return transaction(database,async tx=>{
        await begin(tx,job);const id=digest([ownerId,result.inputHash]);
        await tx.query('INSERT INTO marcel_market_analysis.event_studies(owner_id,id,created_at,body) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING',[ownerId,id,iso(clock),raw]);
        const n=(await tx.query('SELECT count(*)::int AS n FROM marcel_market_analysis.event_studies WHERE owner_id=$1',[ownerId])).rows[0].n;
        requireValue(n<=100,'Owner study quota exceeded.');await finish(tx,job,signal,{id,result});return {id,result};
      });
    },
    async getStudy(id) {return (await database.query('SELECT body FROM marcel_market_analysis.event_studies WHERE owner_id=$1 AND id=$2',[ownerId,id])).rows[0]?.body ?? null;},
  });
}
