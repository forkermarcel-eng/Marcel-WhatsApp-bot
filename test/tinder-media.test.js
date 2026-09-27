import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
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
