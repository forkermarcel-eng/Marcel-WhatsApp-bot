import{readFileSync,writeFileSync}from'node:fs';import{resolve}from'node:path';import pg from'pg';
import{openLocalKnowledge,createPgKnowledgeRepository}from'../brain-knowledge/repository.js';import{createKnowledgeService}from'../brain-knowledge/service.js';import{validateTransfer,planTransfer,mergeTransfer}from'../brain-knowledge/transfer.js';import{hash}from'../brain-knowledge/model.js';
const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1],mode=args[0];
if(!['export','plan','apply'].includes(mode))throw Error('Usage: brain-transfer.mjs export --db ABSOLUTE --out PRIVATE.json | plan --file PRIVATE.json | apply --file PRIVATE.json --expected-database NAME --backup-proof PRIVATE.json --approve-production-write');
if(mode==='export'){
 if(!args.includes('--db')||!args.includes('--out'))throw Error('Expliziter vorhandener DB-Pfad und privater Exportpfad nötig.');
 const repo=await openLocalKnowledge(resolve(value('--db')),{readOnly:true});try{const payload=await createKnowledgeService(repo).exportAll();const file=resolve(value('--out'));writeFileSync(file,JSON.stringify(payload),{flag:'wx',mode:0o600});console.log(JSON.stringify({exported:true,counts:validateTransfer(payload),sha256:hash(readFileSync(file)),file}));}finally{repo.close();}
}else{
 if(!args.includes('--file'))throw Error('Expliziter privater Export erforderlich.');const payload=JSON.parse(readFileSync(resolve(value('--file')),'utf8'));const counts=validateTransfer(payload);
 if(mode==='plan'&&!args.includes('--target'))console.log(JSON.stringify({mode:'offline-plan',counts,ddl:'migrations/20261018_brain_knowledge_foundation.sql',writes:false,documentsAndMedia:'File bytes must be transferred separately using document paths; this JSON contains indexed text and provenance, not original binaries.'}));
 else{
  if(!process.env.DATABASE_URL)throw Error('Zielverbindung nicht konfiguriert.');
  if(mode==='apply'){
   if(!args.includes('--approve-production-write')||!args.includes('--backup-proof')||!args.includes('--expected-database'))throw Error('Separat freigegebener Schreibschritt, erwartete Datenbank und Backup-/Restore-Nachweis fehlen.');
   const proof=JSON.parse(readFileSync(resolve(value('--backup-proof')),'utf8'));if(proof.backupVerified!==true||proof.restoreVerified!==true||proof.database!==value('--expected-database')||!proof.artifact||!proof.verifiedAt)throw Error('Nachweis muss geprüfte Sicherung und geprüften Restore für das konkrete Ziel enthalten.');
  }
  const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});try{
   const identity=(await pool.query('SELECT current_database() AS name')).rows[0].name;
   if(mode==='apply'&&identity!==value('--expected-database'))throw Error('Falsche Zieldatenbank.');
   const repository=createPgKnowledgeRepository(pool);console.log(JSON.stringify(mode==='apply'?await mergeTransfer(repository,payload):await planTransfer(repository,payload)));
  }finally{await pool.end();}
 }
}
