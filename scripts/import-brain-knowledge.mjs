import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openLocalKnowledge } from '../brain-knowledge/repository.js';
import { createKnowledgeService } from '../brain-knowledge/service.js';
import { discoverSources, readDocumentArchive } from '../brain-knowledge/discover.js';
import { readSource, readChatSource, textBlocks, contextualBlocks } from '../brain-knowledge/extract.js';
import { hash } from '../brain-knowledge/model.js';

const args=process.argv.slice(2),operation=args.shift()||'help';
const get=(name,fallback=null)=>{const i=args.indexOf('--'+name);return i<0?fallback:args[i+1];};
const repoRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const file=resolve(get('db',join(repoRoot,'.local-knowledge','marcel-brain.sqlite')));
if(/postgres(?:ql)?:\/\//i.test(file)||process.env.RAILWAY_ENVIRONMENT_ID)throw Error('This command only imports into a local private SQLite file. No production import path is enabled.');
if(operation==='help'){console.log('import-brain-knowledge.mjs import|stats|ask|pending|review|export --db ABSOLUTE_PATH [--workflow ROOT --documents ROOT --downloads ROOT --chats ROOT] [--question TEXT --domain DOMAIN --project PROJECT]');process.exit(0);}
if(!['import','stats','ask','pending','review','export'].includes(operation))throw Error('Unknown operation');
const readOnly=!['import','review'].includes(operation);
const repo=await openLocalKnowledge(file,{readOnly}),service=createKnowledgeService(repo);
try{
  if(operation==='import'){
    const workflowRoot=resolve(get('workflow',join(repoRoot,'..','..','..')));
    const manifestFile=get('manifest');
    const specs=manifestFile?JSON.parse(readFileSync(manifestFile,'utf8')):discoverSources({workflowRoot,repoRoot,documentsRoot:get('documents',''),downloadsRoot:get('downloads',''),chatRoot:get('chats','')});
    const sources=[];
    for(const spec of specs)sources.push(spec.path.endsWith('.jsonl')?await readChatSource(spec):readSource(spec));
    const archive=get('archive');if(archive&&existsSync(archive))sources.push(...readDocumentArchive(archive));
    const policyPath=join(repoRoot,'services','communication-policies.js');
    const indexPath=existsSync(policyPath)?policyPath:join(repoRoot,'index.js'),index=readFileSync(indexPath,'utf8');
    const persona=index.match(/const MARCEL_PERSONA_V1_7_2 = `([\s\S]*?)`;/)?.[1];
    if(persona)sources.push({id:hash([indexPath,hash(persona)]),contentHash:hash(persona),path:indexPath+'#MARCEL_PERSONA_V1_7_2',title:'Bestehende Marcel Persona V1.7.2',project:'marcel',domain:'MARCEL_DNA',authority:'existing_persona_code',kind:'communication_rule',status:'processed',blocks:textBlocks(persona)});
    for(const source of sources){source.blocks=contextualBlocks(source.blocks||[]);source.extractorVersion=2;}
    const stats=await service.ingest(sources);
    try{chmodSync(file,0o600);}catch{}
    writeFileSync(join(dirname(file),'source-manifest.private.json'),JSON.stringify(specs,null,2),{mode:0o600});
    const overview=await service.overview();
    writeFileSync(join(dirname(file),'import-report.private.json'),JSON.stringify({at:new Date().toISOString(),database:file,stats,counts:overview.counts,domains:overview.domains,documents:overview.documents},null,2),{mode:0o600});
    console.log(JSON.stringify({stats,counts:overview.counts,domains:overview.domains,sources:overview.documents.map(d=>({title:d.title,status:d.status,reason:d.reason}))},null,2));
  }else if(operation==='stats'){const overview=await service.overview();delete overview.documents;console.log(JSON.stringify(overview,null,2));}
  else if(operation==='ask')console.log(JSON.stringify(await service.ask({question:get('question',''),domain:get('domain'),project:get('project')}),null,2));
  else if(operation==='pending')console.log(JSON.stringify((await service.pending()).map(e=>({id:e.id,project:e.project,domains:e.domains,version:e.version,reason:e.reviewReason})),null,2));
  else if(operation==='review')console.log(JSON.stringify(await service.review({id:get('id'),action:get('action'),text:get('text'),expectedVersion:Number(get('version')),allowPersonal:args.includes('--allow-personal'),resolveConflict:args.includes('--resolve-conflict')}),null,2));
  else if(operation==='export'){
    const output=get('out');if(!output)throw Error('Explicit private --out path required');
    writeFileSync(resolve(output),JSON.stringify(await service.exportAll()),{flag:'wx',mode:0o600});console.log(JSON.stringify({exported:true,path:resolve(output)}));
  }
}finally{repo.close();}
