import { spawn } from 'node:child_process';
import { once } from 'node:events';
import pg from 'pg';

const source = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const dump = process.env.PG_AUDIT_DUMP_PATH;
const port = process.env.PG_AUDIT_TUNNEL_PORT;
const database = process.env.PG_AUDIT_RESTORE_DATABASE;
if (!source || !dump || !port || !database) throw new Error('DATABASE_URL, PG_AUDIT_DUMP_PATH, PG_AUDIT_TUNNEL_PORT und PG_AUDIT_RESTORE_DATABASE sind erforderlich.');
if (!/^marcel_[a-z0-9_]+$/.test(database)) throw new Error('Ungültiger Name für eine isolierte Marcel-Restore-Testdatenbank.');

const base = new URL(source);
base.hostname = process.env.PG_AUDIT_TUNNEL_HOST || '127.0.0.1';
base.port = port;
base.pathname = '/postgres';
const admin = new pg.Client({ connectionString: base.toString() });
await admin.connect();
try {
  const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
  if (existing.rowCount) throw new Error(`Restore-Testdatenbank existiert bereits: ${database}`);
  await admin.query(`CREATE DATABASE "${database}"`);
} finally {
  await admin.end();
}

const pgRestore = process.env.PG_RESTORE_PATH || 'pg_restore';
const child = spawn(pgRestore, [
  '--exit-on-error', '--no-owner', '--no-privileges', '--verbose',
  '--host', process.env.PG_AUDIT_TUNNEL_HOST || '127.0.0.1', '--port', port,
  '--username', decodeURIComponent(base.username), '--dbname', database, dump,
], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PGPASSWORD: decodeURIComponent(base.password) } });
let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
const [code] = await once(child, 'close');
if (code !== 0) throw new Error(`pg_restore fehlgeschlagen (${code}): ${stderr.slice(-1000)}`);

base.pathname = `/${database}`;
const verify = new pg.Client({ connectionString: base.toString() });
await verify.connect();
try {
  const result = await verify.query(`SELECT
    (SELECT count(*)::int FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')) AS table_count,
    (SELECT count(*)::int FROM marcel_knowledge.entries) AS knowledge_entries,
    (SELECT count(*)::int FROM marcel_world.news WHERE expires_at > now()) AS active_world_news,
    (SELECT count(*)::int FROM marcel_trading.candles) AS trading_candles`);
  console.log(JSON.stringify({ ok: true, database, ...result.rows[0] }, null, 2));
} finally {
  await verify.end();
}
