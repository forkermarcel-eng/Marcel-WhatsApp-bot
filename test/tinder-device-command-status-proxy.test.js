import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import handler from "../api/tinder/device-status.js";
import {
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES,
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS,
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES
} from "../device-bridge/tinder-official-resume-schema-evidence-contract.js";

const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const COMMAND_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const PASSWORD = "test-dashboard-password";

function validCookie() {
  const token = "test-session";
  const signature = crypto.createHmac("sha256", PASSWORD).update(token).digest("hex");
  return `marcel_dashboard_session=${token}.${signature}`;
}

function request({ method = "GET", authenticated = true, deviceId = DEVICE_ID, commandId = COMMAND_ID } = {}) {
  return {
    method,
    headers: { cookie: authenticated ? validCookie() : "" },
    query: { deviceId, commandId }
  };
}

function responseRecorder() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

function backendResponse({ ok = true, status = 200 } = {}) {
  const body = ok
    ? {
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        command: {
          protocol_version: 1,
          command_id: COMMAND_ID,
          device_id: DEVICE_ID,
          type: "PING",
          status: "RECEIVED",
          terminal_status: null,
          issued_at: "2026-09-02T12:00:00.000Z",
          delivered_at: null,
          acknowledged_at: "2026-09-02T12:00:03.000Z",
          occurred_at: "2026-09-02T12:00:02.000Z",
          terminal_at: null,
          result: null,
          error: null
        }
      }
    : {
        ok: false,
        error: { code: "COMMAND_NOT_FOUND", message: "Command was not found", retryable: false }
      };
  return { ok, status, async text() { return JSON.stringify(body); } };
}

function deviceStatus({ inboxNavigation = null, officialResumeHandoff = null,
  officialResumeSchemaEvidence = null, resumedForegroundChatReturn = null,
  resumedForegroundChatReturnDiagnostic = null,
  lastAcceptedOfficialResumeSchemaDiagnostic = null, extra = {} } = {}) {
  return {
    device_id: DEVICE_ID,
    display_name: "ZTE",
    enrollment_state: "ACTIVE",
    device_status: "ONLINE",
    enrolled_at: "2026-09-02T12:00:00.000Z",
    last_heartbeat_accepted_at: "2026-09-02T12:00:03.000Z",
    app_version: "1.0",
    app_build: 1,
    bridge_service_state: "RUNNING",
    tinder_state: "CONNECTED",
    automation_state: "STOPPED",
    tinder_manual_gate_capable: true,
    tinder_local_conversation_attestation_post_chat_capable: false,
    configuration_revision: 1,
    inbox_navigation: inboxNavigation,
    official_resume_handoff: officialResumeHandoff,
    tinder_official_resume_schema_evidence: officialResumeSchemaEvidence,
    last_accepted_official_resume_schema_diagnostic:
      lastAcceptedOfficialResumeSchemaDiagnostic,
    tinder_resumed_foreground_chat_return: resumedForegroundChatReturn,
    tinder_resumed_foreground_chat_return_diagnostic: resumedForegroundChatReturnDiagnostic,
    ...extra
  };
}

function schemaEvidenceCounts(fields, values = {}) {
  return Object.fromEntries(fields.map(field => [field, values[field] || 0]));
}

function schemaEvidence(overrides = {}) {
  const value = {
    evidence_version: "tinder-official-resume-schema-profile-v1",
    safety_status: "BLOCKED_UNKNOWN_STRUCTURE",
    tree_truncated: false,
    visible_node_count: 4,
    maximum_visible_depth: 3,
    class_family_counts: schemaEvidenceCounts(
      TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES,
      { TEXT_VIEW: 1, EDIT_TEXT: 1, RECYCLER_VIEW: 1, FRAME_LAYOUT: 1 }),
    view_id_state_counts: schemaEvidenceCounts(
      TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES,
      { ABSENT: 2, STATIC_TINDER_ID: 2 }),
    role_counts: schemaEvidenceCounts(
      TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS,
      { HEADER_CONTAINER: 1, MESSAGE_LIST: 1, COMPOSER_CONTAINER: 1,
        COMPOSER_EDITABLE: 1, MESSAGE_TEXT_LEAF: 1 }),
    relation_flags: {
      header_before_message_list: true,
      message_list_before_composer: true,
      message_list_has_text_leaf: true,
      composer_has_editable_leaf: true,
      has_clickable_node: true,
      has_long_clickable_node: false,
      has_scrollable_node: true,
      has_text_present_node: true,
      has_content_description_present_node: false
    }
  };
  return { ...value, ...overrides };
}

