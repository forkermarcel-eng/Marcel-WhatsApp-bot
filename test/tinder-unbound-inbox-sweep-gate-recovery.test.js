import assert from "node:assert/strict";
import test from "node:test";
import {
  createPgTinderUnboundInboxSweepGateRecoveryRepository,
  createTinderUnboundInboxSweepGateRecoveryCoordinator,
  TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_AUDIT_EVENT,
  TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CREATED_BY,
  TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS
} from "../services/tinder-unbound-inbox-conversation-sweep-gate-recovery.js";
import {
  T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES
} from "../device-bridge/protocol-v1.js";

const NOW = new Date("2026-09-15T12:00:00.000Z");
const DEVICE_ID = "e880455d-325c-4f35-9914-823dcb0e0d18";
const SWEEP_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";
const CHILD_ID = "b565e8a7-ef60-42d0-b19d-26e7904390fa";
const CONNECT_ID = "c565e8a7-ef60-42d0-b19d-26e7904390fa";

function runtime(overrides = {}) {
  return {
    device_id: DEVICE_ID,
    enrollment_state: "ACTIVE",
    revoked_at: null,
    last_accepted_heartbeat_at: new Date(NOW.valueOf() - 10_000).toISOString(),
    bridge_service_state: "RUNNING",
    tinder_state: "DISCONNECTED",
    automation_state: "STOPPED",
    capabilities: T4_RESUME_ATTESTATION_POST_CHAT_UNBOUND_INBOX_SWEEP_DEVICE_CAPABILITIES,
    ...overrides
  };
}

function activeIssuedSweep(overrides = {}) {
  return {
    sweep_id: SWEEP_ID,
    device_id: DEVICE_ID,
    sweep_state: "ACTIVE",
    active_command_id: CHILD_ID,
    sweep_issued_at: new Date(NOW.valueOf() - 1_000).toISOString(),
    sweep_expires_at: new Date(NOW.valueOf() + 10 * 60_000).toISOString(),
    child_state: "ISSUED",
    child_kind: "READ",
    child_expires_at: new Date(NOW.valueOf() + 3 * 60_000).toISOString(),
    ...overrides
  };
}

function coordinatorRow(overrides = {}) {
  return {
    command_id: CONNECT_ID,
    device_id: DEVICE_ID,
    command_type: "CONNECT_TINDER",
    created_by: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CREATED_BY,
    payload: {},
    expires_at: new Date(NOW.valueOf() + 60_000).toISOString(),
    terminal_status: null,
    ...overrides
  };
}

function fixture({
  runtimeRow = runtime(),
  sweepRow = activeIssuedSweep(),
  priorRows = [],
  nonCoordinatorPending = false,
  queueResult = true
} = {}) {
  const state = {
    runtimeReads: 0,
    sweepReads: 0,
    priorReads: 0,
    priorInputs: [],
    nonCoordinatorReads: 0,
    nonCoordinatorInputs: [],
    queued: [],
    audits: []
  };
  return {
    state,
    repository: {
      async getDeviceRuntimeForUpdate() { state.runtimeReads += 1; return runtimeRow; },
      async getActiveIssuedUnboundInboxSweepForDeviceForUpdate() { state.sweepReads += 1; return sweepRow; },
      async findCoordinatorConnectRowsForSweep(_transaction, input) {
        state.priorReads += 1;
        state.priorInputs.push(input);
        return priorRows;
      },
      async findNonCoordinatorPendingConnectForDevice(_transaction, input) {
        state.nonCoordinatorReads += 1;
        state.nonCoordinatorInputs.push(input);
        return nonCoordinatorPending;
      },
      async queueCoordinatorConnect(_transaction, input) { state.queued.push(input); return queueResult; },
      async appendCoordinatorConnectAudit(_transaction, audit) { state.audits.push(audit); }
    }
  };
}

function coordinator(repository) {
  return createTinderUnboundInboxSweepGateRecoveryCoordinator(repository, {
    now: () => NOW,
    createCommandId: () => CONNECT_ID
  });
}

