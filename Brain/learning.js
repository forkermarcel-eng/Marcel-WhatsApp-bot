(()=>{
 const $=id=>document.getElementById(id),endpoint='/api/dashboard/marcel-brain?resource=chat';let active=null,preview=null,payload=null;
 document.addEventListener('brain-chat-active',e=>{active=e.detail;});
 const status=t=>$('chatImportStatus').textContent=t;
 async function call(body){const r=await fetch(endpoint,{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(!r.ok){const d=await r.json().catch(()=>({}));throw Error(d.error||'Import oder Export fehlgeschlagen.');}return r;}
 $('chatExport').onclick=async()=>{try{if(!active)throw Error('Zuerst eine Unterhaltung öffnen.');const ids=[...document.querySelectorAll('[data-chat-turn]:checked')].map(i=>i.dataset.chatTurn),r=await call({op:'export',conversationId:active.conversationId,turnIds:ids}),blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='marcel-brain-chat.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);status('TXT exportiert. KORREKTUR- oder LERNREGEL-Blöcke außerhalb des Systems ausfüllen.');}catch(e){status(e.message);}};
 $('chatImportPurpose').onchange=()=>{$('chatImportFile').onchange();};
 $('chatImportFile').onchange=()=>{preview=null;payload=null;$('chatImportConfirm').hidden=true;$('chatImportItems').textContent='';};
 $('chatImportPreview').onclick=async()=>{
  try{preview=null;$('chatImportConfirm').hidden=true;const file=$('chatImportFile').files[0];if(!file)throw Error('Bitte zuerst eine Datei wählen.');if(file.size>1024*1024)throw Error('Maximal 1 MB pro Datei.');status('Datei wird ohne KI-Aufruf geprüft …');
   const text=/\.txt$/i.test(file.name)?await file.text():'';
   if(text.replace(/^\uFEFF/,'').startsWith('MARCEL-BRAIN-CHAT-TXT V1')){payload={op:'learning-import',text};preview=await(await call({op:'learning-preview',text})).json();$('chatImportItems').textContent=preview.proposals.map(p=>p.type+': '+p.text).join('\n\n');status(preview.proposals.length+' ausdrücklich markierte Lernvorschläge.');}
   else{const bytes=new Uint8Array(await file.arrayBuffer());let raw='';for(const b of bytes)raw+=String.fromCharCode(b);payload={op:'document-import',name:file.name,base64:btoa(raw),purpose:$('chatImportPurpose').value};preview=await(await call({...payload,op:'document-preview'})).json();$('chatImportItems').textContent=preview.items.map(p=>p.text).join('\n\n');status(preview.sections+' Abschnitte, '+preview.known+' bereits bekannt. Alle neuen Inhalte bleiben prüfpflichtig.');}
   $('chatImportConfirm').hidden=!((preview.proposals?.length||preview.sections)>0);
  }catch(e){status(e.message);}
 };
 $('chatImportConfirm').onclick=async()=>{if(!preview||!payload)return;$('chatImportConfirm').disabled=true;try{const result=await(await call({...payload,confirm:true,previewHash:preview.previewHash})).json();status(result.created+' neue Vorschläge, '+result.known+' bereits bekannt. Bestätigung erfolgt in der vorhandenen Wissensprüfung.');$('chatImportConfirm').hidden=true;preview=null;payload=null;}catch(e){status(e.message);}finally{$('chatImportConfirm').disabled=false;}};
 $('chatOpenReview').onclick=()=>{document.querySelector('[data-tab="projectKnowledge"]').click();$('knowledgeReload').click();};
})();
