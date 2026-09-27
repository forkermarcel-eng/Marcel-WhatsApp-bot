import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import sharp from "sharp";
import { migrateSharedMedia } from "../shared-media/migration.js";
import { applyMediaContent } from "../shared-media/content-migration.js";
import { createSharedMediaRepository } from "../shared-media/repository.js";
import { createSharedAttachmentIngress } from "../shared-media/ingress.js";
import { createMediaContextReader } from "../shared-media/media-context.js";
import { createSharedMediaContactGalleryAdapter } from "../shared-media/contact-gallery.js";
import { createWhatsAppMediaAdapter } from "../services/whatsapp-media.js";
import { Readable } from "node:stream";

test("real PostgreSQL media DDL, unique digest, restart reuse, gallery and ordered context share an asset", async () => {
  const db = new PGlite();
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) };
  const files = new Map();
  const storage = { async put(k,v) { files.set(k,v); }, async read(k) { return files.get(k); },
    async exists(k) { return files.has(k); }, async remove(k) { files.delete(k); }, publicRef() { return null; } };
  try {
    await db.exec("CREATE TABLE media (id SERIAL PRIMARY KEY)");
    await migrateSharedMedia(pool);
    assert.equal((await applyMediaContent(pool)).state,"COMMIT_CONFIRMED");
    assert.equal((await applyMediaContent(pool)).state,"COMMIT_CONFIRMED");
    const repository = createSharedMediaRepository(pool);
    const input = await sharp({ create: { width: 4,height: 4,channels: 3,background: "blue" } }).png().toBuffer();
    const context = { contactId: 7, channel: "whatsapp", sourceType: "attachment", messageReference: "B",
      conversationReference: "c1", direction: "inbound", ordinal: 0, caption: "fixture" };
    const first = await createSharedAttachmentIngress({ repository,storage }).ingest({ input,context });
    const again = await createSharedAttachmentIngress({ repository: createSharedMediaRepository(pool),storage }).ingest({ input,context });
    assert.equal(first.asset.assetId,again.asset.assetId);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM media_assets")).rows[0].n,1);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM media_asset_links")).rows[0].n,3);
    assert.equal(files.size,3);
    const row = (await db.query("SELECT * FROM media_assets")).rows[0];
    await assert.rejects(() => db.query(`INSERT INTO media_assets (asset_id,source_channel,media_type,storage_key,metadata)
      VALUES ('44444444-4444-4444-8444-444444444444','whatsapp','image','other.png',$1::jsonb)`,[JSON.stringify(row.metadata)]),e => e.code === "23505");
    const gallery = await createSharedMediaContactGalleryAdapter({ repository, publicRefForAsset: asset => `/asset/${asset.assetId}` }).listSharedItemsForContact(7);
    const reader = createMediaContextReader({ listAttachments: repository.listAttachments });
    const result = await reader.read({ contactId: 7, channel: "whatsapp", conversationReference: "c1",
      messages: ["A","B","C"].map(messageReference => ({ messageReference })) });
    assert.equal(result.messages[0].attachments.length,0);
    assert.equal(result.messages[1].attachments[0].assetId,first.asset.assetId);
    assert.equal(gallery[0].id,`shared:${first.asset.assetId}`);
    assert.equal(result.messages[2].attachments.length,0);
    const profile = await createSharedAttachmentIngress({ repository,storage }).ingest({ input,
      context: { channel:"tinder",sourceType:"profile",conversationReference:"verified-c2",
        profileReference:"verified-c2",role:"profile_primary",ordinal:0 } });
    assert.equal(profile.asset.assetId,first.asset.assetId);
    await db.query("BEGIN");
    await repository.attachConversationContact(db,{contactId:8,conversationId:"verified-c2"});
    await repository.attachConversationContact(db,{contactId:8,conversationId:"verified-c2"});
    await db.query("COMMIT");
    const bound = await repository.listAssetsForOwner({ownerChannel:"contacts",ownerType:"contact",ownerReference:"8"},{includeContext:true});
    assert.equal(bound.length,1);
    assert.equal(bound[0].asset.assetId,first.asset.assetId);
    const profileContext = await reader.read({contactId:8,channel:"tinder",conversationReference:"verified-c2",messages:[]});
    assert.equal(profileContext.profileMedia.length,1);
    assert.equal(profileContext.profileMedia[0].assetId,first.asset.assetId);
    assert.equal(profileContext.messages.length,0);
    await createSharedAttachmentIngress({repository,storage}).ingest({input,
      context:{contactId:7,channel:"tinder",sourceType:"attachment",messageReference:"T",conversationReference:"t1",direction:"inbound",ordinal:0}});
    const mixedGallery = await createSharedMediaContactGalleryAdapter({repository,publicRefForAsset:a=>`/asset/${a.assetId}`}).listSharedItemsForContact(7);
    assert.equal(mixedGallery.length,1);
    assert.deepEqual(mixedGallery[0].channels.slice().sort(),["tinder","whatsapp"]);
    const expiredContext={...context,messageReference:"expired"};
    const expired=await createSharedAttachmentIngress({repository,storage}).unavailable({context:expiredContext,reason:"SOURCE_EXPIRED"});
    const expiredAgain=await createSharedAttachmentIngress({repository:createSharedMediaRepository(pool),storage})
      .unavailable({context:expiredContext,reason:"SOURCE_EXPIRED"});
    assert.equal(expiredAgain.asset.assetId,expired.asset.assetId);
    assert.equal(expiredAgain.reused,true);
    assert.equal(expired.asset.metadata.sourceSha256,undefined);
    assert.equal(mixedGallery[0].contactId,7);
  } finally { await db.close(); }
});

