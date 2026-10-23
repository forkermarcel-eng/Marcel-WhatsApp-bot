import fs from 'node:fs';import path from 'node:path';
import {createMarketAnalysisRuntime,apiError} from './api-runtime.js';
import {createLocalScanner} from './scanner.js';
import {utcMillis,requireValue} from './instruments.js';

// Only operator-controlled configuration; never a path, executable or grant from HTTP.
export function loadAnalysisConfiguration({env=process.env,config}={}) {
 try {
  let value=config;
  if(value===undefined){
   const filename=env.MARCEL_ANALYSIS_CONFIG_PATH;
   if(filename){requireValue(path.isAbsolute(filename),'Absolute configuration path required.');const fd=fs.openSync(filename,'r');try{const stat=fs.fstatSync(fd);requireValue(stat.isFile()&&stat.size<=2000000,'Configuration too large.');const bytes=Buffer.alloc(2000001),size=fs.readSync(fd,bytes,0,bytes.length,0);requireValue(size<=2000000,'Configuration too large.');value=JSON.parse(bytes.subarray(0,size).toString('utf8'));}finally{fs.closeSync(fd);}}
   else value={schemaVersion:1,mode:'production'};
  }
  requireValue(value&&typeof value==='object'&&!Array.isArray(value)&&value.schemaVersion===1,'Invalid configuration.');
  requireValue(Object.keys(value).every(k=>['schemaVersion','mode','pythonPath','memoryMb','timeoutMs','calendars','specifications','authorizations'].includes(k)),'Unknown configuration field.');
  const only=(object,keys)=>requireValue(object&&typeof object==='object'&&!Array.isArray(object)&&Object.keys(object).every(k=>keys.includes(k)),'Unexpected configuration field.');
  const c=structuredClone(value),mode=c.mode ?? 'production';requireValue(['production','offline-fixture'].includes(mode),'Invalid mode.');
  const fixture=mode==='offline-fixture';
  requireValue(!fixture||(env.NODE_ENV==='test'&&!Object.entries(env).some(([key,value])=>value&&/^(RAILWAY_|VERCEL)/.test(key))),'Fixtures prohibited in deployment configuration.');
  const pythonPath=env.MARCEL_ANALYSIS_PYTHON_PATH ?? c.pythonPath ?? null;
  requireValue(pythonPath===null||typeof pythonPath==='string'&&path.isAbsolute(pythonPath)&&!/[\x00-\x1f]/.test(pythonPath),'Invalid executable.');
  const memoryMb=c.memoryMb ?? 256,timeoutMs=c.timeoutMs ?? 10000;
  requireValue(Number.isInteger(memoryMb)&&memoryMb>=64&&memoryMb<=512&&Number.isInteger(timeoutMs)&&timeoutMs>=10&&timeoutMs<=10000,'Invalid resource limits.');
  const mapped=(rows,validate)=>{requireValue(Array.isArray(rows)&&rows.length<=250,'Configuration capacity exceeded.');const map=new Map();for(const row of rows){requireValue(row&&typeof row.instrumentId==='string'&&row.instrumentId.length<=700&&!map.has(row.instrumentId),'Invalid configuration identity.');map.set(row.instrumentId,validate(row));}return map;};
  const calendars=mapped(c.calendars ?? [],row=>{
   requireValue(Object.keys(row).every(k=>['instrumentId','calendar'].includes(k)),'Invalid calendar fields.');
   const cal=row.calendar;only(cal,['from','to','zone','reference','windows']);requireValue(cal&&typeof cal.reference==='string'&&cal.reference.trim()&&Array.isArray(cal.windows)&&cal.windows.length<=800,'Explicit calendar required.');
   const from=utcMillis(cal.from),to=utcMillis(cal.to);requireValue(from<to&&to-from<=370*86400000,'Invalid calendar coverage.');let end=from;const ids=new Set();
   for(const w of cal.windows){only(w,['id','start','end']);const a=utcMillis(w.start),b=utcMillis(w.end);requireValue(typeof w.id==='string'&&!ids.has(w.id)&&a>=end&&a<b&&b<=to,'Invalid/overlapping sessions.');ids.add(w.id);end=b;}return cal;
  });
  const specifications=mapped(c.specifications ?? [],row=>{
   requireValue(Object.keys(row).every(k=>['instrumentId','contract','costs','conversion'].includes(k)),'Invalid specification fields.');
   requireValue(row.contract&&row.contract.instrumentId===row.instrumentId&&row.costs,'Explicit contract and costs required.');
   only(row.contract,['instrumentId','kind','broker','reference','asOf','validUntil','quoteCurrency','unitsPerQuantity','tickSize','quantityStep','minQuantity','maxQuantity','priceBasis','tickValueQuotePerQuantity','pipSize']);
   only(row.costs,['currency','reference','asOf','validUntil','spreadPrice','entrySlippagePrice','exitSlippagePrice','commissionPerQuantityRoundTrip','commissionFlatRoundTrip','fundingPerQuantityPerDay']);only(row.costs.fundingPerQuantityPerDay,['LONG','SHORT']);
   if(row.conversion)only(row.conversion,['from','to','source','asOf','maxAgeMs','rate']);
   return {contract:row.contract,costs:row.costs,...(row.conversion?{conversion:row.conversion}:{})};
  });
  const authorizations=mapped(c.authorizations ?? [],row=>{only(row,['instrumentId','verified','usage','reference','checkedAt','expiresAt']);requireValue(row.verified===true&&row.usage==='internal-analysis'&&typeof row.reference==='string'&&row.reference.trim()&&utcMillis(row.checkedAt)<utcMillis(row.expiresAt),'Invalid analysis authorization.');return row;});
  return {pythonPath,memoryMb,timeoutMs,allowFixtures:fixture,calendars,specifications,authorizations};
 }catch{throw apiError('ANALYSIS_CONFIGURATION_INVALID',503);}
}

