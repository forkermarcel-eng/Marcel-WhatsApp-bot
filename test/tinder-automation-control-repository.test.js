import assert from "node:assert/strict";
import test from "node:test";
import { createPgTinderAutomationControlRepository } from "../services/tinder-automation-control-repository.js";

function pool(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql: String(sql), values });
      return { rows: rows.shift() || [] };
    }
  };
}

test("T7 repository adapter exposes only the existing control-service read contract", async () => {
  const database = pool([
    [{ state: "STOPPED", operation_state: "ACTIVE", explicit_approval: false, policy_revision: null }],
    [{
      contact_id: 7,
      state: "DISABLED",
      identity_confirmed: false,
      auto_reply_enabled: false,
      human_takeover_active: null,
      handoff_active: null,
      date_lock_enabled: false,
      manual_review_required: true
    }]
  ]);
  const repository = createPgTinderAutomationControlRepository(database);
  assert.deepEqual(Object.keys(repository).sort(), ["getContactControl", "getGlobalControl"]);
  assert.deepEqual(await repository.getGlobalControl(), {
    state: "STOPPED", operation_state: "ACTIVE", explicit_approval: false, policy_revision: null
  });
  assert.deepEqual(await repository.getContactControl(7), {
    contact_id: 7,
    state: "DISABLED",
    identity_confirmed: false,
    auto_reply_enabled: false,
    human_takeover_active: null,
    handoff_active: null,
    date_lock_enabled: false,
    manual_review_required: true
  });
  assert.equal(database.calls.length, 2);
  const sql = database.calls.map(call => call.sql).join("\n");
  assert.match(sql, /FROM tinder_automation_global_control/);
  assert.match(sql, /COALESCE\(control\.state, 'DISABLED'\)/);
  assert.match(sql, /identifier_type = 'tinder_profile'/);
  assert.match(sql, /human_verified = TRUE/);
  assert.doesNotMatch(sql, /visible_messages|original_draft|approved_text|INSERT\s+INTO|UPDATE\s+|DELETE\s+|device_bridge_commands|SEND_TINDER_DRAFT/i);
  assert.deepEqual(database.calls[1].values, [7]);
});

test("T7 repository adapter rejects malformed contact IDs before any database query", async () => {
  const database = pool();
  const repository = createPgTinderAutomationControlRepository(database);
  await assert.rejects(() => repository.getContactControl(0), /positive integer/);
  await assert.rejects(() => repository.getContactControl("no"), /positive integer/);
  assert.equal(database.calls.length, 0);
});

test("T7 repository adapter requires a read-capable pool and does not create a writer seam", () => {
  assert.throws(() => createPgTinderAutomationControlRepository({}), /pool\.query/);
  const repository = createPgTinderAutomationControlRepository(pool());
  assert.equal(Object.hasOwn(repository, "withTransaction"), false);
  assert.equal(Object.hasOwn(repository, "setGlobalControl"), false);
  assert.equal(Object.hasOwn(repository, "setContactControl"), false);
  assert.equal(Object.hasOwn(repository, "insertAudit"), false);
});
