import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  commandAckSemanticHash,
  createCommandAckHandler,
  parseAndValidateCommandAck,
  processCommandAckTransaction
} from "../device-bridge/command-ack.js";
import { canonicalRequest, sha256Hex } from "../device-bridge/protocol-v1.js";

const NOW = new Date("2026-09-01T12:34:56.000Z");
const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const KEY_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const COMMAND_ID = "2324a0db-c846-41f8-a9f5-3539ca83de00";
const REQUEST_ID = "d2675347-0888-4548-9feb-ae4d71a972cf";

function ackPayload(status, overrides = {}) {
  const defaults = {
    RECEIVED: { result: null, error: null },
    SUCCEEDED: { result: { pong: true }, error: null },
    FAILED: { result: null, error: { code: "COMMAND_EXECUTION_FAILED", message: "Execution failed" } },
    REJECTED: { result: null, error: null },
    EXPIRED: { result: null, error: null }
  }[status];
  return {
    protocol_version: 1,
    command_id: COMMAND_ID,
    sent_at: NOW.toISOString(),
    status,
    occurred_at: NOW.toISOString(),
    ...defaults,
    ...overrides
  };
}

function ackRequest(payload = ackPayload("RECEIVED"), { requestId = REQUEST_ID, keys, now = NOW } = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const hash = sha256Hex(body);
  const path = `/device-bridge/v1/devices/${DEVICE_ID}/commands/${COMMAND_ID}/ack`;
  const pair = keys || crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const canonical = canonicalRequest({ protocolVersion: 1, method: "POST", path, timestamp: now.toISOString(), requestId, contentSha256: hash });
  const headers = {
    "x-marcel-protocol-version": "1", "x-marcel-device-id": DEVICE_ID,
    "x-marcel-key-id": KEY_ID, "x-marcel-timestamp": now.toISOString(),
    "x-marcel-request-id": requestId, "x-marcel-content-sha256": hash,
    "x-marcel-signature": crypto.sign("sha256", Buffer.from(canonical), pair.privateKey).toString("base64url")
  };
  return {
    req: { method: "POST", originalUrl: path, body, params: { deviceId: DEVICE_ID, commandId: COMMAND_ID }, get: name => headers[name.toLowerCase()] },
    keys: pair,
    hash,
    headers
  };
}

function responseRecorder() {
  return { statusCode: null, body: null, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
}

function historyRow(ack) {
  return { status: ack.status, occurred_at: ack.occurred_at, result: ack.result, error: ack.error, body_sha256: commandAckSemanticHash(ack), accepted_at: NOW };
}

function ackPool({ request, history = [], terminalStatus = null, commandDeviceId = DEVICE_ID,
  commandType = "PING", revision = 1, deviceRevision = 1, expiresAt = new Date(NOW.valueOf() + 60_000),
  deviceState = "ACTIVE", deviceRevoked = false, keyRevoked = false, missingCommand = false,
  nonceReplay = false, failAudit = false } = {}) {
  const calls = [];
  const state = { nonce: 0, ackInserts: 0, commandUpdates: 0, audits: 0, commits: 0, rollbacks: 0 };
  const authRow = {
    device_id: DEVICE_ID, key_id: KEY_ID, enrollment_state: "ACTIVE", device_revoked_at: null,
    key_revoked_at: null, public_key_spki_der: request?.keys.publicKey.export({ type: "spki", format: "der" })
  };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === "BEGIN") return { rows: [] };
      if (sql === "COMMIT") { state.commits += 1; return { rows: [] }; }
      if (sql === "ROLLBACK") { state.rollbacks += 1; return { rows: [] }; }
      if (sql.includes("FROM device_bridge_devices d") && sql.includes("FOR UPDATE")) return { rows: [{
        device_id: DEVICE_ID, enrollment_state: deviceState, revoked_at: deviceRevoked ? NOW : null,
        configuration_revision: deviceRevision, key_id: KEY_ID, key_revoked_at: keyRevoked ? NOW : null
      }] };
      if (sql.includes("INSERT INTO device_bridge_request_nonces")) {
        if (nonceReplay) { const error = new Error("duplicate"); error.code = "23505"; throw error; }
        state.nonce += 1; return { rows: [] };
      }
      if (sql.includes("FROM device_bridge_commands") && sql.includes("FOR UPDATE")) return { rows: missingCommand ? [] : [{
        command_id: COMMAND_ID, device_id: commandDeviceId, command_type: commandType,
        configuration_revision: revision, issued_at: new Date(NOW.valueOf() - 60_000),
        expires_at: expiresAt, terminal_status: terminalStatus, terminal_at: terminalStatus ? NOW : null
      }] };
      if (sql.includes("FROM device_bridge_command_acks")) return { rows: history };
      if (sql.includes("INSERT INTO device_bridge_command_acks")) { state.ackInserts += 1; return { rows: [] }; }
      if (sql.includes("UPDATE device_bridge_commands")) { state.commandUpdates += 1; return { rows: [] }; }
      if (sql.includes("INSERT INTO device_bridge_audit_events")) {
        if (failAudit) throw new Error("simulated audit failure");
        state.audits += 1; return { rows: [] };
      }
      return { rows: [] };
    },
    release() { state.released = true; }
  };
  return {
    pool: {
      async query(sql) { return sql.includes("LEFT JOIN device_bridge_keys") ? { rows: [authRow] } : { rows: [] }; },
      async connect() { return client; }
    },
    calls,
    state
  };
}

