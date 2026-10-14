/** Optional persistent context synchronizer; separate from the WhatsApp runtime. */
import {PgRepository} from '../server/repository.js';
import {syncContext} from '../server/providers.js';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL fehlt.');
const {default:pg}=await import('pg');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:2});
const repo=new PgRepository(pool);let running=false;
async function tick(){if(running)return;running=true;try{await repo.health();const result=await syncContext(repo);console.log('[trading-context]',JSON.stringify(result.reports));}catch(e){console.error('[trading-context]',e.message);}finally{running=false;}}
const interval=setInterval(tick,Math.max(300000,Number(process.env.TRADING_CONTEXT_INTERVAL_MS)||900000));
await tick();
for(const s of ['SIGINT','SIGTERM'])process.on(s,async()=>{clearInterval(interval);while(running)await new Promise(r=>setTimeout(r,100));await pool.end();process.exit(0);});
