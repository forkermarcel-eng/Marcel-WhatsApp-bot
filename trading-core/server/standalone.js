/** Isolated server for local inspection, development and dedicated deployment.
 * No external process or broker session is launched. File storage is local-only.
 */
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve,extname} from 'node:path';
import {createHmac,randomBytes} from 'node:crypto';
import {FileRepository,PgRepository} from './repository.js';
import {createTradingHandler,secretEqual,readBody,send} from './api.js';
import {syncContext} from './providers.js';

export async function startServer({env=process.env,demo=false,port=Number(env.TRADING_PORT||3090),host=env.TRADING_HOST||'127.0.0.1',file=env.TRADING_LOCAL_FILE,repo=null}={}){
 const local=['127.0.0.1','::1','localhost'].includes(host);
 if(demo&&!local)throw Error('Demo darf ausschließlich auf localhost laufen.');
 if(file&&!local&&env.TRADING_ALLOW_FILE_SERVER!=='true')throw Error('Dateispeicher ist für einen lokalen Einzelprozess vorgesehen. Produktion: PostgreSQL.');
 let pool;
 if(!repo){
  if(demo)repo=new FileRepository();
  else if(file)repo=new FileRepository(resolve(file));
  else if(env.DATABASE_URL){const {default:pg}=await import('pg');pool=new pg.Pool({connectionString:env.DATABASE_URL,max:4});repo=new PgRepository(pool);}
  else throw Error('DATABASE_URL oder ausdrücklich TRADING_LOCAL_FILE setzen; Demo: --demo.');
 }
 if(demo){const {seedDemo}=await import('../demo/seed.js');await seedDemo(repo);}
 const password=env.TRADING_LOCAL_PASSWORD||env.DASHBOARD_PASSWORD;
 if(!demo&&(!password||password.length<12))throw Error('TRADING_LOCAL_PASSWORD (mindestens 12 Zeichen) setzen.');
 const loginKey=randomBytes(32); const ipFailures=new Map();
 const sign=s=>createHmac('sha256',loginKey).update(s).digest('hex');
 function session(req){
  if(demo)return true;
  const cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('marcel_trading_local='))?.slice(21);
  if(!cookie)return false;const [expiry,nonce,sig,...extra]=cookie.split('.');
  return !extra.length&&Number(expiry)>Date.now()&&Number(expiry)<Date.now()+86401000&&nonce?.length===32&&secretEqual(sig,sign(expiry+'.'+nonce));
 }
 const handler=createTradingHandler({repo,env:{...env,TRADING_DEMO:demo?'true':'false'},authorize:req=>new URL(req.url,'http://local').pathname==='/api/trading'&&session(req)});
 const root=fileURLToPath(new URL('../../',import.meta.url));
 const assets=new Set(['/Trading/index.html','/Trading/trading.js','/Trading/trading.css','/Trading/domain.js','/Trading/chart.js','/Trading/news-context.js','/platform.css']);
 const loginPage=`<!doctype html><html lang="de"><meta name="viewport" content="width=device-width,initial-scale=1"><meta charset="utf-8"><title>Marcel Trading · Anmeldung</title><style>body{background:#101722;color:#eee;font:17px system-ui;display:grid;place-items:center;height:90vh}form{background:#18212e;padding:35px;border:1px solid #3a3f49;border-radius:18px;width:min(340px,80vw)}input,button{box-sizing:border-box;width:100%;padding:14px;margin:12px 0;background:#121923;color:#eee;border:1px solid #6b6050;border-radius:8px}button{background:#dfbc78;color:#151515;font-weight:bold}small{color:#a8b0ba}</style><form method="post" action="/local-login"><h2>Marcel Trading</h2><small>Separater lokaler Zugang. Keine Brokerverbindung.</small><label><input name="password" type="password" placeholder="Lokales Passwort" required autocomplete="current-password"></label><button>Anmelden</button></form></html>`;
 const server=http.createServer(async(req,res)=>{try{
  const u=new URL(req.url,'http://local');
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if(u.pathname==='/login.html'&&req.method==='GET')return send(res,200,loginPage,'text/html; charset=utf-8');
  if(u.pathname==='/local-login'&&req.method==='POST'){
   const origin=req.headers.origin,hostHeader=req.headers.host;if(origin&&new URL(origin).host!==hostHeader)return send(res,403,{error:'Fremder Ursprung'});
   const ip=req.socket.remoteAddress;let f=ipFailures.get(ip)||{at:Date.now(),count:0};if(Date.now()-f.at>600000)f={at:Date.now(),count:0};
   if(f.count>=10)return send(res,429,{error:'Zu viele Anmeldeversuche. Zehn Minuten warten.'});
   let body='';for await(const c of req){body+=c;if(body.length>4096)return send(res,413,{error:'Zu groß'});}
   if(!secretEqual(new URLSearchParams(body).get('password'),password)){f.count++;ipFailures.set(ip,f);return send(res,401,'Passwort falsch. Zurück zur Anmeldung.','text/plain; charset=utf-8');}
   ipFailures.delete(ip);const payload=(Date.now()+86400000)+'.'+randomBytes(16).toString('hex');
   res.setHeader('Set-Cookie',`marcel_trading_local=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400${env.TRADING_SECURE_COOKIE==='true'?'; Secure':''}`);res.statusCode=303;res.setHeader('Location','/Trading/');return res.end();
  }
  if(u.pathname==='/trading-api')return handler(req,res); // Bearer roles only.
  if(u.pathname==='/api/trading'){
   if(!session(req))return send(res,401,{ok:false,error:'Bitte anmelden.'});
   if(req.method!=='GET'){
    if(req.headers['x-trading-client']!=='marcel-ipad')return send(res,403,{ok:false,error:'CSRF-Prüfung fehlgeschlagen.'});
    if(req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)return send(res,403,{ok:false,error:'Fremder Ursprung blockiert.'});
   }
   return handler(req,res);
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,{error:'Methode nicht erlaubt.'});
  if(!session(req)){res.statusCode=303;res.setHeader('Location','/login.html');return res.end();}
  const path=['/','/Trading','/Trading/'].includes(u.pathname)?'/Trading/index.html':u.pathname;
  if(!assets.has(path))return send(res,404,'Nur das isolierte Trading-Modul läuft hier. Die übrigen Marcel-AI-Bereiche bleiben auf der Hauptseite.','text/plain; charset=utf-8');
  const file=await readFile(resolve(root,'.'+path));const types={'.js':'text/javascript','.css':'text/css','.html':'text/html'};
  return send(res,200,file,(types[extname(path)]||'application/octet-stream')+'; charset=utf-8');
 }catch(e){if(!res.headersSent)send(res,500,{ok:false,error:'Lokaler Trading-Serverfehler.'});else res.end();if(env.TRADING_DEBUG==='true')console.error(e);}});
 await new Promise((r,j)=>{server.once('error',j);server.listen(port,host,r);});
 let timer=null,running=false;
 if(env.TRADING_CONTEXT_POLL==='true'&&!demo){const poll=async()=>{if(running)return;running=true;try{await syncContext(repo,env);}catch(e){console.error('[trading-context]',e.message);}finally{running=false;}};timer=setInterval(poll,Math.max(300000,Number(env.TRADING_CONTEXT_INTERVAL_MS)||900000));timer.unref();}
 return {server,repo,url:`http://${host}:${server.address().port}/Trading/`,close:async()=>{clearInterval(timer);await new Promise(r=>server.close(r));await pool?.end();}};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 startServer({demo:process.argv.includes('--demo')}).then(s=>{console.log(`Trading: ${s.url}${process.argv.includes('--demo')?' · DEMO / ausschließlich synthetische Daten':''}`);for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>s.close().then(()=>process.exit(0)));}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
