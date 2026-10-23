import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {requireValue} from './instruments.js';

const runner = fileURLToPath(new URL('./python/runner.py',import.meta.url));
export class ScannerError extends Error {
  constructor(code) {super(code);this.code=code;}
}
// Explicit interpreter, fixed reviewed script, stdin JSON, no shell/inherited secrets.
export function createLocalScanner({pythonPath,timeoutMs = 5000,memoryMb = 256} = {}) {
  requireValue(typeof pythonPath === 'string' && path.isAbsolute(pythonPath),'Explicit absolute Python executable required.');
  requireValue(Number.isInteger(timeoutMs) && timeoutMs>=10 && timeoutMs<=10000,'Invalid scanner timeout.');
  requireValue(Number.isInteger(memoryMb) && memoryMb>=64 && memoryMb<=512,'Invalid scanner memory limit.');
  let busy = false,lastRuntime = null;
  async function execute(requests,{signal} = {},probe = false) {
    if(signal?.aborted) throw new ScannerError('ABORTED');
    if(busy) throw new ScannerError('SCANNER_BUSY');
    if(!probe)requireValue(Array.isArray(requests) && requests.length>=1 && requests.length<=12,'Scanner request limit.');
    const raw = JSON.stringify(probe?{control:'probe'}:{requests});
    requireValue(Buffer.byteLength(raw)<=8000000,'Scanner input byte limit.');
    busy = true;
    try {
      return await new Promise((resolve,reject)=>{
        const child = spawn(pythonPath,['-I','-B','-X','utf8',runner,'--memory-mb='+memoryMb],{shell:false,windowsHide:true,env:{},stdio:['pipe','pipe','pipe']});
        let bytes=0,stderrBytes=0,failure=null;const chunks=[];
        const stop = code=>{failure ??= new ScannerError(code);child.kill();};
        const abort = ()=>stop('ABORTED');
        signal?.addEventListener('abort',abort,{once:true});
        const timer = setTimeout(()=>stop('TIMEOUT'),timeoutMs);
        child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4000000)stop('OUTPUT_LIMIT');else chunks.push(chunk);});
        child.stderr.on('data',chunk=>{stderrBytes+=chunk.length;if(stderrBytes>16384)stop('COMPUTE_FAILED');});
        child.stdin.on('error',()=>{failure ??= new ScannerError('COMPUTE_FAILED');});
        child.on('error',()=>{failure ??= new ScannerError('PYTHON_UNAVAILABLE');});
        child.on('close',code=>{
          clearTimeout(timer);signal?.removeEventListener('abort',abort);
          if(failure) return reject(failure);
          if(code!==0 || stderrBytes) return reject(new ScannerError('COMPUTE_FAILED'));
          try {
            const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if(data.ok !== true) return reject(new ScannerError(['INPUT_LIMIT','INPUT_INVALID','REQUEST_LIMIT','TOTAL_BAR_LIMIT','SIMULATION_WORK_LIMIT','MEMORY_LIMIT','MEMORY_LIMIT_UNAVAILABLE','PYTHON_VERSION_UNSUPPORTED'].includes(data.error)?data.error:'COMPUTE_FAILED'));
            requireValue(data.runtime?.protocol===1 && /^3\.(?:1[2-9]|[2-9][0-9])\./.test(data.runtime.pythonVersion) && data.runtime.memoryLimitMb===memoryMb && ['windows-job-process-memory','posix-rlimit-as-cpu'].includes(data.runtime.memoryEnforcement),'Invalid runtime handshake.');
            requireValue(Array.isArray(data.results) && data.results.length===(probe?0:requests.length),'Invalid computation result.');
            lastRuntime=structuredClone(data.runtime);
            resolve(probe?data.runtime:data.results);
          } catch {reject(new ScannerError('COMPUTE_FAILED'));}
        });
        child.stdin.end(raw);
      });
    } finally {busy=false;}
  }
  return Object.freeze({analyze:(requests,options)=>execute(requests,options),probe:options=>execute(null,options,true),lastRuntime:()=>structuredClone(lastRuntime)});
}
