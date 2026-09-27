import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { catalogState, readCatalog } from "./matches-migration.js";

export const MATCH_PROFILE_DDL = "ALTER TABLE tinder_matches ADD COLUMN profile JSONB NULL";
export const MATCH_PROFILE_MIGRATION_HASH = createHash("sha256").update(MATCH_PROFILE_DDL).digest("hex");

export async function inspectMatchProfileSchema(client) {
  const catalog = await readCatalog(client);
  const profile = catalog.columns.filter(c => c.table_name === "tinder_matches" && c.column_name === "profile");
  if (profile.length > 1 || (profile.length === 1 && (profile[0].udt_name !== "jsonb"
    || profile[0].is_nullable !== "YES" || profile[0].column_default !== null))) {
    throw new Error("MATCH_PROFILE_SCHEMA_DRIFT");
  }
  const baseline = {...catalog, columns:catalog.columns.filter(c=>!profile.includes(c))};
  if (catalogState(baseline).state !== "ALREADY_CANONICAL") throw new Error("MATCH_PROFILE_SCHEMA_DRIFT");
  return {state:profile.length ? "ALREADY_CANONICAL" : "ELIGIBLE_FOR_MIGRATION", hash:MATCH_PROFILE_MIGRATION_HASH};
}

async function productSnapshot(client, omitMatchProfile) {
  const result = {};
  for (const table of ["tinder_matches","tinder_conversations","tinder_conversation_messages"]) {
    // Subtract only the additive key: existing row values must remain identical.
    const rowExpression=table==="tinder_matches"&&omitMatchProfile?"(to_jsonb(t) - 'profile')":"to_jsonb(t)";
    result[table]=(await client.query(`SELECT count(*)::int AS count,
      md5(COALESCE(string_agg(row_value, E'\\n' ORDER BY row_value),'')) AS digest
      FROM (SELECT ${rowExpression}::text AS row_value FROM ${table} t) s`)).rows[0];
  }
  return result;
}

export async function preflightMatchProfile(pool) {
  const client=await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    const result=await inspectMatchProfileSchema(client);
    await client.query("COMMIT");
    return result;
  } catch(error) { await client.query("ROLLBACK").catch(()=>{});throw error; }
  finally {client.release();}
}

export async function migrateMatchProfile(pool) {
  const client=await pool.connect();
  let committing=false,discard=false;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock(7421,28)");
    await client.query("LOCK TABLE tinder_matches IN ACCESS EXCLUSIVE MODE");
    await client.query("LOCK TABLE tinder_conversations, tinder_conversation_messages IN SHARE MODE");
    const before=await inspectMatchProfileSchema(client);
    const omitMatchProfile=before.state==="ELIGIBLE_FOR_MIGRATION";
    const snapshot=await productSnapshot(client,omitMatchProfile);
    if(before.state==="ELIGIBLE_FOR_MIGRATION") {
      await client.query(MATCH_PROFILE_DDL);
      if((await client.query("SELECT count(*)::int AS n FROM tinder_matches WHERE profile IS NOT NULL")).rows[0].n!==0)
        throw new Error("MATCH_PROFILE_UNEXPECTED_BACKFILL");
    }
    const after=await inspectMatchProfileSchema(client);
    if(after.state!=="ALREADY_CANONICAL" || !isDeepStrictEqual(snapshot,await productSnapshot(client,omitMatchProfile)))
      throw new Error("MATCH_PROFILE_POSTCHECK_FAILED");
    committing=true;
    await client.query("COMMIT");
    return {state:"COMMIT_CONFIRMED",changed:before.state!==after.state,hash:MATCH_PROFILE_MIGRATION_HASH,
      counts:Object.fromEntries(Object.entries(snapshot).map(([key,value])=>[key,value.count]))};
  } catch(error) {
    if(committing) {discard=true;throw new Error("MATCH_PROFILE_COMMIT_OUTCOME_UNKNOWN",{cause:error});}
    try {await client.query("ROLLBACK");}catch{discard=true;}
    throw error;
  } finally {client.release(discard);}
}
