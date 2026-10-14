// Vercel gateway. Existing signed dashboard session, private same-origin API.
// Never forwards browser credentials to a broker; only to own trading backend.
import {createHmac,timingSafeEqual} from 'node:crypto';
function validSession(req,password){if(!password)return false;const raw=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('marcel_dashboard_session='))?.slice('marcel_dashboard_session='.length);if(!raw)return false;const[token,sig,...rest]=raw.split('.');if(rest.length||!/^[a-f0-9]{64}$/.test(token||'')||!/^[a-f0-9]{64}$/.test(sig||''))return false;const expected=createHmac('sha256',password).update(token).digest('hex');return timingSafeEqual(Buffer.from(sig),Buffer.from(expected));}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');
 if(!validSession(req,process.env.DASHBOARD_PASSWORD))return res.status(401).json({ok:false,error:'Bitte anmelden.'});
 if(!['GET','POST','DELETE'].includes(req.method))return res.status(405).json({ok:false,error:'Methode nicht erlaubt.'});
 if(req.method!=='GET'){if(req.headers['x-trading-client']!=='marcel-ipad')return res.status(403).json({ok:false,error:'CSRF-Prüfung fehlgeschlagen.'});const origin=req.headers.origin;const expected=process.env.TRADING_PUBLIC_ORIGIN||'https://'+req.headers.host;if(origin&&origin!==expected)return res.status(403).json({ok:false,error:'Fremder Ursprung blockiert.'});if(!String(req.headers['content-type']||'').includes('application/json'))return res.status(415).json({ok:false,error:'JSON erforderlich.'});}
 const base=process.env.TRADING_BACKEND_URL||process.env.RAILWAY_BACKEND_URL;const secret=process.env.TRADING_API_SECRET||process.env.DASHBOARD_API_SECRET;
 if(!base||!secret)return res.status(503).json({ok:false,error:'Trading-Backend ist noch nicht konfiguriert.',code:'NOT_CONFIGURED'});
 try{const u=new URL('/trading-api',base);if(u.protocol!=='https:')throw Error('HTTPS required');for(const[k,v]of Object.entries(req.query||{}))if(typeof v==='string')u.searchParams.set(k,v);const payload=req.method==='GET'?undefined:JSON.stringify(req.body||{});if(payload&&Buffer.byteLength(payload)>1500000)return res.status(413).json({ok:false,error:'Anfrage zu groß.'});
 const result=await fetch(u,{method:req.method,headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json','X-Idempotency-Key':String(req.headers['x-idempotency-key']||'')},body:payload,redirect:'error',signal:AbortSignal.timeout(25000)});
 res.status(result.status);for(const h of ['content-type','content-disposition'])if(result.headers.get(h))res.setHeader(h,result.headers.get(h));const data=Buffer.from(await result.arrayBuffer());if(data.length>20_000_000)throw Error('oversized');return res.send(data);
 }catch{return res.status(502).json({ok:false,error:'Trading-Backend nicht erreichbar. Keine Daten als live angenommen.'});}
}
