import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import {createHash} from "node:crypto";
import {createTinderLocalMatchDiscoveryRuntime,discoverMatchInventory} from "../scripts/tinder-block2-match-initial-sync.mjs";
import {bindAndFlushInitialMedia} from "../scripts/tinder-block2-initial-sync.mjs";
import {createExistingDashboardBearerTransport} from "../tinder-mirror/appium-adapter.js";
import {readFileSync} from "node:fs";
import { createTinderMediaService } from "../tinder-mirror/media.js";
import { ingestVisibleAvatar, createMatchAvatarCollector } from "../tinder-mirror/visible-avatar-media.js";
import { observeInboxFromXml, observeMatchCarouselFromXml } from "../tinder-mirror/appium-conversation-reader.js";

const deviceId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const assetId = "33333333-3333-4333-8333-333333333333";
function inbox(extra = "") { return `<hierarchy><android.widget.FrameLayout bounds="[0,0][576,1280]">
  <androidx.recyclerview.widget.RecyclerView bounds="[0,225][576,1122]">
    <android.widget.FrameLayout bounds="[0,289][576,509]">
      <androidx.recyclerview.widget.RecyclerView bounds="[0,289][576,509]">
        <android.widget.FrameLayout bounds="[0,300][106,488]">
          <android.widget.ImageView clickable="true" bounds="[4,304][102,402]"/>
          <android.widget.TextView text="Likes" bounds="[4,416][102,472]"/>
        </android.widget.FrameLayout>
        <android.widget.FrameLayout bounds="[118,300][224,488]">
          <android.widget.ImageView clickable="true" bounds="[122,304][220,402]"/>
          <android.widget.TextView text="Match fixture" bounds="[122,416][220,472]"/>
        </android.widget.FrameLayout>
      </androidx.recyclerview.widget.RecyclerView>
    </android.widget.FrameLayout>
    <android.widget.FrameLayout bounds="[0,618][576,726]">
      <android.view.View clickable="true" bounds="[0,618][576,726]"/>
      <android.widget.ImageView bounds="[10,630][70,690]"/>${extra}
      <android.widget.TextView text="Conversation fixture" bounds="[80,640][500,700]"/>
    </android.widget.FrameLayout>
  </androidx.recyclerview.widget.RecyclerView></android.widget.FrameLayout></hierarchy>`; }

test("visible row and Match crops require no opens, exclude Likes, and refuse changed or ambiguous image bounds", async () => {
  const xml=inbox(), screenshot=await sharp({create:{width:576,height:1280,channels:3,background:"blue"}}).png().toBuffer();
  let writes=0;
  for(const ownerType of ["conversation","match"]){
    const entries=ownerType==="match"?observeMatchCarouselFromXml(xml).tiles:observeInboxFromXml(xml).rows;
    assert.equal(entries.length,1);
    const runtime={sourceXml:async()=>xml,captureScreen:async()=>screenshot};
    const result=await ingestVisibleAvatar({runtime,ownerType,ramKey:entries[0].ram_key,ingest:async ({sourceBytes})=>{
      writes++;const metadata=await sharp(sourceBytes).metadata();
      assert.equal(metadata.width,ownerType==="match"?98:60);
      return {asset_id:assetId};
    }});
    assert.equal(result.status,"AVATAR_INGESTED");
  }
  let reads=0;
  const row=observeInboxFromXml(xml).rows[0];
  const changed=await ingestVisibleAvatar({ownerType:"conversation",ramKey:row.ram_key,
    runtime:{sourceXml:async()=>++reads===1?xml:xml.replace("Conversation fixture","changed"),captureScreen:async()=>screenshot},
    ingest:async()=>{throw Error("must not ingest changed row");}});
  assert.equal(changed.status,"VISIBLE_ROW_CHANGED");
  const ambiguous=inbox('<android.widget.ImageView bounds="[90,630][150,690]"/>');
  assert.equal(observeInboxFromXml(ambiguous).rows[0].avatar_bounds,null);
  assert.equal(writes,2);
});
test("real Match avatar resource excludes shimmer without changing tile identity or opening it", () => {
  const original=inbox();
  const avatar='<android.widget.ImageView resource-id="com.tinder:id/matchAvatar" clickable="true" bounds="[122,304][220,402]"/>';
  const xml=original.replace('<android.widget.ImageView clickable="true" bounds="[122,304][220,402]"/>',
    '<android.widget.ImageView resource-id="com.tinder:id/shimmer_animation" bounds="[120,302][222,404]"/>'+avatar);
  const before=observeMatchCarouselFromXml(original).tiles[0];
  const after=observeMatchCarouselFromXml(xml).tiles[0];
  assert.deepEqual(after.avatar_bounds,before.avatar_bounds);
  assert.deepEqual(after.tile,before.tile);
  assert.equal(after.ram_key,before.ram_key);
  assert.equal(observeMatchCarouselFromXml(xml).tiles.length,1);
  assert.equal(observeMatchCarouselFromXml(xml.replace(avatar,avatar+avatar)).tiles[0].avatar_bounds,null);
});

