import {createRuntime,processPersistedMatch} from "../scripts/tinder-block2-match-live-profile.mjs";

// Composition for the existing worker/session/bearer transport only.
export function createExistingProcessMatch({environment,deviceId,fetchImpl=fetch}) {
  const base=String(environment.TINDER_MIRROR_BASE_URL||"https://cooperative-kindness-production.up.railway.app").replace(/\/+$/,"");
  const runtime=createRuntime({sessionId:environment.APPIUM_SESSION,
    appiumBaseUrl:String(environment.APPIUM_BASE_URL||"http://127.0.0.1:4723/wd/hub").replace(/\/+$/,"")},fetchImpl);
  async function request(path,body) {
    const response=await fetchImpl(`${base}${path}`,{method:body?"POST":"GET",cache:"no-store",
      headers:{Authorization:`Bearer ${environment.DASHBOARD_API_SECRET}`,Accept:"application/json",...(body?{"Content-Type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const data=await response.json();
    if(!response.ok||data?.ok!==true)throw new Error("PROCESS_MATCH_BACKEND_OPERATION_FAILED");
    return data;
  }
  const profilePath=id=>`/dashboard-api/tinder/matches/${encodeURIComponent(id)}/profile`;
  const store={
    async get({matchId}) {return (await request(`${profilePath(matchId)}?device_id=${encodeURIComponent(deviceId)}`)).match;},
    async saveComplete({matchId,expectedTile,profile}) {return request(profilePath(matchId),{device_id:deviceId,expected_tile:expectedTile,profile});}
  };
  const transport={async ingestMedia({ownerId,kind,ordinal,sourceBytes,profileCollectionSize}){
    return request(`/dashboard-api/tinder/matches/${encodeURIComponent(ownerId)}/media`,{
      device_id:deviceId,kind,ordinal,profile_collection_size:profileCollectionSize,source_base64:sourceBytes.toString("base64")});
  }};
  return async job=>{
    if(environment.SHARED_MEDIA_ENABLED!=="true")throw new Error("PROCESS_MATCH_MEDIA_RUNTIME_DISABLED");
    if(job.device_id!==deviceId)throw new Error("PROCESS_MATCH_DEVICE_MISMATCH");
    const result=await processPersistedMatch({runtime,store,transport,target:{deviceId,matchId:job.match_id},
      ensureMediaContext:async target=>{
        const current=await store.get(target);
        if(!current.contact_id)return {ready:false,reason:"CONTACT_BINDING_REQUIRED"};
        if(current.media?.profile_collection_complete!==true)return {ready:false,reason:"PROFILE_MEDIA_INCOMPLETE"};
        return {ready:Boolean(current.profile)};
      }});
    // The existing worker logger receives status/counts, never the profile body.
    return {status:result.status,profile_reads:result.profileRead?1:0,
      match_tile_opens:result.profileRead?1:0,history_reads:0,ai_calls:0};
  };
}
