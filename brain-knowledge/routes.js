import { existsSync } from 'node:fs';
import { createKnowledgeService } from './service.js';
import { createPgKnowledgeRepository, openLocalKnowledge } from './repository.js';

export function registerKnowledgeRoutes({app,pool,dashboardApiAuthorized,environment=process.env,repository=null}) {
  let initialized;
  const service=async()=>{
    if(repository)return createKnowledgeService(repository);
    if(environment.BRAIN_KNOWLEDGE_ENABLED!=='true')throw Object.assign(Error('Dokumentenwissen ist in dieser Umgebung noch nicht freigeschaltet.'),{status:503});
    if(!initialized){
      if(environment.BRAIN_KNOWLEDGE_FILE){
        if(environment.RAILWAY_ENVIRONMENT_ID)throw Object.assign(Error('Lokale Wissensdatei ist kein freigegebener Produktionsspeicher.'),{status:503});
        if(!existsSync(environment.BRAIN_KNOWLEDGE_FILE))throw Object.assign(Error('Lokaler Wissensimport fehlt.'),{status:503});
        initialized=openLocalKnowledge(environment.BRAIN_KNOWLEDGE_FILE,{readOnly:environment.BRAIN_KNOWLEDGE_WRITES!=='true'}).then(createKnowledgeService);
      }else initialized=Promise.resolve(createKnowledgeService(createPgKnowledgeRepository(pool)));
    }return initialized;
  };
  app.all('/dashboard-api/marcel-brain/knowledge',async(req,res)=>{
    res.setHeader('Cache-Control','no-store, private');
    if(!dashboardApiAuthorized(req))return res.status(401).json({ok:false,error:'Nicht autorisiert.'});
    try{
      const api=await service();
      if(req.method==='GET'){
        const op=String(req.query.op||'overview');
        if(op==='overview')return res.json({ok:true,...await api.overview()});
        if(op==='document')return res.json({ok:true,document:await api.documentText(req.query.id)});
        if(op==='pending')return res.json({ok:true,items:await api.pending()});
        if(op==='export'){res.setHeader('Content-Disposition','attachment; filename="marcel-knowledge-private.json"');return res.json(await api.exportAll());}
        if(op==='ask')return res.json({ok:true,...await api.ask({question:String(req.query.q||''),domain:req.query.domain||null,project:req.query.project||null})});
      }
      if(req.method==='POST'){
        const body=req.body||{};
        if(body.op==='ask')return res.json({ok:true,...await api.ask({question:body.question,domain:body.domain||null,project:body.project||null})});
        if(body.op==='review'){
          if(environment.BRAIN_KNOWLEDGE_WRITES!=='true')return res.status(403).json({ok:false,error:'Wissensänderungen sind hier nicht freigeschaltet.'});
          return res.json({ok:true,item:await api.review({id:body.id,action:body.action,text:body.text,expectedVersion:body.expectedVersion,resolveConflict:body.resolveConflict===true,allowPersonal:body.allowPersonal===true})});
        }
      }
      return res.status(405).json({ok:false,error:'Unbekannte Wissensoperation oder Methode.'});
    }catch(e){const status=e.status||503;return res.status(status).json({ok:false,error:e.status?e.message:'Wissensspeicher nicht verfügbar. Lokalen Import beziehungsweise separat freigegebene Einrichtung prüfen.'});}
  });
}
