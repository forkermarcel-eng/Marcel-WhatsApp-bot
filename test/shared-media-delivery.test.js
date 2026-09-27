import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { registerMediaDelivery } from "../shared-media/delivery.js";
import { createLocalFilesystemMediaStorage } from "../shared-media/storage.js";
import { createSharedMediaRuntime } from "../shared-media/runtime.js";

test("protected media serves ranges; owner mismatch denied and unknown originals download", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"marcel-delivery-test-"));
  const storage = createLocalFilesystemMediaStorage({ rootDirectory: root });
  await storage.put("fixture.bin",Buffer.from("0123456789"));
  const id = "11111111-1111-4111-8111-111111111111";
  const app = express();
  registerMediaDelivery({ app, storage, authorized: req => req.headers.authorization === "Bearer test-only",
    repository: { async assetForOwner(assetId,owner) {
      return owner.ownerReference === "7" ? { assetId, availability: "AVAILABLE", storageKey: "fixture.bin", mimeType: "application/octet-stream", metadata: {} } : null;
    } } });
  const server = await new Promise(resolve => { const value = app.listen(0,"127.0.0.1",() => resolve(value)); });
  const url = `http://127.0.0.1:${server.address().port}/dashboard-api/media/${id}?ownerChannel=contacts&ownerType=contact&ownerReference=7`;
  try {
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url.replace("Reference=7","Reference=8"),{ headers: { Authorization: "Bearer test-only" } })).status,404);
    const response = await fetch(url,{ headers: { Authorization: "Bearer test-only", Range: "bytes=2-5" } });
    assert.equal(response.status,206);
    assert.equal(response.headers.get("content-range"),"bytes 2-5/10");
    assert.equal(response.headers.get("content-disposition"),"attachment");
    assert.equal(response.headers.get("x-content-type-options"),"nosniff");
    assert.equal(await response.text(),"2345");
    const head = await fetch(url,{ method: "HEAD", headers: { Authorization: "Bearer test-only" } });
    assert.equal(head.status,200);
    assert.equal(await head.text(),"");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root,{ recursive: true, force: true });
  }
});
test("disabled media does not touch database; Railway storage cannot silently be ephemeral", () => {
  assert.equal(createSharedMediaRuntime({ pool: {}, environment: {} }),null);
  assert.throws(() => createSharedMediaRuntime({ pool: {}, environment: {
    SHARED_MEDIA_ENABLED: "true", MEDIA_STORAGE_ROOT: os.tmpdir(), RAILWAY_ENVIRONMENT_ID: "fixture"
  } }),/VOLUME_REQUIRED/);
});
