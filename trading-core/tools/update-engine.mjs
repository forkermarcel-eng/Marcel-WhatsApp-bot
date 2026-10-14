/** Conflict-aware FILE update. Never deploys, runs SQL, starts the app or edits .git.
 * Intended for a separate checkout, not a worktree currently being edited.
 */
import {readFile,writeFile,mkdir,rename,lstat,rm,realpath} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute,sep} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

export const IMPORT_LINE='import { registerTradingRoutes } from "./trading-core/server/api.js";';
export const REGISTER_LINE='registerTradingRoutes(app, pool);';
const COMMENT='// Isolated manual Trading Cockpit; disabled unless TRADING_ENABLED=true.';
const POOL_ANCHOR='const pool = new Pool({\nconnectionString: process.env.DATABASE_URL\n});';
export const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const count=(s,part)=>s.split(part).length-1;

export function integrateIndex(raw) {
  const newline=raw.includes('\r\n')?'\r\n':'\n';
  let source=raw.replaceAll('\r\n','\n');
  const hasImport=count(source,IMPORT_LINE),hasRegister=count(source,REGISTER_LINE);
  if(hasImport===1&&hasRegister===1)return raw;
  if(hasImport||hasRegister||source.includes('registerTradingRoutes'))throw Error('index.js enthält eine abweichende Trading-Integration. Manuell vergleichen; nichts überschrieben.');
  if(count(source,POOL_ANCHOR)!==1||!/^const app\s*=\s*express\(\);/m.test(source))throw Error('index.js hat nicht mehr den eindeutig erkennbaren app/pool-Anker. Integration wird sicher abgebrochen.');
  source=IMPORT_LINE+'\n'+source.replace(POOL_ANCHOR,POOL_ANCHOR+'\n'+COMMENT+'\n'+REGISTER_LINE);
  return source.replaceAll('\n',newline);
}
function validatePath(path) {
  if(typeof path!=='string'||path.includes('\\')||path.includes('\0')||isAbsolute(path)||path.split('/').some(x=>!x||x==='.'||x==='..'))throw Error('Unsicherer Paketpfad.');
  if(!(path.startsWith('Trading/')||path.startsWith('trading-core/')||path==='api/trading.js'))throw Error('Datei liegt außerhalb des freigegebenen Trading-Bereichs: '+path);
  return path;
}
async function readOptional(path) {try{return await readFile(path);}catch(e){if(e.code==='ENOENT')return null;throw e;}}
async function noSymlinks(root,path) {
  let current=root;
  for(const part of path.split('/')) {
    current=join(current,part);
    try {if((await lstat(current)).isSymbolicLink())throw Error('Symlink im Updatepfad: '+path);}catch(e){if(e.code==='ENOENT')return;if(e)throw e;}
  }
}
async function atomicWrite(path,bytes) {
  await mkdir(dirname(path),{recursive:true});
  const temp=path+'.trading-tmp-'+randomUUID();
  try {await writeFile(temp,bytes,{mode:0o600});await rename(temp,path);}finally{await rm(temp,{force:true});}
}
export async function applyUpdate({target,payload,manifest,apply=false}) {
  if(manifest.format!=='marcel-trading-update/1'||!Array.isArray(manifest.files))throw Error('Unbekanntes Paketformat.');
  target=await realpath(resolve(target));payload=await realpath(resolve(payload));
  if(!(await readOptional(join(target,'package.json'))))throw Error('Ziel ist kein Repository mit package.json.');
  const inside=(a,b)=>{const rel=relative(a,b);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep));};
  if(inside(target,payload)||inside(payload,target))throw Error('Update-Paket und Ziel müssen getrennte Ordner sein.');
  const seen=new Set(),writes=[],conflicts=[],unchanged=[];
  for(const f of manifest.files) {
    const path=validatePath(f.path);
    if(seen.has(path.toLowerCase()))throw Error('Doppelter Windows-Pfad im Paket: '+path);
    seen.add(path.toLowerCase());
    await noSymlinks(target,path);await noSymlinks(payload,path);
    const next=await readFile(join(payload,path));
    if(digest(next)!==f.sha256)throw Error('Paket-Prüfsumme stimmt nicht: '+path);
    const before=await readOptional(join(target,path));
    const oldHash=before?digest(before):null;
    if(oldHash===f.sha256){unchanged.push(path);continue;}
    if(before&&(!f.baseline||oldHash!==f.baseline)){conflicts.push(path);continue;}
    if(!before&&f.baseline){conflicts.push(path+' (Originaldatei fehlt)');continue;}
    writes.push({path,before,next,hash:f.sha256});
  }
  await noSymlinks(target,'index.js');
  const before=await readOptional(join(target,'index.js'));
  if(!before)throw Error('index.js fehlt.');
  try {
    const next=Buffer.from(integrateIndex(before.toString('utf8')));
    if(digest(before)!==digest(next))writes.push({path:'index.js',before,next,hash:digest(next)});
    else unchanged.push('index.js');
  }catch(e){conflicts.push(e.message);}
  const result={mode:apply?'APPLY':'DRY_RUN',target,files:writes.map(x=>x.path),unchanged,conflicts,applied:false,indexBaselineMatches:digest(before)===manifest.indexBaseline,noDatabaseChanges:true,noDeployment:true};
  if(conflicts.length||!apply)return result;
  // Validate again before the first write; no partial changes on detected conflicts.
  for(const w of writes) {
    const current=await readOptional(join(target,w.path));
    if((current?digest(current):null)!==(w.before?digest(w.before):null))throw Error('Paralleländerung erkannt: '+w.path);
  }
  if(!writes.length){result.applied=true;return result;}
  const backup=join(dirname(target),'Marcel-Trading-Backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  await mkdir(backup,{recursive:true,mode:0o700});
  for(const w of writes)if(w.before){const p=join(backup,w.path);await mkdir(dirname(p),{recursive:true});await writeFile(p,w.before,{mode:0o600});}
  await writeFile(join(backup,'backup-manifest.json'),JSON.stringify({createdAt:new Date().toISOString(),target,files:writes.map(w=>({path:w.path,existed:!!w.before,before:w.before?digest(w.before):null,after:w.hash}))},null,2),{mode:0o600});
  const done=[];
  try {
    for(const w of writes) {
      const current=await readOptional(join(target,w.path));
      if((current?digest(current):null)!==(w.before?digest(w.before):null))throw Error('Paralleländerung erkannt: '+w.path);
      await atomicWrite(join(target,w.path),w.next);done.push(w);
    }
  }catch(error) {
    const rollbackConflicts=[];
    for(const w of done.reverse()) {
      const current=await readOptional(join(target,w.path));
      if(current&&digest(current)===w.hash){if(w.before)await atomicWrite(join(target,w.path),w.before);else await rm(join(target,w.path),{force:true});}
      else rollbackConflicts.push(w.path);
    }
    error.message+='; Sicherung: '+backup+(rollbackConflicts.length?'; fremde Paralleländerungen nicht überschrieben: '+rollbackConflicts.join(', '):'; eigene Änderungen zurückgerollt.');
    throw error;
  }
  return {...result,applied:true,backup};
}
