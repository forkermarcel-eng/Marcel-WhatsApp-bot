import {planTask,loadCapability,searchCapabilities} from '../brain-capabilities/registry.js';
import {scaffoldProject,runLocalTool,operationFingerprint,readLocalToolInput} from '../brain-capabilities/tools.js';
const[op,...rest]=process.argv.slice(2);
async function toolInput(name,workspace,args){
 if(['node-check','ffmpeg-image-preview'].includes(name))return{path:args[0]};
 if(name==='browser-local-inspect')return{url:args[0],width:1280,height:800};
 if(name==='write-reviewed-artifact')return readLocalToolInput({workspace,path:args[0]});
 return{};
}
try{
 let result;
 if(op==='search')result=searchCapabilities({q:rest.join(' ')});
 else if(op==='plan')result=planTask(rest.join(' '));
 else if(op==='load')result=await loadCapability(rest[0]);
 else if(op==='scaffold')result=await scaffoldProject({kind:rest[0],workspace:rest[1],name:rest[2]});
 else if(['tool','fingerprint'].includes(op)){
  const[name,workspace,...args]=rest,input=await toolInput(name,workspace,args.filter(a=>!a.startsWith('--approve=')));
  result=op==='fingerprint'?{tool:name,fingerprint:operationFingerprint(name,input),notice:'Approval covers this exact input; no tool executed.'}:await runLocalTool({name,workspace,input,approval:args.find(a=>a.startsWith('--approve='))?.slice(10)});
 }else throw Error('Usage: search <terms> | plan <task> | load <id> | scaffold <kind> <workspace> <name> | tool <name> <workspace> [argument] [--approve=...] | fingerprint <name> <workspace> [argument]');
 console.log(JSON.stringify(result,null,2));
}catch(e){console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
