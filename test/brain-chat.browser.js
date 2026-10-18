// Synthetic model responses only. Evaluate on a fresh about:blank page.
export async function runBrainChatBrowserChecks(html){
 // about:blank lacks secure-context randomUUID; real HTTPS/localhost supplies it.
 if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{configurable:true,value:()=> '10000000-1000-4000-8000-100000000000'.replace(/[018]/g,c=>(c^crypto.getRandomValues(new Uint8Array(1))[0]&15>>c/4).toString(16))});
 const conversations=new Map(),checks=[];let failNext=false;
 const check=(condition,name)=>{if(!condition)throw Error(name);checks.push(name);};
 const wait=async fn=>{for(let i=0;i<250;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Browser check timed out');};
 window.fetch=async(url,options={})=>{
  const u=new URL(url,'http://fixture.invalid'),body=options.body?JSON.parse(options.body):{};
  const json=(data,status=200)=>Promise.resolve(new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}}));
  if(u.searchParams.get('resource')!=='chat')return json({ok:true,items:[],liveState:{},documents:[],counts:{documents:0,entries:0,active:0,pending:0}});
  if(body.op==='create'){const id=crypto.randomUUID(),c={id:'brain-chat:'+id,conversationId:id,title:'Neue Unterhaltung',turns:[]};conversations.set(id,c);return json({conversation:c},201);}
  if(body.op==='send'){
   if(failNext){failNext=false;return json({error:'Test: KI-Verbindung nicht verfügbar.'},503);}
   const c=conversations.get(body.conversationId),source={text:'Englische Mastervideos als dokumentierter Plan.',documents:[{title:'Content DNA',locator:'MB-fixture'}]};
   c.title=body.text;c.turns.push({id:body.requestId,user:body.text,assistant:'Eine simulierte Antwort im Browsercheck.',sources:[source],status:'complete'});
   const events=[['context',{sources:[source]}],['delta',{text:'Eine simulierte Antwort '}],['delta',{text:'im Browsercheck.'}],['done',{conversation:c}]];
   return new Response(events.map(([event,data])=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'Content-Type':'text/event-stream'}});
  }
  if(u.searchParams.has('id'))return json({conversation:conversations.get(u.searchParams.get('id'))});
  return json({conversations:[...conversations.values()].map(c=>({id:c.conversationId,title:c.title}))});
 };
 document.open();document.write(html);document.close();const q=s=>document.querySelector(s);
 await wait(()=>q('#chatStatus')&&q('#chatStatus').textContent==='');
 check(q('#brainChat').classList.contains('active'),'Chat is the initial Brain view');
 q('#chatNew').click();await wait(()=>conversations.size===1&&q('#chatList button'));
 q('#chatInput').value='Welche Instagram-Strategie haben wir?';q('#chatComposer').dispatchEvent(new Event('submit',{cancelable:true}));
 await wait(()=>q('.chat-text')&&q('#chatSend').disabled===false&&q('#chatTranscript').textContent.includes('simulierte Antwort'));
 check(q('#chatTranscript').textContent.includes('MB-fixture'),'Source locators are available');
 check(q('#chatTranscript').textContent.includes('Welche Instagram'),'Question and streamed answer render');
 q('#chatInput').value='Jetzt auf Englisch.';q('#chatComposer').dispatchEvent(new Event('submit',{cancelable:true}));await wait(()=>[...conversations.values()][0].turns.length===2&&!q('#chatSend').disabled);
 check(q('#chatTranscript').querySelectorAll('.chat-message.user').length===2,'Follow-up stays in the conversation');
 q('#chatNew').click();await wait(()=>conversations.size===2&&q('#chatTranscript .chat-empty'));
 check(q('#chatTranscript').querySelectorAll('.chat-message').length===0,'New conversation starts empty');
 q('#chatList button').click();await wait(()=>q('#chatTranscript').querySelectorAll('.chat-message.user').length===2);
 check(q('#chatTranscript').textContent.includes('Jetzt auf Englisch'),'Earlier conversation reopens');
 failNext=true;q('#chatInput').value='Fehlerfall';q('#chatComposer').dispatchEvent(new Event('submit',{cancelable:true}));await wait(()=>q('#chatStatus').classList.contains('error')&&!q('#chatSend').disabled);
 check(q('#chatInput').value==='Fehlerfall','Provider error is visible and preserves the input');
 for(const id of ['knowledge','state','review','projectKnowledge']){q(`[data-tab="${id}"]`).click();check(q('#'+id).classList.contains('active'),'Existing view reachable: '+id);}
 q('[data-tab="brainChat"]').click();const rect=q('#chatInput').getBoundingClientRect();check(rect.width>150&&rect.right<=innerWidth+1&&rect.left>=0,'Composer fits viewport');
 check(document.documentElement.scrollWidth<=innerWidth+1,'Page has no horizontal overflow');
 return{passed:checks.length,checks,viewport:innerWidth,modelResponsesSimulated:true};
}