export function createConfiguredAnalysisRuntime({database,clock=Date.now,env=process.env,config}={}) {
 const settings=loadAnalysisConfiguration({env,config});
 const scanner=settings.pythonPath?createLocalScanner(settings):null;
 const runtime=createMarketAnalysisRuntime({database,clock,...settings,scanner});
 let last=null,pending=null;
 async function ready(){
  if(!scanner)throw apiError('PYTHON_NOT_CONFIGURED',503);
  if(!last||clock()-last.at>=60000){if(!pending)pending=scanner.probe().then(r=>{last={at:clock(),runtime:r};return last;}).catch(error=>{throw apiError(['PYTHON_UNAVAILABLE','PYTHON_VERSION_UNSUPPORTED','MEMORY_LIMIT_UNAVAILABLE','MEMORY_LIMIT','TIMEOUT','SCANNER_BUSY'].includes(error.code)?error.code:'PYTHON_PROBE_FAILED',503);}).finally(()=>{pending=null;});await pending;}
  return last.runtime;
 }
 const usesPython=op=>['scan','time-machine','risk','historical-setups'].includes(op);
 return Object.freeze({...runtime,
  async createJob(owner,body,signal){if(usesPython(body?.operation))await ready();return runtime.createJob(owner,body,signal);},
  async run(owner,id){const job=await runtime.job(owner,id);if(usesPython(job.operation)&&!['succeeded','failed','cancelled','blocked'].includes(job.status))await ready();return runtime.run(owner,id);},
  async runtimeStatus(){
   if(!scanner)return {ready:false,code:'PYTHON_NOT_CONFIGURED',fixtureEnabled:settings.allowFixtures};
   await ready();return {ready:true,interpreterReady:true,inputConfigurationReady:settings.calendars.size>0&&settings.specifications.size>0&&(settings.allowFixtures||settings.authorizations.size>0),runtime:scanner.lastRuntime(),limits:{memoryMb:settings.memoryMb,timeoutMs:settings.timeoutMs,globalComputeJobs:1},configured:{calendars:settings.calendars.size,specifications:settings.specifications.size,authorizations:settings.authorizations.size},fixtureEnabled:settings.allowFixtures};
  }
 });
}
