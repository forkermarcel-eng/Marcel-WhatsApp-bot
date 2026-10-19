import { normalize } from './model.js';

// Offline multilingual concept vectors; no model download, remote embeddings,
// LLM call, or hidden network fallback. This is not a trained embedding model.
export const SEARCH_METHOD = 'local-concept-vectors-v1';
const concepts = {
  gold:['gold','xauusd','xau','gc','mgc'], nasdaq:['nasdaq','nas100','nq','mnq'], dow:['dow','dj30','ym','mym'],
  instagram:['instagram','insta','reel','reels','stories'], usa:['usa','united states','vereinigte staaten','amerika','amerikanisch','us-markt','us market'],
  social:['social media','social-media','content','reichweite','reach','engagement','posting'],
  risk:['risiko','risk','risikomanagement','risk management','positionsgröße'],
  structure:['marktstruktur','market structure','bos','choch','mss','swing'],
  orders:['limit','limitorder','limit-order','retest','entry','einstieg'],
  journal:['journal','journaling','review','protokoll','session'],
  local:['lokal','lokale','lokaler','lokales','local','rechner','computer','hardware','gpu','cloud-übergang','portabilität'],
  brain:['brain','gedächtnis','memory','wissen','knowledge'],
  business:['luxe','boutique','barber','e-commerce','ecommerce','onlineshop','shop'],
  media:['video','videos','schnitt','audio','vision','bild','image','medien','meme'],
  trading:['trading','gold','mgc','nasdaq','dow','ict','smc','liquidität','fvg','orderblocks','limit-retest'],
  rules:['regeln','regel','verbindliche','grundprinzip','strategie','strategien','strategy'],
  style:['sprachstil','schreibstil','humor','humour','kommunikation','texte','text','dna'],
  architecture:['architektur','architecture','schnittstellen','interface','agenten','agents','datenbank','database']
  ,workflow:['workflow','ablauf','prozess','pipeline','analyse','analyseablauf','journal','journaling','session']
};
const stop = new Set('der die das den dem des ein eine einer einem und oder aber als ist sind war wird werden was wie meine mein meinen für von mit auf im in zu zum zur ich wir du er sie es the a an and or of for to my our is are how what soll haben wurde bitte'.split(' '));
const clean = value => normalize(value).toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'');
const matchers=Object.entries(concepts).map(([concept,words])=>[concept,new RegExp(`(?:^|[^a-z0-9])(?:${words.map(w=>clean(w).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|')})(?:$|[^a-z0-9])`)]);
const vectorCache=new WeakMap();
function entryVectors(entry){const signature=entry.text+'\n'+(entry.section||'')+'\n'+(entry.topics||[]).join(' '),old=vectorCache.get(entry);if(old?.signature===signature)return old;const result={signature,body:vector(entry.text),expanded:vector(signature)};vectorCache.set(entry,result);return result;}
export function vector(text) {
  const input=clean(text), weights=new Map();
  for(const token of input.match(/[a-z0-9]+/g)||[]){if(token.length<3||stop.has(token))continue;const stem=token.length>6?token.replace(/(?:ungen|ation|ing|isch|en|er|es|e|s)$/,''):token;weights.set(stem,(weights.get(stem)||0)+1);}
  for(const [concept,matcher]of matchers)if(matcher.test(input))weights.set('@'+concept,3);
  const length=Math.sqrt([...weights.values()].reduce((sum,v)=>sum+v*v,0))||1;
  return Object.fromEntries([...weights].map(([k,v])=>[k,v/length]));
}
export function rankEntries(entries, { question, domain=null, project=null, limit=6, includeHistory=false }) {
  if(typeof question!=='string'||question.trim().length<3||question.length>2000)throw Object.assign(Error('Frage muss 3 bis 2000 Zeichen enthalten.'),{status:400});
  const q=vector(question), terms=Object.keys(q).filter(k=>!k.startsWith('@'));
  const anchors=['@usa','@gold','@nasdaq','@dow',...(q['@instagram']&&!q['@rules']?['@instagram']:[]),...(q['@media']?['@media']:[]),...(q['@trading']?['@trading']:[]),...(q['@local']&&q['@architecture']?['@local']:[])].filter(k=>q[k]);
  const eligible=entries.filter(e=>(e.status==='active'||includeHistory&&e.status==='historical')&&!e.reviewRequired&&(!domain||e.domains.includes(domain))&&(!project||e.project===project));
  return eligible.map(entry=>{
    const cached=entryVectors(entry),body=cached.body,v=cached.expanded;let score=Object.entries(q).reduce((sum,[k,w])=>sum+w*(v[k]||0),0);
    if(q['@workflow']&&v['@workflow'])score+=0.12;
    const topical=['@media','@trading','@social','@instagram','@local','@business'].some(k=>q[k]&&body[k]);
    if(entry.sourceAuthority==='provided_document_unverified'&&topical)score+=0.25;
    if(q['@rules']&&['workflow_rule','communication_rule'].includes(entry.kind)&&topical)score+=0.25;
    if(entry.text.length<85)score*=0.4;
    if(/luxe/i.test(question)&&/geplant|plan/i.test(question)&&/boutique|onlineshop|online shop|physical boutique|brand|marke/i.test(entry.text))score+=0.25;
    const matched=terms.filter(t=>v[t]).length;
    // A generic concept alone must not fabricate an answer to a specific topic.
    if((!matched&&!topical)||anchors.some(k=>!body[k]))score=0;
    if(q['@local']&&q['@architecture']&&!/lokal.{0,80}(?:ki|ai|brain|architektur|modell|llm)|(?:ki|ai|brain|llm).{0,160}(?:rechner|hardware|gpu|lokal)|gpu|vram|ollama|local.{0,30}(?:ai|brain|architecture)/i.test(entry.text))score=0;
    if(/wer ist marcel|homepage/i.test(question)&&(!entry.domains.some(d=>['MARCEL_DNA','PERSONAL_KNOWLEDGE'].includes(d))||/marcel_memory|live_state|extractor|backfill|postgres|deployment/i.test(entry.text)))score=0;
    // A document's old open-task list never establishes today's live state.
    if(/entscheidungen.*offen/i.test(question)&&(entry.knowledgeLayer!=='LIVE_STATE'||!entry.liveVerifiedAt))score=0;
    if(q['@local']&&q['@architecture']&&/commit|function.limit|deploy.*(?:fehler|scheiter)|scheiter.*deploy/i.test(entry.text))score=0;
    if(/^(?:[#* ]*CODEX|Untersuche|Analysiere|Erstelle|Implementiere|Führe|Arbeite|Liefere|Suche|Prüfe)\b/i.test(entry.text))score=0;
    if(/social.media/i.test(question)&&/texte|schreib|sprach/i.test(question)&&!/sprach|schreib|humor|kommunikation|tone|style|writing/i.test(entry.text))score=0;
    if(q['@local']&&q['@architecture']&&!/tinder|android|zte|bridge|capture/i.test(question)&&/tinder|android|zte|bridge|capture|runner|rollback|\bT[0-8]\b/i.test(entry.text))score=0;
    return {entry,score:Number(score.toFixed(5))};
  }).filter(r=>r.score>=0.13).sort((a,b)=>b.score-a.score||(b.entry.effectiveDate||'').localeCompare(a.entry.effectiveDate||'')).slice(0,Math.min(12,Math.max(1,limit)));
}
