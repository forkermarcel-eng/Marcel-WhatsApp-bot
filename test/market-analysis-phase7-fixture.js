import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {normalizeInstrument} from '../market-analysis/instruments.js';
import {normalizeEvent} from '../market-analysis/news/events.js';
import {createAnalysisRepository} from '../market-analysis/repository.js';
import {createMarketAnalysisRuntime} from '../market-analysis/api-runtime.js';
export async function phase7Fixture({pythonPath,database:injectedDatabase}={}){
 const database=injectedDatabase ?? new PGlite();for(const name of ['20261022_brain_market_analysis.sql','20261022_brain_market_analysis_phase6.sql'])await database.exec(fs.readFileSync('migrations/'+name,'utf8'));
 const start=Date.parse('2026-10-22T00:00:00Z'),iso=n=>new Date(n).toISOString();let at=start,clock=()=>at;
 const instrument=normalizeInstrument({provider:'offline-fixture',environment:'test',symbol:'INDEX-FIXTURE',name:'Synthetischer Index · OFFLINE-FIXTURE',kind:'cfd',group:'indices',active:true,quote:'USD',metadata:{tickSize:.25,priceBasis:'mid',shortAllowed:true},provenance:{mode:'offline-fixture'}});
 const sourceId='fixture-bars',calendar={from:iso(start),to:iso(start+4*3600000),reference:'OFFLINE-FIXTURE synthetic session, not exchange data',windows:[{id:'fixture',start:iso(start),end:iso(start+80*60000)}]};
 const repository=createAnalysisRepository({database,clock});
 await repository.commitBatch({sourceId,fetchedAt:iso(at),processedAt:iso(at),mode:'offline-fixture',instruments:[instrument]});
 for(let i=0;i<80;i++){at=start+(i+1)*60000;const time=iso(start+i*60000),close=100+i*.25;await repository.commitBatch({sourceId,fetchedAt:iso(at),processedAt:iso(at),mode:'offline-fixture',histories:[{instrumentId:instrument.id,bars:[{time,open:close,high:close+.5,low:close-.5,close}],from:time,to:iso(at),observedAt:iso(at),intervalMs:60000,delayMs:0,maxAgeMs:60000,provenance:{mode:'offline-fixture'}}]});}
 at=start+60*60000;
 const event=normalizeEvent({kind:'macro',title:'US CPI · OFFLINE-FIXTURE',externalId:'fixture-cpi',seriesId:'CPI',period:'2026-09',publishedAt:iso(at),country:'US',currency:'USD',actual:3.2,unit:'percent'}, {source:{id:'fixture-macro',name:'OFFLINE-FIXTURE',country:'US',url:'https://example.invalid/cpi'},fetchedAt:iso(at),processedAt:iso(at),instruments:[instrument],mode:'offline-fixture'});
 await repository.commitBatch({sourceId:'fixture-macro',fetchedAt:iso(at),processedAt:iso(at),mode:'offline-fixture',events:[event]});at=start+80*60000;
 const contract={instrumentId:instrument.id,kind:'cfd',broker:'OFFLINE-FIXTURE',reference:'synthetic test specification, NOT a broker offering',asOf:iso(start),validUntil:iso(start+86400000),quoteCurrency:'USD',unitsPerQuantity:'1',tickSize:'.25',quantityStep:'1',minQuantity:'1',priceBasis:'mid'};
 const costs={currency:'USD',reference:'OFFLINE-FIXTURE synthetic zero-cost assumption',asOf:iso(start),validUntil:iso(start+86400000),spreadPrice:'0',entrySlippagePrice:'0',exitSlippagePrice:'0',commissionPerQuantityRoundTrip:'0',commissionFlatRoundTrip:'0',fundingPerQuantityPerDay:{LONG:'0',SHORT:'0'}};
 const runtime=createMarketAnalysisRuntime({database,clock,pythonPath,allowFixtures:true,calendars:new Map([[instrument.id,calendar]]),specifications:new Map([[instrument.id,{contract,costs}]])});
 return {database,repository,runtime,clock,contract,costs,advance:()=>{at+=60000;},instrument,event,sourceId,calendar,base:{sourceId,instrumentId:instrument.id,from:iso(start),to:iso(start+80*60000),intervalMs:60000,side:'LONG',entry:'120',stop:'118',target:'124',quantity:'2',accountCurrency:'USD',equity:'10000',holdingDays:'0'},close:()=>injectedDatabase?Promise.resolve():database.close()};
}