async function withEnvironment(run) {
  const originalFetch = globalThis.fetch;
  const originalPassword = process.env.DASHBOARD_PASSWORD;
  const originalUrl = process.env.RAILWAY_BACKEND_URL;
  const originalSecret = process.env.DASHBOARD_API_SECRET;
  process.env.DASHBOARD_PASSWORD = PASSWORD;
  process.env.RAILWAY_BACKEND_URL = "https://backend.example";
  process.env.DASHBOARD_API_SECRET = "server-only-secret";
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalPassword === undefined) delete process.env.DASHBOARD_PASSWORD;
    else process.env.DASHBOARD_PASSWORD = originalPassword;
    if (originalUrl === undefined) delete process.env.RAILWAY_BACKEND_URL;
    else process.env.RAILWAY_BACKEND_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.DASHBOARD_API_SECRET;
    else process.env.DASHBOARD_API_SECRET = originalSecret;
  }
}

test("unauthenticated status request is rejected", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  const res = responseRecorder();
  await handler(request({ authenticated: false }), res);
  assert.equal(res.statusCode, 401);
}));

test("valid GET calls the exact backend command-status endpoint", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return backendResponse();
  };
  const res = responseRecorder();
  await handler(request(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.command.status, "RECEIVED");
  assert.equal(call.url, `https://backend.example/dashboard-api/device-bridge/devices/${DEVICE_ID}/commands/${COMMAND_ID}`);
  assert.equal(call.options.method, "GET");
  assert.equal(call.options.headers.Authorization, "Bearer server-only-secret");
}));

test("GET without command identifiers preserves the device-list proxy", async () => withEnvironment(async () => {
  let call;
  globalThis.fetch = async (url, options) => {
    call = { url, options };
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, server_time: "2026-09-02T12:00:04.000Z", devices: [] });
      }
    };
  };
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices, []);
  assert.equal(call.url, "https://backend.example/dashboard-api/device-bridge/devices");
  assert.equal(call.options.method, "GET");
}));

test("device-list proxy allowlists the bounded inbox navigation projection", async () => withEnvironment(async () => {
  const inboxNavigation = {
    stage: "BLOCKED",
    reason: "ACCESSIBILITY_UNBOUND",
    visible_conversation_count: 0,
    observed_event_count: 3
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ inboxNavigation })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].inbox_navigation, inboxNavigation);
  assert.deepEqual(Object.keys(res.body.devices[0]).sort(), [
    "app_build", "app_version", "automation_state", "bridge_service_state", "configuration_revision",
    "device_id", "device_status", "display_name", "enrolled_at", "enrollment_state",
    "inbox_navigation", "last_accepted_official_resume_schema_diagnostic", "last_heartbeat_accepted_at", "official_resume_handoff", "tinder_local_conversation_attestation_post_chat_capable",
    "tinder_manual_gate_capable", "tinder_official_resume_schema_evidence", "tinder_resumed_foreground_chat_return",
    "tinder_resumed_foreground_chat_return_diagnostic", "tinder_state"
  ]);
}));

test("device-list proxy projects only the exact terminal discovery V16 state", async () => withEnvironment(async () => {
  const inboxNavigation = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED"
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ inboxNavigation })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].inbox_navigation, inboxNavigation);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message"
  ]) assert.equal(JSON.stringify(res.body).includes(forbidden), false);

  for (const invalid of [
    { ...inboxNavigation, discovery_v16_state: "UNBOUNDED" },
    { ...inboxNavigation, stage: "INBOX_READY", reason: "NONE" },
    { ...inboxNavigation, reason: "UNKNOWN_INBOX_STRUCTURE" }
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [deviceStatus({ inboxNavigation: invalid })]
        });
      }
    });
    const invalidRes = responseRecorder();
    await handler(req, invalidRes);
    assert.equal(invalidRes.statusCode, 200);
    assert.equal(invalidRes.body.devices[0].inbox_navigation, null);
  }
}));

