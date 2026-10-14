// Embedded PostgreSQL (PGlite) only. No URL, socket, external database or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {PgRepository} from '../server/repository.js';

test('isolated PostgreSQL schema/repository: idempotency, append-only and protected public data',async()=>{
  const db=new PGlite();
  try {
    await db.exec("CREATE TABLE public.protected_fixture(id integer PRIMARY KEY, value text); INSERT INTO public.protected_fixture VALUES(1,'unchanged');");
    const before=(await db.query('SELECT * FROM public.protected_fixture')).rows;
    const sql=await readFile(new URL('../schema.sql',import.meta.url),'utf8');
    await db.exec('BEGIN');
    await db.exec(sql);
    await db.exec(sql);
    await db.query('INSERT INTO marcel_trading.schema_versions(version,checksum) VALUES(1,$1)',['local-test']);
    const repo=new PgRepository(db);
    assert.equal((await repo.health()).ready,true);
    await repo.put('plans',{id:'isolated',contract:'MGCZ6'});
    assert.equal((await repo.get('plans','isolated')).contract,'MGCZ6');
    await repo.put('attachments',{id:'image',data:'synthetic-only'});
    assert.equal((await repo.list('attachments'))[0].data,undefined);
    await repo.storeCandles({contract:'MGCZ6',source:'test',resolution:60,bars:[{time:'2026-09-18T00:00:00Z',open:4400,high:4402,low:4399,close:4401,volume:15}]});
    assert.equal((await repo.series())[0].price,4401);
    assert.equal((await repo.candles('MGCZ6'))[0].volume,15);
    await db.exec('SAVEPOINT immutable');
    await assert.rejects(()=>db.query("UPDATE marcel_trading.plans SET body='{}' WHERE id='isolated'"),/Immutable trading record/);
    await db.exec('ROLLBACK TO SAVEPOINT immutable');
    assert.deepEqual((await db.query('SELECT * FROM public.protected_fixture')).rows,before);
    assert.deepEqual((await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'")).rows,[{table_name:'protected_fixture'}]);
    await db.exec('ROLLBACK');
    assert.equal((await db.query("SELECT to_regnamespace('marcel_trading') AS schema")).rows[0].schema,null);
  } finally {await db.close();}
});
