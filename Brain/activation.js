/* Symbolic visual context only. No inference service, memory write or emotion telemetry. */
(()=>{
 const modes={knowledge:'Wissen & Recherche',analysis:'Analyse & Trading',creative:'Kreativität & Social',romance:'Nähe & Verbindung',planning:'Planung & Projekte'};
 const domainModes={trading:'analysis',social_media:'creative',media_ai:'creative',business:'planning',architecture:'planning',master_brain_architecture:'planning'};
 function classify(text,domain=''){const t=text.toLocaleLowerCase('de');if(/flirt|romanti|sinnlich|begehren|verlieb|küssen|liebesbrief/.test(t))return 'romance';if(/trading|trade|aktien|fundamental|marktanalyse|analytisch/.test(t))return 'analysis';if(/instagram|tiktok|social media|kreativ|content|video|design/.test(t))return 'creative';if(/planung|projekt|roadmap|architektur|meilenstein|geschäft/.test(t))return 'planning';return domainModes[domain.toLowerCase()]||'knowledge';}
 function activate(mode,source){if(!Object.hasOwn(modes,mode))return false;document.getElementById('brainChat').dataset.activation=mode;document.getElementById('activationLabel').textContent=modes[mode];document.getElementById('activationSource').textContent=source;document.querySelectorAll('[data-activation]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.activation===mode)));document.dispatchEvent(new CustomEvent('brain-activation',{detail:{mode,source}}));return true;}
 // Symbolic context is derived from existing local conversation/domain rules.
 // No manual activation handler on buttons or the scene container.
 const domain=document.getElementById('chatDomain');domain?.addEventListener('change',()=>activate(classify('',domain.value),'Gewählter Wissensbereich'));
 document.getElementById('chatComposer').addEventListener('submit',()=>{const text=document.getElementById('chatInput').value.trim();if(text)activate(classify(text,domain?.value),'Lokale Stichwortzuordnung');},true);
 document.getElementById('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&e.target.value.trim())activate(classify(e.target.value,domain?.value),'Lokale Stichwortzuordnung');},true);
 document.addEventListener('brain-chat-active',e=>{const turns=e.detail?.turns;if(!turns?.length&&document.getElementById('chatTranscript').getAttribute('aria-busy')==='true')return;if(turns?.length)activate(classify(turns.at(-1).user||'',domain?.value),'Gesprächskontext · lokale Regeln');else activate('knowledge','Wissensmodus');});
 activate('knowledge','Wissensmodus');
})();