test("device-list proxy projects V16 selector counters only as the exact terminal capped pair", async () => withEnvironment(async () => {
  const inboxNavigation = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 2,
    discovery_v16_qualified_selector_match_count: 1
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ inboxNavigation })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].inbox_navigation, inboxNavigation);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message", "selector_text", "selector_id"
  ]) assert.equal(JSON.stringify(res.body).includes(forbidden), false);

  for (const invalid of [
    { ...inboxNavigation, discovery_v16_raw_selector_match_count: 3 },
    { ...inboxNavigation, discovery_v16_qualified_selector_match_count: -1 },
    { ...inboxNavigation, stage: "INBOX_READY", reason: "NONE" },
    (() => {
      const { discovery_v16_raw_selector_match_count, ...withoutPair } = inboxNavigation;
      return withoutPair;
    })()
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [deviceStatus({ inboxNavigation: invalid })]
        });
      }
    });
    const invalidRes = responseRecorder();
    await handler(req, invalidRes);
    assert.equal(invalidRes.statusCode, 200);
    assert.equal(invalidRes.body.devices[0].inbox_navigation, null);
  }
}));

test("device-list proxy projects direct-static V2 only as the exact V16 terminal extension", async () => withEnvironment(async () => {
  const inboxNavigation = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 2,
    discovery_v16_qualified_selector_match_count: 0,
    direct_static_v2_state: "DIRECT_PARENT_SHAPE_REJECTED"
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ inboxNavigation })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].inbox_navigation, inboxNavigation);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message", "selector_text", "selector_id"
  ]) assert.equal(JSON.stringify(res.body).includes(forbidden), false);

  for (const invalid of [
    { ...inboxNavigation, direct_static_v2_state: "UNBOUNDED" },
    { ...inboxNavigation, stage: "INBOX_READY", reason: "NONE" },
    (() => {
      const { discovery_v16_qualified_selector_match_count, ...withoutCounter } = inboxNavigation;
      return withoutCounter;
    })()
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [deviceStatus({ inboxNavigation: invalid })]
        });
      }
    });
    const invalidRes = responseRecorder();
    await handler(req, invalidRes);
    assert.equal(invalidRes.statusCode, 200);
    assert.equal(invalidRes.body.devices[0].inbox_navigation, null);
  }
}));

test("device-list proxy projects V17 only as the exact zero-count terminal extension", async () => withEnvironment(async () => {
  const inboxNavigation = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 0,
    discovery_v16_qualified_selector_match_count: 0,
    direct_static_v2_state: "DIRECT_PARENT_SHAPE_REJECTED",
    discovery_v17_carrier_relation_state: "DIRECT_CHILD_CARDINALITY_OVER_FOUR"
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ inboxNavigation })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].inbox_navigation, inboxNavigation);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message", "selector_text", "selector_id"
  ]) assert.equal(JSON.stringify(res.body).includes(forbidden), false);

  for (const invalid of [
    { ...inboxNavigation, discovery_v17_carrier_relation_state: "UNBOUNDED" },
    { ...inboxNavigation, discovery_v16_state: "TARGET_ACTION_REJECTED" },
    { ...inboxNavigation, discovery_v16_raw_selector_match_count: 1 },
    { ...inboxNavigation, stage: "INBOX_READY", reason: "NONE" },
    (() => {
      const { direct_static_v2_state, ...withoutV2 } = inboxNavigation;
      return withoutV2;
    })()
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [deviceStatus({ inboxNavigation: invalid })]
        });
      }
    });
    const invalidRes = responseRecorder();
    await handler(req, invalidRes);
    assert.equal(invalidRes.statusCode, 200);
    assert.equal(invalidRes.body.devices[0].inbox_navigation, null);
  }
}));

