import test from "node:test";
import assert from "node:assert/strict";
import {PGlite} from "@electric-sql/pglite";
import {TINDER_MIRROR_MIGRATION_STATEMENTS as base} from "../tinder-mirror/migration.js";
import {TINDER_LAST_MESSAGE_ORDER_MIGRATION_STATEMENTS as order} from "../tinder-mirror/last-message-order-migration.js";
import {TINDER_MATCH_MIGRATION_STATEMENTS as matches} from "../tinder-mirror/matches-migration.js";
import {MATCH_PROFILE_DDL} from "../tinder-mirror/match-profile-migration.js";
import {migrateMatchLifecycle} from "../tinder-mirror/match-lifecycle-migration.js";
import {createMatchLifecycle} from "../tinder-mirror/match-lifecycle.js";
import {createTinderMatchMirror} from "../tinder-mirror/matches.js";
const deviceId="11111111-1111-4111-8111-111111111111";
const matchId="22222222-2222-4222-8222-222222222222";
const tile={display_name:"synthetic fixture",attributes:{},media_refs:[]};
const at=n=>new Date(Date.UTC(2026,0,1,0,n)).toISOString();
const inventory=(n,tiles=[])=>({complete:true,status:"COMPLETE",started_at:at(n*2),finished_at:at(n*2+1),tiles});
async function fixture(run){
  const db=new PGlite();const pool={query:(...a)=>db.query(...a),connect:async()=>({query:(...a)=>db.query(...a),release(){}})};
  try {
    await db.exec("CREATE TABLE device_bridge_devices(device_id UUID PRIMARY KEY)");
    for(const sql of [...base,...order,...matches,MATCH_PROFILE_DDL])await db.exec(sql);
    await db.query("INSERT INTO device_bridge_devices VALUES($1)",[deviceId]);
    await db.query(`INSERT INTO tinder_matches(match_id,device_id,tile,profile,carousel_position,created_at)
      VALUES($1,$2,$3,'{"attributes":{"about":"preserved"}}',0,$4)`,[matchId,deviceId,JSON.stringify(tile),at(0)]);
    await migrateMatchLifecycle(pool);
    const read=async()=>(await db.query("SELECT * FROM tinder_matches WHERE match_id=$1",[matchId])).rows[0];
    const service=()=>createMatchLifecycle({pool,now:()=>new Date(at(100))});
    await run({db,pool,read,service,observe:inv=>service().observe({deviceId,inventory:inv})});
  }finally{await db.close();}
}
test("three independent complete misses persist across restart; hide only active projection; retain historical profile",async()=>fixture(async({pool,read,observe})=>{
  const before=await read();
  for(let n=1;n<=3;n++) {
    const result=await observe(inventory(n)); // a fresh service simulates restart
    assert.equal(result.missed,1);
    assert.equal((await read()).consecutive_complete_misses,n);
    assert.equal((await read()).is_active,n<3);
  }
  const mirror=createTinderMatchMirror({pool});
  assert.equal((await mirror.list()).length,0);
  assert.equal((await mirror.list({includeInactive:true})).length,1);
  const after=await read();
  for(const key of ["match_id","device_id","profile","tile","conversation_id","created_at","updated_at"])assert.deepEqual(after[key],before[key]);
}));
test("seen after one or two misses resets; inactive return reuses the same owner",async()=>fixture(async({read,observe})=>{
  await observe(inventory(1));await observe(inventory(2));
  await observe(inventory(3,[{media_refs:[],attributes:{},display_name:tile.display_name}]));
  assert.equal((await read()).consecutive_complete_misses,0);
  assert.equal(new Date((await read()).last_seen_at).toISOString(),at(7));
  for(let n=4;n<=6;n++)await observe(inventory(n));
  assert.equal((await read()).is_active,false);
  await observe(inventory(7,[tile]));
  assert.equal((await read()).is_active,true);assert.equal((await read()).consecutive_complete_misses,0);
  assert.equal((await read()).match_id,matchId);
}));
test("partial, loading, error and nonterminal observations change no lifecycle field",async()=>fixture(async({read,observe})=>{
  await observe(inventory(1));const before=await read();
  for(const status of ["PARTIAL","ERROR","LOADING"])assert.equal((await observe({...inventory(2),status})).ignored,true);
  assert.equal((await observe({...inventory(2),complete:false})).ignored,true);
  assert.deepEqual(await read(),before);
}));
test("replayed, overlapping and out-of-order inventories do not manufacture independent misses",async()=>fixture(async({read,observe})=>{
  await observe(inventory(2));
  await observe(inventory(2));await observe(inventory(1));
  await observe({...inventory(3),started_at:at(4)});
  assert.equal((await read()).consecutive_complete_misses,1);
  await observe(inventory(4));assert.equal((await read()).consecutive_complete_misses,2);
}));
test("indistinguishable surviving tile cannot mark an arbitrary historical peer missing",async()=>fixture(async({db,read,observe})=>{
  await db.query(`INSERT INTO tinder_matches(match_id,device_id,tile,carousel_position,created_at)
    VALUES('33333333-3333-4333-8333-333333333333',$1,$2,1,$3)`,[deviceId,JSON.stringify(tile),at(0)]);
  const result=await observe(inventory(1,[tile]));
  assert.equal(result.ambiguous,2);assert.equal((await read()).consecutive_complete_misses,0);
}));
test("new rows created after inventory start cannot be counted absent; confirmed converted rows cannot reactivate",async()=>fixture(async({db,read,observe})=>{
  await db.query("UPDATE tinder_matches SET created_at=$1",[at(5)]);
  assert.equal((await observe(inventory(1))).missed,0);
  const conversationId="44444444-4444-4444-8444-444444444444";
  await db.query("INSERT INTO tinder_conversations(conversation_id,device_id) VALUES($1,$2)",[conversationId,deviceId]);
  await db.query("UPDATE tinder_matches SET conversation_id=$1,is_active=FALSE",[conversationId]);
  await observe(inventory(4,[tile]));assert.equal((await read()).is_active,false);
}));
test("future inventory rejected without mutation",async()=>fixture(async({read,observe})=>{
  const before=await read();
  await assert.rejects(()=>observe(inventory(200)),/Invalid complete inventory/);
  assert.deepEqual(await read(),before);
}));
