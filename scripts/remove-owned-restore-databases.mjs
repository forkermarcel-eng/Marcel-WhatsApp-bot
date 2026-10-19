import pg from 'pg';

const ownedRestoreDatabases = [
  'marcel_night_restore_20261019',
  'marcel_world2_restore_20261018',
  'marcel_production_verify_20261019',
];
const requested = process.env.PG_OWNED_RESTORE_DATABASE;
if (requested) {
  if (!/^marcel_[a-z0-9_]+$/.test(requested)) throw new Error('Ungültiger Name für eine eigene Restore-Testdatenbank.');
  ownedRestoreDatabases.push(requested);
}
const source = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const port = process.env.PG_AUDIT_TUNNEL_PORT;
if (!source || !port) throw new Error('DATABASE_URL und PG_AUDIT_TUNNEL_PORT sind erforderlich.');
const connection = new URL(source);
connection.hostname = process.env.PG_AUDIT_TUNNEL_HOST || '127.0.0.1';
connection.port = port;
connection.pathname = '/postgres';
const client = new pg.Client({ connectionString: connection.toString() });
await client.connect();
try {
  const found = await client.query('SELECT datname FROM pg_database WHERE datname = ANY($1::text[]) ORDER BY datname', [ownedRestoreDatabases]);
  const foundNames = new Set(found.rows.map((row) => row.datname));
  for (const database of ownedRestoreDatabases) {
    if (!foundNames.has(database)) continue;
    await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [database]);
    await client.query(`DROP DATABASE "${database}"`);
  }
  console.log(JSON.stringify({ ok: true, removed: ownedRestoreDatabases.filter((database) => foundNames.has(database)) }, null, 2));
} finally {
  await client.end();
}
