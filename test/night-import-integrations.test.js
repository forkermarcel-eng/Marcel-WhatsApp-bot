import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {extractBytes} from '../brain-knowledge/extract.js';
import {parseLearningTXT} from '../brain-chat/learning.js';
import {createHomeAssistant} from '../brain-integrations/home-assistant.js';
import {createLocalVoice} from '../brain-integrations/voice.js';
import {prepareRecipeSource,prepareSocialDraft} from '../brain-integrations/social-drafts.js';
import {openLocalKnowledge} from '../brain-knowledge/repository.js';
import {createBrainChat} from '../brain-chat/service.js';
function zip(files){const local=[],directory=[];let offset=0;for(const [name,text]of Object.entries(files)){const path=Buffer.from(name),body=Buffer.from(text),header=Buffer.alloc(30);header.writeUInt32LE(0x04034b50);header.writeUInt32LE(body.length,18);header.writeUInt32LE(body.length,22);header.writeUInt16LE(path.length,26);local.push(header,path,body);const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(path.length,28);central.writeUInt32LE(offset,42);directory.push(central,path);offset+=header.length+path.length+body.length;}const entries=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(directory.length/2,10);end.writeUInt32LE(entries.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...local,entries,end]);}
test('EPUB uses spine order and never executes embedded scripts',()=>{
 const files={'META-INF/container.xml':'<container><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>','OEBPS/book.opf':'<package><manifest><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="b"/><itemref idref="a"/></spine></package>','OEBPS/a.xhtml':'<html><body><p>Second text with enough detail to be imported.</p><script>throw Error("execute")</script></body></html>','OEBPS/b.xhtml':'<html><body><h1>First chapter</h1><p>First text with enough detail to be imported.</p></body></html>'};
 const blocks=extractBytes(zip(files),'.epub');assert.equal(blocks[0].text,'First chapter');assert.match(blocks.at(-1).text,/Second text/);assert.ok(blocks.every(b=>!b.text.includes('throw Error')));
 files['OEBPS/book.opf']=files['OEBPS/book.opf'].replace('a.xhtml','https://example.org/a');assert.throws(()=>extractBytes(zip(files),'.epub'),/External EPUB/);
});
test('project decisions remain explicit proposals with independent project boundaries',()=>{
 const id=randomUUID(),turn=randomUUID(),second=randomUUID();const text=`MARCEL-BRAIN-CHAT-TXT V1\nGESPRAECH-ID: ${id}\n=== ABSCHNITT ${turn} ===\nPROJEKT: luxe\n[ENTSCHEIDUNG]\nA synthetic business decision awaiting owner review.\n[/ENTSCHEIDUNG]\n=== ABSCHNITT ${second} ===\n[STILREGEL]\nA separate communication style proposal awaiting review.\n[/STILREGEL]`;
 const result=parseLearningTXT(text);assert.deepEqual(result.proposals.map(p=>p.project),['luxe','marcel']);assert.equal(result.proposals[0].type,'ENTSCHEIDUNG');assert.equal(result.proposals[0].turnId,turn);
});
test('structured chat decisions persist as deduplicated pending review with conversation provenance',async()=>{
 const repository=await openLocalKnowledge(':memory:');try{
  const chat=createBrainChat({repository,retrieve:async()=>({sources:[],warnings:[]})}),conversation=await chat.create(),text='[ENTSCHEIDUNG]\nSynthetic project decision retained for owner review only.\n[/ENTSCHEIDUNG]';
  for(const project of ['luxe','luxe','barber'])await chat.send({conversationId:conversation.conversationId,requestId:randomUUID(),text,project});
  const entries=await repository.list('entries');assert.equal(entries.length,2);assert.deepEqual(entries.map(e=>e.project).sort(),['barber','luxe']);assert.ok(entries.every(e=>e.reviewRequired&&e.status!=='active'&&e.kind==='decision'));assert.ok((await repository.list('evidence')).every(e=>e.locator.includes(conversation.conversationId)));
  const before=entries.length;await chat.send({conversationId:conversation.conversationId,requestId:randomUUID(),text:'Quoted example: '+text,project:'luxe'});assert.equal((await repository.list('entries')).length,before);
 }finally{repository.close();}
});
test('private Home Assistant adapter is disabled by default and rejects public addresses before fetch',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;return new Response('{"state":"on"}');};
 await assert.rejects(createHomeAssistant({url:'http://127.0.0.1:8123',token:'fixture',allowedEntities:['light.test'],fetchImpl}).state('light.test'),/freigegeben/);
 await assert.rejects(createHomeAssistant({url:'https://example.org',token:'fixture',approved:true,allowedEntities:['light.test'],fetchImpl}).state('light.test'),/private IP/);assert.equal(calls,0);
 const local=createHomeAssistant({url:'http://127.0.0.1:8123',token:'fixture',approved:true,allowedEntities:['light.test'],fetchImpl});assert.equal((await local.state('light.test')).state,'on');assert.equal(local.controlEnabled,false);
});
test('voice transport and social drafts require explicit adapters and owned media',async()=>{
 await assert.rejects(async()=>{for await(const item of createLocalVoice().listen([]))void item;},/nicht angebunden/);
 async function* audio(){yield new Uint8Array([1,2]);}const voice=createLocalVoice({approved:true,transcribe:async function*(chunks){for await(const chunk of chunks)assert.equal(chunk.length,2);yield{text:'synthetic',final:true};}});const events=[];for await(const e of voice.listen(audio()))events.push(e);assert.equal(events[0].source,'local-stt');
 assert.throws(()=>prepareSocialDraft({text:'Draft',platform:'instagram',media:[{assetId:'test'}]}),/Nutzungsrechte/);assert.equal(prepareSocialDraft({text:'Draft',platform:'instagram'}).publishingEnabled,false);
 assert.equal(prepareRecipeSource({url:'https://example.org/recipe',text:'Synthetic recipe text with ingredients and preparation steps.'}).reviewAll,true);
});