test("Tinder raster media reuses universal ingress and confirmed NULL-JID contact without changing conversation/messages", async () => {
  const calls = [], inputs = [];
  const service = createTinderMediaService({ pool: { async query(sql,args) {
    calls.push({sql,args});
    return { rows: sql.includes("contact_identifiers") ? [{contact_id: 7}] : [{conversation_id: ownerId}] };
  } }, media: { ingress: { async ingest(input) { inputs.push(input); return {asset: {assetId},reused: true}; } } } });
  const sourceBytes = await sharp({create:{width:8,height:8,channels:3,background:"red"}}).png().toBuffer();
  const result = await service.ingest({ deviceId,ownerId,ownerType:"conversation",kind:"profile",sourceBytes });
  assert.deepEqual(result,{asset_id:assetId,reused:true});
  assert.equal(inputs[0].context.contactId,7);
  assert.equal(inputs[0].context.role,"profile_primary");
  assert.equal(inputs[0].context.provenance.kind,"screenshot_crop");
  assert.deepEqual(inputs[0].input,sourceBytes);
  assert.equal(calls.every(call => call.sql.startsWith("SELECT")),true);
  assert.equal(calls.some(call => /whatsapp_jid|messages|UPDATE|INSERT/.test(call.sql)),false);
  await assert.rejects(() => service.ingest({deviceId,ownerId,ownerType:"conversation",kind:"avatar",sourceBytes:Buffer.from("not image content")}), e => e.code === "INVALID_MEDIA_BYTES");
  assert.equal(inputs.length,1);
});
test("Match avatar inventory flush uses only one unambiguous persisted tile owner and clears RAM", async () => {
  const xml=inbox(),carousel=observeMatchCarouselFromXml(xml);
  const screen=await sharp({create:{width:576,height:1280,channels:3,background:"blue"}}).png().toBuffer();
  const collector=createMatchAvatarCollector({runtime:{sourceXml:async()=>xml,captureScreen:async()=>screen}});
  await collector.observe(carousel);await collector.observe(carousel);
  let writes=0;
  const stored=[{id:ownerId,tile:carousel.tiles[0].tile}];
  const upload=async(id,bytes)=>{assert.equal(id,ownerId);assert.ok(Buffer.isBuffer(bytes));writes++;};
  assert.equal((await collector.flush({inventory:carousel.tiles,stored,upload})).persisted,1);
  assert.equal((await collector.flush({inventory:carousel.tiles,stored,upload})).persisted,0);
  await collector.observe(carousel);
  assert.equal((await collector.flush({inventory:carousel.tiles,stored:[...stored,...stored],upload})).skipped,1);
  assert.equal(writes,1);
});

test("Match collector replaces an edge-clipped crop with the fuller observed image without extra navigation",async()=>{
  const full=inbox(),clipped=full.replace('bounds="[122,304][220,402]"','bounds="[122,304][180,402]"');
  let xml=clipped;
  const screen=await sharp({create:{width:576,height:1280,channels:3,background:"blue"}}).png().toBuffer();
  const collector=createMatchAvatarCollector({runtime:{sourceXml:async()=>xml,captureScreen:async()=>screen}});
  await collector.observe(observeMatchCarouselFromXml(xml));
  xml=full;await collector.observe(observeMatchCarouselFromXml(xml));
  xml=clipped;await collector.observe(observeMatchCarouselFromXml(xml));
  const inventory=observeMatchCarouselFromXml(full).tiles;
  let writes=0;
  const result=await collector.flush({inventory,stored:[{id:ownerId,tile:inventory[0].tile}],upload:async(id,bytes)=>{
    writes++;assert.equal(id,ownerId);assert.equal((await sharp(bytes).metadata()).width,98);
  }});
  assert.equal(result.persisted,1);assert.equal(writes,1);
});

test("normal carousel boundary observations retain a full avatar even when the tile list never changes",async()=>{
  const full=inbox();let xml=full.replace('bounds="[122,304][220,402]"','bounds="[122,304][180,402]"');
  const screen=await sharp({create:{width:576,height:1280,channels:3,background:"blue"}}).png().toBuffer();
  const gestures=[];
  const runtime={sourceXml:async()=>xml,captureScreen:async()=>screen,scrollCarousel:async(bounds,direction)=>{
    gestures.push(direction);if(direction==="right")xml=full;return false;
  }};
  const collector=createMatchAvatarCollector({runtime});
  const result=await discoverMatchInventory({...runtime,observeVisibleMedia:c=>collector.observe(c)},{maxGestures:4});
  assert.equal(result.end_actually_reached,true);assert.deepEqual(gestures,["left","left","right","right"]);
  let width;
  await collector.flush({inventory:result.inventory,stored:[{id:ownerId,tile:result.inventory[0].tile}],upload:async(id,bytes)=>{
    width=(await sharp(bytes).metadata()).width;
  }});
  assert.equal(width,98);
});

