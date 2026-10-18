// Reuses the application's OpenAI client. Inject this one interface for a later
// local model; neither the UI nor the knowledge store depends on a provider.
export function createBrainModel({client,model}) {
  return async function* generate({instructions,messages,signal}) {
    if(!client)throw Object.assign(Error('Die KI ist lokal noch nicht konfiguriert. OPENAI_API_KEY serverseitig setzen.'),{status:503});
    const stream=await client.responses.create({model,instructions,input:messages,stream:true,store:false,max_output_tokens:3000},{signal,timeout:90000,maxRetries:0});
    let completed=false;
    for await(const event of stream){
      if(event.type==='response.output_text.delta')yield event.delta;
      if(event.type==='response.completed')completed=true;
      if(['error','response.failed','response.incomplete'].includes(event.type))throw Error('Die KI-Antwort wurde nicht vollständig erzeugt. Bitte erneut versuchen.');
    }
    if(!completed)throw Error('Die Verbindung zur KI wurde unterbrochen.');
  };
}
