import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  MEDIA_TYPES,
  MEDIA_OWNER_TYPES,
  MEDIA_RELATION_TYPES,
  createMediaAsset,
  createMediaAssetLink,
  normalizeMediaAsset
} from "../shared-media/model.js";
import { createSharedMediaAssetService } from "../shared-media/asset-service.js";
import {
  createSharedMediaContactGalleryAdapter,
  mergeContactGalleryItems,
  sharedAssetToContactGalleryItem
} from "../shared-media/contact-gallery.js";
import { createSharedMediaRepository } from "../shared-media/repository.js";
import { createLocalFilesystemMediaStorage } from "../shared-media/storage.js";

const assetId = "11111111-1111-4111-8111-111111111111";
const linkId = "22222222-2222-4222-8222-222222222222";
const createdAt = "2026-09-25T00:00:00.000Z";

function availableAsset(overrides = {}) {
  return createMediaAsset({
    assetId,
    sourceChannel: "tinder",
    sourceReference: "profile:opaque",
    mediaType: "image",
    mimeType: "image/webp",
    storageKey: `media-assets/${assetId}/image.webp`,
    thumbnailStorageKey: `media-assets/${assetId}/thumbnail.webp`,
    byteSize: 33,
    width: 40,
    height: 30,
    metadata: { orientation: "portrait" },
    createdAt,
    ...overrides
  });
}

function assetLink(overrides = {}) {
  return createMediaAssetLink({
    linkId,
    assetId,
    ownerChannel: "tinder",
    ownerType: MEDIA_OWNER_TYPES.TINDER_PROFILE,
    ownerReference: "profile:opaque",
    relationshipType: MEDIA_RELATION_TYPES.PROFILE_MEDIA,
    ordinal: 0,
    createdAt,
    ...overrides
  });
}

test("shared assets carry channel-neutral metadata and generic owner links", () => {
  const asset = availableAsset();
  const link = assetLink();
  assert.equal(asset.sourceChannel, "tinder");
  assert.equal(asset.mediaType, "image");
  assert.equal(asset.storageKey, `media-assets/${assetId}/image.webp`);
  assert.equal(link.ownerType, "tinder_profile");
  assert.equal(link.relationshipType, "profile_media");

  const whatsappLink = assetLink({
    linkId: "33333333-3333-4333-8333-333333333333",
    ownerChannel: "whatsapp",
    ownerType: MEDIA_OWNER_TYPES.WHATSAPP_MESSAGE,
    ownerReference: "message:opaque",
    relationshipType: MEDIA_RELATION_TYPES.ATTACHMENT
  });
  const contactLink = assetLink({
    linkId: "44444444-4444-4444-8444-444444444444",
    ownerChannel: "contacts",
    ownerType: MEDIA_OWNER_TYPES.CONTACT,
    ownerReference: "42",
    relationshipType: MEDIA_RELATION_TYPES.GALLERY
  });
  assert.equal(whatsappLink.ownerType, "whatsapp_message");
  assert.equal(contactLink.ownerType, "contact");
  const conversationLink = assetLink({
    linkId: "55555555-5555-4555-8555-555555555555",
    ownerChannel: "whatsapp",
    ownerType: MEDIA_OWNER_TYPES.CONVERSATION,
    ownerReference: "conversation:opaque"
  });
  const futureChannelLink = assetLink({
    linkId: "66666666-6666-4666-8666-666666666666",
    ownerChannel: "future_channel",
    ownerType: "future_owner",
    ownerReference: "opaque"
  });
  assert.equal(conversationLink.ownerType, "conversation");
  assert.equal(futureChannelLink.ownerChannel, "future_channel");
  for (const mediaType of MEDIA_TYPES) {
    assert.equal(availableAsset({ mediaType }).mediaType, mediaType);
  }
  assert.throws(
    () => normalizeMediaAsset({ ...asset, storageKey: "../outside.webp" }),
    /storageKey is invalid/
  );
});