test("normal Match discovery fills known avatars despite missing old tile; unchanged skips; changed bytes update",async()=>{
  const xml=inbox(),carousel=observeMatchCarouselFromXml(xml);
  let color="blue",posts=0,opens=0;
  // PostgreSQL JSONB does not preserve the source object's key order.
  const storedTile=Object.fromEntries(Object.entries(carousel.tiles[0].tile).reverse());
  assert.notEqual(JSON.stringify(storedTile),JSON.stringify(carousel.tiles[0].tile));
  const stored=[{id:ownerId,device_id:deviceId,tile:storedTile,carousel_position:0},
    {id:"old-unresolved",device_id:deviceId,tile:{display_name:"missing"},carousel_position:1}];
  const runtime={sourceXml:async()=>xml,sleep:async()=>{},scrollCarousel:async()=>false,
    captureScreen:()=>sharp({create:{width:576,height:1280,channels:3,background:color}}).png().toBuffer(),
    tap(){opens++;throw Error("no open");},dashboard:async(path,options)=>{
      if(path.includes("device-bridge"))return {devices:[{device_id:deviceId,app_version_code:140}]};
      if(options?.method==="POST"){
        if(path==='/dashboard-api/tinder/matches/inventory') {
          assert.equal(options.body.inventory.complete,true);
          return {ok:true,ambiguous:0,deactivated:0};
        }
        if(path==='/dashboard-api/tinder/matches'){
          stored.push({id:ownerId,device_id:deviceId,...options.body.match});
          return {ok:true,created:true};
        }
        assert.ok(path.endsWith('/media'));posts++;
        const target=stored.find(item=>item.id===ownerId);
        target.avatar_url="/protected";
        target.avatar_source_sha256=createHash('sha256').update(Buffer.from(options.body.source_base64,'base64')).digest('hex');
        return {ok:true};
      }
      return {matches:stored};
    }};
  const service=await createTinderLocalMatchDiscoveryRuntime({APPIUM_SESSION:"existing",DASHBOARD_API_SECRET:"fixture",TINDER_DEVICE_VERSION_CODE:"140",SHARED_MEDIA_ENABLED:"true"},{runtimeFactory:()=>runtime});
  const run=async()=>service.reconcileMatchInventory(await service.observeMatchInventory());
  const first=await run();assert.equal(first.unresolved,0);assert.equal(first.media.persisted,1);
  assert.equal((await run()).media.persisted,0);
  color="green";assert.equal((await run()).media.persisted,1);
  assert.equal(posts,2);assert.equal(opens,0);assert.equal(stored.length,2);
  stored.splice(0,1);
  const newMatch=await run();assert.equal(newMatch.created,1);assert.equal(newMatch.unresolved,0);assert.equal(newMatch.media.persisted,1);
  assert.equal((await run()).media.persisted,0);assert.equal(posts,3);assert.equal(opens,0);
});

test("loading or unreadable carousel does not submit a complete inventory or lifecycle mutation",async()=>{
  for(const xml of [inbox().replace('<android.widget.TextView text="Match fixture"','<android.widget.TextView text=""'),
    inbox('<android.widget.ProgressBar bounds="[200,650][240,690]"/>')]) {
    let writes=0;
    const runtime={sourceXml:async()=>xml,scrollCarousel:async()=>false,
      dashboard:async(path,options)=>{if(options?.method==="POST")writes++;
        return {devices:[{device_id:deviceId,app_version_code:140}]};}};
    const service=await createTinderLocalMatchDiscoveryRuntime({APPIUM_SESSION:"existing",DASHBOARD_API_SECRET:"fixture",TINDER_DEVICE_VERSION_CODE:"140"},{runtimeFactory:()=>runtime});
    await assert.rejects(()=>service.readMatchDiscovery(),/readable New-Matches carousel/);
    assert.equal(writes,0);
  }
});

test("narrow clipped edge tiles do not prevent normal carousel traversal, full-width placeholders still do",()=>{
  const fragment=(left,right)=>`<android.view.ViewGroup bounds="[${left},300][${right},488]"><android.widget.ImageView bounds="[${left},304][${right},402]"/></android.view.ViewGroup>`;
  const xml=inbox().replace('<android.widget.FrameLayout bounds="[0,300][106,488]">',
    fragment(0,49)+fragment(526,576)+'<android.widget.FrameLayout bounds="[0,300][106,488]">');
  assert.equal(observeMatchCarouselFromXml(xml).inventory_readable,true);
  assert.equal(observeMatchCarouselFromXml(xml.replace(fragment(0,49),fragment(0,100))).inventory_readable,false);
});

