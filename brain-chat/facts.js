// Deterministic intent and formatting; values always come from approved Memory.
import {secretRisk} from '../brain-knowledge/model.js';
const normalize=s=>String(s||'').normalize('NFKD').replace(/\p{Diacritic}/gu,'').toLowerCase().replace(/ß/g,'ss');
const fields=[
 {id:'height',keys:['height','height_cm','body_height','body_height_cm','koerpergroesse','körpergröße'],pattern:/\b(?:wie gross|korpergrosse|koerpergroesse|grosse)\b/,properties:['centimeters','centimetres','height_cm','cm'],unit:'cm'},
 {id:'weight',keys:['weight','weight_kg','body_weight','koerpergewicht'],pattern:/\b(?:wie schwer|korpergewicht|koerpergewicht|gewicht)\b/,properties:['kilograms','weight_kg','kg'],unit:'kg'},
 {id:'languages',keys:['languages','spoken_languages','language_skills'],pattern:/\b(?:sprachen|sprichst|spreche|spricht)\b/,properties:['languages','spoken_languages','fluent'],unit:null}
];
export function factIntent(text){const q=normalize(text);if(!/\b(?:marcel|marcels|ich|mein|meine|meiner)\b/.test(q)||/\b(?:frau|freundin|freund|partnerin|partner|kind|kinder|tochter|sohn|kontakt|firma|unternehmen|datenbank|tabelle|projekt|erinnerst|damals|fruher|historisch)\b/.test(q))return null;return fields.find(f=>f.pattern.test(q))||null;}
function format(memory,field){let value=memory.memory_value;if(typeof value==='string'){try{value=JSON.parse(value);}catch{}}
 if(field.id==='languages'&&value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).every(v=>typeof v==='boolean')){const labels={german:'Deutsch',english:'Englisch',spanish:'Spanisch',french:'Französisch',italian:'Italienisch'};value=Object.entries(value).filter(([,spoken])=>spoken).map(([language])=>labels[language]||language);}
 if(value&&typeof value==='object'&&!Array.isArray(value)){const key=field.properties.find(k=>value[k]!=null);value=key?value[key]:value.value??null;}
 if(field.unit){if(typeof value==='string'&&/^\d+(?:[.,]\d+)?(?:\s*(?:cm|kg))?$/.test(value))value=Number(value.replace(',','.').replace(/\s*(cm|kg)$/,''));if(typeof value!=='number'||!Number.isFinite(value)||value<=0)return null;return new Intl.NumberFormat('de-DE',{maximumFractionDigits:2}).format(value)+' '+field.unit+'.';}
 if(Array.isArray(value)&&value.length<=15&&value.every(v=>typeof v==='string'&&v.length<80))value=value.join(', ');
 return typeof value==='string'&&value.trim().length>0&&value.length<250&&!secretRisk(value)?value.replace(/[.!?]+$/,'')+'.':null;
}
export function answerFact(memories,field,now=Date.now()){
 const rows=memories.filter(m=>m.human_verified===true&&m.allowed_for_bot===true&&(!m.status||m.status==='active')&&!/intimate|third.party/.test(m.sensitivity||'')&&(!m.valid_until||Date.parse(m.valid_until)>now)&&field.keys.includes(m.memory_key));
 const answers=rows.map(row=>({row,answer:format(row,field)})).filter(x=>x.answer),unique=new Set(answers.map(x=>x.answer));
 if(unique.size>1)return {answer:'Dazu liegen widersprüchliche bestätigte Angaben vor. Bitte im Review prüfen.',sources:[],warnings:['conflicting_confirmed_memory']};
 if(!answers.length)return {answer:'Dazu liegt kein gültiger, freigegebener Fakt vor.',sources:[],warnings:['missing_approved_memory']};
 const {row,answer}=answers[0];return {answer,sources:[{id:'memory:'+row.id,text:answer,kind:'confirmed_memory',personal:true,project:'marcel',documents:[{title:'Bestätigtes Marcel Memory',locator:row.memory_key,date:row.updated_at||null}]}],warnings:[]};
}
