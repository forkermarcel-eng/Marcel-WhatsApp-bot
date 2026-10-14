// Execute the complete current index.js in a VM with no network/process/DB access.
// Compare enabled/disabled Trading with the exact source minus its three added lines.
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {registerTradingRoutes} from '../server/api.js';

const source=(await readFile(new URL('../../index.js',import.meta.url),'utf8')).replaceAll('\r\n','\n');
const baseline=source.replace('import { registerTradingRoutes } from "./trading-core/server/api.js";\n','')
  .replace('// Opt-in Trading routes; isolated schema, no automatic migration or feed startup.\n','')
  .replace('registerTradingRoutes(app, pool);\n','');
assert.equal(source.split('\n').length-baseline.split('\n').length,3);

async function bootstrap(src,enabled) {
  const state={routes:[],sql:[],errors:[],callbacks:[],externalCalls:0};
  const app={};
  for(const method of ['use','get','post','patch','delete','put','all'])app[method]=(...args)=>{state.routes.push([method,String(args[0])]);return app;};
  app.listen=(port,callback)=>{state.callbacks.push(callback);return {};};
  const express=()=>app;
  for(const method of ['raw','json','urlencoded'])express[method]=()=>function parser(){};
  const forbidden=()=>{state.externalCalls++;throw Error('External operation forbidden in bootstrap test');};
  class Pool {
    async query(sql){state.sql.push(sql);return {rows:[],rowCount:0};}
    async connect(){return {query:this.query.bind(this),release(){}};}
  }
  const env={TRADING_ENABLED:enabled?'true':'false',WHATSAPP_ENABLED:'false',TINDER_DISCOVERY_TRANSPORT_ENABLED:'false',SHARED_MEDIA_ENABLED:'false'};
  const noop=()=>{};
  const bindings={express:{default:express},crypto:{default:{}},openai:{default:class {}},
    '@whiskeysockets/baileys':{default:forbidden,DisconnectReason:{},fetchLatestBaileysVersion:forbidden,useMultiFileAuthState:forbidden},
    pino:{default:()=>({})},pg:{default:{Pool}},'pg-boss':{PgBoss:class {constructor(){forbidden();}}},
    './device-bridge/protocol-v1.js':{DEVICE_BRIDGE_PROTOCOL:{maximumRequestBytes:65536}},
    './device-bridge/reset-initialization.js':{initializeResetDeviceBridgeDatabase:async()=>{}},
    './device-bridge/enrollment.js':{createAdminEnrollmentCodeHandler:()=>noop,createDeviceEnrollmentHandler:()=>noop},
    './device-bridge/reset-block-routes.js':{registerDeviceBridgeResetRoutes:()=>{}},
    './device-bridge/readiness.js':{deviceBridgeFoundationMiddleware:noop,deviceBridgeRawBodyErrorMiddleware:noop,requireDeviceBridgeReady:noop},
    './services/contact-media.js':{createContactMediaService:()=>({listContactMedia:noop})},
    './services/contact-channel.js':{requireContactWhatsAppJid:noop},
    './shared-media/runtime.js':{createSharedMediaRuntime:()=>null},
    './services/contact-identities.js':{createContactIdentityService:()=>({})},
    './tinder-mirror/routes.js':{registerTinderMirrorRoutes:noop},
    './tinder-mirror/pg-boss-discovery.js':{createTinderDiscoveryEnqueuer:forbidden,createTinderDiscoveryPgBoss:forbidden},
    './trading-core/server/api.js':{registerTradingRoutes:(app,pool)=>registerTradingRoutes(app,pool,env)}
  };
  const context=vm.createContext({process:{env},Buffer,URL,console:{log:noop,error:(...args)=>state.errors.push(args.map(String))},setTimeout:forbidden,setInterval:forbidden});
  const module=new vm.SourceTextModule(src,{context});
  await module.link(specifier=>{
    assert.ok(bindings[specifier],`Unreviewed startup dependency: ${specifier}`);
    const exports=bindings[specifier];
    return new vm.SyntheticModule(Object.keys(exports),function(){for(const [name,value]of Object.entries(exports))this.setExport(name,value);},{context});
  });
  await module.evaluate();
  assert.equal(state.sql.length,0,'import/registration must not query the DB');
  assert.equal(state.callbacks.length,1);
  await state.callbacks[0]();
  await Promise.resolve();
  assert.equal(state.externalCalls,0);
  return state;
}
const before=await bootstrap(baseline,false);
for(const enabled of [false,true]) {
  const after=await bootstrap(source,enabled);
  assert.deepEqual(after.routes.filter(([method,path])=>!(method==='all'&&path==='/trading-api')),before.routes);
  assert.equal(after.routes.filter(([,path])=>path==='/trading-api').length,enabled?1:0);
  assert.deepEqual(after.sql,before.sql,'Trading must not change existing startup SQL');
  assert.deepEqual(after.errors,before.errors,'Trading must not change existing mocked startup result');
  assert.ok(after.sql.every(sql=>!sql.includes('marcel_trading')));
}
console.log('ISOLATED_SERVER_BOOTSTRAP_PASS');
