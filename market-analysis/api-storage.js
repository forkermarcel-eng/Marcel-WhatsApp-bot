import {identity,lockSource} from './storage.js';
import {requireValue} from './instruments.js';

export function validateEnvelope(api) {
  if(api===null)return;
  identity(api.owner);requireValue(api.v===1&&['scanner','phase6'].includes(api.kind)&&typeof api.operation==='string'&&api.payload,'Invalid API envelope.');
  requireValue(Buffer.byteLength(JSON.stringify(api))<=8000000,'API input storage limit.');
}
// Called inside the existing fenced completion transaction, never afterwards.
export async function saveAPIResult(tx,job,result) {
  if(!job.api)return;
  let output=result;
  if(Array.isArray(output)&&job.api.presentation)output=output.map(row=>row.result?{...row,result:{...row.result,apiContext:job.api.presentation}}:row);
  const raw=JSON.stringify(output);requireValue(Buffer.byteLength(raw)<=4000000,'API output storage limit.');
  const total=(await tx.query("SELECT COALESCE(sum(octet_length(api::text)),0)::bigint AS bytes FROM marcel_market_analysis.jobs WHERE api IS NOT NULL")).rows[0];
  requireValue(Number(total.bytes)+Buffer.byteLength(raw)<=32000000,'API result capacity exceeded.');
  await tx.query("UPDATE marcel_market_analysis.jobs SET api=jsonb_set(api,'{result}',$2::jsonb) WHERE id=$1",[job.id,raw]);
  const stored=(await tx.query("SELECT COALESCE(sum(octet_length(api::text)),0)::bigint AS bytes FROM marcel_market_analysis.jobs WHERE api IS NOT NULL")).rows[0];
  requireValue(Number(stored.bytes)<=32000000,'API result capacity exceeded.');
}
// Shared request budget in existing source state; no additional table or queue.
export async function consumeBudget(database,owner,write,clock) {
  const {transaction}=await import('./storage.js');
  return transaction(database,async tx=>{
    const id='analysis-api-budget';await lockSource(tx,id);
    const row=(await tx.query('SELECT state FROM marcel_market_analysis.sources WHERE id=$1',[id])).rows[0];
    const at=Math.floor(clock()/60000),old=row.state?.apiBudget,state=old?.at===at?old:{at,reads:0,writes:0};
    const key=write?'writes':'reads',max=write?20:60;if(state[key]>=max)return false;state[key]++;
    await tx.query('UPDATE marcel_market_analysis.sources SET state=$2::jsonb WHERE id=$1',[id,JSON.stringify({apiBudget:state})]);return true;
  });
}
