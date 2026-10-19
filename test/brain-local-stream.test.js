import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalBrainModel} from '../brain-chat/local-model.js';
const environment={BRAIN_CHAT_LOCAL_APPROVED:'true',BRAIN_CHAT_LOCAL_MODEL:'qwen-local'};
test('local model streams fragmented UTF-8 SSE without cloud fallback',async()=>{
 let request;const bytes=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Größe"}}]}\n\ndata: [DONE]\n\n');
 const generate=createLocalBrainModel({environment,fetchImpl:async(url,options)=>{request={url,options};return new Response(new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close();}}),{headers:{'content-type':'text/event-stream'}});}});
 const parts=[];for await(const part of generate({instructions:'local',messages:[]}))parts.push(part);
 assert.deepEqual(parts,['Größe']);assert.equal(JSON.parse(request.options.body).stream,true);assert.equal(request.url.hostname,'127.0.0.1');assert.equal(request.options.redirect,'error');
});
test('truncated local streams fail explicitly',async()=>{
 const generate=createLocalBrainModel({environment,fetchImpl:async()=>new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n',{headers:{'content-type':'text/event-stream'}})});
 await assert.rejects(async()=>{for await(const part of generate({instructions:'',messages:[]}))void part;},/unvollständig/);
});
