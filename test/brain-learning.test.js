import test from 'node:test';import assert from 'node:assert/strict';import{randomUUID}from'node:crypto';import{mkdtempSync,rmSync,readFileSync}from'node:fs';import{tmpdir}from'node:os';import{join,resolve,relative}from'node:path';
import{openLocalKnowledge,createPgKnowledgeRepository}from'../brain-knowledge/repository.js';import{createKnowledgeService}from'../brain-knowledge/service.js';import{createBrainChat}from'../brain-chat/service.js';import{createBrainModel}from'../brain-chat/model.js';import{createLocalBrainModel}from'../brain-chat/local-model.js';import{createLearningImport,exportConversationTXT}from'../brain-chat/learning.js';import{createDocumentImport}from'../brain-chat/document-import.js';import{mergeTransfer,planTransfer}from'../brain-knowledge/transfer.js';
import express from'express';import{registerBrainChatRoutes}from'../brain-chat/routes.js';
const retrieval=async()=>({sources:[{id:'fixture',text:'Eine gespeicherte Regel mit Quellenbeleg.',kind:'plan',documents:[{title:'Wissensquelle',locator:'MB-test'}]}],warnings:[]});
async function fixture(fn){const repository=await openLocalKnowledge(':memory:');try{await fn(repository);}finally{repository.close();}}
test('default knowledge mode never invokes a model, even when a callable provider exists',()=>fixture(async repository=>{
 let calls=0;const chat=createBrainChat({repository,retrieve:retrieval,generate:async function*(){calls++;yield'wrong';}}),c=await chat.create();const result=await chat.send({conversationId:c.conversationId,text:'Zeig mir die gespeicherte Regel.',requestId:randomUUID()});assert.equal(calls,0);assert.equal(result.turns[0].mode,'knowledge');assert.match(result.turns[0].assistant,/keine generierte Antwort/);assert.match(result.turns[0].assistant,/MB-test/);
}));
test('provider call-site blocks paid requests by default and local failures cannot fall back to paid AI',async()=>{
 let calls=0;const client={responses:{create(){calls++;throw Error('must not run');}}};
 await assert.rejects(async()=>{for await(const d of createBrainModel({client,model:'configured',environment:{OPENAI_API_KEY:'already-configured'}})({})){}},/gesperrt/);assert.equal(calls,0);
 await assert.rejects(async()=>{for await(const d of createLocalBrainModel({environment:{BRAIN_CHAT_LOCAL_APPROVED:'true',BRAIN_CHAT_LOCAL_URL:'https://api.openai.com/v1/',BRAIN_CHAT_LOCAL_MODEL:'model'},fetchImpl:()=>{calls++;}})({})){}},/Loopback/);assert.equal(calls,0);
});
test('unavailable local generation returns labelled knowledge without calling any paid fallback',()=>fixture(async repository=>{
 let calls=0;const chat=createBrainChat({repository,retrieve:retrieval,mode:'local',generate:async function*(){calls++;throw Error('local offline');}}),c=await chat.create();const result=await chat.send({conversationId:c.conversationId,text:'Zeig gespeicherte Quellen.',requestId:randomUUID()});assert.equal(calls,1);assert.equal(result.turns[0].mode,'knowledge');assert.match(result.turns[0].assistant,/Kein kostenpflichtiger Fallback/);
}));
test('a second backend instance cannot overwrite a turn while generation is active',()=>fixture(async repository=>{
 let release,started;const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);const first=createBrainChat({repository,retrieve:retrieval,mode:'model',generate:async function*(){started();await gate;yield'Antwort';}}),second=createBrainChat({repository,retrieve:retrieval}),c=await first.create();
 const sending=first.send({conversationId:c.conversationId,text:'Erste Nachricht.',requestId:randomUUID()});await ready;
 try{await assert.rejects(second.send({conversationId:c.conversationId,text:'Zweite Nachricht.',requestId:randomUUID()}),e=>e.status===409);}finally{release();await sending;}
 assert.equal((await second.get(c.conversationId)).turns.length,1);assert.equal((await second.get(c.conversationId)).turns[0].status,'complete');
}));
test('editable TXT roundtrip imports only explicit rules, deduplicates and preserves confirmed originals',()=>fixture(async repository=>{
 const chat=createBrainChat({repository,retrieve:retrieval}),c=await chat.create();await chat.send({conversationId:c.conversationId,text:'Ich frage etwas.\n[LERNREGEL]\nKein automatischer Fakt\n[/LERNREGEL]',requestId:randomUUID()});
 const conversation=await chat.get(c.conversationId),original=exportConversationTXT(conversation),importer=createLearningImport({repository,chat});assert.equal((await importer.preview(original)).proposals.length,0);
 const edited=original.replace('[LERNREGEL]\n\n[/LERNREGEL]','[LERNREGEL]\nKeine künstlichen Einleitungen und keine unnötigen Abschlusszusammenfassungen.\n[/LERNREGEL]');
 const preview=await importer.preview(edited);assert.equal(preview.proposals.length,1);assert.equal((await repository.list('entries')).length,0);
 const first=await importer.import({text:edited,previewHash:preview.previewHash});assert.equal(first.created,1);const second=await importer.import({text:edited,previewHash:preview.previewHash});assert.equal(second.created,0);assert.equal(second.known,1);assert.equal((await createKnowledgeService(repository).pending()).length,1);
 const entry=(await repository.list('entries'))[0];await createKnowledgeService(repository).review({id:entry.id,action:'confirm',expectedVersion:entry.version,allowPersonal:true});await importer.import({text:edited,previewHash:preview.previewHash});assert.equal((await repository.get('entries',entry.id)).reviewedBy,'owner');
 await assert.rejects(importer.import({text:edited+'changed',previewHash:'wrong'}),/Vorschau/);
}));
test('explicit corrections create linked conflicts without overwriting the previous human-confirmed fact',()=>fixture(async repository=>{
 const chat=createBrainChat({repository,retrieve:retrieval}),c=await chat.create();await chat.send({conversationId:c.conversationId,text:'Welche Schreibregeln gelten?',requestId:randomUUID()});
 const old={id:'existing',text:'Eine zuvor bestätigte Schreibregel bleibt bis zur Prüfung geschützt.',reviewedBy:'owner',status:'active',domains:['PERSONAL_KNOWLEDGE'],topics:[],project:'marcel',version:1};await repository.transaction(tx=>tx.put('entries',old));
 const file=exportConversationTXT(await chat.get(c.conversationId)).replace('BEZUG-ID:\n','BEZUG-ID: existing\n').replace('[KORREKTUR]\n\n','[KORREKTUR]\nDiese Schreibregel soll ab jetzt kürzere Einleitungen verwenden.\n'),importer=createLearningImport({repository,chat}),preview=await importer.preview(file);await importer.import({text:file,previewHash:preview.previewHash});
 assert.deepEqual(await repository.get('entries','existing'),old);const correction=(await repository.list('entries')).find(e=>e.id!=='existing');assert.equal(correction.status,'conflict');assert.deepEqual(correction.conflictsWith,['existing']);
}));
test('document upload is preview-only, then pending; representation reuploads do not duplicate entries',()=>fixture(async repository=>{
 const importer=createDocumentImport(repository),input={name:'Regeln.txt',base64:Buffer.from('Eine dokumentierte Kommunikationsregel vermeidet unnötige künstliche Bestätigungen.').toString('base64')},preview=await importer.preview(input);assert.equal((await repository.list('entries')).length,0);assert.equal(preview.sections,1);
 assert.equal((await importer.import({...input,previewHash:preview.previewHash})).created,1);const next=await importer.preview({...input,name:'Regeln-Kopie.txt'});assert.equal((await importer.import({...input,name:'Regeln-Kopie.txt',previewHash:next.previewHash})).created,0);assert.equal((await createKnowledgeService(repository).pending()).length,1);
}));
test('chat survives local database restart and transfer merge preserves metadata idempotently',async()=>{
 const parent=resolve(tmpdir()),dir=mkdtempSync(join(parent,'marcel-brain-chat-')),file=join(dir,'chat.sqlite');let repo=await openLocalKnowledge(file);
 try{const chat=createBrainChat({repository:repo,retrieve:retrieval}),c=await chat.create();await chat.send({conversationId:c.conversationId,text:'Dauerhafte Gesprächshistorie prüfen.',requestId:randomUUID()});repo.close();repo=await openLocalKnowledge(file);assert.equal((await createBrainChat({repository:repo,retrieve:retrieval}).get(c.conversationId)).turns.length,1);
 const payload=await createKnowledgeService(repo).exportAll();await fixture(async target=>{assert.equal((await mergeTransfer(target,payload)).conflicts.length,0);assert.equal((await mergeTransfer(target,payload)).created,0);await target.transaction(tx=>tx.put('meta',{...payload.collections.meta[0],title:'different'}));assert.ok((await planTransfer(target,payload)).conflicts.length);await assert.rejects(mergeTransfer(target,payload),/überschrieben/);});
 }finally{repo.close();const rel=relative(parent,resolve(dir));if(rel.startsWith('marcel-brain-chat-')&&!rel.includes('..'))rmSync(dir,{recursive:true,force:true});}
});
test('prepared PostgreSQL schema and repository persist chat records without a second database design',async()=>{
 const {PGlite}=await import('@electric-sql/pglite');const db=new PGlite();try{await db.exec(readFileSync(new URL('../migrations/20261018_brain_knowledge_foundation.sql',import.meta.url),'utf8'));
 const client={query:(sql,params)=>/pg_advisory_xact_lock/.test(sql)?Promise.resolve({rows:[]}):db.query(sql,params),release(){}};const pool={...client,connect:async()=>client},repository=createPgKnowledgeRepository(pool),chat=createBrainChat({repository,retrieve:retrieval}),c=await chat.create();await chat.send({conversationId:c.conversationId,text:'PostgreSQL Gespräch prüfen.',requestId:randomUUID()});
 const reopened=createBrainChat({repository:createPgKnowledgeRepository(pool),retrieve:retrieval});assert.equal((await reopened.get(c.conversationId)).turns[0].mode,'knowledge');const payload=await createKnowledgeService(repository).exportAll();assert.equal((await planTransfer(repository,payload)).conflicts.length,0);
 }finally{await db.close();}
});
test('HTTP default is cost-free and editable TXT export/import uses the authenticated existing chat route',()=>fixture(async repository=>{
 const app=express();app.use(express.json());let calls=0;registerBrainChatRoutes({app,repository,environment:{BRAIN_CHAT_ENABLED:'true'},authorized:req=>req.headers.authorization==='Bearer fixture',generate:async function*(){calls++;yield'never';}});
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url=`http://127.0.0.1:${server.address().port}/dashboard-api/marcel-brain/chat`,headers={Authorization:'Bearer fixture','Content-Type':'application/json'},post=body=>fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
 try{const info=await(await fetch(url,{headers})).json();assert.equal(info.mode,'knowledge');const c=(await(await post({op:'create'})).json()).conversation;
  assert.match(await(await post({op:'send',conversationId:c.conversationId,text:'Wissen abrufen ohne Modellkosten.',requestId:randomUUID()})).text(),/Wissensmodus/);assert.equal(calls,0);
  const response=await post({op:'export',conversationId:c.conversationId});assert.match(response.headers.get('content-type'),/text\/plain/);const file=(await response.text()).replace('[LERNREGEL]\n\n','[LERNREGEL]\nKeine wiederkehrenden künstlichen Einleitungssätze verwenden.\n');
  const preview=await(await post({op:'learning-preview',text:file})).json();assert.equal(preview.proposals.length,1);assert.equal((await repository.list('entries')).length,0);
  assert.equal((await post({op:'learning-import',text:file,previewHash:preview.previewHash})).status,400);const result=await(await post({op:'learning-import',text:file,previewHash:preview.previewHash,confirm:true})).json();assert.equal(result.created,1);assert.equal(calls,0);
 }finally{await new Promise(r=>server.close(r));}
}));