test("unavailable media has an explicit reason and no storage reference", () => {
  const unavailable = createMediaAsset({
    assetId,
    sourceChannel: "tinder",
    mediaType: "image",
    availability: "UNAVAILABLE",
    unavailableReason: "FLAG_SECURE",
    metadata: {},
    createdAt
  });
  assert.equal(unavailable.availability, "UNAVAILABLE");
  assert.equal(unavailable.storageKey, null);
  assert.throws(
    () => createMediaAsset({ ...unavailable, storageKey: "media-assets/x/image.webp" }),
    /unavailable assets must not have storage/
  );
});

test("local filesystem storage is persistent, key-scoped, and non-overwriting", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "marcel-shared-media-"));
  try {
    const storage = createLocalFilesystemMediaStorage({ rootDirectory: root, publicBaseUrl: "/media" });
    const written = await storage.put("media-assets/test/file.bin", Buffer.from([1, 2, 3]));
    assert.deepEqual(written, {
      key: "media-assets/test/file.bin",
      byteSize: 3,
      publicRef: "/media/media-assets/test/file.bin"
    });
    assert.equal(await storage.exists("media-assets/test/file.bin"), true);
    assert.deepEqual(await storage.read("media-assets/test/file.bin"), Buffer.from([1, 2, 3]));
    await assert.rejects(storage.put("media-assets/test/file.bin", Buffer.from([4])), { code: "MEDIA_STORAGE_KEY_EXISTS" });
    assert.equal(await storage.remove("media-assets/test/file.bin"), true);
    assert.equal(await storage.remove("media-assets/test/file.bin"), false);
    assert.equal(await storage.exists("media-assets/test/file.bin"), false);
    assert.throws(() => storage.publicRef("../outside"), /storage key is invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("asset service can represent an unavailable Tinder asset without writing bytes", () => {
  const calls = [];
  const storage = {
    async put(...args) { calls.push(args); },
    async read() { return Buffer.alloc(0); },
    async exists() { return false; },
    async remove() {},
    publicRef() { return null; }
  };
  const ids = [assetId, linkId];
  const service = createSharedMediaAssetService({
    storage,
    idFactory: () => ids.shift(),
    now: () => new Date(createdAt)
  });
  const result = service.createUnavailableAsset({
    sourceChannel: "tinder",
    sourceReference: "profile:opaque",
    unavailableReason: "FLAG_SECURE",
    owners: [{
      ownerType: "tinder_profile",
      ownerReference: "profile:opaque",
      relationshipType: "profile_media"
    }]
  });
  assert.equal(result.asset.availability, "UNAVAILABLE");
  assert.equal(result.links[0].ownerChannel, "tinder");
  assert.equal(calls.length, 0);
});

test("asset service stores non-raster channel media through the same asset/link shape", async () => {
  const writes = [];
  const storage = {
    async put(key, bytes) { writes.push([key, Buffer.from(bytes)]); },
    async read() { return Buffer.alloc(0); },
    async exists() { return false; },
    async remove() {},
    publicRef() { return null; }
  };
  const ids = [assetId, linkId];
  const service = createSharedMediaAssetService({
    storage,
    idFactory: () => ids.shift(),
    now: () => new Date(createdAt)
  });
  const result = await service.ingestBinary({
    sourceChannel: "whatsapp",
    sourceReference: "message:opaque",
    mediaType: "audio",
    mimeType: "audio/ogg",
    bytes: Buffer.from([9, 8, 7]),
    durationMs: 1200,
    owners: [{
      ownerType: "whatsapp_message",
      ownerReference: "message:opaque",
      relationshipType: "attachment"
    }]
  });
  assert.equal(result.asset.mediaType, "audio");
  assert.equal(result.asset.thumbnailStorageKey, null);
  assert.equal(result.asset.durationMs, 1200);
  assert.deepEqual(writes, [[`media-assets/${assetId}/source.bin`, Buffer.from([9, 8, 7])]]);
  await assert.rejects(service.ingestBinary({
    sourceChannel: "whatsapp",
    mediaType: "image",
    bytes: Buffer.from([1]),
    owners: [{ ownerType: "contact", ownerReference: "42" }]
  }), /must use ingestImage/);
});

test("asset service removes just-written objects when repository persistence fails", async () => {
  const stored = new Map();
  const removed = [];
  const repositoryFailure = new Error("repository insert failed");
  repositoryFailure.sharedMediaPersistenceOutcome = "ROLLED_BACK";
  const storage = {
    async put(key, bytes) { stored.set(key, Buffer.from(bytes)); },
    async read(key) { return stored.get(key) ?? Buffer.alloc(0); },
    async exists(key) { return stored.has(key); },
    async remove(key) {
      removed.push(key);
      stored.delete(key);
    },
    publicRef() { return null; }
  };
  const ids = [assetId, linkId];
  const service = createSharedMediaAssetService({
    storage,
    repository: {
      async insertAssetWithLinks() { throw repositoryFailure; }
    },
    idFactory: () => ids.shift(),
    now: () => new Date(createdAt),
    imagePipeline: async () => ({
      image: { bytes: Buffer.from([1, 2, 3]), mimeType: "image/webp", width: 3, height: 1 },
      thumbnail: { bytes: Buffer.from([4]), mimeType: "image/webp", width: 1, height: 1 }
    })
  });

  await assert.rejects(service.ingestImage({
    sourceChannel: "tinder",
    sourceReference: "profile:opaque",
    bytes: Buffer.from([9]),
    owners: [{
      ownerType: "tinder_profile",
      ownerReference: "profile:opaque",
      relationshipType: "profile_media"
    }]
  }), (error) => error === repositoryFailure);

  assert.deepEqual(removed, [
    `media-assets/${assetId}/image.webp`,
    `media-assets/${assetId}/thumbnail.webp`
  ]);
  assert.equal(stored.size, 0);
});

test("asset service preserves the repository failure when best-effort cleanup fails", async () => {
  const repositoryFailure = new Error("repository insert failed");
  repositoryFailure.sharedMediaPersistenceOutcome = "ROLLED_BACK";
  const storage = {
    async put() {},
    async read() { return Buffer.alloc(0); },
    async exists() { return false; },
    async remove() { throw new Error("storage cleanup unavailable"); },
    publicRef() { return null; }
  };
  const ids = [assetId, linkId];
  const service = createSharedMediaAssetService({
    storage,
    repository: {
      async insertAssetWithLinks() { throw repositoryFailure; }
    },
    idFactory: () => ids.shift(),
    now: () => new Date(createdAt)
  });

  await assert.rejects(service.ingestBinary({
    sourceChannel: "whatsapp",
    mediaType: "audio",
    bytes: Buffer.from([9]),
    owners: [{ ownerType: "whatsapp_message", ownerReference: "message:opaque" }]
  }), (error) => error === repositoryFailure);
});

test("asset service never deletes a just-written object after an unresolved repository commit outcome", async () => {
  const stored = new Map();
  const repositoryFailure = new Error("commit connection lost");
  repositoryFailure.sharedMediaPersistenceOutcome = "UNRESOLVED";
  const storage = {
    async put(key, bytes) { stored.set(key, Buffer.from(bytes)); },
    async read(key) { return stored.get(key) ?? Buffer.alloc(0); },
    async exists(key) { return stored.has(key); },
    async remove(key) { stored.delete(key); },
    publicRef() { return null; }
  };
  const ids = [assetId, linkId];
  const service = createSharedMediaAssetService({
    storage,
    repository: {
      async insertAssetWithLinks() { throw repositoryFailure; }
    },
    idFactory: () => ids.shift(),
    now: () => new Date(createdAt)
  });

  await assert.rejects(service.ingestBinary({
    sourceChannel: "whatsapp",
    mediaType: "audio",
    bytes: Buffer.from([9]),
    owners: [{ ownerType: "whatsapp_message", ownerReference: "message:opaque" }]
  }), (error) => error === repositoryFailure);

  assert.equal(stored.size, 1);
});

test("gallery adapter merges shared records without touching legacy item shape", () => {
  const legacy = Object.freeze({
    id: 7,
    channel: "whatsapp",
    type: "photo",
    capturedAt: "2026-09-24T00:00:00.000Z",
    fileRef: "/legacy/a.webp",
    thumbnailRef: "/legacy/a-thumb.webp",
    metadata: { mimeType: "image/webp" }
  });
  const shared = availableAsset();
  const item = sharedAssetToContactGalleryItem(shared, {
    publicRefForKey: (key) => `/media/${key}`
  });
  assert.equal(item.id, `shared:${assetId}`);
  assert.equal(item.type, "photo");
  assert.equal(item.fileRef, `/media/media-assets/${assetId}/image.webp`);
  const merged = mergeContactGalleryItems([legacy], [shared], {
    publicRefForKey: (key) => `/media/${key}`
  });
  assert.deepEqual(merged.map((value) => value.id), [`shared:${assetId}`, 7]);
  assert.strictEqual(merged[1], legacy);
});

test("Contacts Gallery adapter reads only shared contact links when explicitly constructed", async () => {
  const requests = [];
  const adapter = createSharedMediaContactGalleryAdapter({
    repository: {
      async listAssetsForOwner(owner) {
        requests.push(owner);
        return [{ asset: availableAsset() }];
      }
    },
    publicRefForKey: (key) => `/media/${key}`
  });
  const items = await adapter.listSharedItemsForContact(42);
  assert.deepEqual(requests, [{ ownerChannel: "contacts", ownerType: "contact", ownerReference: "42" }]);
  assert.equal(items[0].id, `shared:${assetId}`);
  assert.equal(items[0].thumbnailRef, `/media/media-assets/${assetId}/thumbnail.webp`);
});

test("repository uses only the shared tables and parameterized owner lookup", async () => {
  const statements = [];
  const client = {
    async query(sql, values = []) {
      statements.push([String(sql).replace(/\s+/g, " ").trim(), values]);
      return { rows: [] };
    },
    release() {}
  };
  const pool = {
    async connect() { return client; },
    async query(sql, values = []) {
      statements.push([String(sql).replace(/\s+/g, " ").trim(), values]);
      return { rows: [] };
    }
  };
  const repository = createSharedMediaRepository(pool);
  await repository.insertAssetWithLinks({ asset: availableAsset(), links: [assetLink()] });
  await repository.listAssetsForOwner({
    ownerChannel: "contacts",
    ownerType: "contact",
    ownerReference: "42"
  });
  const sql = statements.map(([statement]) => statement).join("\n");
  assert.match(sql, /INSERT INTO media_assets/);
  assert.match(sql, /INSERT INTO media_asset_links/);
  assert.match(sql, /FROM media_asset_links l JOIN media_assets a/);
  assert.doesNotMatch(sql, /\bFROM media\b/);
  assert.deepEqual(statements.at(-1)[1], ["contacts", "contact", "42"]);
});

test("repository marks a confirmed rollback so storage compensation can be limited to safe failures", async () => {
  const statements = [];
  const failure = new Error("asset insert failed");
  const client = {
    async query(sql) {
      const normalized = String(sql).replace(/\s+/g, " ").trim();
      statements.push(normalized);
      if (normalized.startsWith("INSERT INTO media_assets")) throw failure;
      return { rows: [] };
    },
    release() {}
  };
  const repository = createSharedMediaRepository({
    async connect() { return client; },
    async query() { return { rows: [] }; }
  });

  await assert.rejects(
    repository.insertAssetWithLinks({ asset: availableAsset(), links: [assetLink()] }),
    (error) => error === failure && error.sharedMediaPersistenceOutcome === "ROLLED_BACK"
  );
  assert.deepEqual(statements, ["BEGIN", statements[1], "ROLLBACK"]);
  assert.match(statements[1], /INSERT INTO media_assets/);
});
