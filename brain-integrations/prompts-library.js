const endpoint='https://prompts.chat/api/mcp';
const allowed=new Set(['search_prompts','get_prompt','search_skills','get_skill']);
const failure=(message,status=502)=>Object.assign(Error(message),{status});
const text=(value,max)=>typeof value==='string'?value.slice(0,max):'';
function publicTerm(value,max=160){
 if(typeof value!=='string'||!value.trim()||value.length>max||/[\x00-\x1f]/.test(value)||/https?:\/\/|\S+@\S+|(?:password|passwort|secret|token|api[_ -]?key)\s*[:=]|\b(?:sk-|pchat_|ghp_)[\w-]+|-----BEGIN|\b\d{8,}\b/i.test(value))throw failure('Nur öffentliche Suchbegriffe eingeben; keine Kontaktdaten, URLs oder Zugangsdaten.',400);
 return value.trim();
}
function argumentsFor(tool,input){
 if(!allowed.has(tool))throw failure('Dieses Werkzeug ist nicht freigegeben.',400);
 if(tool.startsWith('get_')){if(typeof input.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(input.id))throw failure('Ungültige öffentliche ID.',400);return {id:input.id,...(tool==='get_prompt'?{fill_variables:false}:{})};}
 const args={query:publicTerm(input.query),limit:10};
 for(const key of ['category','tag'])if(input[key]){if(typeof input[key]!=='string'||!/^[a-z0-9-]{1,60}$/.test(input[key]))throw failure('Kategorie und Tag benötigen einen öffentlichen Slug.',400);args[key]=input[key];}
 return args;
}
async function boundedBody(response){
 const reader=response.body?.getReader();if(!reader)throw failure('Leere Antwort von prompts.chat.');
 const chunks=[];let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>1048576)throw failure('Die externe Antwort ist zu groß. Bitte einen anderen Eintrag wählen.',413);chunks.push(value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 return Buffer.concat(chunks).toString('utf8');
}
function envelope(raw,id){
 const messages=[];
 if(raw.trim().startsWith('{'))messages.push(JSON.parse(raw));
 else for(const block of raw.replace(/\r\n/g,'\n').split('\n\n')){const data=block.split('\n').filter(x=>x.startsWith('data:')).map(x=>x.slice(5).trimStart()).join('\n');if(data)messages.push(JSON.parse(data));}
 const message=messages.find(x=>x.jsonrpc==='2.0'&&x.id===id);
 if(!message||message.error||!message.result)throw failure('Die öffentliche MCP-Anfrage wurde nicht erfolgreich beantwortet.');
 return message.result;
}
function item(value,kind){
 if(!value||typeof value.id!=='string'||!/^[a-zA-Z0-9_-]{1,100}$/.test(value.id)||value.isPrivate===true)throw failure('Ungültiger öffentlicher Bibliothekseintrag.');
 const tags=Array.isArray(value.tags)?value.tags.slice(0,20).map(t=>text(typeof t==='string'?t:t?.name,100)):[];
 if(Array.isArray(value.files)&&value.files.length>60)throw failure('Dieser Skill enthält zu viele Dateien für die sichere Vorschau.',413);
 const files=Array.isArray(value.files)?value.files.map(f=>({filename:text(f.filename,200),content:text(f.content,1048576)})):[];
 return {id:value.id,kind,title:text(value.title,400),description:text(value.description,3000),author:text(value.author,200),category:text(value.category,200),tags,content:text(value.content||value.contentPreview,1048576),files,fileNames:Array.isArray(value.fileNames)?value.fileNames.slice(0,60).map(f=>text(f,200)):files.map(f=>f.filename),source:'https://prompts.chat/prompts/'+encodeURIComponent(value.id),security:{trusted:false,executable:false,status:'Externe, ungeprüfte Community-Inhalte. Keine Installation oder Ausführung. Nutzungsrechte an der Quelle prüfen.'}};
}
export function reviewSkill(entry){
 const content=[entry.description,...entry.files.map(x=>x.content)].join('\n');
 const overlaps=[[/document|pdf|dokument|knowledge|retriev/i,'Dokumentenwissen: vorhandene Quellen und Textauszüge'],[/weather|wetter/i,'Wetter: vorhandene Wetterabfragen'],[/calendar|caldav|kalender/i,'Organisation: vorhandener CalDAV-Adapter (Kontoverbindung separat)'],[/mail|imap|smtp/i,'Organisation: vorhandener Mailadapter (Kontoverbindung separat)'],[/market|trading|finance|finanz/i,'Marktanalyse: vorhandene Analysefunktionen; keine Ordersteuerung übernehmen']].filter(([r])=>r.test(content)).map(([,s])=>s);
 const declared=content.split('\n').filter(line=>/^(?:\s*[-*]\s*)?(?:requires|dependencies|prerequisites|requirements|allowed-tools|voraussetzungen|abhängigkeiten)\s*:/i.test(line)).slice(0,12).map(x=>x.slice(0,300));
 const runtimes=[...new Set(entry.fileNames.map(f=>f.endsWith('.py')?'Python':/\.[cm]?js$/.test(f)?'JavaScript':/\.(?:sh|ps1|bat)$/.test(f)?'Shell / Systemzugriff':null).filter(Boolean))];
 return {overlaps,declared,runtimes,suggestion:overlaps.length?'Mögliche Überschneidung: vorhandene Brain-Funktionen zuerst wiederverwenden. Fremde Dateien nur manuell prüfen.':'Mögliche Erweiterung: Voraussetzungen und Nutzen manuell prüfen; keine automatische Übernahme.',notice:'Regelbasierter Textvergleich, keine Kompatibilitäts- oder Sicherheitsfreigabe. Nicht deklarierte Voraussetzungen können fehlen.'};
}
export function createPromptsLibrary({fetcher=fetch,clock=Date.now}={}){
 let initialized=null,session=null,sequence=0,active=0,failures=0,retryAt=0;
 const cache=new Map();let windowAt=clock(),requests=0;
 async function rpc(method,params,signal){
  const id=++sequence;
  const response=await fetcher(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2024-11-05',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',id,method,...(params?{params}:{})}),signal});
  if(!response.ok){if(response.status===404){initialized=null;session=null;}throw failure(response.status===429?'prompts.chat begrenzt gerade Anfragen. Später erneut versuchen.':'prompts.chat ist momentan nicht erreichbar.',response.status===429?429:502);}
  const newSession=response.headers.get('mcp-session-id');if(newSession&&/^[\w.-]{1,200}$/.test(newSession))session=newSession;
  return envelope(await boundedBody(response),id);
 }
 async function connect(signal){
  if(initialized)return initialized;
  initialized=(async()=>{const hello=await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'marcel-brain-public-library',version:'1.0.0'}},signal);if(hello.protocolVersion!=='2024-11-05')throw failure('MCP-Protokollversion nicht unterstützt.');
   const response=await fetcher(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2024-11-05',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'}),signal});if(!response.ok)throw failure('MCP-Initialisierung nicht bestätigt.');await response.body?.cancel();
   const listed=await rpc('tools/list',null,signal);const tools=new Map((listed.tools||[]).map(t=>[t.name,t]));for(const name of allowed){const schema=tools.get(name)?.inputSchema;if(schema?.type!=='object'||!(name.startsWith('search_')?schema.properties?.query?.type==='string':schema.properties?.id?.type==='string'))throw failure('Benötigte MCP-Werkzeuge oder Parameter sind nicht verfügbar.');}return true;
  })().catch(e=>{initialized=null;session=null;throw e;});return initialized;
 }
 return {async call(tool,input={}){
  const args=argumentsFor(tool,input),now=clock();
  if(now-windowAt>=60000){windowAt=now;requests=0;}if(++requests>30)throw failure('Anfragelimit erreicht. Bitte eine Minute warten.',429);
  const key=JSON.stringify([tool,args]),hit=cache.get(key);if(hit&&hit.until>now)return hit.value;
  if(now<retryAt)throw failure('Externe Bibliothek vorübergehend pausiert. Bitte später erneut versuchen.',503);
  if(active>=2)throw failure('Es laufen bereits zwei Bibliotheksanfragen.',429);active++;
  try{
   const signal=AbortSignal.timeout(15000);await connect(signal);
   const result=await rpc('tools/call',{name:tool,arguments:args},signal);if(result.isError)throw failure('Die öffentliche Bibliothek konnte diesen Eintrag nicht liefern.');
   const content=result.content?.find(c=>c.type==='text')?.text;const data=result.structuredContent||JSON.parse(content||'null');if(!data||data.error)throw failure('Die öffentliche Bibliothek hat keine verwendbaren Daten geliefert.');
   const kind=tool.includes('skill')?'skill':'prompt';let value;
   if(tool.startsWith('search_')){const rows=data[kind==='skill'?'skills':'prompts'];if(!Array.isArray(rows))throw failure('Unerwartetes Suchformat.');value={items:rows.slice(0,10).map(x=>item(x,kind)),source:endpoint};}
   else{const selected=item(data,kind);if(selected.id!==args.id)throw failure('Die Antwort gehört nicht zum angefragten Eintrag.');value={item:selected,...(kind==='skill'?{review:reviewSkill(selected)}:{})};}
   failures=0;if(cache.size>=40)cache.delete(cache.keys().next().value);cache.set(key,{until:clock()+180000,value});return value;
  }catch(e){if(++failures>=3)retryAt=clock()+30000;if(e.status)throw e;throw failure('Öffentliche Bibliothek nicht erreichbar oder Antwort ungültig. Bitte später erneut versuchen.',503);}finally{active--;}
 }};
}
export function registerPromptsLibraryRoutes({app,authorized,library=createPromptsLibrary()}){
 app.all('/dashboard-api/marcel-brain/prompt-library',async(req,res)=>{
  res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
  if(!authorized(req))return res.status(401).json({ok:false,error:'Nicht autorisiert.'});
  if(req.method!=='POST')return res.status(405).json({ok:false,error:'Nur explizite Bibliotheksanfragen sind erlaubt.'});
  try{if(req.body?.publicQueryApproved!==true)throw failure('Nur ausdrücklich freigegebene öffentliche Suchbegriffe verwenden.',400);const result=await library.call(req.body.tool,req.body.arguments||{});return res.json({ok:true,...result});}
  catch(e){return res.status(e.status||503).json({ok:false,error:e.status?e.message:'Bibliothek momentan nicht verfügbar.'});}
 });
}
