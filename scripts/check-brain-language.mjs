// Explicit, bounded acceptance runner. Never called by application startup or npm test.
// Uses only synthetic fixtures and the application's existing single model adapter.
import OpenAI from 'openai';
import {randomUUID} from 'node:crypto';
import {openLocalKnowledge} from '../brain-knowledge/repository.js';
import {createBrainChat} from '../brain-chat/service.js';
import {createBrainModel} from '../brain-chat/model.js';
import {createLocalBrainModel} from '../brain-chat/local-model.js';
const run=process.argv.includes('--model-check');
if(!run||process.env.BRAIN_LANGUAGE_TEST_APPROVED!=='true'){
 console.log(JSON.stringify({status:'blocked',reason:'Explicit bounded model-test approval is required; no model called.'}));process.exitCode=2;
}else{
 const local=process.env.BRAIN_CHAT_MODE==='local'&&process.env.BRAIN_CHAT_LOCAL_APPROVED==='true';
 const paid=process.env.BRAIN_CHAT_PAID_API_ENABLED==='true'&&!!process.env.OPENAI_API_KEY;
 if(!local&&!paid){console.log(JSON.stringify({status:'blocked',reason:'Existing model gate is disabled or no approved model is available.'}));process.exitCode=2;}
 else{
  const repository=await openLocalKnowledge(':memory:');
  const generate=local?createLocalBrainModel():createBrainModel({client:new OpenAI({apiKey:process.env.OPENAI_API_KEY}),model:process.env.OPENAI_MODEL||'gpt-5.6-sol'});
  const chat=createBrainChat({repository,retrieve:async()=>({sources:[],warnings:[]}),supplement:async()=>null,mode:local?'local':'model',generate});
  const scenarios=[
   ['de-DE',['Erkläre einer Kollegin kurz eine API. Höchstens drei Sätze. Unser Beispielport ist 5432.','Das klingt zu werblich. Bitte direkt und ohne Lob.','Port 5432 ist eine Primzahl, oder? Antworte kurz und überprüfe die Behauptung.']],
   ['en-US',['Explain an API to a coworker in natural US English, in no more than three sentences. Our example port is 5432.','That sounds too much like an ad. Be direct and skip the praise.','Port 5432 is a prime number, right? Answer briefly and check the claim.']],
   ['es-CO',['Explica qué es una API a una colega en español colombiano, en tres frases como máximo. Nuestro puerto de ejemplo es 5432.','Eso suena demasiado publicitario. Sé directo y sin elogios.','El puerto 5432 es un número primo, ¿cierto? Responde brevemente y verifica la afirmación.']],
   ['pt-BR',['Explique uma API para uma colega em português brasileiro, em até três frases. Nossa porta de exemplo é 5432.','Isso soa como propaganda. Seja direto, sem elogios.','A porta 5432 é um número primo, certo? Responda brevemente e confira a afirmação.']]
  ];
  const results=[];
  try{
   for(const[expected,messages]of scenarios){const c=await chat.create();for(const text of messages){const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),90000);try{const result=await chat.send({conversationId:c.conversationId,text,requestId:randomUUID(),signal:controller.signal}),turn=result.turns.at(-1);results.push({expected,locale:turn.language.locale,register:turn.language.register,input:text,answer:turn.assistant,mode:turn.mode,styleChecks:turn.styleChecks||[]});}finally{clearTimeout(timer);}}}
   const c=await chat.create();for(const[expected,text]of [['de-DE','Antworte auf Deutsch: Unsere Besprechung ist am Dienstag um 14 Uhr. Formuliere eine kurze Erinnerung.'],['en-US','Now respond in English. Keep the meeting details.'],['es-CO','Ahora responde en español colombiano. Conserva los datos de la reunión.'],['pt-BR','Agora responda em português brasileiro. Preserve os dados da reunião.']]){const result=await chat.send({conversationId:c.conversationId,text,requestId:randomUUID()}),turn=result.turns.at(-1);results.push({expected,locale:turn.language.locale,input:text,answer:turn.assistant,mode:turn.mode,styleChecks:turn.styleChecks||[]});}
   console.log(JSON.stringify({status:'completed',modelCalls:results.length,results,knowledgeEntries:(await repository.list('entries')).length},null,2));
  }finally{repository.close();}
 }
}
