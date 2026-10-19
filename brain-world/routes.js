import {createWorldService} from './service.js';
import {readWorldMarkets} from './markets.js';
import {createFinanceService} from './finance.js';
export function registerWorldRoutes({app,pool,authorized}){
 const service=createWorldService({pool}),finance=createFinanceService({pool});let ready=false,running=false;
 async function tick(){if(running)return;running=true;try{const results=await Promise.allSettled([(async()=>{await pool.query('SELECT 1 FROM marcel_world.news LIMIT 0');ready=true;await service.sync();})(),finance.syncNews()]);results.forEach((r,i)=>{if(r.status==='rejected')console.error(i?'Brain Finanzen: Aktualisierung nicht verfügbar.':'Brain Welt: Hintergrundaktualisierung nicht verfügbar.',r.reason?.code||'provider_error');});}catch(e){console.error('Brain Welt: Hintergrundaktualisierung nicht verfügbar.',e.code||'provider_error');}finally{running=false;}}
 const timer=setInterval(tick,5*60000);timer.unref();const initial=setTimeout(tick,10000);initial.unref();
 const cleanupTimer=setInterval(()=>service.cleanup().catch(e=>console.error('Brain Welt: Bereinigung fehlgeschlagen.',e.code||'database_error')),60000);cleanupTimer.unref();
 app.all('/dashboard-api/marcel-brain/world',async(req,res)=>{
  res.setHeader('Cache-Control','no-store, private');if(!authorized(req))return res.status(401).json({ok:false,error:'Nicht angemeldet.'});
  try{
   if(req.method==='GET'&&req.query.op==='finance')return res.json({ok:true,...await finance.read()});
   if(!ready)await pool.query('SELECT 1 FROM marcel_world.news LIMIT 0');
   const q=req.query,op=q.op||'news';
   if(req.method==='POST'&&req.body?.op==='bookmark')return res.json({ok:true,entry:await service.bookmark(req.body.id,req.body.notes)});
   if(req.method==='POST'&&req.body?.op==='news')return res.json({ok:true,...await service.news(req.body)});
   if(req.method==='POST'&&req.body?.op==='favorite')return res.json({ok:true,items:await service.favorites(req.body.place,req.body.remove===true)});
   if(req.method!=='GET')return res.status(405).json({ok:false,error:'Methode nicht erlaubt.'});
   if(op==='search')return res.json({ok:true,places:await service.search(q.q)});
   if(op==='reverse')return res.json({ok:true,places:await service.reverse(q.lat,q.lon,q.zoom)});
   if(op==='weather')return res.json({ok:true,weather:await service.weather(q.lat,q.lon)});
   if(op==='place')return res.json({ok:true,place:await service.placeInfo(q.id)});
   if(op==='news')return res.json({ok:true,...await service.news(q)});
   if(op==='favorites')return res.json({ok:true,items:await service.favorites()});
   if(op==='markets')return res.json({ok:true,...await readWorldMarkets(pool)});
   if(op==='saved')return res.json({ok:true,items:(await pool.query("SELECT body FROM marcel_knowledge.entries WHERE id LIKE 'news:%' AND body->>'bookmarkedBy'='owner' ORDER BY body->>'createdAt' DESC LIMIT 300")).rows.map(r=>r.body)});
   return res.status(400).json({ok:false,error:'Unbekannte Weltoperation.'});
  }catch(e){return res.status(e.status||503).json({ok:false,error:e.status?e.message:'Welt-Datenquelle ist momentan nicht erreichbar.'});}
 });return {service,tick,stop:()=>{clearTimeout(initial);clearInterval(timer);clearInterval(cleanupTimer);}};
}
