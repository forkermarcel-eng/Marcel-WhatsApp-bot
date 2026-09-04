import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  DeviceBridgeProtocolError,
  T0_DEVICE_CAPABILITIES,
  T1_DEVICE_CAPABILITIES,
  canonicalRequest,
  enrollmentCodeDigest,
  sha256Hex
} from "../device-bridge/protocol-v1.js";
import {
  consumeEnrollmentRateLimit,
  createAdminEnrollmentCodeHandler,
  createEnrollmentCodeRecord,
  enrollDeviceTransaction,
  generateEnrollmentCode,
  parseAndValidateEnrollmentRequest,
  resetEnrollmentRateLimitForTests
} from "../device-bridge/enrollment.js";
import {
  registerAuthenticatedRequestReplay,
  verifyAuthenticatedDeviceRequest
} from "../device-bridge/device-auth.js";

const NOW = new Date("2026-09-01T12:34:56.000Z");
const ENROLLMENT_PATH = "/device-bridge/v1/enroll";
const CODE = "01234-56789-ABCDE-FGHJK-MNPQRS";
const INSTALLATION_ID = "c7cb0b92-ad3c-4ec6-88dc-d149ef536c3d";
const ATTEMPT_ID = "7b415e56-ff2d-4ee7-ae39-19962c53de5b";
const REQUEST_ID = "d2675347-0888-4548-9feb-ae4d71a972cf";
const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const KEY_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const CAPABILITIES = T0_DEVICE_CAPABILITIES;

function keyPair() {
  return crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
}

function requestFrom({ payloadOverrides = {}, headerOverrides = {}, keys = keyPair(), requestId = REQUEST_ID, path = ENROLLMENT_PATH } = {}) {
  const publicKeyValue = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const payload = {
    protocol_version: 1,
    enrollment_attempt_id: ATTEMPT_ID,
    requested_at: NOW.toISOString(),
    enrollment_code: CODE,
    installation_id: INSTALLATION_ID,
    display_name: "ZTE Blade A35e",
    public_key: { algorithm: "EC_P256_SHA256", format: "SPKI_DER_BASE64", value: publicKeyValue },
    app: { version_name: "1.0", version_code: 1 },
    device: { manufacturer: "ZTE", model: "ZTE Blade A35e", android_api: 35, abis: ["arm64-v8a"] },
    capabilities: CAPABILITIES,
    ...payloadOverrides
  };
  const body = Buffer.from(JSON.stringify(payload));
  const contentSha256 = sha256Hex(body);
  const headers = {
    "x-marcel-protocol-version": "1",
    "x-marcel-timestamp": NOW.toISOString(),
    "x-marcel-request-id": requestId,
    "x-marcel-content-sha256": contentSha256,
    ...headerOverrides
  };
  const canonical = canonicalRequest({ protocolVersion: 1, method: "POST", path, timestamp: headers["x-marcel-timestamp"], requestId, contentSha256 });
  headers["x-marcel-signature"] ||= crypto.sign("sha256", Buffer.from(canonical), keys.privateKey).toString("base64url");
  return {
    req: { method: "POST", originalUrl: path, body, ip: "127.0.0.1", get: name => headers[name.toLowerCase()] },
    keys,
    payload,
    headers
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

function validCodeRow(overrides = {}) {
  return {
    enrollment_code_id: "8d70b5c7-2397-4942-a6dd-53ec5343bc76",
    code_digest: enrollmentCodeDigest(CODE),
    expires_at: new Date(NOW.valueOf() + 60_000),
    consumed_at: null,
    enrollment_attempt_id: null,
    consumed_installation_id: null,
    consumed_public_key_fingerprint: null,
    consumed_device_id: null,
    consumed_key_id: null,
    ...overrides
  };
}

function fakeEnrollmentPool(codeRow, options = {}) {
  const calls = [];
  const state = { devices: 0, keys: 0, audits: 0, committed: false, rolledBack: false };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") return { rowCount: null, rows: [] };
      if (sql === "COMMIT") { state.committed = true; return { rows: [] }; }
      if (sql === "ROLLBACK") { state.rolledBack = true; return { rows: [] }; }
      if (sql.includes("FROM device_bridge_request_nonces")) return { rowCount: options.replay ? 1 : 0, rows: options.replay ? [{}] : [] };
      if (sql.includes("FROM device_bridge_enrollment_codes")) return { rowCount: codeRow ? 1 : 0, rows: codeRow ? [codeRow] : [] };
      if (sql.includes("FROM device_bridge_devices d")) return { rowCount: options.conflict ? 1 : 0, rows: options.conflict ? [{}] : [] };
      if (sql.includes("INSERT INTO device_bridge_devices")) { state.devices += 1; return { rowCount: 1, rows: [] }; }
      if (sql.includes("INSERT INTO device_bridge_keys")) {
        if (options.failKeyInsert) throw new Error("simulated database failure");
        state.keys += 1; return { rowCount: 1, rows: [] };
      }
      if (sql.includes("INSERT INTO device_bridge_audit_events")) { state.audits += 1; return { rowCount: 1, rows: [] }; }
      return { rowCount: 1, rows: [] };
    },
    release() { state.released = true; }
  };
  return { pool: { async connect() { return client; } }, calls, state };
}

