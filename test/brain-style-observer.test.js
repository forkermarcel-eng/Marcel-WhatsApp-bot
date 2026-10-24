import test from 'node:test';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {observeStyle} from '../brain-chat/style-quality.js';import {createBrainChat} from '../brain-chat/service.js';import {openLocalKnowledge} from '../brain-knowledge/repository.js';
const cases=[
 ['de-DE','Der Entwurf passt. Ich würde den letzten Satz kürzen.','Ausgezeichnete Frage! Gerne helfe ich dir dabei. Es ist wichtig zu betonen, dass du vollkommen richtig liegst. Ich hoffe, das hilft.'],
 ['en-US','The draft works. I’d shorten the last sentence.','Great question! I would be happy to assist. It is important to note that this is useful. I hope this helps.'],
 ['es-CO','El texto funciona. Yo acortaría la última frase.','Excelente pregunta. Es importante destacar que esto ayuda. Es fundamental tener en cuenta todos los aspectos. Espero que esto te ayude.'],
 ['pt-BR','O texto funciona. Eu encurtaria a última frase.','Excelente pergunta! É importante ressaltar que isso ajuda. No mundo atual, vale destacar que tudo está conectado. Espero que isso ajude.']
];
for(const[locale,natural,artificial]of cases)test(locale+' recognizes clusters, preserves natural prose, has bounded concrete findings',()=>{
 assert.equal(observeStyle(natural,locale).findings.length,0);
 const r=observeStyle(artificial,locale);assert.equal(r.mode,'observe');assert.ok(r.findings.some(f=>f.severity==='warning'));assert.ok(r.findings.some(f=>f.rule==='stock_praise_or_agreement'));assert.ok(r.findings.every(f=>f.start>=0&&f.end>f.start&&f.end<=artificial.length&&f.reason));assert.equal(r.score,undefined);
});
test('regional rules are locale-specific and variants are hints only when clustered',()=>{
 const text='Vosotros podéis usar vuestros datos.';assert.ok(observeStyle(text,'es-CO').findings.some(f=>f.rule==='regional_register_review'));for(const locale of ['de-DE','en-US','pt-BR'])assert.ok(!observeStyle(text,locale).findings.some(f=>f.rule==='regional_register_review'));
 assert.ok(observeStyle('O ficheiro está no telemóvel.','pt-BR').findings.some(f=>f.rule==='regional_register_review'));assert.equal(observeStyle('That colour works.','en-US').findings.length,0);
});
test('same information, opening, closing and user echo across turns are observed without semantic claims',()=>{
 const first='Ich erkläre dir diesen Zusammenhang gern noch etwas genauer.',last='Damit haben wir die wichtigsten Punkte gemeinsam ausführlich betrachtet.';
 const previous=[{status:'complete',language:{locale:'de-DE'},assistant:first+' Das ist ein anderer Gedanke. '+last}];
 const r=observeStyle(first+' Hier folgt jetzt eine andere Erklärung. '+last,'de-DE',{previous});assert.ok(r.findings.some(f=>f.rule==='repeated_opening'));assert.ok(r.findings.some(f=>f.rule==='repeated_closing'));
 assert.ok(observeStyle(first+' '+first,'de-DE').findings.some(f=>f.rule==='repeated_sentence'));
 const user='Ich wünsche mir eine klare Erklärung ohne unnötige lange Einleitung.';assert.ok(observeStyle(user,'de-DE',{userText:user}).findings.some(f=>f.rule==='possible_user_echo'));
 assert.equal(observeStyle(first,'de-DE',{previous:[{...previous[0],language:{locale:'pt-BR'}}]}).findings.length,0);
});
test('necessary repetitions, dates, facts, code, quotations, natural emotion and single connectors are preserved',()=>{
 const fact='Der Termin ist am Dienstag um 14 Uhr.';const warning='Warnung: Diese Datei niemals löschen, sie enthält deine Sicherung.';
 for(const text of [fact,warning])assert.equal(observeStyle(text+' '+text,'de-DE',{previous:[{status:'complete',assistant:text}]}).findings.length,0);
 const sentence='Ich erkläre dir diesen Zusammenhang gern noch etwas genauer.';assert.equal(observeStyle(sentence+' '+sentence,'de-DE',{userText:'Bitte wiederhole diese Aussage wörtlich.'}).findings.length,0);
 for(const[locale,text]of [['de-DE','Danke! Das freut mich.'],['en-US','Thanks! That’s wonderful.'],['es-CO','¡Qué alegría! Gracias por contármelo.'],['pt-BR','Que bom! Além disso, sobrou tempo.']])assert.equal(observeStyle(text,locale).findings.length,0);
 assert.equal(observeStyle('"Great question! I hope this helps."\n```js\nthe the\n```','en-US').findings.length,0);
 assert.equal(observeStyle('„Ausgezeichnete Frage! Gerne helfe ich dir dabei.“','de-DE').findings.length,0);
});
test('generic questions and repeated transitions are contextual hints, not blanket bans',()=>{
 assert.ok(observeStyle('The task is finished. Would you like me to elaborate?','en-US').findings.some(f=>f.rule==='generic_followup'));
 assert.ok(!observeStyle('The task is finished. Would you like me to elaborate?','en-US',{register:'personal'}).findings.some(f=>f.rule==='generic_followup'));
 assert.ok(observeStyle('Além disso, temos tempo. Além disso, temos espaço. Além disso, temos apoio.','pt-BR').findings.some(f=>f.rule==='transition_density'));
});
test('knowledge and literal outputs are explicitly skipped; unknown profiles fail closed',()=>{
 for(const[origin,literal]of [['knowledge',false],['model',true]]){const r=observeStyle(cases[0][2],'de-DE',{origin,literal});assert.equal(r.status,'skipped');assert.equal(r.findings.length,0);}
 assert.equal(observeStyle('Bonjour','fr-FR').reason,'unsupported_locale');
});
test('chat stores observations without changing streaming, knowledge mode, source content or making extra model calls',async()=>{
 const repository=await openLocalKnowledge(':memory:');try{let calls=0;const model=async function*(){calls++;yield cases[0][2];};
 const chat=createBrainChat({repository,mode:'model',retrieve:async()=>({sources:[],warnings:[]}),supplement:async()=>null,generate:model}),c=await chat.create();let streamed='';const result=await chat.send({conversationId:c.conversationId,text:'Bitte erkläre das kurz.',requestId:randomUUID(),onEvent:(e,d)=>{if(e==='delta')streamed+=d.text;}});const t=result.turns[0];assert.equal(t.assistant,cases[0][2]);assert.equal(streamed,t.assistant);assert.equal(calls,1);assert.ok(t.styleObservation.findings.length);assert.equal((await repository.list('entries')).length,0);
 const knowledge=createBrainChat({repository,retrieve:async()=>({answer:'Originalbeleg: Great question!',sources:[],warnings:[]}),supplement:async()=>null,generate:model}),k=await knowledge.create();const saved=await knowledge.send({conversationId:k.conversationId,text:'Bitte erkläre das kurz.',requestId:randomUUID()});assert.equal(saved.turns[0].assistant,'Originalbeleg: Great question!');assert.equal(saved.turns[0].styleObservation.status,'skipped');assert.equal(calls,1);
 }finally{repository.close();}
});

test('isolated enthusiasm and confirmation remain natural; repeated canned confirmation is visible',()=>{
 assert.equal(observeStyle('Absolutely. That works.','en-US').findings.length,0);
 const previous=[{status:'complete',assistant:'Absolutely. We can do that.'},{status:'complete',assistant:'Absolutely. This is possible.'}];
 assert.ok(observeStyle('Absolutely. Here is the draft.','en-US',{previous}).findings.some(f=>f.rule==='repeated_confirmation'));
 assert.ok(observeStyle('Absolutely fantastic! Truly amazing!','en-US').findings.some(f=>f.rule==='enthusiasm_cluster'));
 const long=observeStyle('Great question! '.repeat(3700),'en-US');assert.ok(long.findings.length<=24);
});
