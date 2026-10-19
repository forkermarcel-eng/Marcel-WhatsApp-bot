import {PgRepository} from '../trading-core/server/repository.js';
// Reuses stored Trading candles. No synchronization, provider request or trading action.
export async function readWorldMarkets(pool,{repository=new PgRepository(pool),now=Date.now()}={}){
 const series=await repository.series();
 const latest=new Map();for(const item of series){const key=item.contract;if(!latest.has(key)||item.last>latest.get(key).last)latest.set(key,item);}
 const items=await Promise.all([...latest.values()].slice(0,24).map(async item=>{
  const bars=await repository.candles(item.contract,{source:item.source,resolution:item.resolution,limit:120,to:new Date(now).toISOString()});
  const last=bars.at(-1),previous=bars.at(-2);if(!last)return null;
  return {contract:item.contract,source:item.source,value:last.close,at:last.time,resolution:item.resolution,change:previous?last.close-previous.close:null,basis:'Letzte zwei gespeicherte Kerzen',delayed:true,stale:now-Date.parse(last.time)>86400000,chart:bars.map(b=>({time:b.time,value:b.close}))};
 }));return {items:items.filter(Boolean),live:false,notice:'Gespeicherte Trading-Daten. Kein Livefeed; keine neuen Kursabfragen oder Orders.'};
}
