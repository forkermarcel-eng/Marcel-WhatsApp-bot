import { readFileSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { extname, basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { decode } from 'html-entities';
import { hash, normalize } from './model.js';
import {load} from 'cheerio';
import {posix} from 'node:path';

const MAX=32*1024*1024;
// Central-directory ZIP reader: no extraction to disk, traversal, macros or code
// execution. Only bounded ordinary stored/deflated entries are accepted.
export function zipEntries(bytes) {
  if(bytes.length>MAX)throw Error('Archive exceeds 32 MiB');
  let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0)throw Error('ZIP central directory missing');
  const count=bytes.readUInt16LE(end+10),entries=[];let p=bytes.readUInt32LE(end+16),expanded=0;
  if(count>10000)throw Error('Too many archive entries');
  for(let i=0;i<count;i++){
    if(p+46>bytes.length||bytes.readUInt32LE(p)!==0x02014b50)throw Error('Invalid ZIP directory');
    const flags=bytes.readUInt16LE(p+8),method=bytes.readUInt16LE(p+10),size=bytes.readUInt32LE(p+20),plain=bytes.readUInt32LE(p+24),n=bytes.readUInt16LE(p+28),extra=bytes.readUInt16LE(p+30),comment=bytes.readUInt16LE(p+32),offset=bytes.readUInt32LE(p+42);
    const name=bytes.subarray(p+46,p+46+n).toString('utf8');p+=46+n+extra+comment;
    entries.push({name,read(){
      if(flags&1||![0,8].includes(method)||plain>MAX||expanded+plain>64*1024*1024)throw Error('Unsupported or oversized ZIP entry');
      if(offset+30>bytes.length||bytes.readUInt32LE(offset)!==0x04034b50)throw Error('Invalid ZIP local header');
      const start=offset+30+bytes.readUInt16LE(offset+26)+bytes.readUInt16LE(offset+28);if(start+size>bytes.length)throw Error('Truncated ZIP');
      const raw=bytes.subarray(start,start+size),data=method===8?inflateRawSync(raw,{maxOutputLength:MAX}):raw;
      if(data.length!==plain)throw Error('ZIP size mismatch');expanded+=data.length;return data;
    }});
  }return entries;
}
const splitLong=(text,locator,section)=>{const chunks=[];for(let start=0;start<text.length;start+=1800)chunks.push({text:text.slice(start,start+2000),locator:locator+(start?`:char${start}`:''),section});return chunks;};
export function textBlocks(text) {
  const blocks=[];let section='';
  for(const [index,line]of text.replace(/\r/g,'').split('\n').entries()){
    const clean=normalize(line);if(!clean)continue;
    if(/^#{1,6}\s|^\d+(?:\.\d+)*[.)]?\s.{5,100}$/.test(clean))section=clean.replace(/^#+\s*/,'');
    blocks.push(...splitLong(clean,`line:${index+1}`,section));
  }return blocks;
}

export function contextualBlocks(blocks) {
  const output=[];let group=[];
  const flush=()=>{if(!group.length)return;const first=group[0],last=group.at(-1);output.push({...first,text:group.map(b=>b.text).join('\n'),locator:first.locator+(group.length>1?'..'+last.locator:''),forceReview:group.some(b=>b.forceReview)});group=[];};
  for(const block of blocks){
    if(block.subjectKey){flush();output.push(block);continue;}
    if(block.text===block.section)continue;
    const message=b=>b.locator.match(/archive-line:\d+|message:\d+/)?.[0]||'';
    const numericRisk=b=>/\d/.test(b.text)&&/punkte|pips|\bsl\b|stop|risiko|risk|%|kontrakt|contracts|versuch/i.test(b.text);
    if(group.length&&(group[0].section!==block.section||message(group[0])!==message(block)||numericRisk(group[0])!==numericRisk(block)||group.map(b=>b.text).join(' ').length+block.text.length>1400))flush();
    group.push(block);
  }flush();return output;
}
export function extractBytes(bytes, extension, { includeAssistant=false }={}) {
  if(extension==='.epub'){
    const archive=zipEntries(bytes),files=new Map(archive.map(e=>[e.name,e]));
    const xml=path=>{if(!path||path.startsWith('/')||path.split('/').includes('..'))throw Error('Unsafe EPUB resource');const file=files.get(path);if(!file)throw Error('EPUB resource missing');const text=file.read().toString('utf8');if(/<!DOCTYPE[^>]*\[|<!ENTITY/i.test(text))throw Error('EPUB entities are not accepted');return load(text,{xmlMode:true});};
    const container=xml('META-INF/container.xml'),opf=container('rootfile').first().attr('full-path'),book=xml(opf),base=posix.dirname(opf),manifest=new Map();
    book('manifest item').each((_,e)=>{const item=book(e);manifest.set(item.attr('id'),{href:item.attr('href'),type:item.attr('media-type')});});
    const blocks=[];book('spine itemref').each((index,e)=>{const ref=book(e);if(ref.attr('linear')==='no')return;const item=manifest.get(ref.attr('idref'));if(!item||!['application/xhtml+xml','text/html'].includes(item.type))return;
      const href=decodeURIComponent(item.href.split('#')[0]);if(/^[a-z]+:|^\/|\\/i.test(href))throw Error('External EPUB resource rejected');const path=posix.normalize(posix.join(base,href));
      const page=xml(path);page('script,style,nav,iframe,object').remove();let section='';page('h1,h2,h3,h4,p,li,blockquote').each((_,node)=>{const value=normalize(page(node).text());if(!value)return;if(/^h[1-4]$/.test(node.name))section=value;blocks.push(...splitLong(value,`epub:${index+1}/${path}/block:${blocks.length+1}`,section));});
    });if(!blocks.length)throw Error('EPUB contains no readable spine content');return blocks;
  }
  if(extension==='.docx'||extension===''){
    const archive=zipEntries(bytes),document=archive.find(e=>e.name==='word/document.xml');if(!document)throw Error('Word document.xml missing');
    const relations=archive.find(e=>e.name==='word/_rels/document.xml.rels')?.read().toString('utf8')||'',links=new Map();
    if(/<!DOCTYPE|<!ENTITY/i.test(relations))throw Error('External XML declarations are not accepted');
    for(const relation of relations.matchAll(/<Relationship\b([^>]*)\/?\s*>/g)){
      const attrs=Object.fromEntries([...relation[1].matchAll(/([\w:]+)="([^"]*)"/g)].map(m=>[m[1],decode(m[2],{level:'xml'})]));
      if(/\/hyperlink$/.test(attrs.Type||'')&&/^https?:\/\//i.test(attrs.Target||''))links.set(attrs.Id,attrs.Target);
    }
    const xml=document.read().toString('utf8');if(/<!DOCTYPE|<!ENTITY/i.test(xml))throw Error('External XML declarations are not accepted');const blocks=[];let section='',i=0;
    for(const paragraph of xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g)){const text=normalize([...paragraph[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)].map(m=>decode(m[1],{level:'xml'})).join(''));const style=paragraph[1].match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1]||'';
      if(/heading|überschrift|title/i.test(style)||/^\d+(?:\.\d+)*[.)]?\s.{5,130}$/.test(text))section=text;
      if(text){const urls=[...paragraph[1].matchAll(/<w:hyperlink\b[^>]*r:id="([^"]+)"/g)].map(m=>links.get(m[1])).filter(Boolean);blocks.push(...splitLong(text+([...new Set(urls)].filter(url=>!text.includes(url)).map(url=>' '+url).join('')),`paragraph:${i+1}`,section));}i++;
    }return blocks;
  }
  const text=bytes.toString('utf8');
  if(extension==='.jsonl'){
    const blocks=[];for(const [i,line]of text.split('\n').entries()){if(!line)continue;let row;try{row=JSON.parse(line);}catch{continue;}
      const p=row.payload;if(row.type!=='response_item'||p?.type!=='message'||!['user',...(includeAssistant?['assistant']:[])].includes(p.role))continue;
      const content=(p.content||[]).filter(c=>c.type==='input_text'||c.type==='output_text').map(c=>c.text||'').join('\n');
      // Environment/tool/system metadata are not project knowledge.
      if(/^\s*<(?:environment_context|external_codex_apps_open_page)/.test(content))continue;
      for(const b of textBlocks(content))blocks.push({...b,locator:`message:${i+1}/${b.locator}`,section:p.role==='user'?'Owner chat statement':'Assistant proposal (not owner confirmation)',date:row.timestamp?.slice(0,10)});
    }return blocks;
  }
  if(extension==='.json'){
    const data=JSON.parse(text),blocks=[];
    if(Array.isArray(data.facts))for(const fact of data.facts){if(typeof fact.originalAnswer==='string')blocks.push({text:fact.originalAnswer,locator:`json:$.facts[id=${fact.id}]`,section:String(fact.status||'unreviewed'),subjectKey:`business.fact.${fact.id}`,forceReview:!['PUBLIC_CONFIRMED','PLANNED'].includes(fact.status)});}
    else if(Array.isArray(data.entries))for(const entry of data.entries){const t=entry.translations?.en||{};const body=t.answer||entry.answer||entry.text;if(typeof body==='string')blocks.push({text:body,locator:`json:$.entries[id=${entry.id}]`,section:String(entry.businessStatus||entry.status||'unreviewed'),subjectKey:`faq.${entry.id}`});}
    else {const walk=(value,path)=>{if(typeof value==='string')blocks.push({text:value,locator:`json:${path}`,section:path});else if(value&&typeof value==='object')for(const[k,v]of Object.entries(value)){if(!/password|secret|token|email|phone/i.test(k))walk(v,`${path}.${k}`);}};walk(data,'$');}return blocks;
  }
  return textBlocks(text);
}
export function readSource(spec) {
  const base={...spec,title:spec.title||basename(spec.path),project:spec.project||'marcel',authority:spec.authority||'document'};
  try{
    if(spec.excludeReason)return {...base,id:hash(spec.path),contentHash:hash(spec.path),status:'excluded',reason:spec.excludeReason,blocks:[]};
    if(statSync(spec.path).size>MAX)throw Error('Source exceeds 32 MiB');
    const bytes=readFileSync(spec.path),contentHash=hash(bytes);let blocks;
    if(extname(spec.path).toLowerCase()==='.pdf'){
      const out=execFileSync('pdftotext',['-layout',spec.path,'-'],{encoding:'utf8',maxBuffer:MAX,timeout:20000,windowsHide:true});
      if(out.trim().length<35)throw Error('PDF contains no extractable text; local OCR required');blocks=textBlocks(out);
    }else blocks=extractBytes(bytes,extname(spec.path).toLowerCase());
    if(!blocks.length)throw Error('No extractable text; source needs a targeted text export or local OCR');
    return {...base,id:hash([spec.path,contentHash]),contentHash,status:'processed',blocks};
  }catch(e){return {...base,id:hash(spec.path),contentHash:hash(spec.path),status:e.code==='ENOENT'&&!spec.path.endsWith('.pdf')?'missing':'unreadable',reason:e.code==='ENOENT'&&spec.path.endsWith('.pdf')?'PDF source or local pdftotext unavailable':String(e.message).slice(0,200),blocks:[]};}
}

export async function readChatSource(spec) {
  const base={...spec,authority:'owner_chat_statement',project:spec.project||'marcel'};
  try{
    if(statSync(spec.path).size>256*1024*1024)return {...base,id:hash(spec.path),contentHash:hash(spec.path),status:'unreadable',reason:'Chat archive exceeds the bounded 256 MiB import limit; targeted user-message export required.',blocks:[]};
    const digest=createHash('sha256'),input=createReadStream(spec.path),blocks=[];
    input.on('data',chunk=>digest.update(chunk));
    const lines=createInterface({input,crlfDelay:Infinity});let index=0;
    for await(const line of lines){index++;if(!line.includes('"role":"user"')&&!line.includes('"role": "user"'))continue;
      for(const block of extractBytes(Buffer.from(line),'.jsonl'))blocks.push({...block,locator:`archive-line:${index}/${block.locator}`});
    }
    const rawArchiveHash=digest.digest('hex'),contentHash=hash(blocks);return {...base,id:hash([spec.path,contentHash]),contentHash,rawArchiveHash,status:'processed',blocks};
  }catch(e){return {...base,id:hash(spec.path),contentHash:hash(spec.path),status:e.code==='ENOENT'?'missing':'unreadable',reason:String(e.message).slice(0,200),blocks:[]};}
}
