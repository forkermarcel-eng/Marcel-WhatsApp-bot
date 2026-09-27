import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import sharp from "sharp";
import { readMediaInput } from "../shared-media/binary-input.js";
import { normalizeAttachmentContext, attachmentOwners } from "../shared-media/attachment.js";
import { createSharedAttachmentIngress } from "../shared-media/ingress.js";

// Durable-state double shared by distinct ingress instances, never Production.
function fixture() {
  const assets = new Map(), files = new Map(), links = new Map();
  let tail = Promise.resolve();
  const storage = { async put(k,b) { assert.ok(!files.has(k)); files.set(k, Buffer.from(b)); },
    async read(k) { return files.get(k); }, async remove(k) { files.delete(k); },
    async exists(k) { return files.has(k); }, publicRef() { return null; } };
  const repository = { async withContentTransaction(hash, work) {
    const previous = tail;
    let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    const attachLinks = async values => {
      for (const link of values) links.set(JSON.stringify([link.assetId,link.ownerChannel,link.ownerType,link.ownerReference,link.relationshipType,link.ordinal]), link);
    };
    try { return await work({ existing: assets.get(hash), attachLinks,
      async insertAssetWithLinks(record) { assets.set(hash,record.asset); await attachLinks(record.links); } }); }
    finally { release(); }
  } };
  return { repository, storage, assets, files, links };
}
const context = { channel: "whatsapp", contactId: 7, messageReference: "m1",
  conversationReference: "c1", direction: "inbound", timestamp: "2026-09-27T10:00:00Z", caption: "fixture" };

test("byte detection wins; bounded streams hash identically to bytes", async () => {
  const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const a = await readMediaInput(bytes);
  const b = await readMediaInput(Readable.from([bytes.subarray(0,10),bytes.subarray(10)]));
  assert.equal(a.sha256,b.sha256);
  assert.equal(a.mimeType,"image/png");
  await assert.rejects(readMediaInput(Readable.from([bytes]), { maxBytes: 2 }), /limit/);
  await assert.rejects(readMediaInput(Readable.from(["not bytes"])), /bytes/);
});
test("unknown binary stays octet-stream regardless of claimed context", async () => {
  const value = await readMediaInput(Buffer.from("<script>fixture</script>"));
  assert.equal(value.mimeType,"application/octet-stream");
  assert.equal(value.detected,false);
});
test("attachment context retains order and rejects profile-as-inbound", () => {
  const value = normalizeAttachmentContext({ ...context, ordinal: 1 });
  assert.equal(value.ordinal,1);
  assert.equal(attachmentOwners(value).length,3);
  assert.throws(() => normalizeAttachmentContext({ ...context, sourceType: "profile" }), /not a message/);
});
test("parallel and repeated ingress reuse one asset with independent usage links", async () => {
  const f = fixture();
  const service = createSharedAttachmentIngress(f);
  const input = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } }).png().toBuffer();
  const [a,b] = await Promise.all([
    service.ingest({ input,context }),
    service.ingest({ input, context: { ...context, messageReference: "m2" } })
  ]);
  assert.equal(a.asset.assetId,b.asset.assetId);
  assert.equal(f.assets.size,1);
  assert.equal(f.files.size,3);
  assert.deepEqual(await f.storage.read(a.asset.storageKey),input);
  const restarted = createSharedAttachmentIngress(f);
  const before = f.links.size;
  const c = await restarted.ingest({ input,context });
  assert.equal(c.asset.assetId,a.asset.assetId);
  assert.equal(c.reused,true);
  assert.equal(f.links.size,before);
  assert.ok([...f.links.values()].some(l => l.context.caption === "fixture"));
});