test("five WhatsApp fixture streams traverse actual core, SQL, gallery and message context without a socket", async () => {
  const db = new PGlite();
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) };
  const files = new Map();
  const storage = { async put(k,v) { files.set(k,Buffer.from(v)); }, async read(k) { return files.get(k); },
    async exists(k) { return files.has(k); }, async remove(k) { files.delete(k); }, publicRef() { return null; } };
  try {
    await db.exec("CREATE TABLE media (id SERIAL PRIMARY KEY)");
    await migrateSharedMedia(pool);
    await applyMediaContent(pool);
    const repository = createSharedMediaRepository(pool);
    const raster = () => sharp({create:{width:5,height:5,channels:3,background:"red"}});
    let probeCalls=0;
    const posterBytes=await raster().png().toBuffer();
    const ingress = createSharedAttachmentIngress({ repository,storage,processor:{
      async inspectBytes(bytes,{poster}) {
        assert.ok(Buffer.isBuffer(bytes));probeCalls++;
        return {metadata:{durationMs:1200,video:poster?{width:5,height:5,codec:"fixture"}:null,
          audio:{codec:"fixture",sampleRate:16000,channels:1}},poster:poster?posterBytes:null};
      }
    } });
    // Header fixtures prove file-type/transport contracts, not playable video
    // or ffprobe coverage. Actual codec fixtures are tested separately.
    const fixtures = [
      ["imageMessage","image",await raster().png().toBuffer()],
      ["stickerMessage","sticker",await raster().webp().toBuffer()],
      ["videoMessage","video",Buffer.from("00000018667479706d703432000000006d70343269736f6d000000086d646174","hex")],
      ["audioMessage","audio",Buffer.concat([Buffer.from("RIFF"),Buffer.alloc(4),Buffer.from("WAVEfmt "),Buffer.alloc(32)])],
      ["documentMessage","document",Buffer.from("%PDF-1.4\nfixture document\n%%EOF")]
    ];
    const assets = [];
    for (const [type,expected,bytes] of fixtures) {
      const adapter = createWhatsAppMediaAdapter({ ingress,loadBaileys:async () => ({
        extractMessageContent: value => value,
        async downloadMediaMessage(message, mode) {
          assert.equal(mode,"stream"); return Readable.from([bytes.subarray(0,7),bytes.subarray(7)]);
        }
      }) });
      const message = {key:{id:type,fromMe:false},messageTimestamp:1700000000,
        message:{[type]:{mimetype:"wrong/client-type",caption:"fixture caption",fileName:"fixture.bin"}}};
      const result = await adapter.ingestMessage(message,{contactId:9,conversationReference:"wa-fixture"});
      assert.equal(result.asset.mediaType,expected);
      if (["video","audio"].includes(expected)) {
        assert.equal(result.asset.durationMs,1200);
        assert.equal(result.asset.metadata.probe.audio.sampleRate,16000);
        if(expected==="video")assert.deepEqual(files.get(result.asset.thumbnailStorageKey),posterBytes);
      }
      assert.deepEqual(files.get(result.asset.storageKey),bytes);
      assert.equal((await adapter.ingestMessage(message,{contactId:9,conversationReference:"wa-fixture"})).asset.assetId,result.asset.assetId);
      assets.push(result.asset.assetId);
    }
    const gallery = await createSharedMediaContactGalleryAdapter({repository,publicRefForAsset:a=>`/asset/${a.assetId}`}).listSharedItemsForContact(9);
    const context = await createMediaContextReader({listAttachments:repository.listAttachments}).read({
      contactId:9,channel:"whatsapp",conversationReference:"wa-fixture",
      messages:fixtures.map(([messageReference])=>({messageReference}))
    });
    assert.equal(gallery.length,5);
    assert.equal(probeCalls,2,"duplicate video/audio does not run processor again");
    assert.deepEqual(context.messages.map(m=>m.attachments[0].assetId),assets);
    assert.equal(context.profileMedia.length,0);
    for (const message of context.messages) {
      assert.equal(message.attachments.length,1);
      assert.equal(message.attachments[0].direction,"inbound");
      assert.equal(message.attachments[0].caption,"fixture caption");
      assert.equal(message.attachments[0].timestamp,"2023-11-14T22:13:20.000Z");
      assert.ok(gallery.some(item=>item.id===`shared:${message.attachments[0].assetId}`));
    }
  } finally { await db.close(); }
});
