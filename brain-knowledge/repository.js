import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
export const COLLECTIONS = ['documents','entries','evidence','relations','reviews','meta'];
export function collection(name){if(!COLLECTIONS.includes(name))throw Error('Unknown knowledge collection');return name;}

export async function openLocalKnowledge(file, { readOnly=false }={}) {
  if(file!==':memory:'&&!isAbsolute(file))throw Error('Absolute private knowledge path required');
  if(!readOnly&&file!==':memory:')mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const { DatabaseSync }=await import('node:sqlite');
  const db=new DatabaseSync(file,{readOnly,allowExtension:false});
  db.exec('PRAGMA busy_timeout=5000');
  if(!readOnly){db.exec('PRAGMA journal_mode=WAL');for(const name of COLLECTIONS)db.exec(`CREATE TABLE IF NOT EXISTS brain_${name}(id TEXT PRIMARY KEY,body TEXT NOT NULL CHECK(json_valid(body)))`);}
  let chain=Promise.resolve();
  const repository={
    mode:'sqlite',
    async get(name,id){const row=db.prepare(`SELECT body FROM brain_${collection(name)} WHERE id=?`).get(id);return row?JSON.parse(row.body):null;},
    async list(name){return db.prepare(`SELECT body FROM brain_${collection(name)} ORDER BY id`).all().map(r=>JSON.parse(r.body));},
    async put(name,item){if(readOnly)throw Error('Read-only knowledge repository');db.prepare(`INSERT INTO brain_${collection(name)}(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`).run(item.id,JSON.stringify(item));return item;},
    async transaction(fn){if(readOnly)throw Error('Read-only knowledge repository');const task=chain.then(async()=>{db.exec('BEGIN IMMEDIATE');try{const result=await fn(repository);db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}});chain=task.catch(()=>{});return task;},
    close(){db.close();}
  };return repository;
}

// Existing PostgreSQL pool is reused only after a separately approved schema
// migration. Constructor/import/read paths perform no DDL or implicit seed.
export function createPgKnowledgeRepository(pool) {
  const repo={mode:'postgres',
    async get(name,id){return (await pool.query(`SELECT body FROM marcel_knowledge.${collection(name)} WHERE id=$1`,[id])).rows[0]?.body||null;},
    async list(name){return (await pool.query(`SELECT body FROM marcel_knowledge.${collection(name)} ORDER BY id`)).rows.map(r=>r.body);},
    async put(name,item){await pool.query(`INSERT INTO marcel_knowledge.${collection(name)}(id,body) VALUES($1,$2::jsonb) ON CONFLICT(id) DO UPDATE SET body=EXCLUDED.body`,[item.id,JSON.stringify(item)]);return item;},
    async transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='20s'");await c.query('SELECT pg_advisory_xact_lock(1810202604)');const result=await fn(createPgKnowledgeRepository(c));await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
  };return repo;
}
