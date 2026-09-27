import test from "node:test";
import assert from "node:assert/strict";
import {PGlite} from "@electric-sql/pglite";
import {TINDER_MIRROR_MIGRATION_STATEMENTS as base} from "../tinder-mirror/migration.js";
import {TINDER_LAST_MESSAGE_ORDER_MIGRATION_STATEMENTS as ordering} from "../tinder-mirror/last-message-order-migration.js";
import {TINDER_MATCH_MIGRATION_STATEMENTS as matches} from "../tinder-mirror/matches-migration.js";
import {preflightMatchProfile,migrateMatchProfile,MATCH_PROFILE_DDL} from "../tinder-mirror/match-profile-migration.js";
import {createMatchProfileStore,createProcessMatch} from "../tinder-mirror/match-profile.js";
import {createTinderContactBinding} from "../tinder-mirror/contact-binding.js";
import {normalizeTinderProfile} from "../tinder-mirror/conversation.js";
import sharp from "sharp";
import {migrateSharedMedia} from "../shared-media/migration.js";
import {applyMediaContent} from "../shared-media/content-migration.js";
import {createSharedMediaRepository} from "../shared-media/repository.js";
import {createSharedAttachmentIngress} from "../shared-media/ingress.js";
import {createSharedMediaContactGalleryAdapter} from "../shared-media/contact-gallery.js";
import {createTinderMatchMirror} from "../tinder-mirror/matches.js";
import {createTinderMediaService} from "../tinder-mirror/media.js";
import {createMediaContextReader} from "../shared-media/media-context.js";
const deviceId="11111111-1111-4111-8111-111111111111",matchId="22222222-2222-4222-8222-222222222222",conversationId="33333333-3333-4333-8333-333333333333";
const tile={display_name:"fixture",attributes:{},media_refs:[]};
const profile={...tile,attributes:{age:"36",section_01:"About",visible_profile_01:"fixture bio",interest_01:"fixture interest"}};
async function fixture(run) {
  const db=new PGlite();
  const pool={query:(...args)=>db.query(...args),connect:async()=>({query:(...args)=>db.query(...args),release(){}})};
  try {
    await db.exec("CREATE TABLE device_bridge_devices(device_id UUID PRIMARY KEY)");
    for(const sql of [...base,...ordering,...matches])await db.exec(sql);
    await db.query("INSERT INTO device_bridge_devices VALUES ($1)",[deviceId]);
    await db.query("INSERT INTO tinder_matches(match_id,device_id,tile,carousel_position) VALUES($1,$2,$3,0)",[matchId,deviceId,JSON.stringify(tile)]);
    await run(db,pool);
  }finally{await db.close();}
}
test("match profile migration changes only nullable JSONB, preserves rows, canonical rerun and rollback on drift",async()=>fixture(async(db,pool)=>{
  const before=(await db.query("SELECT * FROM tinder_matches")).rows[0];
  assert.equal((await preflightMatchProfile(pool)).state,"ELIGIBLE_FOR_MIGRATION");
  assert.equal(MATCH_PROFILE_DDL,"ALTER TABLE tinder_matches ADD COLUMN profile JSONB NULL");
  assert.equal((await migrateMatchProfile(pool)).state,"COMMIT_CONFIRMED");
  const after=(await db.query("SELECT * FROM tinder_matches")).rows[0];
  assert.equal(after.profile,null);delete after.profile;assert.deepEqual(after,before);
  assert.equal((await migrateMatchProfile(pool)).changed,false);
  await db.exec("ALTER TABLE tinder_matches ALTER COLUMN profile SET DEFAULT '{}'::jsonb");
  await assert.rejects(()=>migrateMatchProfile(pool),/MATCH_PROFILE_SCHEMA_DRIFT/);
  assert.equal((await db.query("SELECT count(*)::int n FROM tinder_matches")).rows[0].n,1);
}));
test("full match profile uses conversation contract; repeated processing skips reader and creates no conversation",async()=>fixture(async(db,pool)=>{
  await migrateMatchProfile(pool);
  const store=createMatchProfileStore({pool});
  let reads=0,contexts=0;
  const process=createProcessMatch({store,revalidate:async()=>({verified:true,unchanged:true}),
    readFullProfile:async()=>{reads++;return {status:"PROFILE_READ",returned_with_back:true,profile};},
    ensureMediaContext:async()=>{contexts++;return {ready:true};}});
  assert.equal((await store.get({deviceId,matchId})).profile,null);
  assert.equal((await createTinderMatchMirror({pool}).list())[0].profile,null);
  assert.equal((await process.run({deviceId,matchId})).status,"PROFILE_CONTEXT_READY");
  const updated=(await db.query("SELECT updated_at FROM tinder_matches")).rows[0].updated_at;
  assert.equal((await process.run({deviceId,matchId})).profileRead,false);
  assert.equal(reads,1);assert.equal(contexts,2);
  assert.deepEqual((await store.get({deviceId,matchId})).profile,normalizeTinderProfile(profile));
  assert.deepEqual((await createTinderMatchMirror({pool}).list())[0].profile,normalizeTinderProfile(profile));
  assert.deepEqual((await db.query("SELECT updated_at FROM tinder_matches")).rows[0].updated_at,updated);
  assert.equal((await db.query("SELECT count(*)::int n FROM tinder_conversations")).rows[0].n,0);
  await assert.rejects(()=>store.saveComplete({deviceId,matchId,expectedTile:{...tile,display_name:"different"},profile}),/Match changed/);
  await assert.rejects(()=>store.saveComplete({deviceId,matchId,expectedTile:tile,profile:{...profile,fingerprint:"forbidden"}}),/unsupported fields/);
  await migrateMatchProfile(pool);
  assert.deepEqual((await store.get({deviceId,matchId})).profile,normalizeTinderProfile(profile));
}));
test("migration rolls back DDL on failed postcheck and reports uncertain commit without retry",async()=>fixture(async(db,pool)=>{
  let injected=false;
  const failing={connect:async()=>({release(){},query:async(sql,params)=>{
    if(sql.startsWith("SELECT count(*)::int AS n FROM tinder_matches WHERE")){injected=true;throw Error("fixture postcheck failure");}
    return db.query(sql,params);
  }})};
  await assert.rejects(()=>migrateMatchProfile(failing),/fixture postcheck failure/);
  assert.equal(injected,true);
  assert.equal((await preflightMatchProfile(pool)).state,"ELIGIBLE_FOR_MIGRATION");
  let commits=0,discarded=false,rollbacks=0;
  const uncertain={connect:async()=>({release(value){discarded=value;},query:async(sql,params)=>{
    if(sql==="ROLLBACK")rollbacks++;
    const result=await db.query(sql,params);
    if(sql==="COMMIT"){commits++;throw Error("fixture lost ACK");}
    return result;
  }})};
  await assert.rejects(()=>migrateMatchProfile(uncertain),/MATCH_PROFILE_COMMIT_OUTCOME_UNKNOWN/);
  assert.equal(commits,1);assert.equal(rollbacks,0);assert.equal(discarded,true);
  assert.equal((await preflightMatchProfile(pool)).state,"ALREADY_CANONICAL");
}));
test("match profile media repeat and conversation handoff share exact assets and one contact gallery",async()=>fixture(async(db,pool)=>{
  await db.exec("CREATE TABLE media(id SERIAL PRIMARY KEY)");
  await migrateSharedMedia(pool);await applyMediaContent(pool);
  const files=new Map();
  const storage={async put(k,v){files.set(k,v);},async read(k){return files.get(k);},async exists(k){return files.has(k);},async remove(k){files.delete(k);},publicRef(){return null;}};
  const repository=createSharedMediaRepository(pool);
  const ingress=createSharedAttachmentIngress({repository,storage});
  const input=await sharp({create:{width:6,height:6,channels:3,background:"blue"}}).png().toBuffer();
  const context={channel:"tinder",sourceType:"profile",matchReference:matchId,profileReference:matchId,role:"profile_primary",ordinal:0};
  const first=await ingress.ingest({input,context});
  assert.equal((await ingress.ingest({input,context})).asset.assetId,first.asset.assetId);
  const presentation=createTinderMediaService({pool,media:{repository,ingress}});
  assert.equal((await presentation.present("match",matchId)).profile_collection_complete,false);
  await ingress.ingest({input,context:{...context,provenance:{profileCollectionSize:1}}});
  assert.equal((await presentation.present("match",matchId)).profile_collection_complete,true);
  await db.query("BEGIN");
  await repository.attachConversationContact(db,{matchId,contactId:7});
  const contextReader=createMediaContextReader({listAttachments:repository.listAttachments});
  const matchContext=await contextReader.read({contactId:7,channel:"tinder",profileReference:matchId,messages:[]});
  assert.equal(matchContext.profileMedia.length,1);assert.equal(matchContext.profileMedia[0].assetId,first.asset.assetId);
  assert.equal(matchContext.messages.length,0);
  await repository.transferMatchMedia(db,{matchId,conversationId,contactId:7});
  await repository.transferMatchMedia(db,{matchId,conversationId,contactId:7});
  await db.query("COMMIT");
  assert.equal((await db.query("SELECT count(*)::int n FROM media_assets")).rows[0].n,1);
  assert.equal((await db.query("SELECT count(*)::int n FROM tinder_conversations")).rows[0].n,0);
  const gallery=await createSharedMediaContactGalleryAdapter({repository,publicRefForAsset:a=>`/fixture/${a.assetId}`}).listSharedItemsForContact(7);
  assert.equal(gallery.length,1);
  const media=await repository.listAssetsForOwner({ownerChannel:"tinder",ownerType:"conversation",ownerReference:conversationId});
  assert.equal(media.length,1);assert.equal(media[0].asset.assetId,first.asset.assetId);
  const duplicates=await db.query("SELECT asset_id FROM media_asset_links GROUP BY asset_id,owner_type,owner_reference,relationship_type,ordinal HAVING count(*)>1");
  assert.equal(duplicates.rows.length,0);
  await db.query("BEGIN");
  await assert.rejects(repository.transferMatchMedia(db,{matchId,conversationId,contactId:8}),/MEDIA_CONTACT_BINDING_CONFLICT/);
  await db.query("ROLLBACK");
  assert.equal((await createSharedMediaContactGalleryAdapter({repository,publicRefForAsset:a=>`/fixture/${a.assetId}`}).listSharedItemsForContact(8)).length,0);
}));
test("confirmed match binding and verified transition preserve the one contact and normal conversation sync state",async()=>fixture(async(db,pool)=>{
  await migrateMatchProfile(pool);
  await db.exec(`CREATE TABLE contacts(id SERIAL PRIMARY KEY,whatsapp_jid TEXT UNIQUE,display_name TEXT,source_platform TEXT,current_platform TEXT,auto_reply_enabled BOOLEAN,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
    CREATE TABLE contact_identifiers(contact_id INTEGER REFERENCES contacts(id),identifier_type TEXT,identifier_value TEXT,normalized_value TEXT UNIQUE,source_platform TEXT,is_primary BOOLEAN,human_verified BOOLEAN,created_at TIMESTAMPTZ,updated_at TIMESTAMPTZ);
    CREATE TABLE contact_memory_profiles(contact_id INTEGER PRIMARY KEY REFERENCES contacts(id));`);
  const store=createMatchProfileStore({pool});
  await store.saveComplete({deviceId,matchId,expectedTile:tile,profile});
  const binding=createTinderContactBinding({pool});
  const bound=await binding.bind({deviceId,matchId,confirmed:true});
  assert.equal((await binding.bind({deviceId,matchId,confirmed:true})).contactId,bound.contactId);
  await db.query("INSERT INTO tinder_conversations(conversation_id,device_id) VALUES ($1,$2)",[conversationId,deviceId]);
  const transferred=await store.handoffToConversation({deviceId,matchId,verifiedConversationId:conversationId});
  assert.equal(transferred.contactId,bound.contactId);assert.equal(transferred.profileReused,true);
  assert.equal((await store.handoffToConversation({deviceId,matchId,verifiedConversationId:conversationId})).profileReused,false);
  assert.equal((await binding.bind({deviceId,conversationId,confirmed:true})).contactId,bound.contactId);
  assert.equal((await db.query("SELECT count(*)::int n FROM contacts")).rows[0].n,1);
  const conversation=(await db.query("SELECT * FROM tinder_conversations")).rows[0];
  assert.deepEqual(conversation.profile,normalizeTinderProfile(profile));
  assert.equal(conversation.history_complete,false);assert.equal(conversation.history_synced_at,null);
  assert.equal((await db.query("SELECT count(*)::int n FROM tinder_conversation_messages")).rows[0].n,0);
}));
