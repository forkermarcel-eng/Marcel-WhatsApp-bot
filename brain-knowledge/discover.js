import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { hash } from './model.js';
import { zipEntries, extractBytes } from './extract.js';

export const EXPECTED_DOCUMENTS = [
 'Marcel_Local_AI_Master_Workflow_START_HIER.docx',
 'Marcel_MasterBrain_Social_Workflow_2026-09-21_TRADING_ERWEITERT_v2.docx',
 'Marcel_MasterBrain_Social_Workflow_2026-09-20_ERWEITERT_MIT_UI_REFERENZEN.docx',
 'Marcel_MasterBrain_Trading_Workflow.docx',
 'Marcel_SMC_Bot_Workflow_Stand_2026-09-13_AKTUALISIERT.docx',
 'Trading_Session_2026-09-21.docx',
 'Marcel_AI_Master-Workflow_Stand_26-09-2026_aktuell.docx'
];
const skip=new Set(['node_modules','.git','.worktrees','.local-knowledge','.next','.vercel','.playwright-mcp','build','gradle','screenshots','qa','design-references']);
export function walk(root) {
 const result=[];if(!existsSync(root))return result;
 for(const e of readdirSync(root,{withFileTypes:true})){if(e.isSymbolicLink())continue;const path=join(root,e.name);if(e.isDirectory()){if(!skip.has(e.name)&&!e.name.startsWith('.gradle'))result.push(...walk(path));}else result.push(path);}
 return result;
}
export function dateFromName(name){const iso=name.match(/20\d{2}[-_](\d{2})[-_](\d{2})/);if(iso)return iso[0].replaceAll('_','-');const de=name.match(/(\d{2})[-_.](\d{2})[-_.](20\d{2})/);return de?`${de[3]}-${de[2]}-${de[1]}`:null;}
export function discoverSources({workflowRoot,repoRoot,documentsRoot,downloadsRoot,chatRoot}) {
 const specs=[],foundNames=new Set();
 const add=(path,options={})=>{foundNames.add(basename(path));specs.push({path:resolve(path),title:basename(path),effectiveDate:dateFromName(basename(path)),...options});};
 for(const path of walk(workflowRoot)){
   const relative=path.slice(workflowRoot.length).replaceAll('\\','/');
   if(relative.includes('/Marcel-WhatsApp-bot/')||relative.includes('/Marcel-Android-Bridge/')||/signing/i.test(relative))continue;
   const ext=extname(path).toLowerCase();
   if(relative.includes('/LUXE-by-LM/')){
     if(/\/(?:README\.md|docs\/[^/]+\.md|src\/features\/customer-service\/knowledge\.json|docs\/internal\/business-facts\.json|docs\/internal\/owner-requirements-continuation\.txt|docs\/internal\/owner-questionnaire-original\.txt)$/.test(relative))add(path,{project:'luxe',domain:'BUSINESS',authority:'project_document',reviewAll:/owner-questionnaire-original/.test(path)});
   }else if(['.docx','.epub','.pdf','.md','.txt','.json'].includes(ext)||/^WhatsApp Bot Backup/.test(basename(path)))add(path,{historical:/Backup|2026-09-12|stand text/i.test(basename(path))});
 }
 // Active main documentation is authoritative about source implementation,
 // not automatically a proof of a successful deployment or database migration.
 for(const path of walk(join(repoRoot,'docs')))if(/\.(md|txt|json)$/i.test(path))add(path,{authority:'current_source_documentation'});
 for(const path of walk(join(repoRoot,'trading-core','docs')))if(/\.md$/i.test(path))add(path,{domain:'TRADING',project:'trading'});
 add(join(repoRoot,'trading-core','README.md'),{domain:'TRADING',project:'trading'});
 for(const path of walk(documentsRoot))if(/\.(docx|pdf|md|txt)$/i.test(path)&&/Marcel|Trading|Workflow|Brain|Social/i.test(basename(path))&&!/[\\/]work[\\/]/.test(path))add(path);
 for(const path of walk(downloadsRoot))if(/Marcel|Trading|Workflow|Brain|Social/i.test(basename(path))&&/\.(docx|pdf|md|txt)$/i.test(path))add(path,{historical:/Pruefbericht/i.test(path)});
 for(const name of EXPECTED_DOCUMENTS)if(!foundNames.has(name))specs.push({path:join(workflowRoot,name),title:name,expected:true,effectiveDate:dateFromName(name)});
 // The pre-existing private contact export is explicitly registered but excluded.
 specs.push({path:join(repoRoot,'imports','sandry','sandry_chat.txt'),excludeReason:'Private third-party chat: no purpose-specific consent for project knowledge import.'});
 if(chatRoot&&existsSync(join(chatRoot,'session_index.jsonl'))){
   const sessions=walk(join(chatRoot,'sessions'));
   for(const line of readFileSync(join(chatRoot,'session_index.jsonl'),'utf8').split('\n')){let row;try{row=JSON.parse(line);}catch{continue;}const title=row.thread_name||row.title||'';if(!/marcel|luxe|trading|brain|workflow|social/i.test(title))continue;
     const file=sessions.find(p=>p.endsWith(`${row.id}.jsonl`));add(file||join(chatRoot,'sessions',`unavailable-${row.id}.jsonl`),{title:`Codex: ${title}`,project:/luxe/i.test(title)?'luxe':'marcel',authority:'owner_chat_statement',effectiveDate:file?dateFromName(basename(file)):null});
   }
 }
 const unique=new Map(specs.map(spec=>[spec.path,spec]));return [...unique.values()];
}

export function readDocumentArchive(path) {
 const bytes=readFileSync(path),result=[];
 for(const item of zipEntries(bytes))if(/\.(md|txt|docx|pdf)$/i.test(item.name)&&!/(node_modules|\.git|fixtures|requirements\.txt)/i.test(item.name)){
   if(item.name.endsWith('.pdf'))continue;
   const data=item.read(),sourcePath=path+'!/'+item.name;
   result.push({id:hash([sourcePath,hash(data)]),path:sourcePath,title:basename(item.name),contentHash:hash(data),project:'trading',domain:'TRADING',authority:'archive_document',effectiveDate:dateFromName(basename(path)),historical:true,status:'processed',blocks:extractBytes(data,extname(item.name).toLowerCase())});
 }return result;
}
