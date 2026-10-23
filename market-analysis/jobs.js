import {randomUUID} from 'node:crypto';
import {requireValue,utcMillis} from './instruments.js';
import {transaction,iso,ms,identity,lockSource,fence,logJob} from './storage.js';
import {validateEnvelope} from './api-storage.js';

const types = new Set(['news-sync','calendar-sync','macro-sync','catalog-sync','history-import','source-check']);
const transient = new Set(['TIMEOUT','SOURCE_HTTP_ERROR','PROVIDER_HTTP_ERROR','RATE_LIMITED','PROVIDER_RESPONSE_ERROR','SOURCE_UNAVAILABLE','LEASE_EXPIRED']);
const blocked = new Set(['SOURCE_RELEASE_NOT_CONFIRMED','TRANSPORT_NOT_CONFIGURED','NETWORK_ADAPTER_NOT_IMPLEMENTED','SOURCE_PERMISSION_NOT_CONFIRMED','SOURCE_NOT_IMPLEMENTED','ENTITLEMENT_NOT_CONFIRMED','ENTITLEMENT_EXPIRED','CREDENTIAL_NOT_CONFIGURED','ACCESS_DENIED']);
// No raw messages, response bodies, API URLs or credentials are logged.
export function safeJobError(error) {
  const code = error?.code;
  return typeof code === 'string' && (transient.has(code) || blocked.has(code) || ['ABORTED','EVENT_INVALID','PIPELINE_INVALID','BATCH_INVALID','SOURCE_RESPONSE_INVALID','PYTHON_UNAVAILABLE','PYTHON_VERSION_UNSUPPORTED','MEMORY_LIMIT','MEMORY_LIMIT_UNAVAILABLE','COMPUTE_FAILED','OUTPUT_LIMIT'].includes(code)) ? code : 'JOB_FAILED';
}
export function retryDelay(attempt,retryAfterMs = 0) {
  return Math.min(3600000,Math.max(1000 * 2 ** Math.min(attempt,10),Number.isFinite(retryAfterMs)?Math.max(0,retryAfterMs):0));
}

