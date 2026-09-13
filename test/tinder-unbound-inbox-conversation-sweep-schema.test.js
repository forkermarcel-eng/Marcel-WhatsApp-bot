import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertTinderUnboundInboxConversationSweepMigrationSource
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-migration.js";
import {
  assertTinderUnboundInboxConversationSweepTriggerRepairMigrationSource
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-trigger-repair-migration.js";
import {
  classifyTinderUnboundInboxConversationSweepTriggerContract,
  preflightTinderUnboundInboxConversationSweepMigration,
  preflightTinderUnboundInboxConversationSweepTriggerRepair,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CONSTRAINT_CONTRACT,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_BODY,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_LEGACY_IMMUTABLE_GUARD_BODY,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRIGGER_CONTRACT,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-schema.js";
import { canonicalCheckDefinition } from "../device-bridge/schema-contract.js";
import {
  TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE_CONSTRAINT_NAME
} from "../device-bridge/t1-schema.js";
import {
  TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE
} from "../device-bridge/tinder-local-conversation-attestation-schema.js";

function canonicalV6() {
  return { state: TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.CANONICAL };
}

function bridgeV6() {
  return {
    ready: true,
    constraints: [{
      specification: { table: "device_bridge_commands", column: "command_type" },
      constraintName: TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE_CONSTRAINT_NAME
    }]
  };
}

function triggerCatalog(immutableSource = TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_BODY) {
  return TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRIGGER_CONTRACT.map(expected => ({
    trigger_name: expected.name,
    relation_name: expected.table,
    enabled: "O",
    function_name: expected.functionName,
    deferrable: expected.deferrable,
    initially_deferred: expected.initiallyDeferred,
    trigger_definition: expected.definition,
    function_source: expected.functionName === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION
      ? immutableSource
      : expected.source
  }));
}

function singleFlightCatalogClient() {
  let active = 0;
  let maxActive = 0;
  return {
    get maxActive() { return maxActive; },
    async query() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= 1;
      return { rows: [] };
    }
  };
}

test("V8 preflight accepts only the exact V6 predecessor with an absent V8 catalog and stays catalog-read-only", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      return { rows: [] };
    }
  };
  const checked = await preflightTinderUnboundInboxConversationSweepMigration(client, {
    inspectV6Schema: async () => canonicalV6(),
    inspectDeviceBridgeSchema: async () => bridgeV6()
  });
  assert.deepEqual(checked, {
    foundation: { state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.UPGRADE_REQUIRED },
    mutate: true
  });
  for (const sql of queries) {
    assert.match(sql, /^\s*SELECT/i);
    assert.doesNotMatch(sql, /\b(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i);
  }
  const indexRead = queries.find(sql => sql.includes("FROM pg_index"));
  assert.match(indexRead, /relation\.relname=ANY\(\$1\)/);
  assert.match(indexRead, /NOT EXISTS \(SELECT 1 FROM pg_constraint constraint_index WHERE constraint_index\.conindid=i\.indexrelid\)/);
  assert.doesNotMatch(indexRead, /idx\.relname=ANY\(\$1\)/);
});

test("V8 catalog inspection keeps one pg client query in flight", async () => {
  const client = singleFlightCatalogClient();
  const checked = await preflightTinderUnboundInboxConversationSweepMigration(client, {
    inspectV6Schema: async () => canonicalV6(),
    inspectDeviceBridgeSchema: async () => bridgeV6()
  });
  assert.deepEqual(checked, {
    foundation: { state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.UPGRADE_REQUIRED },
    mutate: true
  });
  assert.equal(client.maxActive, 1);
});

test("V8 distinguishes only the exact legacy immutable trigger from canonical or other drift", () => {
  assert.equal(
    classifyTinderUnboundInboxConversationSweepTriggerContract(triggerCatalog()),
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL
  );
  assert.equal(
    classifyTinderUnboundInboxConversationSweepTriggerContract(triggerCatalog(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_LEGACY_IMMUTABLE_GUARD_BODY)),
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.TRIGGER_REPAIR_REQUIRED
  );

  const mixed = triggerCatalog();
  mixed[0].function_source = TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_LEGACY_IMMUTABLE_GUARD_BODY;
  assert.equal(
    classifyTinderUnboundInboxConversationSweepTriggerContract(mixed),
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID
  );

  const changed = triggerCatalog();
  changed[0].trigger_definition = `${changed[0].trigger_definition} -- drift`;
  assert.equal(
    classifyTinderUnboundInboxConversationSweepTriggerContract(changed),
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID
  );
});

