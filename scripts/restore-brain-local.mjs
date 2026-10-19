// Offline portability verification. Refuses existing targets; never reads DATABASE_URL.
import {existsSync,readFileSync,statSync} from 'node:fs';
import {resolve} from 'node:path';
import {openLocalKnowledge} from '../brain-knowledge/repository.js';
import {validateTransfer,mergeTransfer,planTransfer} from '../brain-knowledge/transfer.js';
import {hash} from '../brain-knowledge/model.js';
const args=process.argv.slice(2),value=flag=>{const i=args.indexOf(flag);return i>=0?args[i+1]:null;};
if(!value('--file')||!value('--db'))throw Error('Usage: restore-brain-local.mjs --file PRIVATE_EXPORT.json --db NEW_PRIVATE.sqlite [--sha256 EXPECTED]');
const input=resolve(value('--file')),target=resolve(value('--db'));if(existsSync(target))throw Error('Restore target already exists; no overwrite permitted.');
if(statSync(input).size>64*1024*1024)throw Error('Export exceeds 64 MiB.');const bytes=readFileSync(input),checksum=hash(bytes);if(value('--sha256')&&value('--sha256')!==checksum)throw Error('Export checksum mismatch.');
const payload=JSON.parse(bytes),counts=validateTransfer(payload),repository=await openLocalKnowledge(target);
try{const merged=await mergeTransfer(repository,payload),verified=await planTransfer(repository,payload);if(verified.created||verified.conflicts.length||verified.known!==Object.values(counts).reduce((a,b)=>a+b,0))throw Error('Local restore verification failed.');console.log(JSON.stringify({restored:true,verified:true,counts,sha256:checksum,created:merged.created,productionAccess:false,originalMediaIncluded:false}));}finally{repository.close();}
