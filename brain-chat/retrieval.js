import {rankEntries} from '../brain-knowledge/search.js';
import {secretRisk,sensitive} from '../brain-knowledge/model.js';

export function createBrainRetrieval({repository,readMemory=async()=>[],readLiveState=async()=>null}) {
  let snapshot,loadedAt=0;
  return async function retrieve({text,history=[],allowPersonal=false}) {
    if(!snapshot||Date.now()-loadedAt>15000){
      const [entries,documents,evidence]=await Promise.all(['entries','documents','evidence'].map(n=>repository.list(n)));
      snapshot={entries,documents:new Map(documents.map(d=>[d.id,d])),evidence};loadedAt=Date.now();
    }
    const publicText=/homepage|öffentlich|biografie|website|about.me/i.test(history.map(m=>m.content).join(' ')+' '+text);
    const followup=/^(mach|lass|jetzt|kürzer|länger|noch|auf englisch|übersetz|welche meiner|und |mehr |weniger )/i.test(text);
    const context=followup?history.filter(m=>m.role==='user').slice(-3).map(m=>m.content).join(' ').slice(-3000):'';
    const query=(context+' '+text).trim().slice(-4000);
    const specs=[];
    const add=(domain,q=query,project=null)=>specs.push({domain,question:q.slice(0,1900),project,limit:4,includeHistory:/historisch|damals|session.*2026|früher/i.test(text)});
    if(/homepage|persönlich|biografie|wer (?:bin|ist)|beschreib (?:mich|marcel)|meine.*projekte|über mich|über marcel|schreibstil/i.test(query)){add('MARCEL_DNA','Marcel Persönlichkeit Humor Kommunikationsstil Interessen Arbeitsweise');add('BUSINESS','LUXE Boutique Nairobi Onlineshop','luxe');add('BUSINESS','Barber Männerpflege Produkte','barber');}
    if(/social|instagram|tiktok|facebook|reel|content|caption/i.test(query))add('SOCIAL_MEDIA');
    if(/video|media|schnitt|voice|stimme|audio/i.test(query))add('MEDIA_AI');
    if(/trading|gold|nasdaq|dow|fundamental/i.test(query))add('TRADING');
    if(/architektur|rechner|hardware|brain|technik|migration/i.test(query))add('MASTER_BRAIN_ARCHITECTURE');
    if(/luxe/i.test(query))add('BUSINESS',query,'luxe');
    if(/barber/i.test(query))add('BUSINESS',query,'barber');
    if(!specs.length)add(null);
    const eligible=snapshot.entries.filter(e=>!secretRisk(e.text)&&(!e.personal||allowPersonal&&e.reviewedBy==='owner')&&(!publicText||!e.personal&&!sensitive(e.text))&&!/intimate|third.party/.test(e.sensitivity||''));
    const found=new Map();
    for(const spec of specs)for(const {entry,score}of rankEntries(eligible,spec))if(!found.has(entry.id))found.set(entry.id,{entry,score});
    const sources=[];let used=0;
    for(const {entry}of found.values()){
      const text=entry.text.slice(0,1700);if(sources.length>=12||used+text.length>14000)break;
      const evidence=snapshot.evidence.filter(e=>e.entryId===entry.id).slice(0,2);
      sources.push({id:entry.id,text,kind:entry.kind,project:entry.project,personal:entry.personal,documents:evidence.map(e=>({title:snapshot.documents.get(e.documentId)?.title||'Wissenseintrag',locator:e.locator,date:snapshot.documents.get(e.documentId)?.effectiveDate||null}))});used+=text.length;
    }
    const warnings=[];
    if(allowPersonal){
      try{
        const memories=await readMemory();
        const ranked=memories.filter(m=>m.human_verified===true&&m.allowed_for_bot===true&&!/intimate/.test(m.sensitivity||'')&&(!m.valid_until||Date.parse(m.valid_until)>Date.now())).map(m=>({id:'memory:'+m.id,text:JSON.stringify(m.memory_value),kind:'confirmed_memory',project:'marcel',personal:true,documents:[{title:'Bestätigtes Marcel Memory',locator:m.memory_key}],domains:['MARCEL_DNA'],topics:[],status:'active',reviewRequired:false}));
        for(const {entry}of rankEntries(ranked,{question:query.slice(0,1900),limit:4}))if(!publicText&&!secretRisk(entry.text)&&sources.length<12)sources.push({id:entry.id,text:entry.text.slice(0,1700),kind:entry.kind,project:'marcel',personal:true,documents:entry.documents});
        if(/aktuell|wo bin|zustand|wohnort/i.test(text)&&!publicText){const state=await readLiveState();if(state)sources.push({id:'live-state',kind:'reported_live_state',text:JSON.stringify(state).slice(0,1500),project:'marcel',personal:true,documents:[{title:'Marcel Live State',locator:'id:1',date:state.updated_at||null}]});}
      }catch{warnings.push('Bestätigtes Memory und Live State sind lokal nicht angebunden. Dokumentenwissen bleibt verfügbar.');}
    }
    if(!sources.length)warnings.push('Keine passenden freigegebenen persönlichen Quellen gefunden. Offene Review-Einträge werden nicht verwendet.');
    let budget=14000;const bounded=sources.slice(0,12).filter(source=>{if(budget<=0)return false;source.text=source.text.slice(0,budget);budget-=source.text.length;return true;});
    return {sources:bounded,warnings,publicText,currentNews:false};
  };
}
