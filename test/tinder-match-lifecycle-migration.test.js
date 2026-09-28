import test from "node:test";
import assert from "node:assert/strict";
import {PGlite} from "@electric-sql/pglite";
import {TINDER_MIRROR_MIGRATION_STATEMENTS as base} from "../tinder-mirror/migration.js";
import {TINDER_LAST_MESSAGE_ORDER_MIGRATION_STATEMENTS as order} from "../tinder-mirror/last-message-order-migration.js";
import {TINDER_MATCH_MIGRATION_STATEMENTS as matches} from "../tinder-mirror/matches-migration.js";
import {MATCH_PROFILE_DDL} from "../tinder-mirror/match-profile-migration.js";
import {preflightMatchLifecycle,migrateMatchLifecycle} from "../tinder-mirror/match-lifecycle-migration.js";
import {runMatchLifecycleMigration} from "../scripts/tinder-match-lifecycle-migration.js";
async function fixture(run){
  const db=new PGlite();
  const pool={connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
  try{
    await db.exec("CREATE TABLE device_bridge_devices(device_id UUID PRIMARY KEY)");
    for(const sql of [...base,...order,...matches,MATCH_PROFILE_DDL])await db.exec(sql);
    await db.exec(`INSERT INTO device_bridge_devices VALUES ('11111111-1111-4111-8111-111111111111');
      INSERT INTO tinder_matches(match_id,device_id,tile,profile,carousel_position)
      VALUES ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111',
      '{"display_name":"fixture"}','{"attributes":{"about":"preserve"}}',0)`);
    await run(db,pool);
  }finally{await db.close();}
}
test("lifecycle DDL preserves existing product values; no invented observations; canonical rerun",async()=>fixture(async(db,pool)=>{
  const before=(await db.query("SELECT * FROM tinder_matches")).rows[0];
  assert.equal((await preflightMatchLifecycle(pool)).state,"ELIGIBLE_FOR_MIGRATION");
  assert.equal((await migrateMatchLifecycle(pool)).state,"COMMIT_CONFIRMED");
  const after=(await db.query("SELECT * FROM tinder_matches")).rows[0];
  assert.equal(after.last_seen_at,null);assert.equal(after.last_inventory_at,null);
  assert.equal(after.consecutive_complete_misses,0);assert.equal(after.is_active,true);
  for(const key of ["last_seen_at","last_inventory_at","consecutive_complete_misses","is_active"])delete after[key];
  assert.deepEqual(after,before);
  await db.query("UPDATE tinder_matches SET consecutive_complete_misses=3,is_active=false,last_inventory_at=NOW()");
  const persisted=(await db.query("SELECT * FROM tinder_matches")).rows;
  assert.equal((await migrateMatchLifecycle(pool)).changed,false);
  assert.deepEqual((await db.query("SELECT * FROM tinder_matches")).rows,persisted);
  await assert.rejects(()=>db.query("UPDATE tinder_matches SET consecutive_complete_misses=-1"),/check constraint/);
}));
test("partial or contradictory schema aborts without repairing it",async()=>fixture(async(db,pool)=>{
  await db.exec("ALTER TABLE tinder_matches ADD COLUMN is_active BOOLEAN NULL");
  await assert.rejects(()=>migrateMatchLifecycle(pool),/SCHEMA_DRIFT/);
  assert.equal((await db.query("SELECT count(*)::int n FROM tinder_matches")).rows[0].n,1);
}));
test("failed postcheck rolls additive DDL back",async()=>fixture(async(db,pool)=>{
  const fail={connect:async()=>({release(){},query:async(sql,args)=>{
    if(sql.includes("AS n FROM tinder_matches WHERE"))throw Error("postcheck fixture failure");
    return db.query(sql,args);
  }})};
  await assert.rejects(()=>migrateMatchLifecycle(fail),/postcheck fixture failure/);
  assert.equal((await preflightMatchLifecycle(pool)).state,"ELIGIBLE_FOR_MIGRATION");
}));
test("lost COMMIT acknowledgement discards connection and never repeats mutation",async()=>fixture(async(db,pool)=>{
  let commits=0,rollbacks=0,discard=false;
  const uncertain={connect:async()=>({release(value){discard=value;},query:async(sql,args)=>{
    if(sql==="ROLLBACK")rollbacks++;
    const result=await db.query(sql,args);
    if(sql==="COMMIT"){commits++;throw Error("lost acknowledgement");}return result;
  }})};
  await assert.rejects(()=>migrateMatchLifecycle(uncertain),/COMMIT_OUTCOME_UNKNOWN/);
  assert.equal(commits,1);assert.equal(rollbacks,0);assert.equal(discard,true);
  assert.equal((await preflightMatchLifecycle(pool)).state,"ALREADY_CANONICAL");
}));
test("runner requires explicit mode and never logs database secrets",async()=>{
  const output=[];const logger={log:v=>output.push(v),error:v=>output.push(v)};
  let connected=0;
  const createPool=async()=>{connected++;throw Error("postgres://secret-fixture");};
  assert.equal(await runMatchLifecycleMigration({argv:[],environment:{},createPool,logger}),false);
  assert.equal(connected,0);
  assert.equal(await runMatchLifecycleMigration({argv:["--apply"],environment:{DATABASE_URL:"secret-fixture"},createPool,logger}),false);
  assert.equal(output.join(" ").includes("secret-fixture"),false);
});