test("V8 base migration rejects the historical trigger while the repair preflight is exact and read-only", async () => {
  const legacyInspection = async () => ({
    state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.TRIGGER_REPAIR_REQUIRED
  });
  await assert.rejects(
    preflightTinderUnboundInboxConversationSweepMigration({}, { inspectSchema: legacyInspection }),
    /schema is incompatible/i
  );
  assert.deepEqual(
    await preflightTinderUnboundInboxConversationSweepTriggerRepair({}, { inspectSchema: legacyInspection }),
    {
      foundation: { state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.TRIGGER_REPAIR_REQUIRED },
      mutate: true
    }
  );
  assert.deepEqual(
    await preflightTinderUnboundInboxConversationSweepTriggerRepair({}, {
      inspectSchema: async () => ({ state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL })
    }),
    {
      foundation: { state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL },
      mutate: false
    }
  );
});

test("fixed V8 DDL is exact, separate from V1-V6 identity contracts, and makes RETURNED a separately recorded receipt state", () => {
  const source = readFileSync(
    new URL("../migrations/20260912_tinder_unbound_inbox_conversation_sweep_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.doesNotThrow(() => assertTinderUnboundInboxConversationSweepMigrationSource(source));
  assert.match(source, /DROP CONSTRAINT device_bridge_commands_command_type_check_v6/i);
  assert.match(source, /ADD CONSTRAINT device_bridge_commands_command_type_check_v8/i);
  assert.match(source, /READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT/i);
  assert.match(source, /RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT/i);
  assert.match(source, /max_slots = 8/i);
  assert.match(source, /expires_at <= issued_at \+ INTERVAL '3 minutes'/i);
  assert.match(source, /expires_at <= issued_at \+ INTERVAL '90 seconds'/i);
  assert.match(source, /RETURN_STAGED/i);
  assert.match(source, /RETURN_ACCEPTED/i);
  assert.match(source, /CHILD_EXPIRED/i);
  assert.match(source, /'CHILD_EXPIRED'\)\) = \(command_id IS NOT NULL AND slot_ordinal IS NOT NULL\)/i);
  assert.match(source, /tinder-unbound-inbox-conversation-sweep-transcript-v1/i);
  assert.match(source, /mapping_status = 'NEEDS_HUMAN_MAPPING'/i);
  assert.match(source, /human_review_status = 'PENDING'/i);
  assert.match(source, /UNIQUE \(sweep_id, device_id\)/i);
  assert.match(source, /FOREIGN KEY \(sweep_id, device_id\)\s+REFERENCES tinder_unbound_inbox_conversation_sweeps\(sweep_id, device_id\)/i);
  assert.match(source, /ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_steps_transcript_scope\s+FOREIGN KEY \(transcript_id, command_id, sweep_id, device_id\)\s+REFERENCES tinder_unbound_inbox_conversation_sweep_transcripts\(transcript_id, command_id, sweep_id, device_id\)/i);
  assert.match(source, /FOREIGN KEY \(command_id, sweep_id, device_id\)\s+REFERENCES tinder_unbound_inbox_conversation_sweep_steps\(command_id, sweep_id, device_id\)/i);
  assert.match(source, /ADD CONSTRAINT tinder_unbound_inbox_sweep_audit_transcript_scope_fkey\s+FOREIGN KEY \(transcript_id, command_id, sweep_id, device_id\)\s+REFERENCES tinder_unbound_inbox_conversation_sweep_transcripts\(transcript_id, command_id, sweep_id, device_id\)/i);
  assert.match(source, /CREATE CONSTRAINT TRIGGER tinder_unbound_inbox_conversation_sweep_active_child_scope/i);
  assert.match(source, /CREATE CONSTRAINT TRIGGER tinder_unbound_inbox_conversation_sweep_step_active_child_scope\s+AFTER INSERT OR DELETE OR UPDATE ON tinder_unbound_inbox_conversation_sweep_steps\s+DEFERRABLE INITIALLY DEFERRED/i);
  assert.match(source, /IF TG_TABLE_NAME = 'tinder_unbound_inbox_conversation_sweeps' THEN[\s\S]{0,300}NEW\.inbox_observation_nonce/i);
  assert.match(source, /ELSIF TG_TABLE_NAME = 'tinder_unbound_inbox_conversation_sweep_steps' THEN[\s\S]{0,300}OLD\.child_state/i);
  assert.doesNotMatch(source, /IF TG_OP <> 'DELETE'\s+AND TG_TABLE_NAME\s*=\s*'tinder_unbound_inbox_conversation_sweeps'\s+AND NEW\.inbox_observation_nonce/i);
  assert.match(source, /WHERE step\.command_id = parent\.active_command_id[\s\S]{0,320}AND step\.child_state IN \('ISSUED', 'STAGED', 'RETURN_STAGED'\)/i);
  assert.match(source, /CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_audit_scope/i);
  assert.match(source, /step\.slot_ordinal = NEW\.slot_ordinal/i);
  assert.doesNotMatch(source, /READ_TINDER_UNBOUND_INBOX_CONVERSATION(?!_SWEEP_SLOT)/i);
  assert.doesNotMatch(source, /(?:_v7|\bV7\b|unbound_inbox_conversation_read)/i);
  assert.doesNotMatch(source, /(?:source_capture_id|capture_id|binding_id|binding_revision|resolved_contact_id|visible_name|thread_fingerprint|runtime_thread_fingerprint|accessibility_id)/i);
  assert.throws(() => assertTinderUnboundInboxConversationSweepMigrationSource(
    `${source}\nALTER TABLE contacts ADD COLUMN forbidden text;`
  ));
});

