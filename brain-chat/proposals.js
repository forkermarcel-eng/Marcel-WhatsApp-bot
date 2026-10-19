import {hash,secretRisk} from '../brain-knowledge/model.js';
const kinds={ENTSCHEIDUNG:'decision',ANFORDERUNG:'requirement',STILREGEL:'communication_rule',LERNREGEL:'communication_rule',WORKFLOW:'workflow',AUFGABE:'task',PRIORITAET:'priority',HISTORIE:'historical',FAKT:'owner_statement',KORREKTUR:'correction'};
// Only explicitly structured messages, never markers buried in quotes or ordinary chat.
export function structuredChatProposals({text,conversationId,requestId,project='marcel'}){
 if(!Object.hasOwn(kinds,text.trim().match(/^\[([A-Z]+)\]/)?.[1]||''))return [];
 if(!['marcel','luxe','barber','trading'].includes(project||'marcel'))throw Object.assign(Error('Unbekanntes Vorschlagsprojekt.'),{status:400});
 const body=text.trim(),pattern=/\[([A-Z]+)\]\s*([\s\S]*?)\s*\[\/\1\]/gy,sources=[];let offset=0;
 while(offset<body.length){pattern.lastIndex=offset;const match=pattern.exec(body);if(!match||!Object.hasOwn(kinds,match[1])||sources.length>=8||/\[\/?[A-Z]+\]/.test(match[2]))throw Object.assign(Error('Ungültige strukturierte Wissensblöcke.'),{status:400});
  const type=match[1],value=match[2].trim();if(!value||secretRisk(value))throw Object.assign(Error('Leerer oder vertraulicher Wissensvorschlag.'),{status:400});
  const contentHash=hash([project||'marcel',type,value]),id=hash([conversationId,requestId,type,contentHash]);
  sources.push({id,contentHash,path:`brain-chat://${conversationId}/${requestId}/${type}/${contentHash}`,title:'Gesprächsvorschlag: '+type,project:project||'marcel',domains:project==='luxe'||project==='barber'?['BUSINESS']:project==='trading'?['TRADING']:['MARCEL_DNA','PERSONAL_KNOWLEDGE'],kind:kinds[type],historical:type==='HISTORIE',knowledgeLayer:project&&project!=='marcel'?'PROJECT_HISTORY':'MARCEL_MEMORY',status:'processed',reviewAll:true,authority:'explicit_owner_structured_chat',blocks:[{text:value.length<35?`${type} aus gespeichertem Gespräch: ${value}`:value,locator:`conversation:${conversationId}/turn:${requestId}`,section:type}]});
  offset=pattern.lastIndex;while(/\s/.test(body[offset]||'')&&offset<body.length)offset++;
 }return sources;
}
