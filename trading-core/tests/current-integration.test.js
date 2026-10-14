import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {registerTradingRoutes} from '../server/api.js';

async function appFor(t, env, query) {
  const app=express();
  app.use(express.json({limit:'2mb'}));
  app.use(express.urlencoded({extended:true}));
  const sql=[];
  const pool={query:async(...args)=>{sql.push(args);return query(...args);},connect:async()=>{throw Error('Unexpected write');}};
  const registration=registerTradingRoutes(app,pool,env);
  assert.equal(sql.length,0,'route registration must not access the DB');
  app.get('/existing-route',(_req,res)=>res.json({existing:true}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return {url:`http://127.0.0.1:${server.address().port}`,sql,registration};
}

test('disabled Trading adds no route and performs no SQL; existing route is unchanged',async t=>{
  for(const flag of [undefined,'false','TRUE','1']) {
    const {url,sql}=await appFor(t,{TRADING_ENABLED:flag},()=>{throw Error('No SQL allowed');});
    assert.equal((await fetch(url+'/trading-api?resource=health')).status,404);
    assert.deepEqual(await (await fetch(url+'/existing-route')).json(),{existing:true});
    assert.equal(sql.length,0);
  }
});

test('enabled Trading preserves bearer auth and uses only its own schema',async t=>{
  const {url,sql}=await appFor(t,{TRADING_ENABLED:'true',DASHBOARD_API_SECRET:'integration-test-only'},()=>({rows:[{version:1}]}));
  assert.equal((await fetch(url+'/trading-api?resource=health')).status,401);
  assert.equal(sql.length,0);
  const r=await fetch(url+'/trading-api?resource=health',{headers:{Authorization:'Bearer integration-test-only'}});
  assert.equal(r.status,200);
  const body=await r.json();
  assert.equal(body.database.ready,true);
  assert.equal(body.execution,false);
  assert.equal(sql.length,1);
  assert.match(sql[0][0],/^SELECT version FROM marcel_trading\.schema_versions/);
  assert.deepEqual(await (await fetch(url+'/existing-route')).json(),{existing:true});
});

test('enabled Trading without migrated schema fails visibly without migrating',async t=>{
  const {url,sql}=await appFor(t,{TRADING_ENABLED:'true',TRADING_API_SECRET:'integration-test-only'},()=>{throw Error('relation missing');});
  const r=await fetch(url+'/trading-api?resource=bootstrap',{headers:{Authorization:'Bearer integration-test-only'}});
  assert.equal(r.status,503);
  assert.equal((await r.json()).code,'TRADING_NOT_READY');
  assert.equal(sql.length,1);
  assert.match(sql[0][0],/^SELECT /);
});

test('existing Express JSON parser remains ahead of Trading and body is not reread',async t=>{
  const {url}=await appFor(t,{TRADING_ENABLED:'true',TRADING_API_SECRET:'integration-test-only'},()=>({rows:[{version:1}]}));
  const r=await fetch(url+'/trading-api?resource=review',{method:'POST',headers:{Authorization:'Bearer integration-test-only','Content-Type':'application/json'},body:JSON.stringify({note:'test'})});
  assert.equal(r.status,400);
  assert.match((await r.json()).error,/Idempotency-Key/);
  const src=await readFile(new URL('../../index.js',import.meta.url),'utf8');
  assert.ok(src.indexOf('app.use(express.json({ limit: "2mb" }))')<src.indexOf('registerTradingRoutes(app, pool);'));
});

test('complete current server import/start is isolated; Trading changes no existing startup work',()=>{
  const result=spawnSync(process.execPath,['--experimental-vm-modules',fileURLToPath(new URL('./server-bootstrap-fixture.mjs',import.meta.url))],{
    encoding:'utf8',timeout:20000,
    env:{SystemRoot:process.env.SystemRoot||'',TEMP:process.env.TEMP||'',TMP:process.env.TMP||''}
  });
  assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
  assert.match(result.stdout,/ISOLATED_SERVER_BOOTSTRAP_PASS/);
});