test("enrollment code uses 128 bits and exact Crockford grouping", () => {
  const generated = generateEnrollmentCode(() => Buffer.alloc(16, 0xff));
  assert.match(generated.normalized, /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/);
  assert.match(generated.grouped, /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}(?:-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{5}){3}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
});

test("enrollment-code record expires in exactly ten minutes and contains digest", () => {
  const record = createEnrollmentCodeRecord("ZTE Blade A35e", NOW, () => Buffer.alloc(16, 1));
  assert.equal(record.expiresAt.valueOf() - NOW.valueOf(), 600_000);
  assert.match(record.codeDigest, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(record, "normalized"), false);
});

test("admin enrollment handler persists digest but never plaintext code", async () => {
  const calls = [];
  const client = { async query(sql, values = []) { calls.push({ sql, values }); return { rowCount: 1 }; }, release() {} };
  const handler = createAdminEnrollmentCodeHandler({ async connect() { return client; } });
  const res = responseRecorder();
  await handler({ body: { display_name: "ZTE Blade A35e" } }, res);
  assert.equal(res.statusCode, 201);
  assert.match(res.body.enrollment_code, /-/);
  assert.equal(calls.some(call => call.values.includes(res.body.enrollment_code)), false);
  const insert = calls.find(call => call.sql.includes("INSERT INTO device_bridge_enrollment_codes"));
  assert.match(insert.values[1], /^[0-9a-f]{64}$/);
  assert.equal(calls.some(call => call.sql.includes("ENROLLMENT_CODE_CREATED")), true);
});

test("index protects enrollment-code route with existing dashboard auth and readiness", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const start = source.indexOf('"/dashboard-api/device-bridge/enrollment-codes"');
  const block = source.slice(start, start + 600);
  assert.ok(start >= 0);
  assert.match(block, /dashboardApiReady\(res\)/);
  assert.match(block, /dashboardApiAuthorized\(req\)/);
  assert.match(block, /requireDeviceBridgeReady\(res\)/);
});

test("valid P-256 proof of possession is accepted", () => {
  assert.doesNotThrow(() => parseAndValidateEnrollmentRequest(requestFrom().req, NOW));
});

test("T1 manual-gate capability profile enrolls additively while unknown profiles fail closed", () => {
  const t1 = requestFrom({ payloadOverrides: { capabilities: T1_DEVICE_CAPABILITIES } });
  assert.doesNotThrow(() => parseAndValidateEnrollmentRequest(t1.req, NOW));
  for (const capabilities of [
    [...T1_DEVICE_CAPABILITIES].reverse(),
    [...T1_DEVICE_CAPABILITIES, "TINDER_VISIBLE_CHAT_READ_V1"],
    [...T0_DEVICE_CAPABILITIES, "TINDER_MANUAL_GATE_V1", "COMMAND_INJECTED_V1"]
  ]) {
    const input = requestFrom({ payloadOverrides: { capabilities } });
    assert.throws(() => parseAndValidateEnrollmentRequest(input.req, NOW), error => error.code === "INVALID_BODY");
  }
});

test("malformed enrollment code is rejected before database access", () => {
  const input = requestFrom({ payloadOverrides: { enrollment_code: "OOOOO-OOOOO-OOOOO-OOOOO-OOOOOO" } });
  assert.throws(() => parseAndValidateEnrollmentRequest(input.req, NOW), error => error.code === "ENROLLMENT_CODE_INVALID");
});

test("invalid signature and different public key are rejected", () => {
  const original = requestFrom();
  const wrong = keyPair();
  original.headers["x-marcel-signature"] = crypto.sign("sha256", Buffer.from("different"), wrong.privateKey).toString("base64url");
  assert.throws(() => parseAndValidateEnrollmentRequest(original.req, NOW), error => error.code === "ENROLLMENT_PROOF_INVALID");
});

