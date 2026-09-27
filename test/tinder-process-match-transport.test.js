import test from "node:test";
import assert from "node:assert/strict";
import {createTinderDiscoveryEnqueuer,normalizeProcessMatchJob,TINDER_DISCOVERY_QUEUE} from "../tinder-mirror/pg-boss-discovery.js";
import {startTinderDiscoveryWorker} from "../tinder-mirror/pg-boss-worker.js";
import {createTinderPossibleChangeDispatcher} from "../tinder-mirror/possible-change-dispatch.js";
import {createExistingProcessMatch} from "../tinder-mirror/local-process-match.js";
const payload={operation:"PROCESS_MATCH",device_id:"11111111-1111-4111-8111-111111111111",match_id:"22222222-2222-4222-8222-222222222222"};
test("PROCESS MATCH uses the existing queue with references only and the existing serial consumer",async()=>{
  assert.deepEqual(normalizeProcessMatchJob(payload),payload);
  assert.throws(()=>normalizeProcessMatchJob({...payload,profile:{}}));
  let callback,sent,processed=0;
  const boss={sendDebounced(){throw Error("not a change hint");},async send(name,data,options){sent={name,data,options};return "fixture-job";},
    async work(name,options,handler){assert.equal(name,TINDER_DISCOVERY_QUEUE);assert.equal(options.localConcurrency,1);callback=handler;return "fixture-work";},async offWork(){}};
  await createTinderDiscoveryEnqueuer({boss}).enqueueProcessMatch(payload);
  assert.equal(sent.name,TINDER_DISCOVERY_QUEUE);assert.deepEqual(sent.data,payload);
  assert.equal(sent.options.retryLimit,0);assert.equal(sent.options.heartbeatSeconds,null);
  const worker=await startTinderDiscoveryWorker({boss,dispatcher:{signal(){throw Error("must not run discovery");},async processMatch(job){assert.deepEqual(job,payload);processed++;return {status:"PROFILE_CONTEXT_READY"};}}});
  await callback([{data:payload}]);assert.equal(processed,1);await worker.stop();
});
test("PROCESS MATCH and reconciliation serialize on the existing dispatcher even after a failed action",async()=>{
  const events=[];let release;
  const barrier=new Promise(resolve=>{release=resolve;});
  const dispatcher=createTinderPossibleChangeDispatcher({readSourceXml:async()=>"",reconcile:async()=>{events.push("reconcile");return {status:"RECONCILED"};}});
  const action=dispatcher.runExclusive(async()=>{events.push("profile-start");await barrier;events.push("profile-end");throw Error("fixture failure");});
  const failure=assert.rejects(()=>action,/fixture failure/);
  const tick=dispatcher.inspect();
  await Promise.resolve();assert.deepEqual(events,["profile-start"]);
  release();await failure;await tick;
  assert.deepEqual(events,["profile-start","profile-end","reconcile"]);
});
test("disabled or mismatched process-match runtime performs no network or device operation",async()=>{
  let calls=0;
  const fetchImpl=async()=>{calls++;throw Error("must not call");};
  const disabled=createExistingProcessMatch({environment:{},deviceId:payload.device_id,fetchImpl});
  await assert.rejects(()=>disabled(payload),/DISABLED/);
  const enabled=createExistingProcessMatch({environment:{SHARED_MEDIA_ENABLED:"true"},deviceId:payload.device_id,fetchImpl});
  await assert.rejects(()=>enabled({...payload,device_id:"foreign"}),/MISMATCH/);
  assert.equal(calls,0);
});
