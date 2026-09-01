import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  DEVICE_BRIDGE_PROTOCOL,
  DeviceBridgeProtocolError,
  assertTimestampWithinWindow,
  canonicalRequest,
  enrollmentCodeDigest,
  isBase64UrlWithoutPadding,
  isExactUtcTimestamp,
  isUuidV4,
  normalizeEnrollmentCode,
  parseP256Spki,
  publicKeyFingerprint,
  safeAuditDetails,
  sha256Hex,
  verifyEcdsaSha256
} from "../device-bridge/protocol-v1.js";
import {
  deviceBridgeFoundationMiddleware,
  markDeviceBridgeReady
} from "../device-bridge/readiness.js";

const BODY = Buffer.from('{"protocol_version":1}', "utf8");
const BODY_HASH = "00aa4c2c857995eb8e19cb0fade07e4b49aac774e37a99c37a0c9f549204d9de";
const REQUEST_ID = "d2675347-0888-4548-9feb-ae4d71a972cf";
const TIMESTAMP = "2026-09-01T12:34:56.000Z";
const PATH = "/device-bridge/v1/devices/e880455d-325c-4f35-9914-823dcb0e0d18/heartbeat";

function canonical(overrides = {}) {
  return canonicalRequest({
    protocolVersion: 1,
    method: "POST",
    path: PATH,
    timestamp: TIMESTAMP,
    requestId: REQUEST_ID,
    contentSha256: BODY_HASH,
    ...overrides
  });
}

test("Protocol V1 constants are fixed", () => {
  assert.deepEqual(DEVICE_BRIDGE_PROTOCOL, {
    version: 1,
    heartbeatIntervalSeconds: 30,
    offlineAfterSeconds: 90,
    signatureWindowSeconds: 300,
    maximumRequestBytes: 65536,
    commandBatchLimit: 50,
    commands: ["PING", "REQUEST_STATUS", "STOP_BRIDGE"]
  });
});

test("raw body SHA-256 is deterministic and byte-sensitive", () => {
  assert.equal(sha256Hex(BODY), BODY_HASH);
  assert.equal(sha256Hex(BODY), sha256Hex(Buffer.from(BODY)));
  assert.notEqual(sha256Hex(BODY), sha256Hex(Buffer.from('{"protocol_version":2}')));
});

test("canonical request has exactly six LF-separated lines and no final newline", () => {
  const value = canonical();
  assert.equal(value.split("\n").length, 6);
  assert.equal((value.match(/\n/g) || []).length, 5);
  assert.equal(value.includes("\r"), false);
  assert.equal(value.endsWith("\n"), false);
  assert.equal(Buffer.from(value).toString("utf8"), value);
});

test("canonical request rejects query strings", () => {
  assert.throws(() => canonical({ path: `${PATH}?x=1` }), error =>
    error instanceof DeviceBridgeProtocolError && error.code === "INVALID_HEADER");
});

test("timestamp validator requires real UTC milliseconds", () => {
  assert.equal(isExactUtcTimestamp(TIMESTAMP), true);
  for (const value of ["2026-09-01T12:34:56Z", "2026-09-01T12:34:56.000+00:00", "2026-02-30T12:00:00.000Z"])
    assert.equal(isExactUtcTimestamp(value), false);
});

test("signature timestamp window accepts boundaries and rejects outside values", () => {
  const now = new Date("2026-09-01T12:39:56.000Z");
  assert.doesNotThrow(() => assertTimestampWithinWindow(TIMESTAMP, now));
  assert.throws(
    () => assertTimestampWithinWindow("2026-09-01T12:34:55.999Z", now),
    error => error instanceof DeviceBridgeProtocolError && error.code === "TIMESTAMP_OUT_OF_WINDOW"
  );
});

test("UUID validator accepts canonical lowercase v4 only", () => {
  assert.equal(isUuidV4(REQUEST_ID), true);
  assert.equal(isUuidV4(REQUEST_ID.toUpperCase()), false);
  assert.equal(isUuidV4("d2675347-0888-1548-9feb-ae4d71a972cf"), false);
});

test("signature encoding is base64url without padding", () => {
  assert.equal(isBase64UrlWithoutPadding("MEUCIQ_a-b9"), true);
  for (const value of ["", "abc=", "abc+", "abc/"]) assert.equal(isBase64UrlWithoutPadding(value), false);
});

test("enrollment code normalization and digest are deterministic", () => {
  const grouped = "01234-56789-ABCDE-FGHJK-MNPQRS";
  const normalized = "0123456789ABCDEFGHJKMNPQRS";
  assert.equal(normalizeEnrollmentCode(grouped), normalized);
  assert.equal(enrollmentCodeDigest(grouped), sha256Hex(Buffer.from(normalized, "ascii")));
  assert.throws(() => normalizeEnrollmentCode("OOOOO-OOOOO-OOOOO-OOOOO-OOOOOO"));
});

