// Additional explicitly synthetic interactive fixtures. No network or provider data.
// Uses the same repository, normalizers, runtime and 80-bar fixture protocol as phase7Fixture.
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {normalizeInstrument} from './instruments.js';
import {normalizeEvent} from './news/events.js';
import {createAnalysisRepository} from './repository.js';
import {createMarketAnalysisRuntime} from './api-runtime.js';
const rows=[
 ['EUR/USD','Euro / US-Dollar','forex','EUR','USD',1.08,.0001],
 ['GBP/USD','Pfund / US-Dollar','forex','GBP','USD',1.26,.0001],
 ['USD/JPY','US-Dollar / Yen','forex','USD','JPY',150,.01],
 ['GBP/JPY','Pfund / Yen','forex','GBP','JPY',190,.01],
 ['EUR/JPY','Euro / Yen','forex','EUR','JPY',162,.01],
 ['XAU/USD','Gold','metals','XAU','USD',2300,.25],
 ['XAG/USD','Silber','metals','XAG','USD',28,.01],
 ['DAX','DAX','indices',null,'EUR',18000,1],
 ['NASDAQ 100','NASDAQ 100','indices',null,'USD',19000,1],
 ['S&P 500','S&P 500','indices',null,'USD',5200,.25],
 ['BRENT','Brent-Öl','energy',null,'USD',80,.01]
];
export async function interactiveFixture({pythonPath,database:injectedDatabase}={}){
 const database=injectedDatabase ?? new PGlite();if(injectedDatabase){const tables=(await database.query("SELECT tablename FROM pg_tables WHERE schemaname='marcel_market_analysis' ORDER BY tablename")).rows.map(x=>x.tablename);if(JSON.stringify(tables)!==JSON.stringify(['alert_history','alert_rules','alert_states','event_studies','job_log','jobs','news_seen','records','sources']))throw Error('Prepared analysis schema required; no automatic migration');}else for(const name of ['20261022_brain_market_analysis.sql','20261022_brain_market_analysis_phase6.sql'])await database.exec(fs.readFileSync('migrations/'+name,'utf8'));
 const start=Date.parse('2026-10-22T00:00:00Z'),iso=n=>new Date(n).toISOString();let at=start;const clock=()=>at,sourceId='fixture-bars';
 const rounded=n=>Number(n.toFixed(8));
 const instruments=rows.map(([symbol,name,group,base,quote,,tick])=>normalizeInstrument({provider:'offline-fixture',environment:'test',symbol,name:name+' · OFFLINE-TESTDATEN',kind:'cfd',group,base,quote,active:true,metadata:{tickSize:tick,priceBasis:'mid',shortAllowed:true,quantityStep:1,unitsPerLot:1},provenance:{mode:'offline-fixture',description:'Synthetischer Rechentest; kein echter Kurs und keine Broker-Kontraktspezifikation'}}));
 const repository=createAnalysisRepository({database,clock});
 await repository.commitBatch({sourceId,fetchedAt:iso(at),processedAt:iso(at),mode:'offline-fixture',instruments});
 for(let i=0;i<80;i++){
  at=start+(i+1)*60000;const time=iso(start+i*60000);
  const histories=instruments.map((instrument,n)=>{const row=rows[n],close=rounded(row[5]+i*row[6]);return{instrumentId:instrument.id,bars:[{time,open:close,high:rounded(close+2*row[6]),low:rounded(close-2*row[6]),close}],from:time,to:iso(at),observedAt:iso(at),intervalMs:60000,delayMs:0,maxAgeMs:60000,provenance:{mode:'offline-fixture',description:'Deterministische synthetische Testreihe; keine historischen Marktkurse'}};});
  for(let offset=0;offset<histories.length;offset+=10)await repository.commitBatch({sourceId,fetchedAt:iso(at),processedAt:iso(at),mode:'offline-fixture',histories:histories.slice(offset,offset+10)});
 }
 const calendar={from:iso(start),to:iso(start+4*3600000),reference:'OFFLINE-FIXTURE synthetic session, not exchange hours',windows:[{id:'fixture',start:iso(start),end:iso(start+80*60000)}]};
 at=start+60*60000;
 const event=normalizeEvent({kind:'macro',title:'US CPI · OFFLINE-FIXTURE',externalId:'fixture-cpi',seriesId:'CPI',period:'2026-09',publishedAt:iso(at),country:'US',currency:'USD',actual:3.2,unit:'percent'},{source:{id:'fixture-macro',name:'OFFLINE-FIXTURE',country:'US',url:'https://example.invalid/cpi'},fetchedAt:iso(at),processedAt:iso(at),instruments,mode:'offline-fixture'});
 await repository.commitBatch({sourceId:'fixture-macro',fetchedAt:iso(at),processedAt:iso(at),mode:'offline-fixture',events:[event]});at=start+80*60000;
 const specifications=new Map(instruments.map((instrument,n)=>[instrument.id,{contract:{instrumentId:instrument.id,kind:'cfd',broker:'OFFLINE-FIXTURE',reference:'Synthetische Einheit 1, kein Brokerangebot',asOf:iso(start),validUntil:iso(start+86400000),quoteCurrency:instrument.quote,unitsPerQuantity:'1',tickSize:String(rows[n][6]),quantityStep:'1',minQuantity:'1',priceBasis:'mid'},costs:{currency:instrument.quote,reference:'OFFLINE-FIXTURE synthetic zero-cost assumption',asOf:iso(start),validUntil:iso(start+86400000),spreadPrice:'0',entrySlippagePrice:'0',exitSlippagePrice:'0',commissionPerQuantityRoundTrip:'0',commissionFlatRoundTrip:'0',fundingPerQuantityPerDay:{LONG:'0',SHORT:'0'}}}]));
 if(injectedDatabase){const resume=(await database.query("SELECT max(next_allowed_at) AS at FROM marcel_market_analysis.sources WHERE id LIKE 'analysis-local:p7_%'")).rows[0].at;if(resume)at=Math.max(at,Date.parse(resume));}
 const runtime=createMarketAnalysisRuntime({database,clock,pythonPath,allowFixtures:true,calendars:new Map(instruments.map(i=>[i.id,calendar])),specifications});
 return{database,repository,runtime,clock,advance:()=>{at+=60000;},close:()=>injectedDatabase?Promise.resolve():database.close(),instruments};
}
