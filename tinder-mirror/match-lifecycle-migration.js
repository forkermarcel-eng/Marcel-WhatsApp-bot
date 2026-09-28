import {createHash} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import {readCatalog,catalogState} from "./matches-migration.js";
import {canonicalCheckDefinition} from "../device-bridge/schema-contract.js";

const columns={
  last_seen_at:["timestamptz","YES",null],
  last_inventory_at:["timestamptz","YES",null],
  consecutive_complete_misses:["int4","NO","0"],
  is_active:["bool","NO","true"]
};
const checkName="tinder_matches_complete_misses_nonnegative";
export const MATCH_LIFECYCLE_DDL=`ALTER TABLE tinder_matches
  ADD COLUMN last_seen_at TIMESTAMPTZ NULL,
  ADD COLUMN last_inventory_at TIMESTAMPTZ NULL,
  ADD COLUMN consecutive_complete_misses INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD CONSTRAINT ${checkName} CHECK (consecutive_complete_misses >= 0)`;
export const MATCH_LIFECYCLE_HASH=createHash("sha256").update(MATCH_LIFECYCLE_DDL).digest("hex");

export async function inspectMatchLifecycle(client) {
  const catalog=await readCatalog(client);
  const profile=catalog.columns.filter(c=>c.table_name==="tinder_matches"&&c.column_name==="profile");
  const added=catalog.columns.filter(c=>c.table_name==="tinder_matches"&&Object.hasOwn(columns,c.column_name));
  const checks=catalog.constraints.filter(c=>c.table_name==="tinder_matches"&&c.conname===checkName);
  const drift=()=>{throw Error("MATCH_LIFECYCLE_SCHEMA_DRIFT");};
  if(profile.length!==1||profile[0].udt_name!=="jsonb"||profile[0].is_nullable!=="YES"||profile[0].column_default!==null)drift();
  const baseline={...catalog,columns:catalog.columns.filter(c=>!profile.includes(c)&&!added.includes(c)),
    constraints:catalog.constraints.filter(c=>!checks.includes(c))};
  if(catalogState(baseline).state!=="ALREADY_CANONICAL")drift();
  if(added.length===0&&checks.length===0)return {state:"ELIGIBLE_FOR_MIGRATION",hash:MATCH_LIFECYCLE_HASH};
  if(added.length!==4||checks.length!==1||checks[0].contype!=="c"
    ||canonicalCheckDefinition(checks[0].definition)!==canonicalCheckDefinition("CHECK (consecutive_complete_misses >= 0)"))drift();
  for(const [name,[type,nullable,def]] of Object.entries(columns)) {
    const c=added.find(c=>c.column_name===name);
    if(!c||c.udt_name!==type||c.is_nullable!==nullable||c.column_default!==def)drift();
  }
  return {state:"ALREADY_CANONICAL",hash:MATCH_LIFECYCLE_HASH};
}
async function snapshot(client,omitAdded) {
  const result={};
  for(const table of ["tinder_matches","tinder_conversations","tinder_conversation_messages"]) {
    const expression=table==="tinder_matches"&&omitAdded
      ?`(to_jsonb(t) - ARRAY['last_seen_at','last_inventory_at','consecutive_complete_misses','is_active'])`:"to_jsonb(t)";
    result[table]=(await client.query(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(row_value,E'\\n' ORDER BY row_value),'')) AS digest
      FROM (SELECT ${expression}::text AS row_value FROM ${table} t) s`)).rows[0];
  }
  return result;
}
export async function preflightMatchLifecycle(pool) {
  const client=await pool.connect();
  try {await client.query("BEGIN READ ONLY");const result=await inspectMatchLifecycle(client);await client.query("COMMIT");return result;}
  catch(error){await client.query("ROLLBACK").catch(()=>{});throw error;}
  finally{client.release();}
}
export async function migrateMatchLifecycle(pool) {
  const client=await pool.connect();let committing=false,discard=false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(7421,29)");
    await client.query("LOCK TABLE tinder_matches IN ACCESS EXCLUSIVE MODE");
    await client.query("LOCK TABLE tinder_conversations, tinder_conversation_messages IN SHARE MODE");
    const before=await inspectMatchLifecycle(client),changed=before.state==="ELIGIBLE_FOR_MIGRATION";
    const prior=await snapshot(client,changed);
    if(changed) {
      await client.query(MATCH_LIFECYCLE_DDL);
      const invalid=await client.query(`SELECT count(*)::int AS n FROM tinder_matches WHERE
        last_seen_at IS NOT NULL OR last_inventory_at IS NOT NULL OR consecutive_complete_misses <> 0 OR NOT is_active`);
      if(invalid.rows[0].n!==0)throw Error("MATCH_LIFECYCLE_UNEXPECTED_BACKFILL");
    }
    if((await inspectMatchLifecycle(client)).state!=="ALREADY_CANONICAL"
      ||!isDeepStrictEqual(prior,await snapshot(client,changed)))throw Error("MATCH_LIFECYCLE_POSTCHECK_FAILED");
    committing=true;await client.query("COMMIT");
    return {state:"COMMIT_CONFIRMED",changed,hash:MATCH_LIFECYCLE_HASH,
      counts:Object.fromEntries(Object.entries(prior).map(([key,value])=>[key,value.count]))};
  }catch(error){
    if(committing){discard=true;throw Error("MATCH_LIFECYCLE_COMMIT_OUTCOME_UNKNOWN",{cause:error});}
    try{await client.query("ROLLBACK");}catch{discard=true;}throw error;
  }finally{client.release(discard);}
}
