(() => {
  'use strict';
  const root=document.getElementById('projectKnowledge');if(!root)return;
  const endpoint='/api/dashboard/marcel-brain?resource=knowledge';
  const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const labels={MARCEL_DNA:'Marcel DNA',SOCIAL_MEDIA:'Social Media',TRADING:'Trading',BUSINESS:'Business',MEDIA_AI:'Media AI',MASTER_BRAIN_ARCHITECTURE:'Master Brain Architektur',PERSONAL_KNOWLEDGE:'Persönliches Wissen'};
  let pending=[],searchEntries=[],selected=null,loaded=false;
  async function request(op,body=null){const r=await fetch(endpoint+(body?'':'&op='+encodeURIComponent(op)),{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify({op,...body})}:{}),signal:AbortSignal.timeout(20000)});const data=await r.json();if(!r.ok)throw Error(data.error||'Wissensspeicher nicht erreichbar.');return data;}
  async function load(){
    $('knowledgeStatus').textContent='Lokales Dokumentenwissen wird geladen …';
    try{const data=await request('overview');$('knowledgeStatus').textContent=`${data.counts.documents} Quellen · ${data.counts.entries} Einträge · ${data.counts.active} für Antworten verfügbar · ${data.counts.pending} zu prüfen`;
      $('knowledgeSources').innerHTML=data.documents.map(d=>`<div class="knowledge-source"><b>${esc(d.title)}</b><span>${esc(d.status)}${d.effectiveDate?' · '+esc(d.effectiveDate):''}</span>${d.reason?`<p>${esc(d.reason)}</p>`:''}<small>Quelle ${esc(d.id.slice(0,12))} · Version ${esc(d.contentHash.slice(0,12))}</small></div>`).join('');
      const p=await request('pending');pending=p.items||[];renderPending();loaded=true;
    }catch(e){$('knowledgeStatus').textContent=e.message;loaded=false;}
  }
  function renderPending(){ $('knowledgePending').innerHTML=pending.length?pending.map(e=>`<article class="card"><b>${esc(labels[e.domains[0]]||e.domains[0])}</b><p>${esc(e.text)}</p><div class="meta">${esc(e.project)} · ${esc(e.reviewReason)} · Version ${e.version}</div><button data-knowledge-review="${esc(e.id)}">Prüfen</button></article>`).join(''):'<div class="empty">Keine offenen Dokumentenprüfungen.</div>'; }
  async function ask(){const question=$('knowledgeQuestion').value.trim();if(question.length<3){$('knowledgeAnswer').textContent='Bitte eine konkrete Frage eingeben.';return;}$('knowledgeAsk').disabled=true;$('knowledgeAnswer').textContent='Passende freigegebene Quellen werden gesucht …';$('knowledgeEvidence').innerHTML='';$('knowledgeNotice').textContent='';searchEntries=[];
    try{const data=await request('ask',{question,domain:$('knowledgeDomain').value||null,project:$('knowledgeProject').value||null});$('knowledgeAnswer').textContent=data.answer;
      searchEntries=data.results;
      $('knowledgeEvidence').innerHTML=data.results.map((r,i)=>`<article class="knowledge-source"><b>[${i+1}] ${esc(labels[r.domains[0]]||r.domains[0])} · ${esc(r.project)} · ${esc(r.kind)}</b>${r.sources.map(s=>`<p>${esc(s.title)} · ${esc(s.locator)}${s.section?' · '+esc(s.section):''}<br><small>Dokumentversion ${esc(s.version?.slice(0,12))}</small></p>`).join('')}<button data-knowledge-review="${esc(r.id)}">Prüfen / korrigieren</button></article>`).join('');
      $('knowledgeNotice').textContent=data.notice+(data.missingSources.length?' Fehlende Unterlagen: '+data.missingSources.join('; '):'');
    }catch(e){$('knowledgeAnswer').textContent=e.message;}finally{$('knowledgeAsk').disabled=false;}
  }
  function openReview(id){selected=pending.find(e=>e.id===id)||searchEntries.find(e=>e.id===id);if(!selected)return;$('knowledgeCorrection').value=selected.text;$('knowledgePersonalApproval').checked=false;$('knowledgeConflictApproval').checked=false;$('knowledgeReviewStatus').textContent='';$('knowledgeReviewModal').classList.add('open');}
  async function review(action){if(!selected)return;document.querySelectorAll('[data-knowledge-action]').forEach(b=>b.disabled=true);
    try{await request('review',{id:selected.id,action,text:$('knowledgeCorrection').value,expectedVersion:selected.version,allowPersonal:$('knowledgePersonalApproval').checked,resolveConflict:$('knowledgeConflictApproval').checked});$('knowledgeReviewModal').classList.remove('open');selected=null;await load();if($('knowledgeQuestion').value.trim().length>=3)await ask();}
    catch(e){$('knowledgeReviewStatus').textContent=e.message;}finally{document.querySelectorAll('[data-knowledge-action]').forEach(b=>b.disabled=false);}
  }
  $('knowledgeAsk').onclick=ask;$('knowledgeReload').onclick=load;
  $('knowledgePending').onclick=e=>{const button=e.target.closest('[data-knowledge-review]');if(button)openReview(button.dataset.knowledgeReview);};
  $('knowledgeEvidence').onclick=e=>{const button=e.target.closest('[data-knowledge-review]');if(button)openReview(button.dataset.knowledgeReview);};
  $('knowledgeReviewClose').onclick=()=>$('knowledgeReviewModal').classList.remove('open');
  document.querySelectorAll('[data-knowledge-action]').forEach(b=>b.onclick=()=>review(b.dataset.knowledgeAction));
  document.querySelector('[data-tab="projectKnowledge"]').addEventListener('click',()=>{if(!loaded)load();});
  $('knowledgeExport').onclick=async()=>{try{const data=await request('export');const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='marcel-knowledge-private.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(e){$('knowledgeStatus').textContent=e.message;}};
})();
