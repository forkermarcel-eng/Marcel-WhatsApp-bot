import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import express from 'express';
import { openLocalKnowledge } from '../brain-knowledge/repository.js';
import { createKnowledgeService } from '../brain-knowledge/service.js';
import { registerKnowledgeRoutes } from '../brain-knowledge/routes.js';
import { hash, candidateFromBlock } from '../brain-knowledge/model.js';
import { extractBytes } from '../brain-knowledge/extract.js';

function source(text,{project='marcel',domain='MASTER_BRAIN_ARCHITECTURE',subjectKey=null,...rest}={}){return {id:hash([text,project]),path:'/fixture/source.md',title:'Fixture source',contentHash:hash(text),project,domain,status:'processed',blocks:[{text,locator:'line:7',subjectKey}],...rest};}
async function fixture(fn){const repo=await openLocalKnowledge(':memory:');try{await fn(createKnowledgeService(repo),repo);}finally{repo.close();}}

test('repeat import deduplicates entries and evidence while preserving source versions',()=>fixture(async(service)=>{
 const a=source('Die lokale Brain Architektur verwendet eine gemeinsame Datenbank und getrennte Channel Adapter.');
 const first=await service.ingest([a]),second=await service.ingest([a]);assert.equal(first.created,1);assert.equal(second.created,0);assert.equal(second.evidence,0);
 const b={...a,id:hash('another-source'),path:'/fixture/second.md',contentHash:hash('version2')};await service.ingest([b]);const exportAll=await service.exportAll();assert.equal(exportAll.collections.entries.length,1);assert.equal(exportAll.collections.evidence.length,2);
}));
test('personal facts, hypotheses and numeric trading parameters are excluded until reviewed',()=>fixture(async(service)=>{
 await service.ingest([source('Mein Sohn hat Geburtstag und diese persönliche Familieninformation darf nicht ungeprüft verwendet werden.'),source('Für Gold gilt ein Stop Loss von 20 Punkten bei einem Risiko von 1 Prozent.',{domain:'TRADING'}),source('Möglicherweise könnte eine lokale GPU diesen Ansatz beschleunigen.')]);
 assert.equal((await service.overview()).counts.active,0);assert.equal((await service.ask({question:'Was ist das Risiko für Gold?'})).results.length,0);
 const personal=(await service.pending()).find(e=>e.personal);await assert.rejects(service.review({id:personal.id,action:'confirm',expectedVersion:personal.version}),/ausdrücklich/);
 await service.review({id:personal.id,action:'confirm',expectedVersion:personal.version,allowPersonal:true});assert.equal((await service.overview()).counts.active,1);
}));
test('owner reviews reject stale changes and keep audit plus original evidence',()=>fixture(async(service)=>{
 await service.ingest([source('Die lokale Brain Architektur verwendet eine gemeinsame Datenbank und getrennte Channel Adapter.')]);const old=(await service.exportAll()).collections.entries[0];
 const next=await service.review({id:old.id,action:'correct',text:'Die lokale Brain Architektur speichert Quellen und Korrekturen nachvollziehbar in einer Datenbank.',expectedVersion:1});
 await assert.rejects(service.review({id:old.id,action:'confirm',expectedVersion:1}),e=>e.status===409);
 await service.ingest([source(old.text)]);assert.equal((await service.exportAll()).collections.entries[0].text,next.text);
 const archive=await service.exportAll();assert.equal(archive.collections.reviews.length,1);assert.equal(archive.collections.evidence[0].quote,old.text);
 await service.review({id:old.id,action:'reject',expectedVersion:2});assert.equal((await service.ask({question:'lokale Brain Architektur'})).results.length,0);
}));
test('explicit same-subject conflicts are quarantined and owner resolution preserves history',()=>fixture(async(service)=>{
 const a=source('Die Architektur soll die Daten auf einem lokalen Rechner speichern.',{subjectKey:'architecture.storage'}),b=source('Die Architektur soll die Daten ausschließlich in einer Cloud speichern.',{subjectKey:'architecture.storage'});
 await service.ingest([a,b]);assert.equal((await service.overview()).counts.active,0);const row=(await service.pending()).find(e=>e.text===b.blocks[0].text);
 await assert.rejects(service.review({id:row.id,action:'confirm',expectedVersion:row.version}),/Widerspruch/);
 await service.review({id:row.id,action:'confirm',expectedVersion:row.version,resolveConflict:true});const entries=(await service.exportAll()).collections.entries;assert.equal(entries.filter(e=>e.status==='active').length,1);assert.equal(entries.filter(e=>e.status==='superseded').length,1);
}));
test('retrieval is source-cited, separates projects, labels plans and abstains for missing USA strategy',()=>fixture(async(service)=>{
 await service.ingest([source('LUXE plant eine Boutique und einen Onlineshop mit dokumentierten Qualitätsstandards.',{project:'luxe',domain:'BUSINESS'}),source('Die Gold Trading Analyse beginnt mit Marktstruktur, Liquidität und dem persönlichen Journal.',{project:'trading',domain:'TRADING'}),source('Instagram wird im Dashboard als vorbereiteter Social Media Bereich ohne Automation angezeigt.',{domain:'SOCIAL_MEDIA'})]);
 const luxe=await service.ask({question:'Was haben wir für LUXE geplant?'});assert.equal(luxe.results[0].project,'luxe');assert.equal(luxe.results[0].sources[0].locator,'line:7');
 const gold=await service.ask({question:'Wie funktioniert mein Trading Workflow für Gold?'});assert.equal(gold.results[0].project,'trading');
 assert.equal((await service.ask({question:'Was ist meine Instagram Strategie für die USA?'})).results.length,0);
}));
test('USA concept cannot match WAITING_FOR_US and local architecture excludes device rollout controls',()=>fixture(async(service)=>{
 await service.ingest([source('WAITING_FOR_US und HANDOFF beschreiben die Übergabe von Tinder zu Instagram.',{domain:'SOCIAL_MEDIA'}),source('Keine KI lokal berechnen und keine große lokale Dating Datenbank auf der Tinder Android Bridge.')]);
 assert.equal((await service.ask({question:'Instagram Strategie für USA'})).results.length,0);
 assert.equal((await service.ask({question:'Wie soll meine lokale KI Architektur aussehen?'})).results.length,0);
}));
test('secrets and executable dumps are not imported and source kinds remain distinct',()=>fixture(async(service)=>{
 await service.ingest([source('DATABASE_URL=postgresql://user:password@private.example/db'),source('const secret = "this is executable code that must not become owner knowledge";')]);assert.equal((await service.overview()).counts.entries,0);
 assert.equal(candidateFromBlock({id:'a',project:'marcel'}, {text:'Dies ist ein dokumentierter geplanter Ausbau des lokalen Gedächtnisses mit Quellen.',locator:'1'}).kind,'plan');
}));
test('local persistence survives reopening and read-only lookup performs no schema creation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'marcel-knowledge-'));try{const path=join(dir,'brain.sqlite');const repo=await openLocalKnowledge(path);await createKnowledgeService(repo).ingest([source('Die lokale Brain Architektur hält Quellen und Gedächtnis nachvollziehbar zusammen.')]);repo.close();const read=await openLocalKnowledge(path,{readOnly:true});assert.equal((await createKnowledgeService(read).overview()).counts.entries,1);await assert.rejects(read.put('entries',{id:'x'}),/Read-only/);read.close();}finally{const target=resolve(dir),rel=relative(resolve(tmpdir()),target);if(!rel||rel.startsWith('..')||!rel.startsWith('marcel-knowledge-'))throw Error('Unsafe temporary cleanup target');rmSync(target,{recursive:true,force:true});}
});
test('chat extraction uses only owner messages, excluding assistant/tool and environment text',()=>{
 const lines=[{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'Die lokale Brain Architektur soll meine Projekte strikt voneinander trennen.'}]}},{type:'response_item',payload:{type:'message',role:'assistant',content:[{type:'output_text',text:'Erfundene persönliche Tatsachen ohne Bestätigung.'}]}},{type:'response_item',payload:{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>untrusted system configuration</environment_context>'}]}}].map(JSON.stringify).join('\n');
 const blocks=extractBytes(Buffer.from(lines),'.jsonl');assert.equal(blocks.length,1);assert.match(blocks[0].text,/Projekte/);
});
test('authenticated HTTP search uses the existing owner boundary and denies disabled writes',()=>fixture(async(service,repository)=>{
 await service.ingest([source('Die lokale Brain Architektur hält Quellen und Gedächtnis nachvollziehbar zusammen.')]);const app=express();app.use(express.json());registerKnowledgeRoutes({app,repository,environment:{},dashboardApiAuthorized:req=>req.headers.authorization==='Bearer fixture'});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const url=`http://127.0.0.1:${server.address().port}/dashboard-api/marcel-brain/knowledge`;
 try{assert.equal((await fetch(url)).status,401);const r=await fetch(url,{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify({op:'ask',question:'lokale Brain Architektur'})});assert.equal(r.status,200);assert.equal((await r.json()).results.length,1);const denied=await fetch(url,{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify({op:'review'})});assert.equal(denied.status,403);}finally{await new Promise(resolve=>server.close(resolve));}
}));
test('integration is additive: no knowledge added to channel reply or crown flows',()=>{
 const backend=readFileSync(new URL('../index.js',import.meta.url),'utf8'),dashboard=readFileSync(new URL('../Dashboard/index.html',import.meta.url),'utf8');
 assert.equal((backend.match(/registerKnowledgeRoutes\(\{/g)||[]).length,1);assert.match(dashboard,/loadMarcelBrain\(true\)/);assert.doesNotMatch(backend.slice(backend.indexOf('async function generateSharedReply'),backend.indexOf('async function generateAIReply')),/knowledge/i);
});
