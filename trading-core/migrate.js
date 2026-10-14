/** Explicit, isolated SQL migration. Default: dry run. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const sql=await readFile(new URL('./schema.sql',import.meta.url),'utf8');
const checksum=createHash('sha256').update(sql).digest('hex');
if(!process.argv.includes('--apply')) {
  console.log('DRY RUN: ausschließlich neues Schema marcel_trading; keine vorhandenen Tabellenänderungen.\nSHA256 '+checksum+'\nZum Anwenden: node trading-core/migrate.js --apply');
  process.exit(0);
}
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL fehlt.');
const {default:pg}=await import('pg');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:1,connectionTimeoutMillis:10000});
let client,began=false;
try {
  client=await pool.connect();
  await client.query('BEGIN');began=true;
  await client.query("SET LOCAL lock_timeout='5s'");
  await client.query("SET LOCAL statement_timeout='30s'");
  await client.query('SELECT pg_advisory_xact_lock(781022164)');
  const schema=(await client.query("SELECT to_regnamespace('marcel_trading') AS name")).rows[0].name;
  if(schema) {
    const table=(await client.query("SELECT to_regclass('marcel_trading.schema_versions') AS name")).rows[0].name;
    if(!table)throw Error('marcel_trading existiert ohne Versionsnachweis. Keine vorhandenen Strukturen übernommen oder verändert.');
    const previous=(await client.query('SELECT checksum FROM marcel_trading.schema_versions WHERE version=1')).rows[0];
    if(!previous||previous.checksum!==checksum)throw Error('Trading-Schema/Prüfsumme stimmt nicht. Bestehende Migrationen nicht überschreiben.');
    await client.query('ROLLBACK');began=false;
    console.log('Bereits identisch angewendet. Keine Änderung.');
  } else {
    await client.query(sql);
    await client.query('INSERT INTO marcel_trading.schema_versions(version,checksum) VALUES(1,$1)',[checksum]);
    await client.query('COMMIT');began=false;
    console.log('Neues Trading-Schema transaktional angelegt.');
  }
} catch(error) {
  if(began)await client.query('ROLLBACK');
  console.error(error.message);process.exitCode=1;
} finally {client?.release();await pool.end();}
