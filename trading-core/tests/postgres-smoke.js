/** Optional REAL PostgreSQL smoke check. An EMPTY DISPOSABLE database is mandatory.
 * Everything is in a transaction and rolled back, including schema creation.
 * This is intentionally not part of the ordinary dependency-free unit tests.
 */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PgRepository} from '../server/repository.js';

if(process.env.TRADING_TEST_DB_ACK!=='DISPOSABLE_ONLY'||!process.env.TRADING_TEST_DATABASE_URL) {
  console.error('Nur mit leerer Wegwerf-Datenbank: TRADING_TEST_DATABASE_URL und TRADING_TEST_DB_ACK=DISPOSABLE_ONLY setzen. Niemals DATABASE_URL der Produktion verwenden.');
  process.exit(2);
}
if(process.env.TRADING_TEST_DATABASE_URL===process.env.DATABASE_URL)throw Error('Test-URL darf nicht DATABASE_URL der Produktion entsprechen.');
const {default:pg}=await import('pg');
const pool=new pg.Pool({connectionString:process.env.TRADING_TEST_DATABASE_URL,max:1,connectionTimeoutMillis:8000});
const client=await pool.connect();
let began=false;
try {
  await client.query('BEGIN');began=true;
  await client.query("SET LOCAL statement_timeout='15s'");
  const existing=(await client.query("SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")).rows;
  assert.equal(existing.length,0,'Testdatenbank muss leer sein.');
  const sql=await readFile(new URL('../schema.sql',import.meta.url),'utf8');
  await client.query(sql);await client.query(sql); // Additive and idempotent schema DDL.
  await client.query('INSERT INTO marcel_trading.schema_versions(version,checksum) VALUES(1,$1)',[createHash('sha256').update(sql).digest('hex')]);
  const repo=new PgRepository(client);
  assert.equal((await repo.health()).ready,true);
  await repo.put('plans',{id:'smoke',contract:'MGCZ6',createdAt:new Date().toISOString()});
  assert.equal((await repo.get('plans','smoke')).contract,'MGCZ6');
  await repo.put('attachments',{id:'image',data:'not-returned-by-list',createdAt:new Date().toISOString()});
  assert.equal((await repo.list('attachments'))[0].data,undefined);
  await repo.storeCandles({contract:'MGCZ6',source:'smoke',resolution:60,bars:[{time:'2026-09-18T00:00:00Z',open:4400,high:4402,low:4399,close:4401,volume:15}]});
  assert.equal((await repo.series())[0].price,4401);
  assert.equal((await repo.candles('MGCZ6'))[0].volume,15);
  await client.query('SAVEPOINT immutable_test');
  await assert.rejects(()=>client.query("UPDATE marcel_trading.plans SET body='{}' WHERE id='smoke'"),/Immutable trading record/);
  await client.query('ROLLBACK TO SAVEPOINT immutable_test');
  assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public'")).rows[0].n,0);
  console.log('PASS: PostgreSQL schema, idempotent DDL, immutable trigger, repository and candle queries. All test changes rolled back.');
} finally {
  if(began)await client.query('ROLLBACK');
  client.release();await pool.end();
}
