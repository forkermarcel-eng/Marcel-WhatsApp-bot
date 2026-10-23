import {requireValue, utcMillis} from './instruments.js';

// Inject pg Pool, or an explicitly isolated PGlite database. Never reads env.
export async function transaction(database, fn) {
  if (typeof database.transaction === 'function') return database.transaction(fn);
  requireValue(typeof database.connect === 'function', 'Transactional database required.');
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL statement_timeout='20s'");
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export const iso = clock => new Date(clock()).toISOString();
export const ms = value => value instanceof Date ? value.getTime() : utcMillis(value);
export function identity(value) {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= 700 && !/[\x00-\x1f]/.test(value), 'Invalid storage identity.');
  return value;
}
export async function lockSource(tx, sourceId) {
  identity(sourceId);
  await tx.query('INSERT INTO marcel_market_analysis.sources(id) VALUES($1) ON CONFLICT DO NOTHING', [sourceId]);
  await tx.query('SELECT id FROM marcel_market_analysis.sources WHERE id=$1 FOR UPDATE', [sourceId]);
}
export async function fence(tx, job, now, clock) {
  const result = await tx.query("SELECT lease_until FROM marcel_market_analysis.jobs WHERE id=$1 AND source_id=$2 AND status='running' AND lease_token=$3 AND lease_until>$4 FOR UPDATE", [job.id, job.source_id, job.lease_token, now]);
  requireValue(result.rows.length === 1 && (!clock || ms(result.rows[0].lease_until)>clock()), 'JOB_LEASE_LOST');
}
export async function logJob(tx, job, now, status, error = null) {
  await tx.query('INSERT INTO marcel_market_analysis.job_log(job_id,at,status,attempt,error_code) VALUES($1,$2,$3,$4,$5)', [job.id, now, status, job.attempts, error]);
}
