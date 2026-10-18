import {existsSync} from 'node:fs';
import {openLocalKnowledge,createPgKnowledgeRepository} from '../brain-knowledge/repository.js';
import {createBrainRetrieval} from './retrieval.js';
import {createBrainChat} from './service.js';
import {createBrainModel} from './model.js';

export function createMemoryReaders(pool){
  const required=()=>{if(!pool)throw Error('Memory database unavailable');};
  return {
    readMemory:async()=>{required();return (await pool.query(`SELECT id,category,memory_key,memory_value,human_verified,allowed_for_bot,sensitivity,valid_until FROM marcel_memory WHERE status='active' AND human_verified=TRUE AND allowed_for_bot=TRUE AND (valid_until IS NULL OR valid_until>NOW()) ORDER BY importance DESC,updated_at DESC LIMIT 100`)).rows;},
    readLiveState:async()=>{required();return (await pool.query(`SELECT current_country,current_city,current_timezone,location_status,location_verified_at,updated_at,updated_by FROM marcel_live_state WHERE id=1 LIMIT 1`)).rows[0]||null;}
  };
}
export function registerBrainChatRoutes({app,pool,openai,model,authorized,environment=process.env,repository,generate,readers}){
  let initialized;
  const api=async()=>{
    if(environment.BRAIN_CHAT_ENABLED!=='true')throw Object.assign(Error('Brain Chat ist hier noch nicht freigeschaltet.'),{status:503});
    if(!initialized)initialized=(async()=>{
      let repo=repository;
      if(!repo){
        if(environment.BRAIN_KNOWLEDGE_FILE){
          if(environment.RAILWAY_ENVIRONMENT_ID||!existsSync(environment.BRAIN_KNOWLEDGE_FILE))throw Object.assign(Error('Der lokale Wissensspeicher ist hier nicht verfügbar.'),{status:503});
          repo=await openLocalKnowledge(environment.BRAIN_KNOWLEDGE_FILE);
        }else repo=createPgKnowledgeRepository(pool);
      }
      const retrieve=createBrainRetrieval({repository:repo,...(readers||createMemoryReaders(pool))});
      return createBrainChat({repository:repo,retrieve,generate:generate||createBrainModel({client:openai,model})});
    })().catch(e=>{initialized=null;throw e;});
    return initialized;
  };
  app.all('/dashboard-api/marcel-brain/chat',async(req,res)=>{
    res.setHeader('Cache-Control','no-store, private');
    if(!authorized(req))return res.status(401).json({ok:false,error:'Nicht angemeldet.'});
    const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    const event=(event,data)=>{if(!res.destroyed)res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
    try{
      const chat=await api();
      if(req.method==='GET'){
        if(req.query.id)return res.json({ok:true,conversation:await chat.get(req.query.id)});
        return res.json({ok:true,conversations:await chat.list()});
      }
      if(req.method!=='POST')return res.status(405).json({ok:false,error:'Methode nicht erlaubt.'});
      if(req.body?.op==='create')return res.status(201).json({ok:true,conversation:await chat.create()});
      if(req.body?.op!=='send')return res.status(400).json({ok:false,error:'Unbekannte Chat-Aktion.'});
      res.setHeader('Content-Type','text/event-stream; charset=utf-8');res.setHeader('X-Accel-Buffering','no');res.flushHeaders?.();
      const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': waiting\n\n');},10000);
      try{await chat.send({...req.body,allowPersonal:req.body.allowPersonal===true,signal:controller.signal,onEvent:event});}
      finally{clearInterval(heartbeat);}
      res.end();
    }catch(e){
      const error=e.status?e.message:'Brain Chat ist nicht erreichbar. KI-Konfiguration und lokalen Wissensspeicher prüfen.';
      if(res.headersSent){event('error',{error});res.end();}else res.status(e.status||503).json({ok:false,error});
    }
  });
}