function auth(requestId = REQUEST_ID, hash = "a".repeat(64)) {
  return { deviceId: DEVICE_ID, keyId: KEY_ID, requestId, contentSha256: hash };
}

test("valid RECEIVED is accepted and remains non-terminal", async () => {
  const ack = ackPayload("RECEIVED");
  const fake = ackPool();
  const response = await processCommandAckTransaction(fake.pool, auth(), ack, NOW);
  assert.equal(response.status, "RECEIVED");
  assert.equal(fake.state.ackInserts, 1);
  assert.equal(fake.state.commandUpdates, 0);
  assert.equal(fake.state.audits, 1);
});

test("RECEIVED transitions to SUCCEEDED and FAILED", async () => {
  for (const status of ["SUCCEEDED", "FAILED"]) {
    const received = ackPayload("RECEIVED");
    const ack = ackPayload(status);
    const fake = ackPool({ history: [historyRow(received)] });
    await processCommandAckTransaction(fake.pool, auth(), ack, NOW);
    assert.equal(fake.state.commandUpdates, 1);
    assert.equal(fake.state.commits, 1);
  }
});

test("NONE transitions directly to REJECTED and EXPIRED", async () => {
  for (const status of ["REJECTED", "EXPIRED"]) {
    const expired = status === "EXPIRED";
    const fake = ackPool({ expiresAt: new Date(NOW.valueOf() + (expired ? -1 : 60_000)) });
    await processCommandAckTransaction(fake.pool, auth(), ackPayload(status), NOW);
    assert.equal(fake.state.commandUpdates, 1);
  }
});

test("NONE to SUCCEEDED or FAILED is rejected", async () => {
  for (const status of ["SUCCEEDED", "FAILED"]) {
    await assert.rejects(() => processCommandAckTransaction(ackPool().pool, auth(), ackPayload(status), NOW), error => error.code === "INVALID_ACK_TRANSITION");
  }
});

test("terminal states cannot transition", async () => {
  for (const [current, next] of [["SUCCEEDED", "FAILED"], ["FAILED", "SUCCEEDED"], ["REJECTED", "RECEIVED"], ["EXPIRED", "RECEIVED"]]) {
    const fake = ackPool({ terminalStatus: current, history: [historyRow(ackPayload(current))] });
    await assert.rejects(() => processCommandAckTransaction(fake.pool, auth(), ackPayload(next), NOW), error => error.code === "INVALID_ACK_TRANSITION");
  }
});

test("semantic retry with new request id is idempotent without audit or terminalization", async () => {
  const ack = ackPayload("SUCCEEDED");
  const fake = ackPool({ terminalStatus: "SUCCEEDED", history: [historyRow(ack)] });
  const response = await processCommandAckTransaction(fake.pool, auth("4dbf2bd9-3d7c-4925-89de-fc0dc62a2fe1"), ack, NOW);
  assert.equal(response.status, "SUCCEEDED");
  assert.equal(fake.state.ackInserts, 0);
  assert.equal(fake.state.commandUpdates, 0);
  assert.equal(fake.state.audits, 0);
  assert.equal(fake.state.nonce, 1);
});

