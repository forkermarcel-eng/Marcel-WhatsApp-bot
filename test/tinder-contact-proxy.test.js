import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import handler from "../api/dashboard/tinder.js";

const id = "22222222-2222-4222-8222-222222222222";
function response() {
  return { headers: {}, setHeader(k,v) { this.headers[k]=v; },
    status(code) { this.statusCode=code; return this; },
    json(body) { this.body=body; return this; } };
}
async function fixture(run) {
  const keys = ["DASHBOARD_PASSWORD","DASHBOARD_API_SECRET","RAILWAY_BACKEND_URL"];
  const previous = keys.map(key=>process.env[key]);
  const previousFetch=globalThis.fetch;
  process.env.DASHBOARD_PASSWORD="fixture-password";
  process.env.DASHBOARD_API_SECRET="fixture-server-secret";
  process.env.RAILWAY_BACKEND_URL="https://fixture.invalid";
  const signature=crypto.createHmac("sha256",process.env.DASHBOARD_PASSWORD).update("fixture").digest("hex");
  const req={method:"POST",headers:{cookie:`marcel_dashboard_session=fixture.${signature}`},
    query:{resource:"contact",id},body:{confirmed:true,contact_id:7}};
  try { await run(req); } finally {
    globalThis.fetch=previousFetch;
    keys.forEach((key,i)=>{ if(previous[i]===undefined)delete process.env[key];else process.env[key]=previous[i]; });
  }
}
test("contact binding proxy requires signed session and explicit confirmation",async()=>fixture(async req=>{
  let calls=0;
  globalThis.fetch=async()=>{ calls++; throw Error("unexpected request"); };
  for(const [request,status] of [
    [{...req,headers:{}},401],
    [{...req,body:{contact_id:7}},400],
    [{...req,body:{confirmed:true,contact_id:"7"}},400],
    [{...req,query:{resource:"contact",id:"invalid"}},400],
    [{...req,query:{resource:"messages",id}},405]
  ]) { const res=response();await handler(request,res);assert.equal(res.statusCode,status); }
  assert.equal(calls,0);
}));
test("binding proxy forwards only confirmed contact fields, never client routing or credentials",async()=>fixture(async req=>{
  let request;
  globalThis.fetch=async(url,options)=>{request={url,options};return {ok:true,status:200,json:async()=>({ok:true,contactId:7})};};
  req.body={...req.body,device_id:"foreign",secret:"untrusted",profile:{},messages:[]};
  const res=response();await handler(req,res);
  assert.equal(res.statusCode,200);
  assert.equal(request.url,`https://fixture.invalid/dashboard-api/tinder/conversations/${id}/contact`);
  assert.deepEqual(JSON.parse(request.options.body),{confirmed:true,contact_id:7});
  assert.equal(request.options.headers.Authorization,"Bearer fixture-server-secret");
  assert.equal(res.headers["Cache-Control"],"no-store, max-age=0");
  assert.doesNotMatch(JSON.stringify(res.body),/secret/);
}));
test("binding conflicts remain conflicts and new-contact requests use NULL",async()=>fixture(async req=>{
  globalThis.fetch=async(url,options)=>{
    assert.deepEqual(JSON.parse(options.body),{confirmed:true,contact_id:null});
    return {ok:false,status:409,json:async()=>({error:"CONTACT_BINDING_CONFLICT"})};
  };
  req.body={confirmed:true};
  const res=response();await handler(req,res);
  assert.equal(res.statusCode,409);
  assert.equal(res.body.error,"CONTACT_BINDING_CONFLICT");
}));
test("match contact binding and PROCESS MATCH reuse authenticated proxy without forwarding device or profile content",async()=>fixture(async req=>{
  const calls=[];
  globalThis.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({ok:true,job_id:"fixture"})};};
  req.query.resource="match-contact";
  const bound=response();await handler(req,bound);
  assert.equal(calls[0].url,`https://fixture.invalid/dashboard-api/tinder/matches/${id}/contact`);
  req.query.resource="process-match";req.body={profile:{},device_id:"untrusted",source_base64:"discard"};
  const process=response();await handler(req,process);
  assert.equal(process.statusCode,202);
  assert.equal(calls[1].url,`https://fixture.invalid/dashboard-api/tinder/matches/${id}/process`);
  assert.equal(calls[1].options.body,"{}");
  const denied=response();await handler({...req,headers:{}},denied);assert.equal(denied.statusCode,401);
  assert.equal(calls.length,2);
}));
