import {createWorldService} from './service.js';
export function registerWorldRoutes({app,pool,authorized}){
 const service=createWorldService({pool});let ready=false,running=false;
 async function tick(){if(running)return;running=true;try{await pool.query('SELECT 1 FROM marcel_world.news LIMIT 0');ready=true;await service.sync();}catch(e){console.error('Brain Welt: Hintergrundaktualisierung nicht verfügbar.',e.code||'provider_error');}finally{running=false;}}
 const timer=setInterval(tick,5*60000);timer.unref();const initial=setTimeout(tick,10000);initial.unref();
 const cleanupTimer=setInterval(()=>service.cleanup().catch(e=>console.error('Brain Welt: Bereinigung fehlgeschlagen.',e.code||'database_error')),60000);cleanupTimer.unref();
 app.all('/dashboard-api/marcel-brain/world',async(req,res)=>{
  res.setHeader('Cache-Control','no-store, private');if(!authorized(req))return res.status(401).json({ok:false,error:'Nicht angemeldet.'});
  try{
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
   return res.status(400).json({ok:false,error:'Unbekannte Weltoperation.'});
  }catch(e){return res.status(e.status||503).json({ok:false,error:e.status?e.message:'Welt-Datenquelle ist momentan nicht erreichbar.'});}
 });return {service,tick,stop:()=>{clearTimeout(initial);clearInterval(timer);clearInterval(cleanupTimer);}};
}
