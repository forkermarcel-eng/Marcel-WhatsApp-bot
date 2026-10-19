import { spawn } from 'node:child_process';
import { once } from 'node:events';

const source = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL;
const target = process.env.PG_AUDIT_DUMP_PATH;
const port = process.env.PG_AUDIT_TUNNEL_PORT;
if (!source || !target || !port) throw new Error('DATABASE_URL, PG_AUDIT_DUMP_PATH und PG_AUDIT_TUNNEL_PORT sind erforderlich.');

const connection = new URL(source);
const pgDump = process.env.PG_DUMP_PATH || 'pg_dump';
const child = spawn(pgDump, [
  '--format=custom', '--no-owner', '--no-privileges', '--verbose',
  '--host', process.env.PG_AUDIT_TUNNEL_HOST || '127.0.0.1',
  '--port', port, '--username', decodeURIComponent(connection.username),
  '--dbname', decodeURIComponent(connection.pathname.slice(1)),
  '--file', target,
], {
  stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, PGPASSWORD: decodeURIComponent(connection.password) },
});

let stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => { stderr += chunk; });
const [code] = await once(child, 'close');
if (code !== 0) throw new Error(`pg_dump fehlgeschlagen (${code}): ${stderr.slice(-1000)}`);
console.log(JSON.stringify({ ok: true, file: target }, null, 2));