test("device-list proxy projects V18 only as the exact V16 zero and V17 negative extension", async () => withEnvironment(async () => {
  const inboxNavigation = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 0,
    discovery_v16_qualified_selector_match_count: 0,
    direct_static_v2_state: "DIRECT_PARENT_SHAPE_REJECTED",
    discovery_v17_carrier_relation_state: "NO_EXACT_CARRIER_IN_FOUR_CHILD_WINDOW",
    discovery_v18_singleton_grandchild_relation_state:
      "EXACT_CARRIER_SINGLETON_GRANDCHILD"
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ inboxNavigation })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].inbox_navigation, inboxNavigation);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message", "selector_text", "selector_id"
  ]) assert.equal(JSON.stringify(res.body).includes(forbidden), false);

  for (const invalid of [
    { ...inboxNavigation, discovery_v18_singleton_grandchild_relation_state: "UNBOUNDED" },
    { ...inboxNavigation, discovery_v17_carrier_relation_state: "DIRECT_CHILD_CARDINALITY_OVER_FOUR" },
    { ...inboxNavigation, discovery_v16_qualified_selector_match_count: 1 },
    { ...inboxNavigation, stage: "INBOX_READY", reason: "NONE" },
    (() => {
      const { discovery_v17_carrier_relation_state, ...withoutV17 } = inboxNavigation;
      return withoutV17;
    })()
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [deviceStatus({ inboxNavigation: invalid })]
        });
      }
    });
    const invalidRes = responseRecorder();
    await handler(req, invalidRes);
    assert.equal(invalidRes.statusCode, 200);
    assert.equal(invalidRes.body.devices[0].inbox_navigation, null);
  }
}));

test("device-list proxy projects V19 only behind the exact V18 cardinality rejection", async () => withEnvironment(async () => {
  const inboxNavigation = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v16_state: "LABEL_MATCH_COUNT_REJECTED",
    discovery_v16_raw_selector_match_count: 0,
    discovery_v16_qualified_selector_match_count: 0,
    direct_static_v2_state: "DIRECT_PARENT_SHAPE_REJECTED",
    discovery_v17_carrier_relation_state: "NO_EXACT_CARRIER_IN_FOUR_CHILD_WINDOW",
    discovery_v18_singleton_grandchild_relation_state:
      "SINGLETON_GRANDCHILD_CARDINALITY_REJECTED",
    discovery_v19_singleton_wrapper_shape_state: "WRAPPER_EMPTY"
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ inboxNavigation })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].inbox_navigation, inboxNavigation);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message", "selector_text", "selector_id"
  ]) assert.equal(JSON.stringify(res.body).includes(forbidden), false);

  for (const invalid of [
    { ...inboxNavigation, discovery_v19_singleton_wrapper_shape_state: "UNBOUNDED" },
    { ...inboxNavigation, discovery_v18_singleton_grandchild_relation_state:
      "EXACT_CARRIER_SINGLETON_GRANDCHILD" },
    { ...inboxNavigation, discovery_v17_carrier_relation_state: "DIRECT_CHILD_CARDINALITY_OVER_FOUR" },
    { ...inboxNavigation, discovery_v16_qualified_selector_match_count: 1 },
    { ...inboxNavigation, stage: "INBOX_READY", reason: "NONE" },
    (() => {
      const { discovery_v18_singleton_grandchild_relation_state, ...withoutV18 } = inboxNavigation;
      return withoutV18;
    })()
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [deviceStatus({ inboxNavigation: invalid })]
        });
      }
    });
    const invalidRes = responseRecorder();
    await handler(req, invalidRes);
    assert.equal(invalidRes.statusCode, 200);
    assert.equal(invalidRes.body.devices[0].inbox_navigation, null);
  }
}));

test("device-list proxy projects V20 only as its independent exact base-and-counters branch", async () => withEnvironment(async () => {
  const inboxNavigation = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v20_five_structural_chat_state: "TARGET_ACTION_REJECTED",
    discovery_v20_raw_selector_match_count: 1,
    discovery_v20_qualified_selector_match_count: 1
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ inboxNavigation })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].inbox_navigation, inboxNavigation);
  for (const forbidden of [
    "raw_accessibility_tree", "message_text", "visible_name", "node_id",
    "fingerprint", "exception_message", "selector_text", "selector_id"
  ]) assert.equal(JSON.stringify(res.body).includes(forbidden), false);

  for (const invalid of [
    { ...inboxNavigation, discovery_v20_five_structural_chat_state: "UNBOUNDED" },
    { ...inboxNavigation, discovery_v20_five_structural_chat_state: "NOT_EVALUATED" },
    { ...inboxNavigation, discovery_v20_raw_selector_match_count: 3 },
    { ...inboxNavigation, discovery_v20_qualified_selector_match_count: 0 },
    { ...inboxNavigation, discovery_v19_singleton_wrapper_shape_state: "WRAPPER_EMPTY" },
    { ...inboxNavigation, observation_kind: "FRESH_REVIEWED_INBOX_V1",
      observation_nonce: "c7cb0b92-ad3c-4ec6-88dc-d149ef536c3d" },
    { ...inboxNavigation, stage: "INBOX_READY", reason: "NONE" }
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [deviceStatus({ inboxNavigation: invalid })]
        });
      }
    });
    const invalidRes = responseRecorder();
    await handler(req, invalidRes);
    assert.equal(invalidRes.statusCode, 200);
    assert.equal(invalidRes.body.devices[0].inbox_navigation, null);
  }
}));

