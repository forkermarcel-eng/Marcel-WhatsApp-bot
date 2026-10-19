import {rankEntries} from '../brain-knowledge/search.js';
import {execFileSync} from 'node:child_process';
const oldSource=execFileSync('git',['show','9721271:brain-knowledge/search.js'],{encoding:'utf8'}).replace("'./model.js'",JSON.stringify(new URL('../brain-knowledge/model.js',import.meta.url).href));
const baseline=await import('data:text/javascript;base64,'+Buffer.from(oldSource).toString('base64'));
const entries=Array.from({length:10000},(_,i)=>({id:String(i),text:`Synthetic knowledge entry ${i}. Local Brain architecture uses a local GPU computer and reviewed document knowledge.`,section:'Architecture',domains:['MASTER_BRAIN_ARCHITECTURE'],topics:[],project:'marcel',status:'active',reviewRequired:false}));
const options={question:'lokale Brain Architektur GPU',limit:6};
const run=fn=>{const times=[];let ids;for(let i=0;i<5;i++){const start=performance.now();ids=fn(entries,options).map(x=>x.entry.id);times.push(performance.now()-start);}return {coldMs:times[0],warmMedianMs:times.slice(1).sort((a,b)=>a-b)[2],ids};};
const before=run(baseline.rankEntries),after=run(rankEntries);if(JSON.stringify(before.ids)!==JSON.stringify(after.ids))throw Error('Ranking changed');
console.log(JSON.stringify({fixture:'10000 synthetic entries; no database or network',before,after,warmSpeedup:before.warmMedianMs/after.warmMedianMs},null,2));
