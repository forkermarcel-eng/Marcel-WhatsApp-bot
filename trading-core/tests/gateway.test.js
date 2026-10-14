import test from 'node:test';import assert from 'node:assert/strict';import {createHmac} from 'node:crypto';
import handler from '../../api/trading.js';
const pass='only-a-test-not-real',token='a'.repeat(64),cookie='marcel_dashboard_session='+token+'.'+createHmac('sha256',pass).update(token).digest('hex');
function res(){return {headers:{},code:0,value:null,setHeader(k,v){this.headers[k]=v;},status(x){this.code=x;return this;},json(x){this.value=x;return this;},send(x){this.value=x;return this;}};}
test('Vercel proxy: signed session, CSRF and own backend target only',async()=>{const old={...process.env},orig=globalThis.fetch;try{process.env.DASHBOARD_PASSWORD=pass;process.env.TRADING_BACKEND_URL='https://backend.example.org/';process.env.TRADING_API_SECRET='private-test';
 let r=res();await handler({method:'GET',headers:{},query:{}},r);assert.equal(r.code,401);
 r=res();await handler({method:'POST',headers:{cookie,host:'marcelmarlow.com','content-type':'application/json'},query:{resource:'plans'},body:{}},r);assert.equal(r.code,403);
 r=res();await handler({method:'POST',headers:{cookie,host:'marcelmarlow.com','content-type':'application/json','x-trading-client':'marcel-ipad',origin:'https://evil.example'},query:{resource:'plans'},body:{}},r);assert.equal(r.code,403);
 let captured;globalThis.fetch=async(u,o)=>{captured={u:String(u),o};return new Response('{"ok":true}',{headers:{'content-type':'application/json'}});};r=res();await handler({method:'GET',headers:{cookie,host:'marcelmarlow.com'},query:{resource:'bootstrap',redirect:'https://evil.example'}},r);assert.equal(r.code,200);assert.ok(captured.u.startsWith('https://backend.example.org/trading-api?'));assert.equal(captured.o.headers.Authorization,'Bearer private-test');assert.equal(captured.o.headers.cookie,undefined);
}finally{globalThis.fetch=orig;for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);}});