test("device-list proxy projects V20 anchor states only with zero selector counters", async () => withEnvironment(async () => {
  const base = {
    stage: "BLOCKED",
    reason: "DISCOVERY_STRUCTURE_REJECTED",
    visible_conversation_count: 0,
    observed_event_count: 3,
    discovery_v20_raw_selector_match_count: 0,
    discovery_v20_qualified_selector_match_count: 0
  };
  const req = request();
  req.query = {};
  for (const state of [
    "ANCHOR_TRAVERSAL_INCOMPLETE",
    "ANCHOR_PARENT_ABSENT",
    "ANCHOR_STRICT_PROOF_ABSENT",
    "ANCHOR_STRICT_PROOF_AMBIGUOUS"
  ]) {
    const inboxNavigation = {
      ...base,
      discovery_v20_five_structural_chat_state: state
    };
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [deviceStatus({ inboxNavigation })]
        });
      }
    });
    const validRes = responseRecorder();
    await handler(req, validRes);
    assert.deepEqual(validRes.body.devices[0].inbox_navigation, inboxNavigation);

    const invalid = {
      ...inboxNavigation,
      discovery_v20_raw_selector_match_count: 1,
      discovery_v20_qualified_selector_match_count: 1
    };
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [deviceStatus({ inboxNavigation: invalid })]
        });
      }
    });
    const invalidRes = responseRecorder();
    await handler(req, invalidRes);
    assert.equal(invalidRes.body.devices[0].inbox_navigation, null);
  }
}));

test("device-list proxy allowlists the bounded official resume handoff projection", async () => withEnvironment(async () => {
  const officialResumeHandoff = { stage: "BLOCKED", reason: "OFFICIAL_FOREGROUND_NOT_OBSERVED" };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ officialResumeHandoff })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].official_resume_handoff, officialResumeHandoff);
  for (const forbidden of ["permit", "capture", "binding", "identity", "text", "tree", "payload"]) {
    assert.equal(JSON.stringify(res.body).includes(forbidden), false);
  }
}));

test("device-list proxy allowlists only aggregate resume schema evidence with its terminal handoff", async () => withEnvironment(async () => {
  const officialResumeHandoff = { stage: "BLOCKED", reason: "UNREVIEWED_OFFICIAL_SURFACE" };
  const officialResumeSchemaEvidence = schemaEvidence();
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ officialResumeHandoff, officialResumeSchemaEvidence })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].tinder_official_resume_schema_evidence,
    officialResumeSchemaEvidence);
  const serialized = JSON.stringify(res.body);
  for (const forbidden of ["raw_accessibility_tree", "node_shapes", "fingerprint",
    "package_name", "view_id_token", "class_name"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}));

test("device-list proxy separately allowlists only the accepted historical resume schema pair", async () => withEnvironment(async () => {
  const officialResumeHandoff = { stage: "BLOCKED", reason: "UNREVIEWED_OFFICIAL_SURFACE" };
  const historical = {
    handoff: officialResumeHandoff,
    schema_evidence: schemaEvidence()
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({
          officialResumeHandoff,
          lastAcceptedOfficialResumeSchemaDiagnostic: historical
        })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.devices[0].tinder_official_resume_schema_evidence, null);
  assert.deepEqual(res.body.devices[0].last_accepted_official_resume_schema_diagnostic,
    historical);
  const serialized = JSON.stringify(res.body.devices[0]
    .last_accepted_official_resume_schema_diagnostic);
  for (const forbidden of ["raw_accessibility_tree", "node_shapes", "fingerprint",
    "package_name", "view_id_token", "class_name", "command_id", "permit_id",
    "source_capture_id", "binding_id", "capture_id", "visible_name", "message_text"]) {
    assert.equal(serialized.includes(forbidden), false);
  }
}));

