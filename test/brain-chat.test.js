import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {openLocalKnowledge} from '../brain-knowledge/repository.js';
import {createKnowledgeService} from '../brain-knowledge/service.js';
import {createBrainChat} from '../brain-chat/service.js';
import {createBrainRetrieval} from '../brain-chat/retrieval.js';
import {createBrainModel} from '../brain-chat/model.js';
import {registerBrainChatRoutes} from '../brain-chat/routes.js';
import express from 'express';
import {createHmac} from 'node:crypto';
import brainProxy from '../api/dashboard/marcel-brain.js';
async function fixture(fn){const repository=await openLocalKnowledge(':memory:');try{await fn(repository);}finally{repository.close();}}
const retrieve=async()=>({sources:[],warnings:[],publicText:false});
test('persisted conversations preserve follow-up context, isolate threads and retry idempotently',()=>fixture(async repository=>{
 let inputs=[];const generate=async function*(input){inputs.push(input);yield 'Eine natürliche ';yield 'Antwort.';};
 let api=createBrainChat({mode:'model',repository,retrieve,generate});const a=await api.create(),b=await api.create();const first=randomUUID();
 await api.send({conversationId:a.conversationId,text:'Beschreib meine Projekte.',requestId:first});
 await api.send({conversationId:a.conversationId,text:'Mach es frecher.',requestId:randomUUID()});assert.equal(inputs[1].messages.length,3);assert.equal(inputs[1].messages[1].content,'Eine natürliche Antwort.');
 await api.send({conversationId:a.conversationId,text:'Beschreib meine Projekte.',requestId:first});assert.equal(inputs.length,2);
 api=createBrainChat({mode:'model',repository,retrieve,generate});assert.equal((await api.get(a.conversationId)).turns.length,2);assert.equal((await api.get(b.conversationId)).turns.length,0);assert.equal((await api.list()).length,2);
}));
test('only explicit remember requests create pending review candidates; normal chat does not alter knowledge',()=>fixture(async repository=>{
 const api=createBrainChat({mode:'model',repository,retrieve,generate:async function*(){yield 'Verstanden.';}}),c=await api.create();
 await api.send({conversationId:c.conversationId,text:'Hallo Brain!',requestId:randomUUID()});assert.equal((await repository.list('entries')).length,0);
 await api.send({conversationId:c.conversationId,text:'Merk dir, dass ich meine Texte gern kurz und direkt formuliere.',requestId:randomUUID()});
 const pending=await createKnowledgeService(repository).pending();assert.equal(pending.length,1);assert.equal(pending[0].status,'pending');assert.equal(pending[0].reviewRequired,true);
}));
test('retrieval selects bounded relevant sources, rejects pending and requires owner consent for personal facts',()=>fixture(async repository=>{
 const service=createKnowledgeService(repository);await service.ingest([{id:'social',path:'/source',contentHash:'social',title:'Social DNA',project:'marcel',domain:'SOCIAL_MEDIA',status:'processed',blocks:[{text:'Instagram nutzt persönliche Geschichten und englische Reels mit kreativer Content Strategie.',locator:'p1'}]},{id:'private',path:'/private',contentHash:'private',title:'Privat',project:'marcel',domain:'PERSONAL_KNOWLEDGE',status:'processed',blocks:[{text:'Eine ungeprüfte private Familienangabe darf niemals in Antworten erscheinen.',locator:'p2'}]}]);
 const result=await createBrainRetrieval({repository})({text:'Welche Instagram Content Strategie nutzen wir?'});assert.ok(result.sources.length>0);assert.ok(result.sources.length<=12);assert.ok(result.sources.every(s=>!s.text.includes('Familienangabe')));assert.ok(result.sources[0].documents[0].locator);
}));
test('public follow-ups exclude previous private model context and failed turns remain retryable',()=>fixture(async repository=>{
 const inputs=[];let fail=false;const api=createBrainChat({mode:'model',repository,retrieve:async({allowPersonal})=>({sources:allowPersonal?[{personal:true,text:'private owner memory'}]:[],warnings:[]}),generate:async function*(input){inputs.push(input);if(fail)throw Error('provider failure');yield 'Antwort';}});const c=await api.create();
 await api.send({conversationId:c.conversationId,text:'Wie ist mein persönlicher Kontext?',requestId:randomUUID(),allowPersonal:true});
 await api.send({conversationId:c.conversationId,text:'Jetzt eine öffentliche Homepage.',requestId:randomUUID()});assert.equal(inputs[1].messages.length,1);assert.doesNotMatch(inputs[1].instructions,/private owner memory/);
 fail=true;const requestId=randomUUID();await assert.rejects(api.send({conversationId:c.conversationId,text:'Noch eine Antwort.',requestId}));fail=false;
 await api.send({conversationId:c.conversationId,text:'Noch eine Antwort.',requestId});assert.equal((await api.get(c.conversationId)).turns.length,3);
}));
test('model adapter streams real provider event shapes, disables remote response storage and rejects incomplete output',async()=>{
 let options;const model=createBrainModel({model:'configured-model',environment:{BRAIN_CHAT_PAID_API_ENABLED:'true'},client:{responses:{create:async o=>{options=o;return(async function*(){yield{type:'response.output_text.delta',delta:'Hallo'};yield{type:'response.completed'};})();}}}});
 let text='';for await(const d of model({instructions:'system',messages:[{role:'user',content:'Hallo'}]}))text+=d;assert.equal(text,'Hallo');assert.equal(options.store,false);assert.equal(options.stream,true);assert.equal(options.tools,undefined);
 await assert.rejects(async()=>{for await(const _ of createBrainModel({client:null,environment:{BRAIN_CHAT_PAID_API_ENABLED:'true'}})({})){}},/nicht konfiguriert/);
});
test('authenticated chat HTTP streams and persists; unauthenticated requests never invoke the model',()=>fixture(async repository=>{
 const app=express();app.use(express.json());let calls=0;registerBrainChatRoutes({app,repository,environment:{BRAIN_CHAT_ENABLED:'true',BRAIN_CHAT_MODE:'paid',BRAIN_CHAT_PAID_API_ENABLED:'true'},authorized:req=>req.headers.authorization==='Bearer fixture',generate:async function*(){calls++;yield 'Eine Antwort';}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/dashboard-api/marcel-brain/chat`,headers={Authorization:'Bearer fixture','Content-Type':'application/json'};
 try{assert.equal((await fetch(url)).status,401);assert.equal(calls,0);const c=(await(await fetch(url,{method:'POST',headers,body:JSON.stringify({op:'create'})})).json()).conversation;const response=await fetch(url,{method:'POST',headers,body:JSON.stringify({op:'send',conversationId:c.conversationId,text:'Hallo Brain',requestId:randomUUID()})});const body=await response.text();assert.match(body,/event: delta/);assert.match(body,/event: done/);assert.equal(calls,1);const reopened=await(await fetch(url+'?id='+c.conversationId,{headers})).json();assert.equal(reopened.conversation.turns[0].assistant,'Eine Antwort');}finally{await new Promise(r=>server.close(r));}
}));

test('existing authenticated Vercel function forwards chat streams without buffering as JSON',async()=>{
 const previous={fetch:globalThis.fetch,password:process.env.DASHBOARD_PASSWORD,url:process.env.RAILWAY_BACKEND_URL,secret:process.env.DASHBOARD_API_SECRET};
 process.env.DASHBOARD_PASSWORD='fixture-password';process.env.RAILWAY_BACKEND_URL='https://fixture.invalid';process.env.DASHBOARD_API_SECRET='fixture-secret';
 const calls=[];globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response('event: delta\ndata: {"text":"Hallo"}\n\nevent: done\ndata: {}\n\n',{headers:{'Content-Type':'text/event-stream'}});};
 const res={headers:{},output:'',setHeader(k,v){this.headers[k]=v;},status(s){this.statusCode=s;return this;},json(v){this.jsonBody=v;},write(b){this.output+=Buffer.from(b).toString();},end(){this.ended=true;}};
 try{
  await brainProxy({method:'POST',query:{resource:'chat'},headers:{},body:{}},res);assert.equal(res.statusCode,401);assert.equal(calls.length,0);
  const signature=createHmac('sha256','fixture-password').update('fixture-session').digest('hex');
  await brainProxy({method:'POST',query:{resource:'chat'},headers:{cookie:'marcel_dashboard_session=fixture-session.'+signature},body:{op:'send'}},res);
  assert.equal(calls[0].url,'https://fixture.invalid/dashboard-api/marcel-brain/chat');assert.match(res.output,/event: delta/);assert.match(res.headers['Content-Type'],/text\/event-stream/);assert.equal(res.ended,true);
 }finally{globalThis.fetch=previous.fetch;for(const[k,v]of [['DASHBOARD_PASSWORD',previous.password],['RAILWAY_BACKEND_URL',previous.url],['DASHBOARD_API_SECRET',previous.secret]]){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