test("a substituted public key cannot be authorized by the original private key", () => {
  const originalKeys = keyPair();
  const substitutedKeys = keyPair();
  const input = requestFrom({ keys: originalKeys });
  const payload = JSON.parse(input.req.body.toString("utf8"));
  payload.public_key.value = substitutedKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  input.req.body = Buffer.from(JSON.stringify(payload));
  input.headers["x-marcel-content-sha256"] = sha256Hex(input.req.body);
  const canonical = canonicalRequest({
    protocolVersion: 1, method: "POST", path: ENROLLMENT_PATH, timestamp: NOW.toISOString(),
    requestId: REQUEST_ID, contentSha256: input.headers["x-marcel-content-sha256"]
  });
  input.headers["x-marcel-signature"] = crypto.sign("sha256", Buffer.from(canonical), originalKeys.privateKey).toString("base64url");
  assert.throws(() => parseAndValidateEnrollmentRequest(input.req, NOW), error => error.code === "ENROLLMENT_PROOF_INVALID");
});

test("body manipulation is rejected by hash", () => {
  const input = requestFrom();
  input.req.body = Buffer.concat([input.req.body, Buffer.from(" ")]);
  assert.throws(() => parseAndValidateEnrollmentRequest(input.req, NOW), error => error.code === "BODY_HASH_MISMATCH");
});

test("timestamp outside window is rejected", () => {
  const input = requestFrom();
  assert.throws(() => parseAndValidateEnrollmentRequest(input.req, new Date(NOW.valueOf() + 300_001)), error => error.code === "TIMESTAMP_OUT_OF_WINDOW");
});

test("requested_at and header timestamp mismatch is rejected", () => {
  const input = requestFrom({ payloadOverrides: { requested_at: "2026-09-01T12:34:55.000Z" } });
  assert.throws(() => parseAndValidateEnrollmentRequest(input.req, NOW), error => error.code === "INVALID_BODY");
});

test("device or key headers are forbidden during enrollment", () => {
  for (const name of ["x-marcel-device-id", "x-marcel-key-id"]) {
    const input = requestFrom({ headerOverrides: { [name]: DEVICE_ID } });
    assert.throws(() => parseAndValidateEnrollmentRequest(input.req, NOW), error => error.code === "INVALID_HEADER");
  }
});

test("query string and protocol mismatch are rejected", () => {
  assert.throws(() => parseAndValidateEnrollmentRequest(requestFrom({ path: `${ENROLLMENT_PATH}?x=1` }).req, NOW));
  const mismatch = requestFrom({ headerOverrides: { "x-marcel-protocol-version": "2" } });
  assert.throws(() => parseAndValidateEnrollmentRequest(mismatch.req, NOW), error => error.code === "UNSUPPORTED_PROTOCOL_VERSION");
  const bodyMismatch = requestFrom({ payloadOverrides: { protocol_version: 2 } });
  assert.throws(() => parseAndValidateEnrollmentRequest(bodyMismatch.req, NOW), error => error.code === "PROTOCOL_VERSION_MISMATCH");
});

test("invalid UTF-8 is rejected before registration", () => {
  const input = requestFrom();
  input.req.body = Buffer.from([0xc3, 0x28]);
  assert.throws(() => parseAndValidateEnrollmentRequest(input.req, NOW), error => error.code === "INVALID_JSON");
});

test("new enrollment commits exactly one device and key", async () => {
  const validated = parseAndValidateEnrollmentRequest(requestFrom().req, NOW);
  const fake = fakeEnrollmentPool(validCodeRow());
  const result = await enrollDeviceTransaction(fake.pool, validated, NOW);
  assert.equal(result.status, 201);
  assert.equal(result.body.protocol_version, 1);
  assert.deepEqual(result.body.configuration, {
    heartbeat_interval_seconds: 30,
    offline_after_seconds: 90,
    signature_window_seconds: 300,
    configuration_revision: 1
  });
  assert.equal(result.body.device_directive, "CONTINUE");
  assert.equal(fake.state.devices, 1);
  assert.equal(fake.state.keys, 1);
  assert.equal(fake.state.audits, 1);
  assert.equal(fake.state.committed, true);
});