test("device-list proxy suppresses malformed or orphaned resume schema evidence", async () => withEnvironment(async () => {
  const handoff = { stage: "BLOCKED", reason: "UNREVIEWED_OFFICIAL_SURFACE" };
  for (const [officialResumeHandoff, officialResumeSchemaEvidence] of [
    [handoff, { ...schemaEvidence(), raw_accessibility_tree: "forbidden" }],
    [null, schemaEvidence()]
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [deviceStatus({ officialResumeHandoff, officialResumeSchemaEvidence })]
        });
      }
    });
    const req = request();
    req.query = {};
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.devices[0].tinder_official_resume_schema_evidence, null);
  }
}));

test("device-list proxy suppresses malformed, offline, or nonterminal historical resume schema pairs", async () => withEnvironment(async () => {
  const handoff = { stage: "BLOCKED", reason: "UNREVIEWED_OFFICIAL_SURFACE" };
  const validHistorical = { handoff, schema_evidence: schemaEvidence() };
  for (const device of [
    deviceStatus({
      officialResumeHandoff: handoff,
      lastAcceptedOfficialResumeSchemaDiagnostic: {
        handoff,
        schema_evidence: { ...schemaEvidence(), raw_accessibility_tree: "forbidden" }
      }
    }),
    deviceStatus({
      officialResumeHandoff: handoff,
      lastAcceptedOfficialResumeSchemaDiagnostic: {
        handoff: { stage: "BLOCKED", reason: "OFFICIAL_FOREGROUND_NOT_OBSERVED" },
        schema_evidence: schemaEvidence()
      }
    }),
    deviceStatus({ lastAcceptedOfficialResumeSchemaDiagnostic: validHistorical }),
    deviceStatus({
      officialResumeHandoff: handoff,
      lastAcceptedOfficialResumeSchemaDiagnostic: validHistorical,
      extra: { device_status: "OFFLINE" }
    })
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [device]
        });
      }
    });
    const req = request();
    req.query = {};
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.devices[0].last_accepted_official_resume_schema_diagnostic, null);
  }
}));

test("device-list proxy allowlists only the content-free V10 return readiness", async () => withEnvironment(async () => {
  const readiness = { ready: true };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ resumedForegroundChatReturn: readiness })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].tinder_resumed_foreground_chat_return, readiness);
  for (const forbidden of ["permit", "command", "identity", "source", "binding", "capture", "header", "text"]) {
    assert.equal(JSON.stringify(res.body).includes(forbidden), false);
  }
}));

test("device-list proxy suppresses malformed or offline V10 return readiness", async () => withEnvironment(async () => {
  for (const device of [
    deviceStatus({ resumedForegroundChatReturn: { ready: true, raw: "forbidden" } }),
    deviceStatus({ resumedForegroundChatReturn: { ready: "true" } }),
    deviceStatus({ resumedForegroundChatReturn: { ready: true }, extra: { device_status: "OFFLINE" } })
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, server_time: "2026-09-02T12:00:04.000Z", devices: [device] });
      }
    });
    const req = request();
    req.query = {};
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.devices[0].tinder_resumed_foreground_chat_return, null);
  }
}));

test("device-list proxy allowlists only the bounded V10 lifecycle diagnostic", async () => withEnvironment(async () => {
  const diagnostic = { stage: "AWAITING_FRESH_INBOX", reason: "NONE" };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ resumedForegroundChatReturnDiagnostic: diagnostic })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.devices[0].tinder_resumed_foreground_chat_return_diagnostic, diagnostic);
  for (const forbidden of ["permit", "command", "identity", "source", "binding", "capture", "header", "text"]) {
    assert.equal(JSON.stringify(res.body).includes(forbidden), false);
  }
}));

test("device-list proxy suppresses malformed or offline V10 lifecycle diagnostic", async () => withEnvironment(async () => {
  const valid = { stage: "BLOCKED", reason: "EVENT_DRIFT" };
  for (const device of [
    deviceStatus({ resumedForegroundChatReturnDiagnostic: { ...valid, raw: "forbidden" } }),
    deviceStatus({ resumedForegroundChatReturnDiagnostic: { stage: "IDLE", reason: "NONE" } }),
    deviceStatus({ resumedForegroundChatReturnDiagnostic: valid, extra: { device_status: "OFFLINE" } })
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, server_time: "2026-09-02T12:00:04.000Z", devices: [device] });
      }
    });
    const req = request();
    req.query = {};
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.devices[0].tinder_resumed_foreground_chat_return_diagnostic, null);
  }
}));

