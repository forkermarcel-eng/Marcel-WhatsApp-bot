import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertTinderUnboundInboxConversationSweepMigrationSource
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-migration.js";
import {
  preflightTinderUnboundInboxConversationSweepMigration,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE
} from "../device-bridge/tinder-unbound-inbox-conversation-sweep-schema.js";
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
  assert.match(source, /ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_audit_transcript_scope_fkey\s+FOREIGN KEY \(transcript_id, command_id, sweep_id, device_id\)\s+REFERENCES tinder_unbound_inbox_conversation_sweep_transcripts\(transcript_id, command_id, sweep_id, device_id\)/i);
  assert.match(source, /CREATE CONSTRAINT TRIGGER tinder_unbound_inbox_conversation_sweep_active_child_scope/i);
  assert.match(source, /CREATE CONSTRAINT TRIGGER tinder_unbound_inbox_conversation_sweep_step_active_child_scope\s+AFTER INSERT OR DELETE OR UPDATE ON tinder_unbound_inbox_conversation_sweep_steps\s+DEFERRABLE INITIALLY DEFERRED/i);
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
