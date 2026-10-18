import {COLLECTIONS} from './repository.js';
import {hash} from './model.js';
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export function validateTransfer(payload){
 if(payload?.schema!=='marcel.knowledge/1'||!payload.collections)throw Error('Ungültiges Brain-Exportformat.');
 for(const name of COLLECTIONS){if(!Array.isArray(payload.collections[name]))throw Error('Collection fehlt: '+name);const seen=new Set();for(const row of payload.collections[name]){if(typeof row.id!=='string'||!row.id||seen.has(row.id))throw Error('Ungültige/doppelte ID in '+name);seen.add(row.id);}}
 return Object.fromEntries(COLLECTIONS.map(n=>[n,payload.collections[n].length]));
}
export async function planTransfer(repository,payload){
 const counts=validateTransfer(payload),plan={counts,created:0,known:0,conflicts:[]};
 for(const name of COLLECTIONS){const existing=new Map((await repository.list(name)).map(row=>[row.id,row]));for(const row of payload.collections[name]){const old=existing.get(row.id);if(!old)plan.created++;else if(hash(canonical(old))===hash(canonical(row)))plan.known++;else plan.conflicts.push({collection:name,id:row.id});}}
 return plan;
}
// No DDL, no deletion, no overwrite, one transaction. A conflict aborts all.
export async function mergeTransfer(repository,payload){
 validateTransfer(payload);
 return repository.transaction(async tx=>{
  const plan=await planTransfer(tx,payload);if(plan.conflicts.length)throw Error('Ziel enthält abweichende IDs. Kein bestehender Datensatz wird überschrieben.');
  for(const name of COLLECTIONS){const known=new Set((await tx.list(name)).map(r=>r.id));for(const row of payload.collections[name])if(!known.has(row.id))await tx.put(name,row);}
  return plan;
 });
}