test("invalid and expired enrollment codes are rejected", async () => {
  const validated = parseAndValidateEnrollmentRequest(requestFrom().req, NOW);
  await assert.rejects(() => enrollDeviceTransaction(fakeEnrollmentPool(null).pool, validated, NOW), error => error.code === "ENROLLMENT_CODE_INVALID");
  await assert.rejects(() => enrollDeviceTransaction(fakeEnrollmentPool(validCodeRow({ expires_at: new Date(NOW.valueOf() - 1) })).pool, validated, NOW), error => error.code === "ENROLLMENT_CODE_INVALID");
});

test("replayed request identifier is rejected", async () => {
  const validated = parseAndValidateEnrollmentRequest(requestFrom().req, NOW);
  await assert.rejects(() => enrollDeviceTransaction(fakeEnrollmentPool(validCodeRow(), { replay: true }).pool, validated, NOW), error => error.code === "REQUEST_REPLAYED");
});

test("lost response retry returns original device and key without duplicates", async () => {
  const validated = parseAndValidateEnrollmentRequest(requestFrom({ requestId: "4dbf2bd9-3d7c-4925-89de-fc0dc62a2fe1" }).req, NOW);
  const row = validCodeRow({
    consumed_at: NOW,
    enrollment_attempt_id: ATTEMPT_ID,
    consumed_installation_id: INSTALLATION_ID,
    consumed_public_key_fingerprint: validated.fingerprint,
    consumed_device_id: DEVICE_ID,
    consumed_key_id: KEY_ID
  });
  const fake = fakeEnrollmentPool(row);
  const result = await enrollDeviceTransaction(fake.pool, validated, NOW);
  assert.equal(result.status, 200);
  assert.equal(result.body.device_id, DEVICE_ID);
  assert.equal(result.body.key_id, KEY_ID);
  assert.equal(fake.state.devices, 0);
  assert.equal(fake.state.keys, 0);
});

test("foreign consumed attempt and conflicting identity create no device", async () => {
  const validated = parseAndValidateEnrollmentRequest(requestFrom().req, NOW);
  const foreign = fakeEnrollmentPool(validCodeRow({ consumed_at: NOW, enrollment_attempt_id: crypto.randomUUID() }));
  await assert.rejects(() => enrollDeviceTransaction(foreign.pool, validated, NOW), error => error.code === "ENROLLMENT_CODE_INVALID");
  assert.equal(foreign.state.devices, 0);
  const conflict = fakeEnrollmentPool(validCodeRow(), { conflict: true });
  await assert.rejects(() => enrollDeviceTransaction(conflict.pool, validated, NOW), error => error.code === "ENROLLMENT_CODE_INVALID");
  assert.equal(conflict.state.devices, 0);
});

test("database failure rolls transaction back", async () => {
  const validated = parseAndValidateEnrollmentRequest(requestFrom().req, NOW);
  const fake = fakeEnrollmentPool(validCodeRow(), { failKeyInsert: true });
  await assert.rejects(() => enrollDeviceTransaction(fake.pool, validated, NOW));
  assert.equal(fake.state.committed, false);
  assert.equal(fake.state.rolledBack, true);
  assert.equal(fake.state.released, true);
});

function authenticatedRequest(keys = keyPair(), overrides = {}) {
  const path = `/device-bridge/v1/devices/${DEVICE_ID}/heartbeat`;
  const body = Buffer.from('{"protocol_version":1}');
  const hash = sha256Hex(body);
  const requestId = overrides.requestId || REQUEST_ID;
  const canonical = canonicalRequest({ protocolVersion: 1, method: "POST", path, timestamp: NOW.toISOString(), requestId, contentSha256: hash });
  const headers = {
    "x-marcel-protocol-version": "1", "x-marcel-device-id": DEVICE_ID,
    "x-marcel-key-id": KEY_ID, "x-marcel-timestamp": NOW.toISOString(),
    "x-marcel-request-id": requestId, "x-marcel-content-sha256": hash,
    "x-marcel-signature": crypto.sign("sha256", Buffer.from(canonical), keys.privateKey).toString("base64url"),
    ...overrides.headers
  };
  return { req: { method: "POST", originalUrl: path, body, get: name => headers[name.toLowerCase()] }, keys };
}

function authPool(input, rowOverrides = {}) {
  const spki = input.keys.publicKey.export({ type: "spki", format: "der" });
  return { async query() { return { rows: [{ device_id: DEVICE_ID, key_id: KEY_ID, enrollment_state: "ACTIVE", device_revoked_at: null, key_revoked_at: null, public_key_spki_der: spki, ...rowOverrides }] }; } };
}

