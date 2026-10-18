// Local verification only. Actual external feeds/weather/geocoding; private test DB.
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createWorldService} from '../brain-world/service.js';
const db=new PGlite();await db.exec(readFileSync(new URL('../migrations/20261018_brain_world.sql',import.meta.url),'utf8'));
await db.exec('CREATE SCHEMA marcel_knowledge; CREATE TABLE marcel_knowledge.meta(id text primary key,body jsonb); CREATE TABLE marcel_knowledge.entries(id text primary key,body jsonb); CREATE TABLE marcel_knowledge.documents(id text primary key,body jsonb); CREATE TABLE marcel_knowledge.evidence(id text primary key,body jsonb);');
const pool={query:(...a)=>db.query(...a),connect:async()=>({...pool,release(){}})};
const service=createWorldService({pool}),app=express();app.use(express.json());
app.all('/api/dashboard/marcel-brain',async(req,res)=>{try{const q=req.query;if(q.resource!=='world')return res.json({items:[],conversations:[],totals:{},liveState:{}});let data={};if(req.method==='POST'){if(req.body.op==='news')data=await service.news(req.body);else if(req.body.op==='favorite')data={items:await service.favorites(req.body.place,req.body.remove)};else data={entry:await service.bookmark(req.body.id)};}else if(q.op==='favorites')data={items:await service.favorites()};else if(q.op==='search')data={places:await service.search(q.q)};else if(q.op==='reverse')data={places:await service.reverse(q.lat,q.lon,q.zoom)};else if(q.op==='weather')data={weather:await service.weather(q.lat,q.lon)};else if(q.op==='place')data={place:await service.placeInfo(q.id)};else data=await service.news(q);res.json({ok:true,...data});}catch(e){res.status(e.status||503).json({error:e.message});}});
app.use(express.static(fileURLToPath(new URL('..',import.meta.url))));
app.listen(4592,'127.0.0.1',()=>console.log('Live-source verification: http://127.0.0.1:4592/Brain/'));
await service.sync();const result=await service.news();console.log(JSON.stringify({active:result.activeSources,total:result.total,sources:result.sources.map(x=>({id:x.id,error:x.error,received:x.received}))}));
