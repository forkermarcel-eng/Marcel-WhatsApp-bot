// Standalone, loopback-only Brain host. Never import index.js: it starts channel
// workers and production schema setup. This host performs neither.
import express from 'express';
import OpenAI from 'openai';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import {existsSync} from 'node:fs';
import login from '../api/login.js';
import {validDashboardSession} from '../api/dashboard/marcel-brain.js';
import {openLocalKnowledge} from '../brain-knowledge/repository.js';
import {registerKnowledgeRoutes} from '../brain-knowledge/routes.js';
import {registerBrainChatRoutes} from '../brain-chat/routes.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
if(process.env.RAILWAY_ENVIRONMENT_ID)throw Error('This host is local only.');
if(!process.env.DASHBOARD_USERNAME||!process.env.DASHBOARD_PASSWORD)throw Error('Vorhandene DASHBOARD_USERNAME und DASHBOARD_PASSWORD für den lokalen Login konfigurieren.');
const file=resolve(process.env.BRAIN_KNOWLEDGE_FILE||resolve(root,'.local-knowledge/marcel-brain.sqlite'));
if(!existsSync(file))throw Error('Der vorhandene lokale Wissensimport fehlt.');
const repository=await openLocalKnowledge(file),app=express();
const environment={...process.env,BRAIN_CHAT_ENABLED:'true',BRAIN_KNOWLEDGE_ENABLED:'true',BRAIN_KNOWLEDGE_WRITES:'true'};
app.disable('x-powered-by');app.use(express.json({limit:'32kb'}));
const authorized=validDashboardSession;
app.post('/api/login',login);
// Keep the same authenticated API surface as Vercel, without a Railway proxy.
app.use('/api/dashboard/marcel-brain',(req,res,next)=>{
 const resource=req.query.resource;
 if(!['chat','knowledge'].includes(resource))return res.status(503).json({ok:false,error:'Marcel Memory und Live State sind in diesem lokalen Host nicht angebunden. Dokumentenwissen und Chat sind verfügbar.'});
 req.url='/dashboard-api/marcel-brain/'+resource+new URL(req.originalUrl,'http://localhost').search;app.handle(req,res,next);
});
registerKnowledgeRoutes({app,repository,dashboardApiAuthorized:authorized,environment});
registerBrainChatRoutes({app,repository,authorized,environment,model:process.env.BRAIN_CHAT_MODEL||process.env.OPENAI_MODEL||'gpt-5.6-sol',openai:process.env.OPENAI_API_KEY?new OpenAI({apiKey:process.env.OPENAI_API_KEY}):null});
app.get('/',(_req,res)=>res.redirect('/Brain/'));
app.get('/Hub/',(_req,res)=>res.redirect('/Brain/'));
app.use('/Brain',(req,res,next)=>authorized(req)?next():res.redirect('/login.html'));
app.use('/Brain',express.static(resolve(root,'Brain')));
app.get('/presentation.js',(_req,res)=>res.sendFile(resolve(root,'presentation.js')));
app.get('/login.html',(_req,res)=>res.sendFile(resolve(root,'login.html')));
const port=Number(process.env.BRAIN_CHAT_PORT||3088);
const server=app.listen(port,'127.0.0.1',()=>console.log(`Marcel Brain: http://localhost:${port}/Brain/ · KI ${process.env.OPENAI_API_KEY?'konfiguriert':'nicht konfiguriert'}`));
function close(){server.close(()=>{repository.close();process.exit(0);});}process.once('SIGINT',close);process.once('SIGTERM',close);
