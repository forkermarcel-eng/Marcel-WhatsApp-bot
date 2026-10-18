/* Companion panels consume existing rendered state; no extra memory/model API calls. */
(()=>{
 const $=id=>document.getElementById(id);
 document.querySelectorAll('[data-open-brain-tab]').forEach(button=>button.onclick=()=>document.querySelector('[data-tab="'+button.dataset.openBrainTab+'"]').click());
 document.addEventListener('brain-memory-review-count',e=>{$('neuralMemoryCount').textContent=String(e.detail.total);$('neuralVerifiedCount').textContent=String(e.detail.verified);});
 function recent(){
  const root=$('neuralRecent');root.replaceChildren();const originals=[...$('chatList').querySelectorAll('button')].slice(0,3);
  if(!originals.length){const p=document.createElement('p');p.textContent='Hier erscheinen deine gespeicherten Unterhaltungen.';root.append(p);}
  for(const original of originals){const button=document.createElement('button'),text=document.createElement('span');text.textContent=original.textContent;button.append(text);button.disabled=original.disabled;button.onclick=()=>{if(original.disabled)return;original.click();if($('experienceConversationToggle').getAttribute('aria-expanded')==='false')$('experienceConversationToggle').click();};root.append(button);}
 }
 new MutationObserver(recent).observe($('chatList'),{childList:true,subtree:true,attributes:true,attributeFilter:['disabled']});recent();$('neuralAllConversations').onclick=()=>$('experienceHistory').click();
 const mobile=matchMedia('(max-width:720px)'),dock=document.querySelector('.composer-dock'),root=$('brainChat');
 function fitComposer(){if(mobile.matches&&!root.classList.contains('active'))return;root.style.paddingTop=mobile.matches?(root.dataset.scene==='world'?100:Math.max(720,dock.offsetTop+dock.offsetHeight+22))+'px':'';}
 new ResizeObserver(fitComposer).observe(dock);mobile.addEventListener('change',fitComposer);document.addEventListener('brain-scene-visible',e=>{if(e.detail.visible)fitComposer();});document.addEventListener('brain-world-view',fitComposer);fitComposer();
})();
