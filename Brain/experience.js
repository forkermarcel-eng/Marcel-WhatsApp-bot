/* Presentation-only coordinator. Existing chat, memory and API handlers stay authoritative. */
(()=>{'use strict';const $=id=>document.getElementById(id),scene=$('brainChat');
 const drawers={history:[$('experienceHistoryPanel'),$('experienceHistory')],tools:[$('experienceToolsPanel'),$('experienceTools')]};let conversationOpen=false;
 function drawer(name,open){for(const [key,[panel,button]]of Object.entries(drawers)){const show=key===name&&open;panel.hidden=!show;button.setAttribute('aria-expanded',String(show));}if(name==='tools'&&open)document.querySelector('.chat-learning').open=true;}
 for(const [name,[panel,button]]of Object.entries(drawers))button.addEventListener('click',()=>drawer(name,panel.hidden));
 document.querySelectorAll('[data-close-drawer]').forEach(b=>b.addEventListener('click',()=>drawer(b.dataset.closeDrawer,false)));
 function conversation(open){conversationOpen=open;$('experienceConversation').hidden=!open;$('experienceConversationToggle').setAttribute('aria-expanded',String(open));scene.classList.toggle('conversation-open',open);document.dispatchEvent(new CustomEvent('brain-scene-view',{detail:{conversationOpen:open}}));}
 $('experienceConversationToggle').onclick=()=>conversation(!conversationOpen);$('experienceConversationClose').onclick=()=>conversation(false);
 $('chatComposer').addEventListener('submit',()=>{if($('chatInput').value.trim()){drawer('',false);conversation(true);}});
 $('chatList').addEventListener('click',e=>{if(e.target.closest('button')){drawer('',false);conversation(true);}});$('chatNew').addEventListener('click',()=>{drawer('',false);conversation(true);});
 document.addEventListener('keydown',e=>{if(e.key==='Escape'){drawer('',false);conversation(false);}});
 $('experienceReview').onclick=()=>{$('search').value='';$('search').dispatchEvent(new Event('input'));document.querySelector('[data-tab="review"]').click();$('reviewGrid').scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});};
 document.addEventListener('brain-memory-review-count',e=>{$('experienceReviewCount').textContent=String(e.detail.count);});
 const screen=matchMedia('(max-width:720px)');function searchPlacement(){(screen.matches?$('experienceAdminTools'):document.querySelector('.header .tools')).prepend($('search'));}screen.addEventListener('change',searchPlacement);searchPlacement();document.body.dataset.brainView='brainChat';
 function activity(){const busy=$('chatTranscript').getAttribute('aria-busy')==='true',error=$('chatStatus').classList.contains('error');scene.dataset.activity=error?'error':busy?'loading':'idle';document.dispatchEvent(new CustomEvent('brain-scene-activity',{detail:{state:scene.dataset.activity}}));}
 new MutationObserver(activity).observe($('chatTranscript'),{attributes:true,attributeFilter:['aria-busy']});new MutationObserver(activity).observe($('chatStatus'),{attributes:true,childList:true});activity();
 document.querySelectorAll('.tab').forEach(b=>b.addEventListener('click',()=>{document.body.dataset.brainView=b.dataset.tab;document.dispatchEvent(new CustomEvent('brain-scene-visible',{detail:{visible:b.dataset.tab==='brainChat'}}));}));
 document.addEventListener('brain-chat-active',e=>{const count=e.detail?.turns?.length||0;$('experienceConversationToggle').firstChild.textContent=count?'Gespräch fortsetzen ':'Gespräch öffnen ';});
 // Small public surface for future *implemented* scenes. No placeholder modules or simulated data.
 const scenes=new Map([['brain',{element:scene,onEnter:()=>document.querySelector('[data-tab=brainChat]').click()}]]);window.MarcelBrainScenes=Object.freeze({register(id,config){if(!id||scenes.has(id)||!config?.element)throw Error('Gültige, eindeutige Szene erforderlich.');scenes.set(id,config);},open(id){const entry=scenes.get(id);if(!entry)return false;for(const [key,s]of scenes)s.element.hidden=key!==id;entry.onEnter?.();return true;},available:()=>[...scenes.keys()]});
})();
