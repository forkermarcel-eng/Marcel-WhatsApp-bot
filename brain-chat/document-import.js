import {extname} from 'node:path';
import {extractBytes,contextualBlocks} from '../brain-knowledge/extract.js';
import {hash,candidateFromBlock} from '../brain-knowledge/model.js';
import {createKnowledgeService} from '../brain-knowledge/service.js';
const invalid=message=>Object.assign(Error(message),{status:400});
// No extraction models, embeddings or executable document instructions.
export function createDocumentImport(repository){
 const prepare=async({name,base64,purpose='reference'})=>{
  if(!['reference','style','transcript'].includes(purpose))throw invalid('Unbekannter Importzweck.');
  if(typeof name!=='string'||typeof base64!=='string'||base64.length>1800000||!/^[A-Za-z0-9+/]*={0,2}$/.test(base64))throw invalid('Datei ungültig oder zu groß (maximal 1 MB).');
  const title=name.replace(/[\\/\r\n\x00-\x1f]/g,'_').slice(0,180),extension=extname(title).toLowerCase();
  if(!['.txt','.md','.docx','.json','.epub'].includes(extension))throw invalid('Hier sind TXT, Markdown, DOCX, EPUB und JSON möglich. PDF benötigt den vorhandenen lokalen Import mit pdftotext; keine automatische OCR.');
  const bytes=Buffer.from(base64,'base64');if(bytes.length>1024*1024)throw invalid('Datei überschreitet 1 MB.');
  const contentHash=hash(bytes),source={id:hash(['manual-upload',contentHash,purpose]),contentHash,path:'brain-upload://'+contentHash+'/'+purpose,title,project:'marcel',authority:'manual_document_upload',kind:purpose==='style'?'style_reference':purpose==='transcript'?'unverified_transcript':'source_reference',knowledgeLayer:purpose==='style'?'MARCEL_MEMORY':'KNOWLEDGE_LIBRARY',status:'processed',reviewAll:true,blocks:contextualBlocks(extractBytes(bytes,extension))};
  const candidates=source.blocks.map(b=>candidateFromBlock(source,b)).filter(Boolean),entries=await repository.list('entries');
  return {source,preview:{previewHash:hash([contentHash,title,purpose]),title,purpose,sections:candidates.length,known:candidates.filter(c=>entries.some(e=>e.id===c.id)).length,items:candidates.slice(0,8).map(c=>({text:c.text,reviewRequired:true}))}};
 };
 return {async preview(input){return (await prepare(input)).preview;},async import(input){const {source,preview}=await prepare(input);if(input.previewHash!==preview.previewHash)throw invalid('Datei seit Vorschau verändert.');if(!preview.sections)throw invalid('Keine importierbaren Wissensabschnitte gefunden.');
  const previous=await repository.get('documents',source.id);if(previous)return{created:0,known:preview.sections,pending:0,alreadyImported:true};
  const stats=await createKnowledgeService(repository).ingest([source]);return{created:stats.created,known:stats.duplicates,pending:stats.pending};
 }};
}
