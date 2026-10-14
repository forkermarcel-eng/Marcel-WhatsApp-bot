/** Synthetic fixtures ONLY for explicit localhost --demo. Never imported by production. */
import {DEFAULT_SETTINGS,DEFAULT_PLAYBOOK,validatePlan} from '../../Trading/domain.js';
import {sha} from '../server/api.js';
export async function seedDemo(repo){
 const now=Date.now(),stamp=new Date(now).toISOString(),start=Math.floor(now/60000)*60000-720*60000;
 const contracts={MGC:'MGCZ6',MNQ:'MNQZ6',MYM:'MYMZ6',MCL:'MCLX6'};
 await repo.transaction(async tx=>{
  await tx.put('settings',{...DEFAULT_SETTINGS,id:'main',contracts,createdAt:stamp});
  await tx.put('playbooks',{...DEFAULT_PLAYBOOK,createdAt:stamp});
  for(const [root,contract]of Object.entries(contracts)){
   const base={MGC:4370,MNQ:29500,MYM:51700,MCL:101}[root],scale={MGC:1,MNQ:6,MYM:8,MCL:.05}[root],tick={MGC:.1,MNQ:.25,MYM:1,MCL:.01}[root],bars=[];
   let previous=base; const round=x=>Math.round(x/tick)*tick;
   for(let i=0;i<720;i++){const trend=(i<310?i*.012:3.7+(i-310)*.042);const cl=round(base+(trend+3*Math.sin(i/31)+.6*Math.sin(i*1.7))*scale);bars.push({time:new Date(start+i*60000).toISOString(),open:previous,high:round(Math.max(previous,cl)+(.6+.4*Math.abs(Math.sin(i)))*scale),low:round(Math.min(previous,cl)-(.5+.3*Math.abs(Math.cos(i)))*scale),close:cl,volume:Math.floor(20+80*Math.abs(Math.sin(i/7)))});previous=cl;}
   await tx.storeCandles({contract,source:'DEMO-SYNTHETISCH',resolution:60,bars});
  }
  const ctx={id:'demo-context',instrument:'MGC',bias:'LONG',thesis:'DEMO: Alter Demand aus dem Vortag, anschließender Reclaim. Rücklauf abwarten – kein Market-Entry.',counterArgument:'DEMO: Unter dem Struktur-Tief wäre die Idee verworfen. Kein Rückschluss auf reale Kurse.',eventsChecked:false,createdAt:stamp,asOf:stamp};await tx.put('context',ctx);
  for(const [i,prices]of [[0,[4371,4374]],[1,[4394,4397]]])await tx.put('drawings',{id:'demo-zone-'+i,contract:contracts.MGC,type:'zone',side:i?'SHORT':'LONG',label:i?'DEMO · Supply':'DEMO · alter Demand',createdAt:new Date(now-12*3600000).toISOString(),points:[{time:new Date(start+180*60000).toISOString(),price:prices[0]},{time:new Date(start+719*60000).toISOString(),price:prices[1]}]});
  const p={...validatePlan({instrument:'MGC',contract:contracts.MGC,side:'LONG',quantity:5,entry:4388,stop:4382,target:4412,zoneLow:4386,zoneHigh:4389,knownAt:new Date(now-86400000).toISOString(),plannedAt:stamp,expiresAt:new Date(now+8*3600000).toISOString(),reason:'DEMO · Retest des Vortagesblocks, ausschließlich synthetisches Anschauungsbeispiel.',invalidation:'Unter dem alten Demand. Keine reale Handelsanweisung.',session:'Nacht / Asien',bias:'LONG',costPerContract:1.2,playbookId:DEFAULT_PLAYBOOK.id}),id:'demo-plan',createdAt:stamp};
  await tx.put('plans',p);const snapshot={id:'demo-snapshot',planId:p.id,plan:p,asOf:stamp,context:{briefing:ctx,news:[],events:[],observations:[],calendarStatus:'DEMO'},createdAt:stamp};snapshot.hash=sha(snapshot);await tx.put('snapshots',snapshot);
  const samples=[['DGS10','US 10Y',4.1,'%'],['DGS2','US 2Y',3.8,'%'],['DFII10','US 10Y real',1.6,'%'],['DXY','Dollarindex',100.2,'Index']];for(const[id,label,value,unit]of samples)await tx.put('observations',{id,label,value,unit,source:'DEMO · kein Livewert',frequency:'SYNTHETISCH',at:stamp,observedAt:stamp,createdAt:stamp});
  for(const[n,title]of ['Kalender vor der Nachtsession auf relevante Termine prüfen','Gold und US-Renditen getrennt vom Entry-Level beurteilen','Limit-Plan ist nicht gleich tatsächliche Ausführung'].entries())await tx.put('news',{id:'demo-news-'+n,title:'DEMO · '+title,url:'https://www.federalreserve.gov/',source:'Synthetische UI-Vorschau',topic:'Demo',publishedAt:stamp,observedAt:stamp,createdAt:stamp});
  await tx.put('events',{id:'demo-event',title:'DEMO · Mustertermin, kein echter Event',country:'Beispiel',at:new Date(now+90*60000).toISOString(),impact:'HIGH',source:'Synthetische Vorschau',observedAt:stamp,createdAt:stamp});
 });
}
