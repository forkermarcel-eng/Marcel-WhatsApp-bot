import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {createOrganisationRepository} from '../brain-organisation/repository.js';
import {createOrganisationDesk} from '../brain-organisation/desk.js';
import {openLocalKnowledge} from '../brain-knowledge/repository.js';
import {createKnowledgeService} from '../brain-knowledge/service.js';
test('private desk persists drafts and documents in existing schema, rejects conflicts and unrelated IDs',async()=>{
 const db=new PGlite();try{
  await db.exec(readFileSync(new URL('../migrations/20261020_brain_organisation.sql',import.meta.url),'utf8').replace(/^\uFEFF/,''));
  const pool={query:(s,a)=>db.query(s,a),connect:async()=>({query:(s,a)=>db.query(s,a),release(){}})};
  const repository=createOrganisationRepository(pool),desk=createOrganisationDesk(repository);
  await repository.put('settings',{id:'automation',enabled:false});
  const draft=await desk.save({type:'draft',title:'Testentwurf',to:'test@example.invalid',text:'Privater Testtext'});
  assert.equal((await createOrganisationDesk(repository).list('draft'))[0].text,'Privater Testtext');
  await desk.save({...draft,type:'draft',title:'Geändert'});
  await assert.rejects(()=>desk.save({...draft,type:'draft'}),{status:409});
  await assert.rejects(()=>desk.save({type:'draft',id:'automation',title:'Angriff'}),{status:400});
  await assert.rejects(()=>desk.save({type:'draft',title:'Fehler',to:'invalid'}),{status:400});
  await desk.save({type:'document',title:'Testbrief',folder:'Testablage',status:'offen',text:'<script>untrusted</script>'});
  assert.equal((await desk.list('document')).length,1);
  assert.equal((await desk.list('draft')).length,1);
  assert.deepEqual(await repository.get('settings','automation'),{id:'automation',enabled:false});
  await assert.rejects(()=>desk.list('shipment'),{status:400});
 }finally{await db.close();}
});
test('document reader returns only the selected imported excerpts without filesystem paths or mutations',async()=>{
 const repo=await openLocalKnowledge(':memory:');try{
  await repo.put('documents',{id:'one',title:'Privater Testbrief',path:'/not-readable/private.pdf',status:'processed'});
  await repo.put('evidence',{id:'a',documentId:'one',locator:'page:1',quote:'SYNTHETISCHER Auszug'});
  await repo.put('evidence',{id:'b',documentId:'other',quote:'Anderes Dokument'});
  const service=createKnowledgeService(repo),before=await service.exportAll(),result=await service.documentText('one');
  assert.equal(result.fragments.length,1);assert.equal(result.fragments[0].text,'SYNTHETISCHER Auszug');
  assert.ok(!JSON.stringify(result).includes('/not-readable'));
  await assert.rejects(()=>service.documentText('../../etc/passwd'),{status:404});
  assert.deepEqual((await service.exportAll()).collections,before.collections);
 }finally{repo.close();}
});
