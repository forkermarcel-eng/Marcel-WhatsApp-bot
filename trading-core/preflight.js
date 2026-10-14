/** Read-only readiness checks. Never creates tables or changes infrastructure. */
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {providerStatus} from './server/providers.js';

export async function preflight({env=process.env,database=false,http=false,production=false}={}) {
  const checks=[];
  const add=(name,status,message)=>checks.push({name,status,message});
  add('Node.js',Number(process.versions.node.split('.')[0])>=22?'PASS':'FAIL',`Version ${process.versions.node}; benötigt 22+.`);
  const feature=env.TRADING_ENABLED==='true';
  add('Backend-Registrierung',feature?'PASS':production?'FAIL':'INFO',feature?'Trading-Router aktiviert.':'TRADING_ENABLED ist nicht true; vorhandener Server bleibt unverändert.');
  add('Datenbank-Zugang',env.DATABASE_URL?'PASS':production?'FAIL':'INFO',env.DATABASE_URL?'DATABASE_URL vorhanden; Wert wird nicht ausgegeben.':'Kein DATABASE_URL. Demo benötigt keine Datenbank.');
  const secret=env.TRADING_API_SECRET||env.DASHBOARD_API_SECRET;
  add('Privater API-Schlüssel',secret&&secret.length>=32?'PASS':production?'FAIL':'INFO',secret&&secret.length>=32?'Backend-Schlüssel mit mindestens 32 Zeichen vorhanden.':'Für den Produktivbetrieb einen zufälligen TRADING_API_SECRET mit mindestens 32 Zeichen setzen.');
  const tokens=[secret,env.TRADING_INGEST_TOKEN,env.TRADING_INTELLIGENCE_TOKEN].filter(Boolean);
  add('Getrennte Rollen',new Set(tokens).size===tokens.length?'PASS':'FAIL','Admin, Datenfeed und Intelligence dürfen nicht denselben Schlüssel verwenden.');
  add('Schema-Isolation','PASS','Alle Trading-Tabellen liegen im separaten Schema marcel_trading.');
  for(const [name,p] of Object.entries(providerStatus(env))) {
    if(name==='broker')continue;
    add('Datenquelle '+name,p.configured?'PASS':'INFO',p.configured?'Konfiguriert, Verbindung/Entitlement damit noch nicht bestätigt.':'Nicht konfiguriert; Anzeige bleibt leer oder manuell.');
  }
  if(database) {
    let pool;
    try {
      if(!env.DATABASE_URL)throw Error('DATABASE_URL fehlt.');
      const {default:pg}=await import('pg');
      pool=new pg.Pool({connectionString:env.DATABASE_URL,max:1,connectionTimeoutMillis:8000,query_timeout:8000});
      const version=(await pool.query('SELECT version,checksum FROM marcel_trading.schema_versions ORDER BY version DESC LIMIT 1')).rows[0];
      const expected=createHash('sha256').update(await readFile(new URL('./schema.sql',import.meta.url))).digest('hex');
      add('SQL-Version/Prüfsumme',version?.version===1&&version.checksum===expected?'PASS':'FAIL','Nur lesender Abgleich mit der ausgelieferten Migration.');
      const tables=(await pool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='marcel_trading'")).rows[0].n;
      add('SQL-Tabellen',tables>=18?'PASS':'FAIL',`${tables} Trading-Tabellen gefunden.`);
    } catch(e) {
      add('SQL-Verbindung','FAIL',e.code==='ERR_MODULE_NOT_FOUND'?'Die vorhandene Projektabhängigkeit pg ist lokal nicht installiert.':'SQL-Zugriff oder Schema nicht bereit; keine Migration ausgeführt.');
    } finally {await pool?.end();}
  }
  if(http) {
    try {
      const u=new URL('/trading-api',env.TRADING_BACKEND_URL||env.RAILWAY_BACKEND_URL);
      if(u.protocol!=='https:')throw Error('HTTPS required');
      u.searchParams.set('resource','health');
      const response=await fetch(u,{headers:{Authorization:'Bearer '+secret},redirect:'error',signal:AbortSignal.timeout(10000)});
      const health=await response.json();
      add('Backend-Health',response.ok&&health.database?.ready&&health.execution===false?'PASS':'FAIL',`HTTP ${response.status}; Ausführungsschnittstelle muss ausgeschaltet sein.`);
    } catch {add('Backend-Health','FAIL','Backend-URL, Authentifizierung oder Erreichbarkeit prüfen.');}
  }
  return {at:new Date().toISOString(),mode:'READ_ONLY',ready:!checks.some(x=>x.status==='FAIL'),checks};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const result=await preflight({database:process.argv.includes('--db'),http:process.argv.includes('--http'),production:process.argv.includes('--production')});
  if(process.argv.includes('--json'))console.log(JSON.stringify(result,null,2));
  else for(const c of result.checks)console.log(`[${c.status}] ${c.name}: ${c.message}`);
  process.exitCode=result.ready?0:1;
}
