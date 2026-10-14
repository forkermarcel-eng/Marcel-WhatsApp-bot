import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
export const KINDS=['plans','snapshots','executions','reviews','attachments','playbooks','context','observations','events','news','settings','drawings','estimates','proposals','audit','commands'];
const IMMUTABLE=new Set(['plans','snapshots','executions','reviews','context','audit','commands']);
const check=k=>{if(!KINDS.includes(k))throw Error('Unknown trading collection');return k;};
function duplicate(){const e=Error('Datensatz existiert bereits.');e.status=409;return e;}
export class FileRepository{
 constructor(path=null){this.path=path;this.state={collections:Object.fromEntries(KINDS.map(k=>[k,{}])),candles:{}};this.queue=Promise.resolve();this.ready=this.load();this.mode=path?'LOCAL_FILE':'MEMORY_TEST';}
 async load(){if(this.path)try{this.state=JSON.parse(await readFile(this.path,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}}
 async health(){await this.ready;return {ready:true,mode:this.mode};}
 async transaction(fn){const task=this.queue.then(async()=>{await this.ready;const before=structuredClone(this.state);try{const result=await fn(this);if(this.path){await mkdir(dirname(this.path),{recursive:true});const tmp=this.path+'.tmp';await writeFile(tmp,JSON.stringify(this.state),{mode:0o600});await rename(tmp,this.path);}return result;}catch(e){this.state=before;throw e;}});this.queue=task.catch(()=>{});return task;}
 async get(k,id){await this.ready;return structuredClone(this.state.collections[check(k)][id]||null);}
 async list(k,limit=10000){await this.ready;return Object.values(this.state.collections[check(k)]).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')).slice(0,limit).map(x=>{if(k==='attachments'){const {data,...meta}=x;return structuredClone(meta);}return structuredClone(x);});}
 async put(k,obj,{update=false}={}){check(k);const old=this.state.collections[k][obj.id];if(old&&(!update||IMMUTABLE.has(k)))throw duplicate();this.state.collections[k][obj.id]=structuredClone(obj);return structuredClone(obj);}
 async delete(k,id){if(IMMUTABLE.has(check(k)))throw Error('Immutable');delete this.state.collections[k][id];}
 async storeCandles({contract,source,resolution,bars}){for(const b of bars)this.state.candles[[contract,source,resolution,b.time].join('|')]={...b,contract,source,resolution,receivedAt:new Date().toISOString()};return bars.length;}
 async candles(contract,{source,from,to,limit=10000,resolution}={}){return Object.values(this.state.candles).filter(b=>b.contract===contract&&(!source||b.source===source)&&(!resolution||b.resolution===resolution)&&(!from||b.time>=from)&&(!to||b.time<=to)).sort((a,b)=>a.time.localeCompare(b.time)).slice(-limit).map(x=>structuredClone(x));}
 async series(){const m=new Map();for(const b of Object.values(this.state.candles)){const id=[b.contract,b.source,b.resolution].join('|');let x=m.get(id);if(!x)m.set(id,x={contract:b.contract,source:b.source,resolution:b.resolution,count:0,first:b.time,last:b.time,price:b.close});x.count++;x.first=x.first<b.time?x.first:b.time;if(b.time>=x.last){x.last=b.time;x.price=b.close;}}return [...m.values()];}
}
export class PgRepository{
 constructor(pool){this.pool=pool;this.mode='POSTGRESQL';}
 async health(){const r=await this.pool.query('SELECT version FROM marcel_trading.schema_versions ORDER BY version DESC LIMIT 1');return {ready:r.rows[0]?.version===1,mode:this.mode};}
 async transaction(fn){const c=await this.pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout = '5s'");await c.query("SET LOCAL statement_timeout = '20s'");await c.query("SELECT pg_advisory_xact_lock(781022163)");const out=await fn(new PgRepository(c));await c.query('COMMIT');return out;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async get(k,id){return (await this.pool.query(`SELECT body FROM marcel_trading.${check(k)} WHERE id=$1`,[id])).rows[0]?.body||null;}
 async list(k,limit=10000){return (await this.pool.query(`SELECT ${k==='attachments'?"body - 'data' AS body":'body'} FROM marcel_trading.${check(k)} ORDER BY created_at DESC,id LIMIT $1`,[Math.min(100000,limit)])).rows.map(r=>r.body);}
 async put(k,obj,{update=false}={}){check(k);if(IMMUTABLE.has(k))update=false;try{await this.pool.query(`INSERT INTO marcel_trading.${k}(id,body) VALUES($1,$2::jsonb)${update?' ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body':''}`,[obj.id,JSON.stringify(obj)]);return obj;}catch(e){if(e.code==='23505')throw duplicate();throw e;}}
 async delete(k,id){if(IMMUTABLE.has(check(k)))throw Error('Immutable');await this.pool.query(`DELETE FROM marcel_trading.${k} WHERE id=$1`,[id]);}
 async storeCandles({contract,source,resolution,bars}){if(!bars.length)return 0;await this.pool.query(`INSERT INTO marcel_trading.candles(contract,source,resolution,at,open,high,low,close,volume)
 SELECT $1,$2,$3,x.time::timestamptz,x.open,x.high,x.low,x.close,x.volume FROM jsonb_to_recordset($4::jsonb) AS x(time text,open numeric,high numeric,low numeric,close numeric,volume numeric)
 ON CONFLICT(contract,source,resolution,at) DO UPDATE SET open=EXCLUDED.open,high=EXCLUDED.high,low=EXCLUDED.low,close=EXCLUDED.close,volume=EXCLUDED.volume,received_at=now()`,[contract,source,resolution,JSON.stringify(bars)]);return bars.length;}
 async candles(contract,{source,from,to,limit=10000,resolution}={}){const r=await this.pool.query(`SELECT * FROM marcel_trading.candles WHERE contract=$1 AND ($2::text IS NULL OR source=$2) AND ($3::timestamptz IS NULL OR at >= $3) AND ($4::timestamptz IS NULL OR at <= $4) AND ($5::int IS NULL OR resolution=$5) ORDER BY at DESC LIMIT $6`,[contract,source||null,from||null,to||null,resolution||null,Math.min(50000,limit)]);return r.rows.reverse().map(x=>({time:x.at.toISOString(),open:+x.open,high:+x.high,low:+x.low,close:+x.close,volume:+x.volume,source:x.source,resolution:x.resolution,contract:x.contract,receivedAt:x.received_at.toISOString()}));}
 async series(){const r=await this.pool.query(`WITH s AS (SELECT contract,source,resolution,count(*)::int AS count,min(at) AS first,max(at) AS last FROM marcel_trading.candles GROUP BY contract,source,resolution) SELECT s.*,c.close AS price FROM s JOIN LATERAL (SELECT close FROM marcel_trading.candles d WHERE d.contract=s.contract AND d.source=s.source AND d.resolution=s.resolution ORDER BY at DESC LIMIT 1)c ON true`);return r.rows.map(x=>({...x,price:+x.price,first:x.first.toISOString(),last:x.last.toISOString()}));}
}