test("V8 base and repair SQL carry the exact same corrected immutable guard body", () => {
  const baseSource = readFileSync(
    new URL("../migrations/20260912_tinder_unbound_inbox_conversation_sweep_foundation.sql", import.meta.url),
    "utf8"
  );
  const repairSource = readFileSync(
    new URL("../migrations/20260913_tinder_unbound_inbox_conversation_sweep_trigger_repair.sql", import.meta.url),
    "utf8"
  );
  assert.doesNotThrow(() => assertTinderUnboundInboxConversationSweepTriggerRepairMigrationSource(repairSource));
  const bodyOf = source => source.match(/AS \$guard\$\s*([\s\S]*?)\$guard\$/)?.[1]?.replace(/\s+/g, " ").trim();
  const expected = TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_BODY.replace(/\s+/g, " ").trim();
  assert.equal(bodyOf(baseSource), expected);
  assert.equal(bodyOf(repairSource), expected);
  assert.equal((repairSource.match(/CREATE OR REPLACE FUNCTION/gi) || []).length, 1);
  assert.doesNotMatch(repairSource, /^\s*(?:CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+TRIGGER|DROP\s+CONSTRAINT|INSERT\s+INTO)/im);
});

test("every explicitly named V8 catalog object fits PostgreSQL's 63-byte identifier limit", () => {
  const source = readFileSync(
    new URL("../migrations/20260912_tinder_unbound_inbox_conversation_sweep_foundation.sql", import.meta.url),
    "utf8"
  );
  const identifiers = [
    ...source.matchAll(/(?:CREATE\s+(?:UNIQUE\s+)?INDEX|CREATE\s+FUNCTION|CREATE\s+(?:CONSTRAINT\s+)?TRIGGER|ADD\s+CONSTRAINT)\s+([a-z_][a-z0-9_]*)/gi)
  ].map(match => match[1]);
  assert.ok(identifiers.length > 0);
  for (const identifier of identifiers) {
    assert.ok(Buffer.byteLength(identifier, "utf8") <= 63, identifier);
  }
});

test("V8 postcheck recognizes PostgreSQL's fixed catalog rendering without weakening checks", () => {
  const contractChecks = new Set(
    TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CONSTRAINT_CONTRACT
      .filter(contract => contract.type === "c")
      .flatMap(contract => contract.definitions)
  );
  for (const catalogDefinition of [
    "CHECK ((next_slot >= 1) AND (next_slot <= 9))",
    "CHECK (expires_at <= (issued_at + '00:30:00'::interval))",
    "CHECK (slot_ordinal >= 1 AND slot_ordinal <= 8)",
    "CHECK (accepted_at IS NULL OR staged_at IS NULL OR accepted_at >= staged_at)",
    "CHECK (initial_visible_node_count >= 1 AND initial_visible_node_count <= 5000)",
    "CHECK (sync_completed_at <= (sync_started_at + '00:01:30'::interval))",
    "CHECK ((action = ANY (ARRAY['READ_ISSUED'::text, 'READ_STAGED'::text, 'READ_TRANSCRIPT_ACCEPTED'::text, 'RETURN_ISSUED'::text, 'RETURN_STAGED'::text, 'RETURN_ACCEPTED'::text, 'SWEEP_STOPPED'::text, 'CHILD_EXPIRED'::text])) = (command_id IS NOT NULL AND slot_ordinal IS NOT NULL))"
  ]) {
    assert.equal(contractChecks.has(canonicalCheckDefinition(catalogDefinition)), true, catalogDefinition);
  }
  assert.equal(
    contractChecks.has(canonicalCheckDefinition("next_slot BETWEEN 1 AND 9")),
    false,
    "the inspector must compare PostgreSQL catalog form, never broaden semantic acceptance"
  );
});
