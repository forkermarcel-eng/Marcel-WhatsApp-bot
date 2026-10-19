// Uses the compatible local HTTP API offered by Ollama and llama.cpp.
// Nothing is installed/downloaded, and no cloud fallback exists.
export function createLocalBrainModel({environment=process.env,fetchImpl=fetch}){
 return async function* generate({instructions,messages,signal}){
  if(environment.BRAIN_CHAT_LOCAL_APPROVED!=='true')throw Object.assign(Error('Keine lokale Modellinstanz freigegeben.'),{status:403});
  const url=new URL(environment.BRAIN_CHAT_LOCAL_URL||'http://127.0.0.1:11434/v1/');
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Object.assign(Error('Nur ausdrücklich freigegebene Loopback-Modellinstanzen sind zulässig.'),{status:400});
  const model=environment.BRAIN_CHAT_LOCAL_MODEL;if(!model||/cloud/i.test(model))throw Object.assign(Error('Ein lokales Modell ohne Cloud-Routing muss konfiguriert sein.'),{status:400});
  const response=await fetchImpl(new URL('chat/completions',url.href.endsWith('/')?url.href:url.href+'/'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'system',content:instructions},...messages],stream:true,max_tokens:3000}),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(90000)]):AbortSignal.timeout(90000),redirect:'error'});
  if(!response.ok)throw Error('Lokales Modell ist nicht erreichbar. Kein kostenpflichtiger Fallback.');
  if(!response.headers?.get('content-type')?.includes('text/event-stream')){
   const data=await response.json(),text=data.choices?.[0]?.message?.content;if(typeof text!=='string'||!text.trim())throw Error('Lokales Modell lieferte keine Antwort.');yield text;return;
  }
  let buffer='',length=0,received=false;const decoder=new TextDecoder();
  for await(const chunk of response.body){
   length+=chunk.byteLength;if(length>2*1024*1024)throw Error('Lokale Modellantwort überschreitet das Größenlimit.');
   buffer+=decoder.decode(chunk,{stream:true});let boundary;
   while((boundary=buffer.indexOf('\n'))>=0){
    const line=buffer.slice(0,boundary).trim();buffer=buffer.slice(boundary+1);
    if(!line.startsWith('data:'))continue;const payload=line.slice(5).trim();
    if(payload==='[DONE]'){if(!received)throw Error('Lokales Modell lieferte keine Antwort.');return;}
    const data=JSON.parse(payload);if(data.error)throw Error('Lokales Modell meldete einen Fehler.');
    const part=data.choices?.[0]?.delta?.content;if(typeof part==='string'&&part){received=true;yield part;}
   }
  }
  throw Error('Lokaler Modellstream wurde unvollständig beendet.');
 };
}
