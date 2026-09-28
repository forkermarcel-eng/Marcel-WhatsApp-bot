import path from "node:path";
import {fileURLToPath} from "node:url";
import {preflightMatchLifecycle,migrateMatchLifecycle} from "../tinder-mirror/match-lifecycle-migration.js";

export async function runMatchLifecycleMigration({argv=process.argv.slice(2),environment=process.env,
  createPool=async options=>{const {default:pg}=await import("pg");return new pg.Pool(options);},logger=console}={}) {
  if(argv.length!==1||!["--preflight","--apply"].includes(argv[0])){logger.error("MATCH_LIFECYCLE_EXPLICIT_MODE_REQUIRED");return false;}
  if(!environment.DATABASE_URL){logger.error("MATCH_LIFECYCLE_DATABASE_URL_REQUIRED");return false;}
  let pool;
  try {
    pool=await createPool({connectionString:environment.DATABASE_URL});
    logger.log(JSON.stringify(await(argv[0]==="--apply"?migrateMatchLifecycle(pool):preflightMatchLifecycle(pool))));return true;
  }catch(error){
    const known=["MATCH_LIFECYCLE_SCHEMA_DRIFT","MATCH_LIFECYCLE_UNEXPECTED_BACKFILL","MATCH_LIFECYCLE_POSTCHECK_FAILED","MATCH_LIFECYCLE_COMMIT_OUTCOME_UNKNOWN"];
    logger.error(known.includes(error.message)?error.message:"MATCH_LIFECYCLE_DATABASE_OPERATION_FAILED");return false;
  }finally{await pool?.end().catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(!await runMatchLifecycleMigration())process.exitCode=1;
}