test("device-list proxy preserves only the bounded post-chat capability bit", async () => withEnvironment(async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ extra: {
          tinder_local_conversation_attestation_post_chat_capable: true,
          capabilities: ["TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_V2"]
        } })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.devices[0].tinder_local_conversation_attestation_post_chat_capable, true);
  assert.equal(JSON.stringify(res.body).includes("TINDER_LOCAL_CONVERSATION_ATTESTATION_POST_CHAT_V2"), false);
  assert.equal(JSON.stringify(res.body).includes("capabilities"), false);
}));

test("device-list proxy makes malformed inbox diagnostics unavailable and strips raw backend fields", async () => withEnvironment(async () => {
  for (const device of [
    deviceStatus({ inboxNavigation: { stage: "BLOCKED", reason: "ACCESSIBILITY_UNBOUND", visible_conversation_count: 0 } }),
    deviceStatus({ inboxNavigation: { stage: "BLOCKED", reason: "ACCESSIBILITY_UNBOUND", visible_conversation_count: 0, observed_event_count: 0, raw_tree: "forbidden" } }),
    deviceStatus({ extra: { raw_audit_details: "forbidden" } })
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [device]
        });
      }
    });
    const req = request();
    req.query = {};
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.devices[0].inbox_navigation, null);
    assert.equal(JSON.stringify(res.body).includes("raw_audit_details"), false);
  }
}));

test("device-list proxy makes malformed official resume handoff diagnostics unavailable and suppresses offline evidence", async () => withEnvironment(async () => {
  const valid = { stage: "BLOCKED", reason: "ACK_WINDOW_EXPIRED" };
  for (const device of [
    deviceStatus({ officialResumeHandoff: { stage: "IDLE", reason: "NONE" } }),
    deviceStatus({ officialResumeHandoff: { ...valid, raw_exception: "forbidden" } }),
    deviceStatus({ officialResumeHandoff: valid, extra: { device_status: "OFFLINE" } })
  ]) {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          ok: true,
          server_time: "2026-09-02T12:00:04.000Z",
          devices: [device]
        });
      }
    });
    const req = request();
    req.query = {};
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.devices[0].official_resume_handoff, null);
    assert.equal(JSON.stringify(res.body).includes("raw_exception"), false);
  }
}));

test("device-list proxy never projects inbox navigation from an offline device", async () => withEnvironment(async () => {
  const inboxNavigation = {
    stage: "BLOCKED",
    reason: "ACCESSIBILITY_UNBOUND",
    visible_conversation_count: 0,
    observed_event_count: 3
  };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify({
        ok: true,
        server_time: "2026-09-02T12:00:04.000Z",
        devices: [deviceStatus({ inboxNavigation, extra: { device_status: "OFFLINE" } })]
      });
    }
  });
  const req = request();
  req.query = {};
  const res = responseRecorder();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.devices[0].device_status, "OFFLINE");
  assert.equal(res.body.devices[0].inbox_navigation, null);
}));

test("invalid device and command identifiers are rejected before backend access", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  for (const options of [{ deviceId: "invalid" }, { commandId: "invalid" }]) {
    const res = responseRecorder();
    await handler(request(options), res);
    assert.equal(res.statusCode, 400);
  }
}));

test("backend 404 is forwarded in a controlled safe shape", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({ ok: false, status: 404 });
  const res = responseRecorder();
  await handler(request(), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, {
    ok: false,
    error: "Command was not found",
    code: "COMMAND_NOT_FOUND"
  });
}));

test("backend and network errors are controlled", async () => withEnvironment(async () => {
  globalThis.fetch = async () => backendResponse({ ok: false, status: 500 });
  const backendRes = responseRecorder();
  await handler(request(), backendRes);
  assert.equal(backendRes.statusCode, 502);

  globalThis.fetch = async () => { throw new Error("private network detail"); };
  const originalError = console.error;
  console.error = () => {};
  try {
    const networkRes = responseRecorder();
    await handler(request(), networkRes);
    assert.equal(networkRes.statusCode, 502);
    assert.equal(networkRes.body.error, "Backend ist momentan nicht erreichbar.");
  } finally {
    console.error = originalError;
  }
}));

test("unsupported method is rejected", async () => withEnvironment(async () => {
  globalThis.fetch = async () => { throw new Error("fetch must not run"); };
  const res = responseRecorder();
  await handler(request({ method: "PUT" }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.Allow, "GET, POST");
}));
