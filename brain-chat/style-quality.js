import lexicalIllusions from './vendor/write-good/lexical-illusions.cjs';
import plainProse from './vendor/plain-prose/check.cjs';
import {STYLE_PATTERNS} from './style-patterns.js';
const blank=s=>s.replace(/[^\r\n]/g,' ');
const normalize=s=>s.normalize('NFC').toLowerCase().replace(/\s+/g,' ').trim();
const words=s=>s.match(/[\p{L}\p{N}]+/gu)||[];
function mask(text){
 return text.replace(/```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|`[^`]*`|https?:\/\/\S+|"[^"\n]*"|“[^”\n]*”|«[^»\n]*»|„[^“\n]*“/g,blank).replace(/^\s*>.*$/gm,blank);
}
const protectedFact=s=>/\d|\b(?:port|api|sql|http|database|datenbank|password|passwort|contraseña|senha|safety|warning|warnung|sicherheit|seguridad|segurança|never|niemals|nunca|nicht löschen|do not delete|no borrar|não apague)\b/iu.test(s);
const repeatRequest=s=>/wiederhol|noch einmal|erneut|repeat|restate|again|übersetz|translate|traduce|traduza|repit|repet|literal|wörtlich|quote|cita|confirm|bestätig/iu.test(s);
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function sentences(text,locale){return [...new Intl.Segmenter(locale,{granularity:'sentence'}).segment(text)].map(s=>({text:s.segment.trim(),start:s.index+s.segment.indexOf(s.segment.trim())})).filter(s=>s.text);}
function summary(findings){return{info:findings.filter(f=>f.severity==='info').length,warning:findings.filter(f=>f.severity==='warning').length};}
// Observes only our own newly generated prose. Never rewrites or rejects it.
export function observeStyle(text,locale,{previous=[],userText='',origin='model',register='casual',literal=false}={}){
 const findings=[],result={version:1,mode:'observe',locale,status:'checked',findings,summary:summary(findings)};
 if(origin!=='model'||literal){return{...result,status:'skipped',reason:literal?'literal_content':'source_or_knowledge_output'};}
 const table=STYLE_PATTERNS[locale];if(!table)return{...result,status:'skipped',reason:'unsupported_locale'};
 if(typeof text!=='string')return{...result,status:'skipped',reason:'invalid_text'};
 const bounded=text.slice(0,60000),prose=mask(bounded),history=previous.filter(t=>t.status==='complete'&&(!t.language?.locale||t.language.locale===locale)).slice(-3);
 const add=(rule,severity,start,end,reason,source='brain-observer')=>{
  if(findings.length>=24||findings.some(f=>f.rule===rule&&f.start===start))return;
  findings.push({rule,severity,start,end,reason,source});
 };
 const phrases=[];
 for(const[category,list]of Object.entries(table))for(const phrase of list){
  const re=new RegExp(`(?<![\\p{L}])${escape(phrase).replace(/ /g,'\\s+')}(?![\\p{L}])`,'giu');
  for(const m of prose.matchAll(re)){if(phrases.length>=128)break;phrases.push({category,start:m.index,end:m.index+m[0].length});}
 }
 for(const hit of phrases){
  const group=phrases.filter(p=>p.category===hit.category),density=phrases.filter(p=>p.category!=='regional').length;
  if(hit.category==='agreement'){
   const match=normalize(prose.slice(hit.start,hit.end));
   const opener=s=>new RegExp(`^\\s*${escape(match)}\\s*[!.,:]`,'iu').test(s);
   if(hit.start>3||!opener(prose)||history.filter(t=>opener(mask(String(t.assistant||'')))).length<2)continue;
   add('repeated_confirmation','info',hit.start,hit.end,'Dieselbe Bestätigung eröffnet mindestens drei nahe Antworten; Berechtigung prüfen.');continue;
  }
  if(hit.category==='enthusiasm'){
   if(group.length<2&&density<3)continue;
   add('enthusiasm_cluster','info',hit.start,hit.end,'Gehäufte Begeisterungsformeln; ohne Kontext kein Urteil über echte Emotion.');continue;
  }
  // A single connector, politeness or regional variant is normal language.
  if(hit.category==='transition'&&group.length<3)continue;
  if(hit.category==='regional'){
   if(group.length<2)continue;
   add('regional_register_review','info',hit.start,hit.end,'Mehrere Varianten außerhalb des gewählten Regionalprofils; Zielgruppe und Zitate prüfen.','DialectOS / curated locale profiles');continue;
  }
  if(hit.category==='question'){
   if(register==='personal'||!prose.slice(hit.end).trim().match(/^[?¿! .]*$/u))continue;
   add('generic_followup','info',hit.start,hit.end,'Generische Abschlussfrage; Notwendigkeit im Gespräch prüfen.');continue;
  }
  add(hit.category==='transition'?'transition_density':hit.category==='praise'?'stock_praise_or_agreement':hit.category==='closing'?'stock_closing':'stock_preamble',density>=3?'warning':'info',hit.start,hit.end,'Formelhafte Gesprächsphrase; situationsgerechte Verwendung ist erlaubt.','curated open-source rules');
 }
 if(locale==='en-US')for(const hit of lexicalIllusions(prose))add('repeated_word','info',hit.index,hit.index+hit.offset,'Unmittelbar wiederholtes Wort; kann auch beabsichtigt sein.','write-good');
 // Reuse the existing checker as an advisory phrase-density signal only, not
 // its AI score, broad word bans, punctuation rules or author classification.
 if(['de-DE','en-US'].includes(locale)&&phrases.filter(p=>p.category!=='regional').length>=3){
  const check=plainProse.analyse(prose,{lang:locale==='de-DE'?'de':'en',context:register==='technical'?'technical':'casual',skipQuotes:true});
  if(check.findings.some(f=>['P0','P1'].includes(f.level)))add('phrase_cluster','warning',0,Math.min(bounded.length,240),'Mehrere mechanische Formulierungen gemeinsam; kein Herkunfts- oder Qualitätsurteil über einzelne Wörter.','plain-prose');
 }
 const current=sentences(prose,locale),old=history.map(t=>sentences(mask(String(t.assistant||'').slice(0,60000)),locale));
 const oldKeys=new Set(old.flatMap(list=>list.map(p=>normalize(p.text))));
 const user=sentences(mask(String(userText).slice(0,6000)),locale);
 const necessary=repeatRequest(userText);
 if(!necessary){
  const seen=new Set();
  for(let i=0;i<current.length;i++){
   const s=current[i],key=normalize(s.text);if(words(s.text).length<6||protectedFact(s.text))continue;
   if(seen.has(key))add('repeated_sentence','warning',s.start,s.start+s.text.length,'Derselbe Satz steht mehrfach in dieser Antwort.');
   seen.add(key);
   const same=oldKeys.has(key);
   if(same)add(i===0?'repeated_opening':i===current.length-1?'repeated_closing':'repeated_information','info',s.start,s.start+s.text.length,'Wörtliche Wiederholung aus einer der letzten drei Antworten; inhaltliche Notwendigkeit prüfen.');
   if(words(s.text).length>=8&&user.some(p=>normalize(p.text)===key))add('possible_user_echo','info',s.start,s.start+s.text.length,'Längerer Benutzersatz wörtlich übernommen; mögliche unnötige Spiegelung.');
  }
 }
 if(current.length>=6&&words(prose).length>=90&&register==='casual'){
  const lengths=current.map(s=>words(s.text).length),average=lengths.reduce((a,b)=>a+b,0)/lengths.length;
  if(average>=12&&lengths.every(n=>Math.abs(n-average)<=2)&&phrases.length>=3)add('uniform_sentence_rhythm','info',0,Math.min(bounded.length,240),'Viele ähnlich lange Sätze zusammen mit weiteren Mustern; Rhythmus prüfen.','humanize / adapted');
 }
 if(words(prose).length>160&&/kurz|knapp|brief|short|breve|curto|conciso/iu.test(userText)&&!protectedFact(prose)&&!repeatRequest(userText))add('length_mismatch','info',0,Math.min(bounded.length,240),'Lange Antwort trotz Kürzewunsch; notwendige Details können dies rechtfertigen.');
 return{...result,summary:summary(findings),truncated:text.length>bounded.length};
}
// Keep existing turn.styleChecks consumers compatible; richer observations are
// stored alongside this field. No sentence or word is removed.
export function styleDiagnostics(text,locale,previous=[]){
 return [...new Set(observeStyle(text,locale,{previous}).findings.map(f=>f.rule))];
}
