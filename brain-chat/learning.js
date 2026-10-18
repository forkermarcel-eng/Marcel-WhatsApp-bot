import {hash,normalize,candidateFromBlock,secretRisk} from '../brain-knowledge/model.js';
import {createKnowledgeService} from '../brain-knowledge/service.js';
const error=message=>Object.assign(Error(message),{status:400});
const quote=text=>String(text||'').split('\n').map(line=>'| '+line).join('\n');
export function exportConversationTXT(conversation,turnIds=null){
 if(turnIds&&(!Array.isArray(turnIds)||turnIds.some(id=>!conversation.turns.some(t=>t.id===id))))throw error('Ungültige Abschnittsauswahl.');
 const turns=turnIds?.length?conversation.turns.filter(t=>turnIds.includes(t.id)):conversation.turns;
 return ['MARCEL-BRAIN-CHAT-TXT V1',`GESPRAECH-ID: ${conversation.conversationId}`,`TITEL: ${conversation.title.replace(/[\r\n]/g,' ')}`,`EXPORT-DATUM: ${new Date().toISOString()}`,'Nur ausdrücklich ausgefüllte KORREKTUR-/LERNREGEL-Blöcke werden als offene Review-Vorschläge importiert. Fragen und Antworten sind Gesprächsarchiv, keine bestätigten Tatsachen.','Optionale BEZUG-ID: vorhandene Wissenseintrags-ID (für eine ausdrücklich vorgeschlagene Korrektur).','',...turns.flatMap(turn=>[`=== ABSCHNITT ${turn.id} ===`,`DATUM: ${turn.createdAt}`,`MODUS: ${turn.mode||'model'}`,'FRAGE:',quote(turn.user),'ANTWORT:',quote(turn.assistant),...turn.sources.flatMap(s=>s.documents.map(d=>'QUELLE: '+d.title+' · '+d.locator)), 'BEZUG-ID:','[KORREKTUR]','','[/KORREKTUR]','[LERNREGEL]','','[/LERNREGEL]',''])].join('\n');
}
export function parseLearningTXT(text){
 if(typeof text!=='string'||Buffer.byteLength(text)>512000||!text.replace(/^\uFEFF/,'').startsWith('MARCEL-BRAIN-CHAT-TXT V1\n')&&!text.replace(/^\uFEFF/,'').startsWith('MARCEL-BRAIN-CHAT-TXT V1\r\n'))throw error('Kein gültiger Brain-Lernexport oder Datei zu groß (maximal 512 KB).');
 text=text.replace(/^\uFEFF/,'').replace(/\r/g,'');
 const conversationId=text.match(/^GESPRAECH-ID: ([\da-f-]{36})$/m)?.[1];if(!conversationId)throw error('Gesprächskennung fehlt.');
 const proposals=[];let section=null,reference=null,type=null,lines=[];
 for(const line of text.split('\n')){
  const header=line.match(/^=== ABSCHNITT ([\da-f-]{36}) ===$/);
  if(header){if(type)throw error('Nicht abgeschlossener Lernblock.');section=header[1];reference=null;continue;}
  if(line.startsWith('| '))continue; // quoted chat text can never become an import directive
  if(/^BEZUG-ID:/.test(line)&&!type){reference=line.slice(9).trim()||null;continue;}
  if(/^\[(KORREKTUR|LERNREGEL)\]$/.test(line)){
   if(!section||type)throw error('Lernblock außerhalb eines Abschnitts oder verschachtelt.');type=line.slice(1,-1);lines=[];continue;
  }
  if(/^\[\/(KORREKTUR|LERNREGEL)\]$/.test(line)){
   if(!type||line!==`[/${type}]`)throw error('Ungültiger Abschluss eines Lernblocks.');
   const value=normalize(lines.join('\n'));if(value){if(value.length>5000||secretRisk(value))throw error('Lernvorschlag zu lang oder möglicherweise mit Zugangsdaten.');proposals.push({conversationId,turnId:section,type,text:value,reference});}type=null;continue;
  }
  if(type)lines.push(line);
 }
 if(type)throw error('Nicht abgeschlossener Lernblock.');if(proposals.length>100)throw error('Maximal 100 Lernvorschläge pro Import.');
 return {conversationId,proposals,previewHash:hash(proposals)};
}
export function createLearningImport({repository,chat}){
 const prepare=async text=>{
  const parsed=parseLearningTXT(text),conversation=await chat.get(parsed.conversationId);
  for(const p of parsed.proposals){if(!conversation.turns.some(t=>t.id===p.turnId))throw error('Ein Abschnitt gehört nicht zum gespeicherten Gespräch.');if(p.reference&&!await repository.get('entries',p.reference))throw error('Die bezogene Wissenseintrags-ID existiert nicht.');}
  return parsed;
 };
 return {preview:prepare,async import({text,previewHash}){
  const parsed=await prepare(text);if(previewHash!==parsed.previewHash)throw error('Datei seit der Vorschau verändert. Bitte erneut prüfen.');
  const sources=parsed.proposals.map(p=>{const contentHash=hash([p.conversationId,p.turnId,p.type,p.text,p.reference]),source={id:contentHash,path:'brain-learning://'+p.conversationId+'/'+p.turnId+'/'+p.type+'/'+contentHash,title:p.type==='LERNREGEL'?'Manuelle Lernregel':'Manuelle Korrektur',contentHash,project:'marcel',domains:['MARCEL_DNA','PERSONAL_KNOWLEDGE'],knowledgeLayer:'MARCEL_MEMORY',status:'processed',reviewAll:true,authority:'explicit_owner_edited_chat_export',effectiveDate:new Date().toISOString().slice(0,10),blocks:[{text:p.text.length<35?`${p.type==='LERNREGEL'?'Manuelle Lernregel':'Manuelle Korrektur'} aus Gespräch: ${p.text}`:p.text,locator:'conversation:'+p.conversationId+'/turn:'+p.turnId,section:p.type}]};return{source,proposal:p};});
  if(!sources.length)return{created:0,known:0,pending:0,proposals:0};
  const stats=await createKnowledgeService(repository).ingest(sources.map(s=>s.source));
  await repository.transaction(async tx=>{
   for(const {source,proposal}of sources){if(!proposal.reference)continue;const candidate=candidateFromBlock(source,source.blocks[0]),entry=await tx.get('entries',candidate.id);if(entry.reviewedBy==='owner')continue;
    await tx.put('entries',{...entry,status:'conflict',reviewRequired:true,reviewReason:'explicit_manual_correction',conflictsWith:[...new Set([...(entry.conflictsWith||[]),proposal.reference])]});
    await tx.put('relations',{id:hash([entry.id,proposal.reference,'proposed_correction']),from:entry.id,to:proposal.reference,type:'proposed_correction',resolution:'owner_review_pending'});
   }
  });
  return {created:stats.created,known:stats.duplicates,pending:stats.pending,proposals:parsed.proposals.length};
 }};
}
