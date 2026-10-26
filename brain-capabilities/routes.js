import {searchCapabilities,getCapability,loadCapability,planTask,capabilitySummary,fail} from './registry.js';
import {createCapabilityState} from './state.js';import {TOOL_SPECS} from './tools.js';import {createPgKnowledgeRepository} from '../brain-knowledge/repository.js';import {createKnowledgeService} from '../brain-knowledge/service.js';import {createHash} from 'node:crypto';
export function registerCapabilityRoutes({app,authorized,pool,repository,environment=process.env}){
 let state;const store=()=>state||(state=createCapabilityState(repository||createPgKnowledgeRepository(pool)));
 let windowAt=Date.now(),count=0,remoteActive=0;
 app.all('/dashboard-api/marcel-brain/capabilities',async(req,res)=>{
  res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
  if(!authorized(req))return res.status(401).json({ok:false,error:'Nicht autorisiert.'});
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'Explizite Capability-Anfrage erforderlich.'});
  try{
   if(Date.now()-windowAt>60000){windowAt=Date.now();count=0;}if(++count>90)throw fail('Anfragelimit erreicht.',429);
   if(Buffer.byteLength(JSON.stringify(req.body||{}))>300000)throw fail('Anfrage zu groß.',413);
   const input=req.body||{};let data;
   if(input.op==='catalog')data={...searchCapabilities(input.filters),summary:capabilitySummary()};
   else if(input.op==='get')data={item:getCapability(input.id)};
   else if(input.op==='load'){
    if(remoteActive>=2)throw fail('Zu viele gleichzeitige Quellabrufe.',429);remoteActive++;try{data=await loadCapability(input.id,{audience:'user'});}finally{remoteActive--;}
   }else if(input.op==='plan')data={plan:planTask(input.text)};
   else if(input.op==='tools')data={tools:TOOL_SPECS,notice:'Nur lokale Adapter. Keine Ausführung über diesen Produktionsendpunkt.'};
   else if(input.op==='workflow-create')data={workflow:await store().createWorkflow(input.text)};
   else if(input.op==='workflow-get')data={workflow:await store().getWorkflow(input.id)};
   else if(input.op==='workflow-update')data={workflow:await store().updateWorkflow(input)};
   else if(input.op==='candidate-propose')data={candidate:await store().proposeCandidate(input)};
   else if(input.op==='candidate-list')data={candidates:await store().listCandidates()};
   else if(input.op==='candidate-review')data={candidate:await store().reviewCandidate(input)};
   else if(input.op==='candidate-load')data=await store().loadCandidate(input.id);
   else if(input.op==='preference-proposal'){
    if(environment.BRAIN_KNOWLEDGE_WRITES!=='true')throw fail('Vorhandene Wissens-Schreibfreigabe ist nicht aktiv.',403);
    if(input.confirm!==true||typeof input.text!=='string'||input.text.length<20||input.text.length>3000)throw fail('Explizite Präferenz und Bestätigung erforderlich.');
    const id=createHash('sha256').update(JSON.stringify([input.project,input.text])).digest('hex');
    const source={id,path:'brain-capability-preference://'+id,contentHash:id,title:'Expliziter Projekt-/Designpräferenzvorschlag',project:['marcel','luxe','barber','trading'].includes(input.project)?input.project:'marcel',domains:['MARCEL_DNA'],kind:'communication_rule',knowledgeLayer:'MARCEL_MEMORY',status:'processed',reviewAll:true,authority:'explicit_owner_capability_preference',blocks:[{text:input.text,locator:'preference:'+id}]};
    data={reviewRequired:true,result:await createKnowledgeService(repository||createPgKnowledgeRepository(pool)).ingest([source])};
   }else throw fail('Unbekannte Capability-Aktion. Installieren, Ausführen und Veröffentlichen sind hier nicht freigegeben.',403);
   res.json({ok:true,...data});
  }catch(e){res.status(e.status||503).json({ok:false,error:e.status?e.message:'Capability-Bibliothek derzeit nicht verfügbar.'});}
 });
}
export function selectCapabilityPlan({text,context,literal,proposal}){
 if(literal||proposal||context?.sources?.length||context?.answer!==undefined||/\b(?:trading|marktanalyse|wetter|kalender|e-mail|dhl|nachrichten)\b/i.test(text))return null;
 if(!/entwick|erstell|entwirf|gestalt|programmi|implement|build|create|design|desarroll|diseñ|criar|desenvolv|video.*(?:schneid|export)|ffmpeg/i.test(text))return null;
 try{return planTask(text);}catch{return null;}
}
