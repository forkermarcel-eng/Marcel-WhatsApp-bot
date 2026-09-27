import path from "node:path";
import { fileURLToPath } from "node:url";
import { preflightMatchProfile, migrateMatchProfile } from "../tinder-mirror/match-profile-migration.js";

export async function runMatchProfileMigration({argv=process.argv.slice(2),environment=process.env,
  createPool=async options=>{const {default:pg}=await import("pg");return new pg.Pool(options);},logger=console}={}) {
  if(argv.length!==1||!["--preflight","--apply"].includes(argv[0])) {logger.error("MATCH_PROFILE_EXPLICIT_MODE_REQUIRED");return false;}
  if(!environment.DATABASE_URL) {logger.error("MATCH_PROFILE_DATABASE_URL_REQUIRED");return false;}
  let pool;
  try {
    pool=await createPool({connectionString:environment.DATABASE_URL});
    const result=await (argv[0]==="--apply"?migrateMatchProfile(pool):preflightMatchProfile(pool));
    logger.log(JSON.stringify(result));return true;
  } catch(error) {
    const known=["MATCH_PROFILE_SCHEMA_DRIFT","MATCH_PROFILE_UNEXPECTED_BACKFILL","MATCH_PROFILE_POSTCHECK_FAILED","MATCH_PROFILE_COMMIT_OUTCOME_UNKNOWN"];
    logger.error(known.includes(error.message)?error.message:"MATCH_PROFILE_DATABASE_OPERATION_FAILED");return false;
  } finally {await pool?.end().catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!await runMatchProfileMigration())process.exitCode=1;
}