test("device auth accepts valid device, key and signature without consuming nonce", async () => {
  const input = authenticatedRequest();
  const pool = authPool(input);
  const context = await verifyAuthenticatedDeviceRequest({ req: input.req, pool, urlDeviceId: DEVICE_ID, now: NOW });
  assert.equal(context.deviceId, DEVICE_ID);
  assert.equal(context.keyId, KEY_ID);
  assert.equal(Object.hasOwn(pool, "connect"), false);
});

test("device auth rejects an invalid signature and manipulated body", async () => {
  const signatureInput = authenticatedRequest();
  const validGet = signatureInput.req.get;
  signatureInput.req.get = name => name.toLowerCase() === "x-marcel-signature" ? "not-a-valid-signature" : validGet(name);
  await assert.rejects(() => verifyAuthenticatedDeviceRequest({ req: signatureInput.req, pool: authPool(signatureInput), urlDeviceId: DEVICE_ID, now: NOW }), error => error.code === "SIGNATURE_INVALID");

  const bodyInput = authenticatedRequest();
  bodyInput.req.body = Buffer.from('{"protocol_version":2}');
  await assert.rejects(() => verifyAuthenticatedDeviceRequest({ req: bodyInput.req, pool: authPool(bodyInput), urlDeviceId: DEVICE_ID, now: NOW }), error => error.code === "BODY_HASH_MISMATCH");
});

test("revoked device and revoked key are rejected", async () => {
  const input = authenticatedRequest();
  await assert.rejects(() => verifyAuthenticatedDeviceRequest({ req: input.req, pool: authPool(input, { enrollment_state: "REVOKED", device_revoked_at: NOW }), urlDeviceId: DEVICE_ID, now: NOW }), error => error.code === "DEVICE_REVOKED");
  await assert.rejects(() => verifyAuthenticatedDeviceRequest({ req: input.req, pool: authPool(input, { key_revoked_at: NOW }), urlDeviceId: DEVICE_ID, now: NOW }), error => error.code === "KEY_REVOKED");
});

test("wrong device/key pair and URL/header mismatch are rejected", async () => {
  const input = authenticatedRequest();
  const missingDevice = { async query() { return { rows: [] }; } };
  const missingKey = { async query() { return { rows: [{ device_id: DEVICE_ID, key_id: null, enrollment_state: "ACTIVE" }] }; } };
  await assert.rejects(() => verifyAuthenticatedDeviceRequest({ req: input.req, pool: missingDevice, urlDeviceId: DEVICE_ID, now: NOW }), error => error.code === "DEVICE_NOT_FOUND");
  await assert.rejects(() => verifyAuthenticatedDeviceRequest({ req: input.req, pool: missingKey, urlDeviceId: DEVICE_ID, now: NOW }), error => error.code === "KEY_NOT_FOUND");
  await assert.rejects(() => verifyAuthenticatedDeviceRequest({ req: input.req, pool: missingDevice, urlDeviceId: crypto.randomUUID(), now: NOW }), error => error.code === "DEVICE_ID_MISMATCH");
});

test("replay registration is separate and maps duplicate nonce safely", async () => {
  const context = { keyId: KEY_ID, requestId: REQUEST_ID, contentSha256: "a".repeat(64) };
  let inserted = false;
  await registerAuthenticatedRequestReplay({ async query() { inserted = true; } }, context, NOW);
  assert.equal(inserted, true);
  await assert.rejects(() => registerAuthenticatedRequestReplay({ async query() { const error = new Error(); error.code = "23505"; throw error; } }, context, NOW), error => error.code === "REQUEST_REPLAYED");
});

test("bounded rate limiter rejects abuse and resets after window", () => {
  resetEnrollmentRateLimitForTests();
  const req = { ip: "192.0.2.1" };
  for (let index = 0; index < 20; index += 1) consumeEnrollmentRateLimit(req, 0);
  assert.throws(() => consumeEnrollmentRateLimit(req, 0), error => error.code === "RATE_LIMITED");
  assert.doesNotThrow(() => consumeEnrollmentRateLimit(req, 600_001));
});

test("protocol errors and audit paths do not expose enrollment or signature values", () => {
  const input = requestFrom();
  input.headers["x-marcel-signature"] = "sensitive-signature-material";
  let error;
  try { parseAndValidateEnrollmentRequest(input.req, NOW); } catch (caught) { error = caught; }
  assert.equal(JSON.stringify({ code: error.code, message: error.message }).includes(CODE), false);
  assert.equal(JSON.stringify({ code: error.code, message: error.message }).includes(input.headers["x-marcel-signature"]), false);
});
