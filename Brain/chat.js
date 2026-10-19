(()=>{
  'use strict';
  const $=id=>document.getElementById(id),endpoint='/api/dashboard/marcel-brain?resource=chat';
  let active=null,busy=false,loaded=false,retry=null;
  async function request(body=null,id=null){
    const response=await fetch(endpoint+(id?'&id='+encodeURIComponent(id):''),{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    if(response.status===401)throw Error('Sitzung abgelaufen. Bitte erneut anmelden.');
    if(!response.ok){const d=await response.json().catch(()=>({}));throw Error(d.error||'Brain Chat ist nicht erreichbar.');}return response;
  }
  function status(text,error=false){$('chatStatus').textContent=text;$('chatStatus').className='chat-status'+(error?' error':'');}
  function setBusy(value){busy=value;for(const id of ['chatSend','chatNew','chatInput','chatPersonal','chatProject','chatProposalType'])$(id).disabled=value;document.querySelectorAll('#chatList button').forEach(b=>b.disabled=value);$('chatTranscript').setAttribute('aria-busy',String(value));}
  function message(role,text){const article=document.createElement('article');article.className='chat-message '+role;const h=document.createElement('h3');h.textContent=role==='user'?'Du':'Marcel Brain';const p=document.createElement('div');p.className='chat-text';p.textContent=text;article.append(h,p);$('chatTranscript').append(article);return article;}
  function sources(article,items){if(!items?.length)return;const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='Quellen ansehen ('+items.length+')';details.append(summary);for(const source of items){const p=document.createElement('div');p.className='chat-source';p.textContent=(source.documents||[]).map(d=>d.title+' · '+d.locator+(d.date?' · '+d.date:'')).join('\n')+'\n'+source.text;details.append(p);}article.append(details);}
  function render(){const box=$('chatTranscript');box.replaceChildren();if(!active?.turns?.length){const empty=document.createElement('div');empty.className='chat-empty';empty.innerHTML='<b>Woran arbeiten wir heute?</b>Frag mich nach deinen Projekten, Dokumenten oder Ideen.';box.append(empty);}for(const turn of active?.turns||[]){const user=message('user',turn.user),selection=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.dataset.chatTurn=turn.id;selection.className='chat-privacy';selection.append(input,document.createTextNode('Für TXT-Export markieren'));user.append(selection);const a=message('assistant',turn.assistant||(turn.status==='pending'?'Antwort wurde unterbrochen.':turn.error||''));if(turn.mode==='knowledge')a.querySelector('h3').textContent='Gespeichertes Wissen';sources(a,turn.sources);if(turn.status==='error'&&turn.assistant){const e=document.createElement('p');e.textContent=turn.error;a.append(e);}}box.scrollTop=box.scrollHeight;document.dispatchEvent(new CustomEvent('brain-chat-active',{detail:active}));}
  function showMode(data){if(!$('chatPersonal').dataset.userChoice)$('chatPersonal').checked=data.mode==='knowledge';if($('chatPersonalDescription'))$('chatPersonalDescription').textContent=data.mode==='model'?'Bestätigte persönliche Angaben für diese Antwort an den konfigurierten KI-Anbieter übermitteln. Offene Reviews bleiben ausgeschlossen.':data.mode==='local'?'Bestätigte persönliche Angaben dem freigegebenen lokalen Modell bereitstellen. Offene Reviews bleiben ausgeschlossen.':'Bestätigte persönliche Angaben in dieser privaten Wissenssuche verwenden. Offene Reviews bleiben ausgeschlossen.';if($('chatModeBanner'))$('chatModeBanner').textContent=data.mode==='model'?'API-KI ausdrücklich freigeschaltet – kostenpflichtige Modellaufrufe aktiv.':data.mode==='local'?'Lokales Modell ausdrücklich freigegeben. Kein kostenpflichtiger Fallback.':'Wissensmodus · API-KI AUS. Originalstellen statt generierter Antworten.';}
  async function list(){const data=await(await request()).json();showMode(data);$('chatList').replaceChildren();for(const c of data.conversations){const b=document.createElement('button');b.textContent=c.title;b.setAttribute('aria-current',String(active?.conversationId===c.id));b.onclick=()=>open(c.id);b.disabled=busy;$('chatList').append(b);}}
  async function open(id){if(busy)return;status('Unterhaltung wird geladen …');try{const data=await(await request(null,id)).json();active=data.conversation;retry=null;render();await list();status('');}catch(e){status(e.message,true);}}
  async function create(force=false){if(busy&&!force)return;try{const data=await(await request({op:'create'})).json();active=data.conversation;retry=null;render();await list();status('');$('chatInput').focus();}catch(e){status(e.message,true);}}
  async function init(){if(loaded)return;try{const data=await(await request()).json();showMode(data);loaded=true;if(data.conversations[0])await open(data.conversations[0].id);else{render();status('');}}catch(e){status(e.message,true);}}
  async function send(){
    const text=$('chatInput').value.trim();if(busy||!text)return;
    setBusy(true);if(!active){await create(true);if(!active){setBusy(false);return;}}
    const requestId=retry?.text===text&&retry.id===active.conversationId?retry.requestId:crypto.randomUUID();
    const options=retry?.requestId===requestId&&retry.options?retry.options:{allowPersonal:$('chatPersonal').checked,domain:$('chatDomain')?.value||null,literal:$('chatLiteral')?.checked===true,project:$('chatProject').value||null,proposalType:$('chatProposalType').value||null};
    retry={id:active.conversationId,text,requestId,options};setBusy(true);$('chatTranscript').querySelector('.chat-empty')?.remove();
    const last=active.turns.at(-1);if(last?.id!==requestId)message('user',text);
    const answer=message('assistant','');const answerText=answer.querySelector('.chat-text');status('Wissen wird abgerufen …');$('chatInput').value='';let complete=false;
    try{
      const response=await request({op:'send',conversationId:active.conversationId,text,requestId,...options});
      if(!response.headers.get('content-type')?.includes('text/event-stream'))throw Error('Die Streaming-Verbindung ist nicht verfügbar.');
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
      const consume=block=>{const name=block.match(/^event: (.+)$/m)?.[1],line=block.match(/^data: (.+)$/m)?.[1];if(!line)return;const data=JSON.parse(line);
        if(name==='delta'){answerText.textContent+=data.text;status('Brain schreibt …');const box=$('chatTranscript');if(box.scrollHeight-box.scrollTop-box.clientHeight<220)box.scrollTop=box.scrollHeight;}
        if(name==='context'){sources(answer,data.sources);if(data.mode==='knowledge')answer.querySelector('h3').textContent='Gespeichertes Wissen';status(data.proposal?'Wissensvorschlag vorgemerkt – Bestätigung unter Dokumentenwissen erforderlich.':data.mode==='knowledge'?'Originalstellen werden geladen …':'Brain formuliert …');}
        if(name==='error')throw Error(data.error);
        if(name==='done'){active=data.conversation;complete=true;retry=null;$('chatProposalType').value='';}
      };
      while(true){const {value,done}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done});let end;while((end=buffer.indexOf('\n\n'))>=0){consume(buffer.slice(0,end));buffer=buffer.slice(end+2);}if(done)break;}
      if(!complete)throw Error('Verbindung unterbrochen. Die Nachricht kann erneut gesendet werden.');
      render();await list();status(active.turns.at(-1)?.proposalId?'Wissensvorschlag wartet unter Dokumentenwissen auf deine Prüfung.':'');
    }catch(e){status(e.message,true);$('chatInput').value=text;try{const d=await(await request(null,active.conversationId)).json();active=d.conversation;render();}catch{}}
    finally{setBusy(false);$('chatInput').focus();}
  }
  if($('chatDomain')&&$('knowledgeDomain'))$('chatDomain').innerHTML=$('knowledgeDomain').innerHTML;
  $('chatPersonal').addEventListener('change',()=>{$('chatPersonal').dataset.userChoice='true';});$('chatNew').onclick=create;$('chatComposer').onsubmit=e=>{e.preventDefault();send();};$('chatInput').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();send();}};
  document.querySelector('[data-tab="brainChat"]').addEventListener('click',init);init();
})();