test("P-256 SPKI parsing, fingerprinting and ECDSA verification interoperate", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const parsed = parseP256Spki(spki);
  assert.equal(publicKeyFingerprint(parsed), sha256Hex(publicKey.export({ type: "spki", format: "der" })));

  const bytes = Buffer.from(canonical(), "utf8");
  const signature = crypto.sign("sha256", bytes, privateKey).toString("base64url");
  assert.equal(verifyEcdsaSha256({ publicKey: parsed, canonicalBytes: bytes, signatureBase64Url: signature }), true);
  assert.equal(verifyEcdsaSha256({ publicKey: parsed, canonicalBytes: Buffer.from(`${canonical()}x`), signatureBase64Url: signature }), false);
});

test("wrong key type and wrong EC curve are rejected", () => {
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey
    .export({ type: "spki", format: "der" }).toString("base64");
  const p384 = crypto.generateKeyPairSync("ec", { namedCurve: "secp384r1" }).publicKey
    .export({ type: "spki", format: "der" }).toString("base64");
  assert.throws(() => parseP256Spki(rsa));
  assert.throws(() => parseP256Spki(p384));
});

test("audit helper drops sensitive and unknown fields", () => {
  assert.deepEqual(safeAuditDetails({ device_id: "safe", signature: "must-not-survive", enrollment_code: "must-not-survive", cookie: "must-not-survive" }), { device_id: "safe" });
});

test("DDL contains all seven idempotent tables, transactional boundaries and constraints", () => {
  const ddl = fs.readFileSync(new URL("../device-bridge/database.js", import.meta.url), "utf8");
  for (const table of [
    "device_bridge_devices", "device_bridge_keys", "device_bridge_enrollment_codes",
    "device_bridge_commands", "device_bridge_command_acks", "device_bridge_request_nonces",
    "device_bridge_audit_events"
  ]) assert.match(ddl, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(ddl, /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/g);
  assert.match(ddl, /await client\.query\("BEGIN"\)/);
  assert.match(ddl, /await client\.query\("COMMIT"\)/);
  assert.match(ddl, /await client\.query\("ROLLBACK"\)/);
  assert.match(ddl, /enrollment_attempt_id UUID UNIQUE/);
  assert.match(ddl, /installation_id UUID NOT NULL UNIQUE/);
  assert.match(ddl, /PRIMARY KEY \(auth_subject, request_id\)/);
});

test("bridge readiness returns controlled 503 before initialization", async () => {
  const req = {
    originalUrl: "/device-bridge/v1/probe",
    body: BODY,
    get(name) {
      return name === "content-type" ? "application/json; charset=utf-8" : REQUEST_ID;
    }
  };
  let status;
  let body;
  const res = {
    status(value) { status = value; return this; },
    json(value) { body = value; }
  };
  deviceBridgeFoundationMiddleware(req, res, () => assert.fail("middleware must not continue before readiness"));
  assert.equal(status, 503);
  assert.equal(body.error.code, "BACKEND_NOT_READY");
});

test("index registers bridge raw parser before global parsers", () => {
  const source = fs.readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const raw = source.indexOf('express.raw({');
  const json = source.indexOf('app.use(express.json({ limit: "2mb" }))');
  const urlencoded = source.indexOf("app.use(express.urlencoded({ extended: true }))");
  assert.ok(raw >= 0 && raw < json && raw < urlencoded);
  assert.match(source, /app\.use\("\/device-bridge\/v1", deviceBridgeFoundationMiddleware\)/);
});

test("ready foundation preserves raw Buffer and rejects query strings", () => {
  markDeviceBridgeReady();
  const makeRequest = originalUrl => ({
    originalUrl,
    body: BODY,
    get(name) { return name === "content-type" ? "application/json; charset=utf-8" : REQUEST_ID; }
  });
  let continued = false;
  deviceBridgeFoundationMiddleware(makeRequest("/device-bridge/v1/probe"), {}, () => { continued = true; });
  assert.equal(continued, true);
  assert.equal(sha256Hex(BODY), BODY_HASH);

  let status;
  let response;
  const res = { status(value) { status = value; return this; }, json(value) { response = value; } };
  deviceBridgeFoundationMiddleware(makeRequest("/device-bridge/v1/probe?x=1"), res, () => assert.fail("query must not continue"));
  assert.equal(status, 400);
  assert.equal(response.error.code, "INVALID_HEADER");
});
