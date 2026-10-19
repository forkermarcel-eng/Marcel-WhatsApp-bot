// Targeted private export for large JSONL archives; bounded memory and output.
import {createReadStream,writeFileSync,appendFileSync,statSync} from 'node:fs';
import {StringDecoder} from 'node:string_decoder';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {extractBytes} from '../brain-knowledge/extract.js';
import {secretRisk} from '../brain-knowledge/model.js';
const args=process.argv.slice(2),option=flag=>{const i=args.indexOf(flag);return i>=0?args[i+1]:null;};
if(!option('--file')||!option('--out'))throw Error('Explicit --file ARCHIVE.jsonl --out NEW_PRIVATE.jsonl required.');
const input=resolve(option('--file')),output=resolve(option('--out'));if(statSync(input).size>2*1024*1024*1024)throw Error('Archive exceeds 2 GiB; select a narrower archive.');
writeFileSync(output,'',{flag:'wx',mode:0o600});const digest=createHash('sha256'),decoder=new StringDecoder('utf8');let buffer='',discard=false,line=0,oversizedLines=0,ownerMessages=0,secretMessages=0,bytesWritten=0;
function accept(text){line++;if(!text.includes('"user"'))return;let row;try{row=JSON.parse(text);}catch{return;}
 if(row.type!=='response_item'||row.payload?.type!=='message'||row.payload.role!=='user')return;
 if(!extractBytes(Buffer.from(text),'.jsonl').length)return;
 const content=(row.payload.content||[]).filter(item=>['input_text','output_text'].includes(item.type)).map(item=>item.text||'').join('\n');
 if(secretRisk(content)){secretMessages++;return;}
 const entry=JSON.stringify({type:'response_item',timestamp:row.timestamp,originalArchiveLine:line,payload:{type:'message',role:'user',content:[{type:'input_text',text:content}]}})+'\n';
 bytesWritten+=Buffer.byteLength(entry);if(bytesWritten>16*1024*1024)throw Error('Owner export exceeds 16 MiB; split into narrower archives.');appendFileSync(output,entry);ownerMessages++;
}
for await(const chunk of createReadStream(input)){digest.update(chunk);const text=decoder.write(chunk);for(const part of text.match(/[^\n]*\n|[^\n]+$/g)||[]){const ends=part.endsWith('\n');if(!discard){buffer+=part;if(Buffer.byteLength(buffer)>1024*1024){buffer='';discard=true;oversizedLines++;}}
 if(ends){if(discard){line++;discard=false;}else accept(buffer);buffer='';}
}}
buffer+=decoder.end();if(buffer&&!discard)accept(buffer);
console.log(JSON.stringify({exported:true,ownerMessages,bytesWritten,archiveSha256:digest.digest('hex'),oversizedLines,secretMessages,complete:oversizedLines===0&&secretMessages===0,productionAccess:false}));