test("same request id is transport replay", async () => {
  const fake = ackPool({ nonceReplay: true });
  await assert.rejects(() => processCommandAckTransaction(fake.pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "REQUEST_REPLAYED");
  assert.equal(fake.state.ackInserts, 0);
});

test("same status with changed occurred_at, result or error is not idempotent", async () => {
  const original = ackPayload("RECEIVED");
  for (const changed of [
    ackPayload("RECEIVED", { occurred_at: "2026-09-01T12:34:55.000Z" }),
    ackPayload("FAILED", { error: { code: "COMMAND_EXECUTION_FAILED", message: "Another failure" } })
  ]) {
    const existing = changed.status === "FAILED" ? ackPayload("FAILED") : original;
    const fake = ackPool({ terminalStatus: changed.status === "FAILED" ? "FAILED" : null, history: [historyRow(existing)] });
    await assert.rejects(() => processCommandAckTransaction(fake.pool, auth(), changed, NOW), error => error.code === "INVALID_ACK_TRANSITION");
  }
});

test("body and URL command identifiers must match", () => {
  const input = ackRequest(ackPayload("RECEIVED", { command_id: crypto.randomUUID() }));
  assert.throws(() => parseAndValidateCommandAck(input.req), error => error.code === "COMMAND_DEVICE_MISMATCH");
});

test("missing, foreign, unsupported and wrong-revision commands are rejected", async () => {
  await assert.rejects(() => processCommandAckTransaction(ackPool({ missingCommand: true }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "COMMAND_NOT_FOUND");
  await assert.rejects(() => processCommandAckTransaction(ackPool({ commandDeviceId: crypto.randomUUID() }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "COMMAND_DEVICE_MISMATCH");
  await assert.rejects(() => processCommandAckTransaction(ackPool({ commandType: "UNKNOWN" }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "COMMAND_TYPE_UNSUPPORTED");
  await assert.rejects(() => processCommandAckTransaction(ackPool({ revision: 2 }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "CONFIGURATION_REVISION_UNSUPPORTED");
});

test("revoked device and revoked key fail closed inside transaction", async () => {
  await assert.rejects(() => processCommandAckTransaction(ackPool({ deviceRevoked: true }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "DEVICE_REVOKED");
  await assert.rejects(() => processCommandAckTransaction(ackPool({ keyRevoked: true }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "KEY_REVOKED");
});

test("signed ack handler rejects bad signature and manipulated body", async () => {
  const current = new Date();
  const input = ackRequest(undefined, { now: current });
  const fake = ackPool({ request: input });
  input.headers["x-marcel-signature"] = "invalid-signature";
  const badSignature = responseRecorder();
  await createCommandAckHandler(fake.pool)(input.req, badSignature);
  assert.equal(badSignature.statusCode, 401);
  assert.equal(badSignature.body.error.code, "SIGNATURE_INVALID");

  const manipulated = ackRequest(undefined, { now: current });
  manipulated.req.body = Buffer.concat([manipulated.req.body, Buffer.from(" ")]);
  const badBody = responseRecorder();
  await createCommandAckHandler(ackPool({ request: manipulated }).pool)(manipulated.req, badBody);
  assert.equal(badBody.body.error.code, "BODY_HASH_MISMATCH");
});

test("sent_at mismatch is rejected", () => {
  const input = ackRequest(ackPayload("RECEIVED", { sent_at: "2026-09-01T12:34:55.000Z" }));
  assert.throws(() => parseAndValidateCommandAck(input.req), error => error.code === "INVALID_BODY");
});

test("expired command accepts first EXPIRED but rejects first RECEIVED", async () => {
  const expiry = new Date(NOW.valueOf() - 1);
  await processCommandAckTransaction(ackPool({ expiresAt: expiry }).pool, auth(), ackPayload("EXPIRED"), NOW);
  await assert.rejects(() => processCommandAckTransaction(ackPool({ expiresAt: expiry }).pool, auth(), ackPayload("RECEIVED"), NOW), error => error.code === "COMMAND_EXPIRED");
});

test("RECEIVED command remains deliverable while terminal command is excluded", () => {
  const heartbeat = fs.readFileSync(new URL("../device-bridge/heartbeat.js", import.meta.url), "utf8");
  assert.match(heartbeat, /terminal_status IS NULL/);
  const ack = fs.readFileSync(new URL("../device-bridge/command-ack.js", import.meta.url), "utf8");
  assert.match(ack, /if \(TERMINAL_STATUSES\.has\(ack\.status\)\)/);
  assert.equal(/UPDATE device_bridge_commands/.test(ack.slice(0, ack.indexOf("TERMINAL_STATUSES.has(ack.status)"))), false);
});

test("DB failure rolls nonce, ack, command update and audit back", async () => {
  const fake = ackPool({ history: [historyRow(ackPayload("RECEIVED"))], failAudit: true });
  await assert.rejects(() => processCommandAckTransaction(fake.pool, auth(), ackPayload("SUCCEEDED"), NOW));
  assert.equal(fake.state.nonce, 1);
  assert.equal(fake.state.ackInserts, 1);
  assert.equal(fake.state.commandUpdates, 1);
  assert.equal(fake.state.commits, 0);
  assert.equal(fake.state.rollbacks, 1);
});

test("RECEIVED and EXPIRED require null result/error", () => {
  for (const status of ["RECEIVED", "EXPIRED"]) {
    assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload(status, { result: { injected: true } })).req));
    assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload(status, { error: { code: "ERROR", message: "x" } })).req));
  }
});

test("SUCCEEDED accepts only small command-specific T0 results or null", () => {
  assert.doesNotThrow(() => parseAndValidateCommandAck(ackRequest(ackPayload("SUCCEEDED")).req, "PING"));
  assert.doesNotThrow(() => parseAndValidateCommandAck(ackRequest(ackPayload("SUCCEEDED", { result: null })).req, "PING"));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("SUCCEEDED", { result: { token: "forbidden" } })).req, "PING"));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("SUCCEEDED", { result: { text: "x".repeat(2000) } })).req, "PING"));
});

test("FAILED and REJECTED errors are strictly bounded", () => {
  assert.doesNotThrow(() => parseAndValidateCommandAck(ackRequest(ackPayload("FAILED")).req));
  assert.doesNotThrow(() => parseAndValidateCommandAck(ackRequest(ackPayload("REJECTED")).req));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("FAILED", { error: { code: "BAD", message: "x".repeat(257) } })).req));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("FAILED", { error: { code: "BAD", message: "token leaked" } })).req));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("FAILED", { error: { code: "BAD", message: "x", stack: "forbidden" } })).req));
  assert.throws(() => parseAndValidateCommandAck(ackRequest(ackPayload("FAILED", { error: { code: "COMMAND_EXECUTION_FAILED", message: "Contains personal text" } })).req));
});

test("response and audit contain no raw result/error or sensitive data", async () => {
  const ack = ackPayload("FAILED");
  const fake = ackPool({ history: [historyRow(ackPayload("RECEIVED"))] });
  const response = await processCommandAckTransaction(fake.pool, auth(), ack, NOW);
  const serialized = JSON.stringify(response);
  for (const value of ["result", "error", "signature", "token", "cookie", "public_key"]) assert.equal(serialized.includes(value), false);
  const audit = fake.calls.find(call => call.sql.includes("device_bridge_audit_events"));
  assert.equal(JSON.stringify(audit).includes("Execution failed"), false);
});

test("ack route is registered through the existing raw/auth route stack", () => {
  const routes = fs.readFileSync(new URL("../device-bridge/block3-routes.js", import.meta.url), "utf8");
  assert.match(routes, /devices\/:deviceId\/commands\/:commandId\/ack/);
  const source = fs.readFileSync(new URL("../device-bridge/command-ack.js", import.meta.url), "utf8");
  assert.match(source, /verifyAuthenticatedDeviceRequest/);
  assert.match(source, /registerAuthenticatedRequestReplay\(client, auth, now\)/);
});