test("active V8 issued child with a disconnected safe runtime queues one exact-empty CONNECT and audit", async () => {
  const { repository, state } = fixture();
  const result = await coordinator(repository).coordinateExistingActiveSweep({}, {
    deviceId: DEVICE_ID, mayIssue: true
  });

  assert.deepEqual(result, {
    status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.PENDING,
    commandId: CONNECT_ID
  });
  assert.equal(state.runtimeReads, 1);
  assert.equal(state.sweepReads, 1);
  assert.equal(state.priorReads, 1);
  assert.deepEqual(state.priorInputs, [{
    deviceId: DEVICE_ID,
    sweepId: SWEEP_ID,
    sweepIssuedAt: new Date(NOW.valueOf() - 1_000).toISOString(),
    sweepExpiresAt: new Date(NOW.valueOf() + 10 * 60_000).toISOString()
  }]);
  assert.equal(state.nonCoordinatorReads, 1);
  assert.deepEqual(state.nonCoordinatorInputs, [{
    deviceId: DEVICE_ID,
    now: NOW.toISOString(),
    sweepId: SWEEP_ID
  }]);
  assert.deepEqual(state.queued, [{
    commandId: CONNECT_ID,
    deviceId: DEVICE_ID,
    sweepId: SWEEP_ID,
    activeCommandId: CHILD_ID,
    commandType: "CONNECT_TINDER",
    payload: {},
    // The coordinator must never outlive the active V8 child even though its
    // inherited T1 maximum is longer.
    expiresAt: new Date(NOW.valueOf() + 3 * 60_000).toISOString()
  }]);
  assert.deepEqual(state.audits, [{ commandId: CONNECT_ID, deviceId: DEVICE_ID, sweepId: SWEEP_ID }]);
});

test("the current locked parent supplies the exact app-layer provenance; no different parent is reused", async () => {
  const currentSweepId = "d565e8a7-ef60-42d0-b19d-26e7904390fa";
  const { repository, state } = fixture({
    sweepRow: activeIssuedSweep({ sweep_id: currentSweepId })
  });
  const result = await coordinator(repository).coordinateExistingActiveSweep({}, {
    deviceId: DEVICE_ID, mayIssue: true
  });

  assert.deepEqual(result, {
    status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.PENDING,
    commandId: CONNECT_ID
  });
  assert.equal(state.priorInputs[0].sweepId, currentSweepId);
  assert.equal(state.queued[0].sweepId, currentSweepId);
  assert.equal(state.audits[0].sweepId, currentSweepId);
});

test("any prior coordinator record for the exact active sweep prevents replacement or replay", async () => {
  for (const priorRows of [
    [coordinatorRow()],
    [coordinatorRow({ terminal_status: "FAILED" })],
    [coordinatorRow({ expires_at: new Date(NOW.valueOf() - 1).toISOString() })],
    [coordinatorRow(), coordinatorRow({ command_id: "d565e8a7-ef60-42d0-b19d-26e7904390fa" })],
    [{ command_id: null, device_id: DEVICE_ID, command_type: "CONNECT_TINDER", payload: {}, terminal_status: null }]
  ]) {
    const { repository, state } = fixture({ priorRows });
    const result = await coordinator(repository).coordinateExistingActiveSweep({}, {
      deviceId: DEVICE_ID, mayIssue: true
    });
    if (priorRows.length === 1 && priorRows[0].command_id === CONNECT_ID && priorRows[0].terminal_status === null
        && new Date(priorRows[0].expires_at).valueOf() > NOW.valueOf()) {
      assert.deepEqual(result, {
        status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.PENDING,
        commandId: CONNECT_ID
      });
    } else {
      assert.deepEqual(result, { status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.BLOCKED });
    }
    assert.equal(state.queued.length, 0);
    assert.equal(state.audits.length, 0);
  }
});

test("the coordinator stays inert outside its live V8/disconnected runtime contract", async () => {
  const cases = [
    { runtimeRow: runtime({ tinder_state: "CONNECTED" }) },
    { runtimeRow: runtime({ bridge_service_state: "STOPPED" }) },
    { runtimeRow: runtime({ last_accepted_heartbeat_at: new Date(NOW.valueOf() - 91_000).toISOString() }) },
    { runtimeRow: runtime({ capabilities: [] }) },
    { sweepRow: activeIssuedSweep({ sweep_expires_at: new Date(NOW.valueOf() - 1).toISOString() }) },
    { sweepRow: activeIssuedSweep({ child_state: "STAGED" }) },
    { sweepRow: null }
  ];
  for (const options of cases) {
    const { repository, state } = fixture(options);
    const result = await coordinator(repository).coordinateExistingActiveSweep({}, {
      deviceId: DEVICE_ID, mayIssue: true
    });
    assert.deepEqual(result, { status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.NOT_APPLICABLE });
    assert.equal(state.queued.length, 0);
    assert.equal(state.audits.length, 0);
  }
});

test("idempotent heartbeats and unrelated pending T1 CONNECTs fail closed without minting coordinator authority", async () => {
  for (const options of [
    { input: { deviceId: DEVICE_ID, mayIssue: false } },
    { nonCoordinatorPending: true, input: { deviceId: DEVICE_ID, mayIssue: true } },
    { queueResult: false, input: { deviceId: DEVICE_ID, mayIssue: true } }
  ]) {
    const { repository, state } = fixture(options);
    const result = await coordinator(repository).coordinateExistingActiveSweep({}, options.input);
    assert.deepEqual(result, { status: TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_STATUS.BLOCKED });
    assert.equal(state.audits.length, 0);
  }
});