export function createAnalysisJobs({database,clock = Date.now,leaseMs = 30000} = {}) {
  requireValue(database && Number.isInteger(leaseMs) && leaseMs>=1000 && leaseMs<=60000,'Invalid job configuration.');
  return Object.freeze({
    leaseMs,
    // policy is a separately verified scheduling grant, NOT data-access authority.
    async enqueue({sourceId,type,idempotencyKey,maxAttempts = 3,policy,api=null}) {
      validateEnvelope(api);
      identity(sourceId);identity(idempotencyKey);
      const now = iso(clock);
      requireValue(types.has(type) && Number.isInteger(maxAttempts) && maxAttempts>=1 && maxAttempts<=5,'Invalid job.');
      requireValue(policy?.sourceId === sourceId && policy.type === type && Number.isInteger(policy.intervalMs) && policy.intervalMs>=60000 && policy.intervalMs<=604800000,'Explicit source-specific interval required.');
      requireValue(policy.mode === 'offline-fixture' || policy.verified === true && typeof policy.reference === 'string' && policy.reference.trim().length>0 && utcMillis(policy.checkedAt)<=utcMillis(now) && utcMillis(policy.expiresAt)>utcMillis(now),'Scheduling rights not verified.');
      return transaction(database,async tx=>{
        if(api)await lockSource(tx,'__job_control__');
        await lockSource(tx,sourceId);
        const existing = (await tx.query('SELECT * FROM marcel_market_analysis.jobs WHERE source_id=$1 AND type=$2 AND idempotency_key=$3',[sourceId,type,idempotencyKey])).rows[0];
        if(existing){requireValue(!api||existing.api?.owner===api.owner,'API owner mismatch.');return existing;}
        if(api){const n=(await tx.query("SELECT count(*)::int AS n,COALESCE(sum(octet_length(api::text)),0)::bigint AS bytes FROM marcel_market_analysis.jobs WHERE api IS NOT NULL")).rows[0];requireValue(n.n<100&&Number(n.bytes)+Buffer.byteLength(JSON.stringify(api))<=32000000,'API storage capacity exceeded.');}
        const count = (await tx.query("SELECT count(*)::integer AS n FROM marcel_market_analysis.jobs WHERE source_id=$1 AND status IN ('queued','retry','running')",[sourceId])).rows[0].n;
        requireValue(count<100,'Source queue capacity exceeded.');
        const state = (await tx.query('SELECT next_allowed_at FROM marcel_market_analysis.sources WHERE id=$1',[sourceId])).rows[0];
        const due = new Date(Math.max(utcMillis(now),state.next_allowed_at?ms(state.next_allowed_at):0)).toISOString();
        await tx.query(`INSERT INTO marcel_market_analysis.jobs(id,source_id,type,idempotency_key,status,created_at,due_at,max_attempts,interval_ms,api)
          VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9::jsonb) ON CONFLICT(source_id,type,idempotency_key) DO NOTHING`,[randomUUID(),sourceId,type,idempotencyKey,now,due,maxAttempts,policy.intervalMs,api?JSON.stringify(api):null]);
        if(api){const stored=(await tx.query("SELECT COALESCE(sum(octet_length(api::text)),0)::bigint AS bytes FROM marcel_market_analysis.jobs WHERE api IS NOT NULL")).rows[0];requireValue(Number(stored.bytes)<=32000000,'API storage capacity exceeded.');}
        return (await tx.query('SELECT * FROM marcel_market_analysis.jobs WHERE source_id=$1 AND type=$2 AND idempotency_key=$3',[sourceId,type,idempotencyKey])).rows[0];
      });
    },
    async claim({jobId = null} = {}) {
      return transaction(database,async tx=>{
        // Serialises claim/recovery across processes; max ONE running analysis job.
        // Does not acquire or consume any existing pg-boss queue.
        await lockSource(tx,'__job_control__');
        const now = iso(clock);
        const expired = await tx.query("SELECT * FROM marcel_market_analysis.jobs WHERE status='running' AND lease_until<=$1 ORDER BY lease_until LIMIT 100 FOR UPDATE SKIP LOCKED",[now]);
        for(const job of expired.rows) {
          const status = job.attempts<job.max_attempts ? 'retry' : 'failed';
          const due = new Date(utcMillis(now)+retryDelay(job.attempts)).toISOString();
          await tx.query('UPDATE marcel_market_analysis.jobs SET status=$2,due_at=$3,ended_at=$4,lease_token=NULL,lease_until=NULL,error_code=$5 WHERE id=$1',[job.id,status,due,now,'LEASE_EXPIRED']);
          await logJob(tx,job,now,status,'LEASE_EXPIRED');
        }
        const running = await tx.query("SELECT id FROM marcel_market_analysis.jobs WHERE status='running' LIMIT 1");
        if(running.rows.length) return null;
        const due = await tx.query(`SELECT j.* FROM marcel_market_analysis.jobs j JOIN marcel_market_analysis.sources s ON s.id=j.source_id
          WHERE j.status IN ('queued','retry') AND j.due_at<=$1 AND (s.next_allowed_at IS NULL OR s.next_allowed_at<=$1)
          AND ($2::uuid IS NULL OR j.id=$2)
          ORDER BY j.due_at,j.created_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,[now,jobId]);
        const job = due.rows[0];if(!job) return null;
        const result = await tx.query(`UPDATE marcel_market_analysis.jobs SET status='running',started_at=$2,ended_at=NULL,
          attempts=attempts+1,lease_token=$3,lease_until=$4 WHERE id=$1 RETURNING *`,[job.id,now,randomUUID(),new Date(utcMillis(now)+leaseMs).toISOString()]);
        // Reserve source cadence at ATTEMPT time, including failed/aborted reads.
        // This also protects already queued jobs with different idempotency keys.
        await tx.query('UPDATE marcel_market_analysis.sources SET next_allowed_at=$2 WHERE id=$1',[job.source_id,new Date(utcMillis(now)+job.interval_ms).toISOString()]);
        await logJob(tx,result.rows[0],now,'running');return result.rows[0];
      });
    },
    async heartbeat(job) {
      return transaction(database,async tx=>{
        await fence(tx,job,iso(clock),clock);
        await tx.query('UPDATE marcel_market_analysis.jobs SET lease_until=$2 WHERE id=$1',[job.id,new Date(clock()+leaseMs).toISOString()]);
      });
    },
    async fail(job,error) {
      const code = safeJobError(error);
      return transaction(database,async tx=>{
        await lockSource(tx,'__job_control__');
        await lockSource(tx,job.source_id);const now = iso(clock);await fence(tx,job,now,clock);
        const status = blocked.has(code) ? 'blocked' : transient.has(code) && job.attempts<job.max_attempts ? 'retry' : 'failed';
        const delay = retryDelay(job.attempts,error?.retryMs ?? (error?.retryAfterSeconds ?? 0)*1000);
        await tx.query('UPDATE marcel_market_analysis.jobs SET status=$2,ended_at=$3,due_at=$4,lease_token=NULL,lease_until=NULL,error_code=$5 WHERE id=$1',[job.id,status,now,new Date(utcMillis(now)+delay).toISOString(),code]);
        await tx.query('UPDATE marcel_market_analysis.sources SET last_error_at=$2,error_code=$3,next_allowed_at=GREATEST(next_allowed_at,$4::timestamptz) WHERE id=$1',[job.source_id,now,code,new Date(utcMillis(now)+delay).toISOString()]);
        await logJob(tx,job,now,status,code);return status;
      });
    },
    async cancel(id) {
      return transaction(database,async tx=>{
        const result = await tx.query("UPDATE marcel_market_analysis.jobs SET status='cancelled',ended_at=$2,lease_token=NULL,lease_until=NULL WHERE id=$1 AND status IN ('queued','retry','running') RETURNING *",[id,iso(clock)]);
        if(result.rows[0]) await logJob(tx,result.rows[0],iso(clock),'cancelled');
        return result.rows.length===1;
      });
    },
    async get(id) { return (await database.query('SELECT * FROM marcel_market_analysis.jobs WHERE id=$1',[id])).rows[0] ?? null; },
    async log(id) { return (await database.query('SELECT * FROM marcel_market_analysis.job_log WHERE job_id=$1 ORDER BY sequence LIMIT 100',[id])).rows; },
  });
}
