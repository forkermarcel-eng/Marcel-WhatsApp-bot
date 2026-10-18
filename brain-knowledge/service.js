import { candidateFromBlock, hash, DOMAINS, secretRisk, sensitive } from './model.js';
import { rankEntries, SEARCH_METHOD } from './search.js';

export function createKnowledgeService(repository) {
  const error=(text,status=400)=>Object.assign(Error(text),{status});
  return {
    async ingest(sources) {
      const stats={documents:0,created:0,duplicates:0,evidence:0,excluded:0,pending:0,historical:0};
      return repository.transaction(async tx=>{
        const seenCandidates=new Set(),processedDocuments=new Set();
        for(const source of sources){
          const {blocks=[],...document}=source;
          if(!document.id||!document.contentHash||!document.path)throw error('Incomplete source provenance');
          const existing=await tx.get('documents',document.id);
          if(!existing)stats.documents++;
          await tx.put('documents',{...document,importedAt:existing?.importedAt||new Date().toISOString()});
          for(const oldDocument of await tx.list('documents'))if(oldDocument.path===document.path&&oldDocument.id!==document.id&&['processed','missing'].includes(oldDocument.status))await tx.put('documents',{...oldDocument,status:'superseded_source_version',supersededBy:document.id});
          if(['missing','excluded','unreadable'].includes(document.status))continue;
          processedDocuments.add(document.id);
          for(const block of blocks){
            const candidate=candidateFromBlock(document,block);
            if(!candidate){stats.excluded++;continue;}
            seenCandidates.add(candidate.id);
            const old=await tx.get('entries',candidate.id);
            if(old){stats.duplicates++;if(candidate.reviewRequired&&!old.reviewRequired&&old.reviewedBy!=='owner')await tx.put('entries',{...old,personal:old.personal||candidate.personal,reviewRequired:true,reviewReason:candidate.reviewReason,status:old.status==='historical'?'historical':candidate.status,version:old.version+1});}
            else {
              // A stable explicit subject is supplied only for structured source
              // facts, never guessed from a person's name or a fuzzy match.
              if(candidate.subjectKey){
                const peers=(await tx.list('entries')).filter(e=>e.project===candidate.project&&e.subjectKey===candidate.subjectKey&&e.contentHash!==candidate.contentHash&&e.status!=='rejected');
                if(peers.length){candidate.status='conflict';candidate.reviewRequired=true;candidate.reviewReason='same_subject_different_statement';candidate.conflictsWith=peers.map(e=>e.id);for(const peer of peers){await tx.put('relations',{id:hash([candidate.id,peer.id,'conflict']),from:candidate.id,to:peer.id,type:'conflict',resolution:'unresolved'});if(peer.reviewedBy!=='owner')await tx.put('entries',{...peer,status:'conflict',reviewRequired:true,reviewReason:'same_subject_different_statement',conflictsWith:[...new Set([...(peer.conflictsWith||[]),candidate.id])],version:peer.version+1});}}
              }
              await tx.put('entries',candidate);stats.created++;
              if(candidate.reviewRequired)stats.pending++;
              if(candidate.status==='historical')stats.historical++;
            }
            const evidence={id:hash([candidate.id,document.id,block.locator]),entryId:candidate.id,documentId:document.id,locator:block.locator,section:block.section||null,quote:candidate.text};
            if(!await tx.get('evidence',evidence.id)){await tx.put('evidence',evidence);stats.evidence++;}
          }
        }
        // Re-extraction never deletes old knowledge. Fragments replaced by a
        // richer chunking revision become historical, retaining every citation.
        const previousEntries=new Set((await tx.list('evidence')).filter(e=>processedDocuments.has(e.documentId)).map(e=>e.entryId));
        for(const entry of await tx.list('entries'))if(!seenCandidates.has(entry.id)&&entry.reviewedBy!=='owner'&&previousEntries.has(entry.id)&&entry.historyReason!=='superseded_extraction')await tx.put('entries',{...entry,status:'historical',kind:'historical',historyReason:'superseded_extraction',version:entry.version+1});
        const entries=await tx.list('entries'),groups=new Map();
        for(const entry of entries){for(const domain of entry.domains){const key=entry.project+':'+domain;const ids=groups.get(key)||[];if(ids.length<20000)ids.push(entry.id);groups.set(key,ids);}}
        // Bounded related-entry links within the same project and topic. Cross-
        // project similarity is never used to merge identities or statements.
        for(const ids of groups.values())for(let i=1;i<ids.length;i++)await tx.put('relations',{id:hash([ids[i-1],ids[i],'topic']),from:ids[i-1],to:ids[i],type:'same_topic'});
        await tx.put('meta',{id:'last_import',at:new Date().toISOString(),stats});
        return stats;
      });
    },
    async overview({includeEntries=false}={}) {
      const [documents,entries]=await Promise.all([repository.list('documents'),repository.list('entries')]);
      return {mode:repository.mode,searchMethod:SEARCH_METHOD,externalAI:false,counts:{documents:documents.length,entries:entries.length,active:entries.filter(e=>e.status==='active'&&!e.reviewRequired).length,pending:entries.filter(e=>e.reviewRequired&&e.status!=='rejected'&&e.historyReason!=='superseded_extraction').length,historical:entries.filter(e=>e.status==='historical').length},domains:Object.fromEntries(DOMAINS.map(d=>[d,entries.filter(e=>e.domains.includes(d)).length])),documents:documents.map(d=>({id:d.id,title:d.title,path:d.path,contentHash:d.contentHash,status:d.status,effectiveDate:d.effectiveDate,reason:d.reason,project:d.project})),...(includeEntries?{entries}:{})};
    },
    async ask(options) {
      options={...options};
      if(!options.project&&/\bluxe\b/i.test(options.question||''))options.project='luxe';
      if(!options.domain&&/\bgold\b|nasdaq|nas100|topstep|\btrading\b/i.test(options.question||''))options.domain='TRADING';
      if(!options.domain&&/instagram|tiktok|social.media/i.test(options.question||''))options.domain='SOCIAL_MEDIA';
      if(!options.project&&options.domain==='SOCIAL_MEDIA')options.project='marcel';
      if(options.domain&&!DOMAINS.includes(options.domain))throw error('Unknown knowledge domain');
      const [entries,documents,evidence]=await Promise.all([repository.list('entries'),repository.list('documents'),repository.list('evidence')]);
      const byId=new Map(documents.map(d=>[d.id,d]));
      const matches=rankEntries(options.project?entries:entries.filter(e=>e.project!=='luxe'),options);
      const results=matches.map(({entry,score})=>({id:entry.id,text:entry.text,kind:entry.kind,status:entry.status,domains:entry.domains,project:entry.project,version:entry.version,score,sources:evidence.filter(e=>e.entryId===entry.id).slice(0,5).map(e=>({documentId:e.documentId,title:byId.get(e.documentId)?.title,version:byId.get(e.documentId)?.contentHash,locator:e.locator,section:e.section,effectiveDate:byId.get(e.documentId)?.effectiveDate}))}));
      const missingSources=documents.filter(d=>['missing','unreadable'].includes(d.status)).map(d=>d.title);
      return {answer:results.length?results.map((r,i)=>`[${i+1}] ${r.kind==='plan'?'Geplant: ':r.kind==='opinion'?'Meinung: ':r.kind==='historical'?'Historisch: ':'Dokumentiert: '}${r.text}`).join('\n\n'):'In den freigegebenen lokalen Quellen ist dazu keine ausreichend passende Information vorhanden.',results,missingSources,searchMethod:SEARCH_METHOD,externalAI:false,notice:'Quellenbasierte Auszüge; dokumentierte Aussagen sind kein Nachweis des heutigen Livezustands. Ungeprüfte persönliche Angaben und ungeprüfte Trading-Parameter sind ausgeschlossen.'};
    },
    async pending(){return (await repository.list('entries')).filter(e=>e.reviewRequired&&e.status!=='rejected'&&e.historyReason!=='superseded_extraction');},
    async review({id,action,text,expectedVersion,resolveConflict=false,allowPersonal=false}) {
      if(!['confirm','reject','correct'].includes(action))throw error('Unknown review action');
      return repository.transaction(async tx=>{
        const old=await tx.get('entries',id);if(!old)throw error('Entry not found',404);
        if(old.version!==expectedVersion)throw error('Eintrag wurde geändert. Bitte neu laden.',409);
        if(action!=='reject'&&old.status==='conflict'&&!resolveConflict)throw error('Widerspruch ausdrücklich auflösen.',409);
        if(action!=='reject'&&old.personal&&!allowPersonal)throw error('Persönliche Angabe ausdrücklich für lokale Antworten freigeben.',409);
        if(action==='correct'&&(typeof text!=='string'||text.trim().length<10||text.length>6000||secretRisk(text)))throw error('Invalid correction');
        const next={...old,...(action==='correct'?{text:text.trim(),personal:old.personal||sensitive(text)}:{}),version:old.version+1,status:action==='reject'?'rejected':old.kind==='historical'?'historical':'active',reviewRequired:false,reviewedBy:'owner',reviewedAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
        if(next.personal&&action!=='reject'&&!allowPersonal)throw error('Neue sensible Korrektur benötigt ausdrückliche Freigabe.',409);
        if(action!=='reject'&&resolveConflict)for(const peerId of old.conflictsWith||[]){const peer=await tx.get('entries',peerId);if(!peer||peer.status==='rejected')continue;const retired={...peer,status:'superseded',reviewRequired:false,supersededBy:id,version:peer.version+1,updatedAt:next.updatedAt};await tx.put('reviews',{id:hash([peerId,retired.version]),entryId:peerId,action:'superseded_by_owner_resolution',before:peer,after:retired,at:next.updatedAt});await tx.put('entries',retired);}
        await tx.put('reviews',{id:hash([id,next.version]),entryId:id,action,before:old,after:next,at:next.updatedAt});
        await tx.put('entries',next);return next;
      });
    },
    async exportAll(){const collections={};for(const name of ['documents','entries','evidence','relations','reviews','meta'])collections[name]=await repository.list(name);return {schema:'marcel.knowledge/1',exportedAt:new Date().toISOString(),private:true,collections};}
  };
}
