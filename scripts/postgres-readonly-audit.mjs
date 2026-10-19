import pg from 'pg';

const url = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
if (!url) throw new Error('Keine DATABASE_URL oder DATABASE_PUBLIC_URL vorhanden.');
const connection = new URL(url);
if (process.env.PG_AUDIT_DATABASE) connection.pathname = `/${encodeURIComponent(process.env.PG_AUDIT_DATABASE)}`;
if (process.env.PG_AUDIT_TUNNEL_PORT) {
  connection.hostname = process.env.PG_AUDIT_TUNNEL_HOST || '127.0.0.1';
  connection.port = process.env.PG_AUDIT_TUNNEL_PORT;
}

const pool = new pg.Pool({ connectionString: connection.toString(), max: 1, connectionTimeoutMillis: 15_000 });
try {
  const databases = await pool.query(`
    SELECT datname, pg_database_size(datname) AS bytes
    FROM pg_database
    WHERE datistemplate = false
    ORDER BY datname
  `);
  const tables = await pool.query(`
    SELECT schemaname, tablename, pg_total_relation_size(format('%I.%I', schemaname, tablename)) AS bytes
    FROM pg_tables
    WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY bytes DESC
    LIMIT 200
  `);
  const integrity = await pool.query(`
    SELECT current_database() AS database,
           pg_is_in_recovery() AS in_recovery,
           pg_postmaster_start_time() AS started_at,
           pg_size_pretty(pg_database_size(current_database())) AS database_size,
           (SELECT count(*)::int FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')) AS table_count
  `);
  const counts = await pool.query(`
    SELECT
      (SELECT count(*)::int FROM marcel_knowledge.documents) AS knowledge_documents,
      (SELECT count(*)::int FROM marcel_knowledge.entries) AS knowledge_entries,
      (SELECT count(*)::int FROM marcel_knowledge.evidence) AS knowledge_evidence,
      (SELECT count(*)::int FROM marcel_memory WHERE status = 'active') AS active_memories,
      (SELECT count(*)::int FROM marcel_memory WHERE status = 'active' AND human_verified = true AND allowed_for_bot = true) AS approved_bot_memories,
      (SELECT count(*)::int FROM marcel_world.news WHERE expires_at > now()) AS active_world_news,
      (SELECT count(*)::int FROM marcel_world.news WHERE fetched_at > now() - interval '24 hours') AS world_news_fetched_24h,
      (SELECT count(*)::int FROM marcel_world.sources) AS world_sources,
      (SELECT count(*)::int FROM marcel_trading.news) AS trading_news,
      (SELECT count(*)::int FROM marcel_trading.candles) AS trading_candles,
      (SELECT count(*)::int FROM pgboss.schedule) AS scheduled_jobs,
      (SELECT count(*)::int FROM pgboss.job) AS queued_jobs
  `);
  console.log(JSON.stringify({ integrity: integrity.rows[0], counts: counts.rows[0], databases: databases.rows, tables: tables.rows }, null, 2));
} finally {
  await pool.end();
}