test("coordinator constants remain exact and contain no new command type or payload authority", () => {
  assert.equal(TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_AUDIT_EVENT,
    "TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CONNECT_CREATED");
  assert.equal(TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CREATED_BY,
    "server_tinder_unbound_inbox_sweep_gate_recovery");
});

test("PostgreSQL adapter binds the audit lookup and guarded insert to the same parent and child", async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("RETURNING command_id")) return { rows: [{ command_id: CONNECT_ID }] };
      return { rows: [] };
    }
  };
  const repository = createPgTinderUnboundInboxSweepGateRecoveryRepository({
    async connect() {}, async query() {}
  });
  await repository.getDeviceRuntimeForUpdate(client, { deviceId: DEVICE_ID });
  await repository.getActiveIssuedUnboundInboxSweepForDeviceForUpdate(client, {
    deviceId: DEVICE_ID, now: NOW.toISOString()
  });
  await repository.findCoordinatorConnectRowsForSweep(client, {
    deviceId: DEVICE_ID,
    sweepId: SWEEP_ID,
    sweepIssuedAt: new Date(NOW.valueOf() - 1_000).toISOString(),
    sweepExpiresAt: new Date(NOW.valueOf() + 10 * 60_000).toISOString()
  });
  await repository.findNonCoordinatorPendingConnectForDevice(client, {
    deviceId: DEVICE_ID,
    now: NOW.toISOString(),
    sweepId: SWEEP_ID
  });
  await repository.queueCoordinatorConnect(client, {
    commandId: CONNECT_ID,
    deviceId: DEVICE_ID,
    sweepId: SWEEP_ID,
    activeCommandId: CHILD_ID,
    expiresAt: new Date(NOW.valueOf() + 60_000).toISOString(),
    commandType: "CONNECT_TINDER",
    payload: {}
  });

  const lockedRuntime = calls.find(call => call.sql.includes("last_accepted_heartbeat_at"));
  assert.match(lockedRuntime.sql, /FOR UPDATE/);
  const lockedParent = calls.find(call => call.sql.includes("FOR UPDATE OF sweep, step, child_command"));
  assert.match(lockedParent.sql, /sweep\.sweep_state='ACTIVE'/);
  assert.match(lockedParent.sql, /step\.child_state='ISSUED'/);
  assert.match(lockedParent.sql, /JOIN device_bridge_commands child_command/);
  assert.match(lockedParent.sql, /child_command\.terminal_status IS NULL/);
  assert.match(lockedParent.sql, /child_command\.payload='\{\}'::jsonb/);
  const provenanceRead = calls.find(call => call.sql.includes("audit.details=jsonb_build_object"));
  assert.match(provenanceRead.sql, /audit\.details=jsonb_build_object\('sweep_id',\$3::text\)/);
  assert.match(provenanceRead.sql, /command\.created_by=\$4/);
  assert.equal(provenanceRead.params[2], SWEEP_ID);
  const unrelatedConnectRead = calls.find(call => call.sql.includes("command.created_by=$4")
    && call.sql.includes("command.command_type='CONNECT_TINDER'"));
  assert.match(unrelatedConnectRead.sql, /audit\.details=jsonb_build_object\('sweep_id',\$5::text\)/);
  assert.equal(unrelatedConnectRead.params[2], TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_AUDIT_EVENT);
  assert.equal(unrelatedConnectRead.params[3], TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CREATED_BY);
  assert.equal(unrelatedConnectRead.params[4], SWEEP_ID);
  const guardedInsert = calls.find(call => call.sql.includes("LEAST\(\$4::timestamptz"));
  assert.match(guardedInsert.sql, /sweep\.sweep_id=\$3/);
  assert.match(guardedInsert.sql, /step\.command_id=\$6/);
  assert.match(guardedInsert.sql, /JOIN device_bridge_commands child_command/);
  assert.match(guardedInsert.sql, /child_command\.terminal_status IS NULL/);
  assert.match(guardedInsert.sql, /child_command\.payload='\{\}'::jsonb/);
  assert.match(guardedInsert.sql, /child_command\.expires_at>NOW\(\)/);
  assert.equal(guardedInsert.params[2], SWEEP_ID);
  assert.equal(guardedInsert.params[5], CHILD_ID);
  assert.equal(guardedInsert.params[4], TINDER_UNBOUND_INBOX_SWEEP_GATE_RECOVERY_CREATED_BY);
});
