import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Preparation only: no branch/index mutation, installation, environment pull or deployment.
const root=fileURLToPath(new URL('../',import.meta.url));if(path.resolve(process.cwd())!==path.resolve(root))throw Error('Run from the authorised worktree.');
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',windowsHide:true,maxBuffer:20000000});
const outputRoot=process.argv.includes('--runtime-build')?'tmp/market-analysis-runtime':'tmp/market-analysis-blockers';
const head=git('rev-parse','HEAD').trim(),base='e2d41dbda3562ee2284ded1d666fcd002bb973a4';
if(git('rev-parse','HEAD^').trim()!==base)throw Error('Reviewed organisation parent changed; stop for review.');
const sha=data=>crypto.createHash('sha256').update(data).digest('hex');
const walk=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(path.join(dir,e.name)):e.isFile()?[path.join(dir,e.name).replaceAll('\\','/')]:[]);
const overlay=[...walk('market-analysis').filter(f=>/\.(js|py)$/.test(f)&&!f.includes('__pycache__')), 'Brain/market-analysis.js','Brain/market-analysis.css','Brain/market-analysis-widget.js',
 'market-analysis/runtime/README.md','market-analysis/runtime/production-config.example.json',
 'Brain/workspaces.js','Brain/world-ui.js','api/dashboard/marcel-brain.js','api/login.js','index.js',
 'migrations/20261022_brain_market_analysis.sql','migrations/20261022_brain_market_analysis_phase6.sql',
 ...walk('test').filter(f=>/\/market-analysis-[^/]+\.(js|py)$/.test(f)),
 'scripts/market-analysis-local.mjs','scripts/market-analysis-native-readiness.mjs','scripts/market-analysis-release-artifact.mjs',
 ...walk('docs').filter(f=>f.startsWith('docs/marcel-brain-marktanalyse-')&&f.endsWith('.md'))].sort();
function stripOrganisation(file,content){
 if(!['index.js','api/dashboard/marcel-brain.js'].includes(file))return content;
 const delta=git('diff','--no-ext-diff','--unified=0',base,head,'--',file),groups=[];let group=[];
 for(const line of delta.split('\n')){
  if(line.startsWith('---')||line.startsWith('+++'))continue;
  if(line.startsWith('-'))throw Error('Organisation delta is no longer addition-only.');
  if(line.startsWith('+'))group.push(line.slice(1));else if(group.length){groups.push(group.join('\n')+'\n');group=[];}
 }if(group.length)groups.push(group.join('\n')+'\n');
 for(const block of groups){if(content.split(block).length!==2)throw Error('Cannot isolate reviewed organisation hunk: '+file);content=content.replace(block,'');}return content;
}
const blobs=overlay.map(file=>{let data=fs.readFileSync(file);if(['index.js','api/dashboard/marcel-brain.js'].includes(file))data=Buffer.from(stripOrganisation(file,data.toString('utf8').replaceAll('\r\n','\n')));return {path:file,sha256:sha(data),content:data.toString('base64')};});
const packageBytes=Buffer.from(git('show',base+':package.json')),lockBytes=Buffer.from(git('show',base+':package-lock.json'));
const body={format:'marcel-market-analysis-source-overlay-v1',baseCommit:base,worktreeHead:head,productionBaseConfirmed:false,organisationDeltaExcluded:true,node:process.version,
 dependencies:{packageSHA256:sha(packageBytes),lockSHA256:sha(lockBytes),install:'npm ci --ignore-scripts (review required dependency lifecycle scripts separately)',python:'CPython 3.12.14 tested reference; >=3.12, stdlib only, protocol 1, enforced 256 MiB default; explicit operator executable/config path'},
 files:blobs};
const raw=Buffer.from(JSON.stringify(body,null,2)+'\n'),hash=sha(raw),folder=path.resolve(outputRoot+'/release-'+hash.slice(0,16));
if(!folder.startsWith(path.resolve(outputRoot)+path.sep))throw Error('Invalid output.');
fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'source-overlay.json'),raw);fs.writeFileSync(path.join(folder,'SHA256SUMS'),hash+'  source-overlay.json\n');
// Reconstruct a complete source tree from the immutable pre-organisation baseline.
const build=path.join(folder,'source');if(!fs.existsSync(build)){
 fs.mkdirSync(build);const tar=execFileSync('git',['-c','core.autocrlf=false','archive','--format=tar',base],{windowsHide:true,maxBuffer:100000000});const archive=path.join(folder,'base.tar');fs.writeFileSync(archive,tar);
 execFileSync('tar.exe',['-xf',archive,'-C',build],{windowsHide:true});
 for(const file of blobs){const target=path.join(build,file.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,Buffer.from(file.content,'base64'));}
}
for(const file of blobs)if(sha(fs.readFileSync(path.join(build,file.path)))!==file.sha256)throw Error('Artifact mismatch: '+file.path);
const tracked=git('ls-tree','-r','--name-only',base).trim().split('\n');
for(const file of tracked)if(!overlay.includes(file)){
 const original=execFileSync('git',['show',base+':'+file],{windowsHide:true,maxBuffer:50000000});if(sha(fs.readFileSync(path.join(build,file)))!==sha(original))throw Error('Protected baseline mismatch: '+file);
}
for(const file of blobs.filter(f=>f.path.endsWith('.js')||f.path.endsWith('.mjs')))execFileSync(process.execPath,['--check',path.join(build,file.path)],{windowsHide:true});
const proof={ok:true,sha256:hash,baseCommit:base,head,files:blobs.length,protectedFiles:tracked.filter(f=>!overlay.includes(f)).length,organisationExcluded:true,productionAccess:false,sourceTree:path.relative(root,build).replaceAll('\\','/')};
fs.writeFileSync(outputRoot+'/release-results.json',JSON.stringify(proof,null,2));console.log(JSON.stringify(proof,null,2));
