import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {applyUpdate,digest,integrateIndex} from '../tools/update-engine.mjs';
const original='import express from "express";\nconst app = express();\nconst pool = new Pool({\nconnectionString: process.env.DATABASE_URL\n});\n// Terra keeps working here\n';
async function setup(t) {
 const base=await mkdtemp(join(tmpdir(),'trading-update-'));
 t.after(()=>rm(base,{recursive:true,force:true}));
 const target=join(base,'repo'),payload=join(base,'package');
 await mkdir(join(target,'Trading'),{recursive:true});await mkdir(join(target,'Tinder'),{recursive:true});await mkdir(join(payload,'Trading'),{recursive:true});
 await writeFile(join(target,'package.json'),'{}');await writeFile(join(target,'index.js'),original);await writeFile(join(target,'Trading/index.html'),'old');await writeFile(join(target,'Tinder/index.html'),'protected');await writeFile(join(payload,'Trading/index.html'),'new');
 return {target,payload,manifest:{format:'marcel-trading-update/1',indexBaseline:digest(original),files:[{path:'Trading/index.html',baseline:digest('old'),sha256:digest('new')}]}};
}
test('update dry-run never writes',async t=>{const f=await setup(t);const r=await applyUpdate(f);assert.equal(r.applied,false);assert.equal((await readFile(join(f.target,'Trading/index.html'),'utf8')),'old');assert.equal((await readFile(join(f.target,'index.js'),'utf8')),original);});
test('update preserves concurrent unrelated index and Tinder edits, reapply is idempotent',async t=>{const f=await setup(t);const terra=original+'\n// NEW TINDER CODE - must remain\n';await writeFile(join(f.target,'index.js'),terra);const r=await applyUpdate({...f,apply:true});assert.equal(r.applied,true);const index=await readFile(join(f.target,'index.js'),'utf8');assert.ok(index.endsWith('// NEW TINDER CODE - must remain\n'));assert.equal(await readFile(join(f.target,'Tinder/index.html'),'utf8'),'protected');assert.equal((await applyUpdate({...f,apply:true})).files.length,0);assert.ok(r.backup);});
test('conflicting UI or ambiguous integration causes zero writes',async t=>{const f=await setup(t);await writeFile(join(f.target,'Trading/index.html'),'Terra changed UI');const r=await applyUpdate({...f,apply:true});assert.equal(r.applied,false);assert.equal(r.conflicts.length,1);assert.equal(await readFile(join(f.target,'index.js'),'utf8'),original);assert.throws(()=>integrateIndex('no app or pool'),/Anker/);});
test('tampered package or traversal is rejected before mutation',async t=>{const f=await setup(t);await writeFile(join(f.payload,'Trading/index.html'),'tampered');await assert.rejects(()=>applyUpdate({...f,apply:true}),/Prüfsumme/);f.manifest.files[0].path='../index.js';await assert.rejects(()=>applyUpdate({...f,apply:true}),/Unsicher/);});
test('integration preserves CRLF and changes only three lines',()=>{const s=original.replaceAll('\n','\r\n'),out=integrateIndex(s);assert.equal(out.split('\r\n').length-s.split('\r\n').length,3);assert.equal(integrateIndex(out),out);});
