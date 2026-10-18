/* Reuses the existing scene registry and the existing globe; no extra rendering engine. */
(()=>{
 const root=document.getElementById('brainChat');
 function view(world){const changed=root.dataset.scene!==(world?'world':'brain');root.dataset.scene=world?'world':'brain';if(changed)window.scrollTo({top:0,behavior:matchMedia('(prefers-reduced-motion:reduce)').matches?'instant':'smooth'});document.querySelectorAll('[data-brain-scene]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.brainScene===(world?'world':'brain'))));document.getElementById('worldInfo').hidden=!world;document.dispatchEvent(new CustomEvent('brain-world-view',{detail:{world}}));}
 window.MarcelBrainScenes.register('world',{element:root,onEnter:()=>{document.querySelector('[data-tab=brainChat]').click();view(true);}});
 document.addEventListener('brain-scene-enter',()=>view(false));
 document.querySelectorAll('[data-brain-scene]').forEach(b=>b.onclick=()=>window.MarcelBrainScenes.open(b.dataset.brainScene));
 document.addEventListener('brain-globe-focus',e=>{const c=e.detail;document.getElementById('worldCityTitle').textContent=c.name;document.getElementById('worldCountry').textContent=c.country;document.getElementById('worldCoordinates').textContent=Math.abs(c.lat).toFixed(2)+'° '+(c.lat<0?'S':'N')+' · '+Math.abs(c.lon).toFixed(2)+'° '+(c.lon<0?'W':'O');if(!c.initial)window.MarcelBrainScenes.open('world');});
 document.querySelector('[data-tab=brainChat]').addEventListener('click',()=>{if(root.dataset.scene!=='world')view(false);});
 view(false);
})();
