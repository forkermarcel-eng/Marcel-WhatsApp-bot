// Transport boundary for local Whisper/Piper/Wyoming bridges, not a speech engine.
// No browser/cloud speech API fallback; adapters are explicitly injected.
export function createLocalVoice({approved=false,transcribe,synthesize}={}){
 return {async *listen(chunks,{signal}={}){
  if(!approved||typeof transcribe!=='function')throw Error('Lokale Spracherkennung nicht angebunden.');
  let size=0;async function* bounded(){for await(const chunk of chunks){signal?.throwIfAborted();if(!(chunk instanceof Uint8Array))throw Error('PCM-Audioblock erwartet.');size+=chunk.byteLength;if(size>32*1024*1024)throw Error('Audio überschreitet 32 MiB.');yield chunk;}}
  for await(const event of transcribe(bounded(),{signal})){signal?.throwIfAborted();if(typeof event.text!=='string'||event.text.length>10000)throw Error('Ungültige lokale Transkription.');yield {text:event.text,final:event.final===true,source:'local-stt'};}
 },async *speak(text,{signal}={}){
  if(!approved||typeof synthesize!=='function')throw Error('Lokale Sprachausgabe nicht angebunden.');if(typeof text!=='string'||text.length>10000)throw Error('Sprachtext zu lang.');
  let size=0;for await(const chunk of synthesize(text,{signal})){signal?.throwIfAborted();if(!(chunk instanceof Uint8Array))throw Error('Audioblock erwartet.');size+=chunk.byteLength;if(size>32*1024*1024)throw Error('Sprachausgabe zu groß.');yield chunk;}
 }};
}
