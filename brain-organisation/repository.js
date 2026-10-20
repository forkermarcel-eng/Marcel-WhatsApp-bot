const kinds=new Set(['shipment','audit','settings','mail_seen']);
const check=kind=>{if(!kinds.has(kind))throw Error('Unbekannte Organisationssammlung');return kind;};
export function createOrganisationRepository(pool){return {
 async get(kind,id){return (await pool.query('SELECT body FROM marcel_organisation.items WHERE kind=$1 AND id=$2',[check(kind),id])).rows[0]?.body||null;},
 async list(kind){return (await pool.query('SELECT body FROM marcel_organisation.items WHERE kind=$1 ORDER BY id',[check(kind)])).rows.map(r=>r.body);},
 async put(kind,item){await pool.query('INSERT INTO marcel_organisation.items(kind,id,body) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body',[check(kind),item.id,JSON.stringify(item)]);return item;},
 async remove(kind,id){await pool.query('DELETE FROM marcel_organisation.items WHERE kind=$1 AND id=$2',[check(kind),id]);},
 async transaction(fn){const c=await pool.connect();try{await c.query('BEGIN');await c.query("SET LOCAL statement_timeout='20s'");await c.query('SELECT pg_advisory_xact_lock(2010202601)');const result=await fn(createOrganisationRepository(c));await c.query('COMMIT');return result;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 };}
