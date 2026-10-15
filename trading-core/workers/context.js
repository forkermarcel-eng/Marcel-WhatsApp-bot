/** Existing context synchronizer, reused by the backend and standalone CLI. */
import {pathToFileURL} from 'node:url';
import {PgRepository} from '../server/repository.js';
import {syncContext} from '../server/providers.js';
export function startContextWorker({repo,env=process.env,sync=syncContext,immediate=true,setTimer=setInterval,clearTimer=clearInterval,log=console.log}={}){
 let running=null,stopped=false;
 const intervalMs=60000;
 async function tick(){
  if(stopped||running)return running;
  running=(async()=>{try{const health=await repo.health();if(!health.ready)throw Error('Schema not ready');
   const started=Date.now(),result=await sync(repo,env);log('[trading-context]',JSON.stringify({status:'OK',at:result.at,durationMs:Date.now()-started,newsCount:result.newsCount,newNewsCount:result.newNewsCount,http200:result.reports.filter(r=>!r.cached&&r.httpStatus===200).length,http304:result.reports.filter(r=>!r.cached&&r.httpStatus===304).length,errors:result.reports.filter(r=>!r.cached&&!r.healthy).length,rateLimits:result.reports.filter(r=>!r.cached&&r.httpStatus===429).length,sources:result.reports.map(r=>({name:r.name,status:r.status,cached:!!r.cached,httpStatus:r.httpStatus,newCount:r.newCount||0}))}));
  }catch{log('[trading-context]',JSON.stringify({status:'ERROR',message:'Context refresh failed; existing data retained.'}));}finally{running=null;}})();
  return running;
 }
 const timer=setTimer(tick,intervalMs);if(!immediate)timer?.unref?.();
 log('[trading-context]',JSON.stringify({status:'STARTED',intervalMs}));
 if(immediate)void tick();
 return {tick,intervalMs,stop:async()=>{stopped=true;clearTimer(timer);await running;}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 if(!process.env.DATABASE_URL)throw Error('DATABASE_URL fehlt.');
 const {default:pg}=await import('pg'),pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
 const worker=startContextWorker({repo:new PgRepository(pool)});
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await worker.stop();await pool.end();process.exit(0);});
}