test("verified terminal Likes-only carousel can report an empty inventory; absent carousel cannot",async()=>{
  const xml=inbox().replace(/<android.widget.FrameLayout bounds="\[118,300\]\[224,488\]">[\s\S]*?<\/android.widget.FrameLayout>/u,"");
  const result=await discoverMatchInventory({sourceXml:async()=>xml,scrollCarousel:async()=>false},{maxGestures:3});
  assert.equal(result.inventory.length,0);assert.equal(result.inventory_complete,true);assert.equal(result.end_actually_reached,true);
  assert.ok(Date.parse(result.started_at)<=Date.parse(result.finished_at));
  await assert.rejects(()=>discoverMatchInventory({sourceXml:async()=>"<hierarchy/>",scrollCarousel:async()=>false},{maxGestures:3}),/readable New-Matches carousel/);
});

test("avatar projection follows latest observation even when older shared bytes are reused",async()=>{
  const rows=[
    {asset:{assetId:"newer-binary",availability:"AVAILABLE",createdAt:"2026-09-28",metadata:{sourceSha256:"B"}},link:{relationshipType:"match_avatar",context:{provenance:{avatarObservedAt:"2026-09-28T10:00:00Z"}}}},
    {asset:{assetId,availability:"AVAILABLE",createdAt:"2026-09-27",metadata:{sourceSha256:"A"}},link:{relationshipType:"match_avatar",context:{provenance:{avatarObservedAt:"2026-09-28T11:00:00Z"}}}}
  ];
  const service=createTinderMediaService({pool:{},media:{repository:{listAssetsForOwner:async()=>rows}}});
  const result=await service.present("match",ownerId);
  assert.equal(result.avatar_source_sha256,"A");assert.ok(result.avatar_url.includes(assetId));
});

test("accepted new initial Conversation binds once before buffered media; reused/UNKNOWN cannot mint a Contact",async()=>{
  const calls=[];
  const transport=createExistingDashboardBearerTransport({baseUrl:"http://fixture",bearerToken:"test",fetchImpl:async(url,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.confirmed,true);assert.equal(body.device_id,deviceId);
    assert.ok(url.endsWith(`/${ownerId}/contact`));assert.equal(body.contact_id,undefined);calls.push("bind");
    return {ok:true,json:async()=>({ok:true,contactId:7})};}});
  const profileMedia={flush:async x=>{assert.equal(x.conversationId,ownerId);calls.push("media");return {persisted:8};}};
  const input={synced:{created:true,conversation:{id:ownerId,history_complete:true}},deviceId,transport,profileMedia,enabled:true};
  assert.equal((await bindAndFlushInitialMedia(input)).persisted,8);assert.deepEqual(calls,["bind","media"]);
  calls.length=0;await bindAndFlushInitialMedia({...input,synced:{...input.synced,created:false}});assert.deepEqual(calls,["media"]);
  await assert.rejects(()=>bindAndFlushInitialMedia({...input,synced:{action:"UNKNOWN"}}),/accepted complete/);
  const source=readFileSync(new URL('../scripts/tinder-block2-initial-sync.mjs',import.meta.url),'utf8');
  assert.match(source,/swipePager:createProfileControlRuntime/);
  assert.match(source,/await bindAndFlushInitialMedia/);
  assert.match(source,/await returnToInbox\(\);\s*if \(synced.created && sharedMediaEnabled\)\s*\{\s*await ingestVisibleAvatar/);
});
test("unassigned match avatar needs no artificial contact/conversation and presents protected media only", async () => {
  let context;
  const service = createTinderMediaService({ pool: { async query(sql) {
    if(sql.includes("FROM contact_identifiers"))return {rows:[]};
    assert.match(sql,/FROM tinder_matches/); return {rows:[{match_id:ownerId}]};
  } }, media: {
    ingress:{async ingest(input){context=input.context;return {asset:{assetId},reused:false};}},
    repository:{async listAssetsForOwner(owner){
      assert.equal(owner.ownerType,"match");
      return [{asset:{assetId,availability:"AVAILABLE"},link:{relationshipType:"match_avatar",ordinal:0}}];
    }}
  } });
  const sourceBytes = await sharp({create:{width:8,height:8,channels:3,background:"blue"}}).png().toBuffer();
  await service.ingest({deviceId,ownerId,ownerType:"match",kind:"avatar",sourceBytes});
  assert.equal(context.contactId,null);
  assert.equal(context.conversationReference,null);
  assert.equal(context.role,"match_avatar");
  const projected = await service.present("match",ownerId);
  assert.match(projected.avatar_url,/^\/api\/dashboard\/contacts\?resource=media&/);
  assert.equal(projected.media.length,1);
});
