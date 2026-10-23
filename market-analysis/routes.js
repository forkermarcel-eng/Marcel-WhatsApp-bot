import {verifyAnalysisAssertion,secureBearer} from './auth.js';
import {consumeBudget} from './api-storage.js';
import {apiError} from './api-runtime.js';
import {createConfiguredAnalysisRuntime} from './runtime-config.js';
// Existing bearer authorization is injected; single-user dashboard owns its data.
// Never accept an owner, credential, DB handle or provider URL from the client.
export function registerMarketAnalysisRoutes({app,pool,authorized,runtime,clock=Date.now,sessionKey=process.env.DASHBOARD_API_SECRET,env=process.env}={}) {
 let service=null,configurationError=null;try{service=runtime ?? createConfiguredAnalysisRuntime({database:pool,clock,env});}catch{configurationError='ANALYSIS_CONFIGURATION_INVALID';}let windowStart=clock(),reads=0,writes=0;
 const base='/dashboard-api/marcel-brain/market-analysis';
 app.all(base,async(req,res)=>{
  res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
  if(!authorized(req))return res.status(401).json({ok:false,error:'Nicht angemeldet.',code:'UNAUTHORIZED'});
  if(!['GET','POST'].includes(req.method))return res.status(405).json({ok:false,error:'Methode nicht erlaubt.',code:'METHOD_NOT_ALLOWED'});
  const principal=verifyAnalysisAssertion(req,{key:sessionKey,now:clock()});
  if(!principal||!secureBearer(req,sessionKey))return res.status(401).json({ok:false,code:'ANALYSIS_SESSION_REQUIRED',error:'Nicht angemeldet.'});
  const owner=principal.sub;
  const write=req.method==='POST';if(clock()-windowStart>=60000){windowStart=clock();reads=0;writes=0;}
  if(write?++writes>20:++reads>60){res.setHeader('Retry-After','60');return res.status(429).json({ok:false,error:'Anfragelimit erreicht.',code:'RATE_LIMITED'});}
  try {
   if(configurationError)throw apiError(configurationError,503);
   if(pool&&!await consumeBudget(pool,owner,write,clock)){res.setHeader('Retry-After','60');return res.status(429).json({ok:false,code:'RATE_LIMITED',error:'Anfragelimit erreicht.'});}
   const b=write?req.body ?? {}:req.query ?? {};if(!b||typeof b!=='object'||Array.isArray(b)||Buffer.byteLength(JSON.stringify(b))>65536)throw apiError('INVALID_INPUT');
   if('ownerId'in b||'owner'in b||'authorization'in b||'credentials'in b)throw apiError('UNTRUSTED_FIELDS');
   const op=String(b.op||'catalog');let result;
   if(!write&&op==='runtime-status')result=await service.runtimeStatus();
   else if(!write&&op==='catalog')result=await service.catalog(b.q ?? '',b.group ?? 'all');
   else if(!write&&op==='series')result=await service.series(b);
   else if(!write&&op==='fundamentals')result=await service.fundamentals(b.instrumentId);
   else if(!write&&op==='alerts')result=await service.alerts(owner,'list');
   else if(!write&&op==='history')result=await service.alerts(owner,'history',b);
   else if(!write&&op==='job')result=await service.job(owner,b.id);
   else if(write&&op==='job-create'){const {op:_,...input}=b;result=await service.createJob(owner,input);return res.status(202).json({ok:true,result});}
   else if(write&&op==='job-run')result=await service.run(owner,b.id);
   else if(write&&op==='job-cancel')result=await service.cancel(owner,b.id);
   else if(write&&['alert-create','alert-toggle','alert-reset'].includes(op))result=await service.alerts(owner,op.slice(6),b);
   else throw apiError('INVALID_OPERATION');
   return res.json({ok:true,result});
  }catch(error){const known=error.status&&/^[A-Z_]+$/.test(error.code||'');const missing=['42P01','3F000','42703'].includes(error.code);return res.status(known?error.status:missing?503:400).json({ok:false,code:known?error.code:missing?'ANALYSIS_STORAGE_NOT_PREPARED':'ANALYSIS_REQUEST_FAILED',error:missing?'Marktanalyse-Speicher ist noch nicht eingerichtet. Keine Migration wurde ausgeführt.':known?'Marktanalyse-Anfrage nicht verfügbar: '+error.code:'Analyse nicht ausführbar. Eingaben, Datenqualität und Konfiguration prüfen.'});}
 });return {service};
}
