import {
  canonicalTinderFoundationDefault,
  hasExpectedTinderFoundationConstraints,
  matchesTinderFoundationDefault,
  readTinderFoundationConstraints,
  TINDER_FOUNDATION_DEFAULT,
  tinderFoundationCheck,
  tinderFoundationKey
} from "./tinder-foundation-constraint-contract.js";
import { canonicalSchemaPredicate } from "./schema-contract.js";
import {
  inspectDeviceBridgeT1Schema,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE_CONSTRAINT_NAME,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_TYPE_CONSTRAINT_NAME
} from "./t1-schema.js";
import {
  inspectTinderLocalConversationAttestationSchema,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE
} from "./tinder-local-conversation-attestation-schema.js";

/* ==================================================
UNBOUND INBOX-CONVERSATION SWEEP -- V8 SCHEMA

This read-only inspector recognizes only the exact additive V8 parent/child
foundation directly over canonical V6. It does not create, repair, migrate,
lock, select a row, or touch V1--V4 capture data.
================================================== */

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE = Object.freeze({
  UPGRADE_REQUIRED: "UPGRADE_REQUIRED",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE =
  "tinder_unbound_inbox_conversation_sweeps";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE =
  "tinder_unbound_inbox_conversation_sweep_steps";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE =
  "tinder_unbound_inbox_conversation_sweep_transcripts";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE =
  "tinder_unbound_inbox_conversation_sweep_audit";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION =
  "tinder_unbound_inbox_conversation_sweep_immutable_terminal_guard";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE_CHILD_GUARD_FUNCTION =
  "tinder_unbound_inbox_conversation_sweep_active_child_guard";
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_SCOPE_GUARD_FUNCTION =
  "tinder_unbound_inbox_conversation_sweep_audit_scope_guard";

const TARGET_RELATIONS = Object.freeze([
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE
]);
const TARGET_INDEX_NAMES = Object.freeze([
  "idx_tinder_unbound_inbox_conversation_sweep_active_device",
  "idx_tinder_unbound_inbox_conversation_sweep_device_expiry",
  "idx_tinder_unbound_inbox_conversation_sweep_active_child_device",
  "idx_tinder_unbound_inbox_conversation_sweep_steps_sweep_slot",
  "idx_tinder_unbound_inbox_conversation_sweep_steps_device_expiry",
  "idx_tinder_unbound_inbox_conversation_sweep_transcript_device_received",
  "idx_tinder_unbound_inbox_conversation_sweep_transcript_pending_received",
  "idx_tinder_unbound_inbox_conversation_sweep_audit_sweep_created",
  "idx_tinder_unbound_inbox_conversation_sweep_audit_command_created"
]);
const TARGET_TRIGGER_NAMES = Object.freeze([
  "tinder_unbound_inbox_conversation_sweep_terminal_immutable",
  "tinder_unbound_inbox_conversation_sweep_step_terminal_immutable",
  "tinder_unbound_inbox_conversation_sweep_transcript_immutable",
  "tinder_unbound_inbox_conversation_sweep_audit_immutable",
  "tinder_unbound_inbox_conversation_sweep_active_child_scope",
  "tinder_unbound_inbox_conversation_sweep_step_active_child_scope",
  "tinder_unbound_inbox_conversation_sweep_audit_scope"
]);

const SWEEP_COLUMNS = Object.freeze({
  sweep_id: ["uuid", true], device_id: ["uuid", true], sweep_contract_version: ["smallint", true],
  inbox_heartbeat_sequence: ["bigint", true], inbox_observation_nonce: ["uuid", true],
  sweep_state: ["text", true], max_slots: ["smallint", true],
  next_slot: ["smallint", true], active_command_id: ["uuid", false], issued_at: ["timestamp with time zone", true],
  expires_at: ["timestamp with time zone", true], closed_at: ["timestamp with time zone", false],
  terminal_reason: ["text", false], created_at: ["timestamp with time zone", true], updated_at: ["timestamp with time zone", true]
});
const STEP_COLUMNS = Object.freeze({
  command_id: ["uuid", true], sweep_id: ["uuid", true], device_id: ["uuid", true],
  step_contract_version: ["smallint", true], slot_ordinal: ["smallint", true], child_kind: ["text", true],
  child_state: ["text", true], transcript_id: ["uuid", false], issued_at: ["timestamp with time zone", true],
  expires_at: ["timestamp with time zone", true], staged_at: ["timestamp with time zone", false],
  accepted_at: ["timestamp with time zone", false], closed_at: ["timestamp with time zone", false],
  terminal_reason: ["text", false], created_at: ["timestamp with time zone", true], updated_at: ["timestamp with time zone", true]
});
const TRANSCRIPT_COLUMNS = Object.freeze({
  transcript_id: ["uuid", true], command_id: ["uuid", true], sweep_id: ["uuid", true], device_id: ["uuid", true],
  transcript_contract_version: ["smallint", true], transcript_schema_version: ["text", true], source_platform: ["text", true],
  source_package: ["text", true], layout_schema_version: ["text", true], sync_started_at: ["timestamp with time zone", true],
  sync_completed_at: ["timestamp with time zone", true], initial_visible_node_count: ["integer", true],
  final_visible_node_count: ["integer", true], segment_count: ["integer", true], overlap_count: ["integer", true],
  transcript_fingerprint: ["character(64)", true], visible_messages: ["jsonb", true], transcript_safety_status: ["text", true],
  mapping_status: ["text", true], human_review_status: ["text", true], received_at: ["timestamp with time zone", true],
  created_at: ["timestamp with time zone", true]
});
const AUDIT_COLUMNS = Object.freeze({
  audit_id: ["uuid", true], sweep_id: ["uuid", true], command_id: ["uuid", false], device_id: ["uuid", true],
  slot_ordinal: ["smallint", false], transcript_id: ["uuid", false], action: ["text", true], reason_code: ["text", false],
  actor: ["text", true], source: ["text", true], details: ["jsonb", true], created_at: ["timestamp with time zone", true]
});

const SWEEP_DEFAULTS = Object.freeze({
  sweep_state: "'ACTIVE'", issued_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW, updated_at: TINDER_FOUNDATION_DEFAULT.NOW
});
const STEP_DEFAULTS = Object.freeze({
  child_state: "'ISSUED'", issued_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW, updated_at: TINDER_FOUNDATION_DEFAULT.NOW
});
const TRANSCRIPT_DEFAULTS = Object.freeze({
  source_platform: "'tinder'", mapping_status: "'NEEDS_HUMAN_MAPPING'",
  human_review_status: "'PENDING'", created_at: TINDER_FOUNDATION_DEFAULT.NOW
});
const AUDIT_DEFAULTS = Object.freeze({
  details: TINDER_FOUNDATION_DEFAULT.EMPTY_JSON_OBJECT, created_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const SWEEP_LIFECYCLE_CHECK = `
  (sweep_state = 'ACTIVE'
    AND active_command_id IS NOT NULL AND next_slot BETWEEN 1 AND max_slots
    AND closed_at IS NULL AND terminal_reason IS NULL)
  OR
  (sweep_state = 'COMPLETED'
    AND active_command_id IS NULL AND next_slot = max_slots + 1
    AND closed_at IS NOT NULL AND terminal_reason = 'SLOTS_EXHAUSTED')
  OR
  (sweep_state = 'STOPPED'
    AND active_command_id IS NULL AND closed_at IS NOT NULL
    AND terminal_reason IN ('THREAD_DRIFT', 'COMMAND_REJECTED', 'RUNTIME_GATE_LOST', 'CHILD_EXPIRED', 'UNKNOWN_OUTCOME'))
  OR
  (sweep_state = 'EXPIRED'
    AND active_command_id IS NULL AND closed_at IS NOT NULL
    AND terminal_reason = 'SWEEP_EXPIRED')
`;
const STEP_LIFECYCLE_CHECK = `
  (child_kind = 'READ' AND child_state = 'ISSUED'
    AND transcript_id IS NULL AND staged_at IS NULL AND accepted_at IS NULL
    AND closed_at IS NULL AND terminal_reason IS NULL)
  OR
  (child_kind = 'READ' AND child_state = 'STAGED'
    AND transcript_id IS NULL AND staged_at IS NOT NULL AND accepted_at IS NULL
    AND closed_at IS NULL AND terminal_reason IS NULL)
  OR
  (child_kind = 'READ' AND child_state = 'TRANSCRIPT_ACCEPTED'
    AND transcript_id IS NOT NULL AND staged_at IS NOT NULL AND accepted_at IS NOT NULL
    AND closed_at = accepted_at AND terminal_reason = 'TRANSCRIPT_ACCEPTED')
  OR
  (child_kind = 'RETURN_ONLY' AND child_state = 'ISSUED'
    AND transcript_id IS NULL AND staged_at IS NULL AND accepted_at IS NULL
    AND closed_at IS NULL AND terminal_reason IS NULL)
  OR
  (child_kind = 'RETURN_ONLY' AND child_state = 'RETURN_STAGED'
    AND transcript_id IS NULL AND staged_at IS NOT NULL AND accepted_at IS NULL
    AND closed_at IS NULL AND terminal_reason IS NULL)
  OR
  (child_kind = 'RETURN_ONLY' AND child_state = 'RETURN_ACCEPTED'
    AND transcript_id IS NULL AND staged_at IS NOT NULL AND accepted_at IS NOT NULL
    AND closed_at = accepted_at AND terminal_reason = 'RETURNED')
  OR
  (child_state = 'EXPIRED'
    AND transcript_id IS NULL AND accepted_at IS NULL AND closed_at IS NOT NULL
    AND terminal_reason = 'CHILD_EXPIRED')
  OR
  (child_state = 'CANCELLED'
    AND transcript_id IS NULL AND accepted_at IS NULL AND closed_at IS NOT NULL
    AND terminal_reason IN ('THREAD_DRIFT', 'COMMAND_REJECTED', 'RUNTIME_GATE_LOST', 'UNKNOWN_OUTCOME'))
`;
const AUDIT_REASON_CHECK = `
  (action IN ('SWEEP_ISSUED', 'READ_ISSUED', 'READ_STAGED', 'READ_TRANSCRIPT_ACCEPTED', 'RETURN_ISSUED', 'RETURN_STAGED', 'RETURN_ACCEPTED', 'SWEEP_COMPLETED') AND reason_code IS NULL)
  OR (action = 'SWEEP_STOPPED' AND reason_code IN ('THREAD_DRIFT', 'COMMAND_REJECTED', 'RUNTIME_GATE_LOST', 'CHILD_EXPIRED', 'UNKNOWN_OUTCOME'))
  OR (action = 'CHILD_EXPIRED' AND reason_code = 'CHILD_EXPIRED')
  OR (action = 'SWEEP_EXPIRED' AND reason_code = 'SWEEP_EXPIRED')
`;

function checks(table, definitions) {
  return definitions.map(definition => tinderFoundationCheck(table, definition));
}

export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CONSTRAINT_CONTRACT = Object.freeze([
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, "p", ["sweep_id"], "PRIMARY KEY (sweep_id)"),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", { referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, "f", ["active_command_id"], "FOREIGN KEY (active_command_id) REFERENCES device_bridge_commands(command_id) ON DELETE RESTRICT", { referenceTable: "device_bridge_commands", referenceColumns: ["command_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, "u", ["sweep_id", "device_id"], "UNIQUE (sweep_id, device_id)"),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, "u", ["device_id", "inbox_observation_nonce"], "UNIQUE (device_id, inbox_observation_nonce)"),
  ...checks(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, ["sweep_contract_version = 1", "inbox_heartbeat_sequence > 0", "sweep_state IN ('ACTIVE', 'COMPLETED', 'STOPPED', 'EXPIRED')", "max_slots = 8", "next_slot BETWEEN 1 AND 9", "expires_at > issued_at", "expires_at <= issued_at + '00:30:00'::interval", SWEEP_LIFECYCLE_CHECK, "closed_at IS NULL OR closed_at >= issued_at"]),

  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, "p", ["command_id"], "PRIMARY KEY (command_id)"),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, "f", ["command_id"], "FOREIGN KEY (command_id) REFERENCES device_bridge_commands(command_id) ON DELETE RESTRICT", { referenceTable: "device_bridge_commands", referenceColumns: ["command_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, "f", ["sweep_id"], `FOREIGN KEY (sweep_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}(sweep_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, referenceColumns: ["sweep_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", { referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, "f", ["command_id", "device_id"], "FOREIGN KEY (command_id, device_id) REFERENCES device_bridge_commands(command_id, device_id) ON DELETE RESTRICT", { referenceTable: "device_bridge_commands", referenceColumns: ["command_id", "device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, "f", ["sweep_id", "device_id"], `FOREIGN KEY (sweep_id, device_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}(sweep_id, device_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, referenceColumns: ["sweep_id", "device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, "f", ["transcript_id", "command_id", "sweep_id", "device_id"], `FOREIGN KEY (transcript_id, command_id, sweep_id, device_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE}(transcript_id, command_id, sweep_id, device_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, referenceColumns: ["transcript_id", "command_id", "sweep_id", "device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, "u", ["command_id", "device_id"], "UNIQUE (command_id, device_id)"),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, "u", ["command_id", "sweep_id", "device_id"], "UNIQUE (command_id, sweep_id, device_id)"),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, "u", ["sweep_id", "slot_ordinal", "child_kind"], "UNIQUE (sweep_id, slot_ordinal, child_kind)"),
  ...checks(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, ["step_contract_version = 1", "slot_ordinal BETWEEN 1 AND 8", "child_kind IN ('READ', 'RETURN_ONLY')", "child_state IN ('ISSUED', 'STAGED', 'RETURN_STAGED', 'TRANSCRIPT_ACCEPTED', 'RETURN_ACCEPTED', 'EXPIRED', 'CANCELLED')", "expires_at > issued_at", "(child_kind = 'READ' AND expires_at <= issued_at + '00:03:00'::interval) OR (child_kind = 'RETURN_ONLY' AND expires_at <= issued_at + '00:01:30'::interval)", STEP_LIFECYCLE_CHECK, "staged_at IS NULL OR staged_at >= issued_at", "accepted_at IS NULL OR (staged_at IS NULL OR accepted_at >= staged_at)", "closed_at IS NULL OR closed_at >= issued_at"]),

  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, "p", ["transcript_id"], "PRIMARY KEY (transcript_id)"),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, "f", ["command_id"], `FOREIGN KEY (command_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE}(command_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, referenceColumns: ["command_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, "f", ["sweep_id"], `FOREIGN KEY (sweep_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}(sweep_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, referenceColumns: ["sweep_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", { referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, "f", ["command_id", "device_id"], `FOREIGN KEY (command_id, device_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE}(command_id, device_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, referenceColumns: ["command_id", "device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, "f", ["command_id", "sweep_id", "device_id"], `FOREIGN KEY (command_id, sweep_id, device_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE}(command_id, sweep_id, device_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, referenceColumns: ["command_id", "sweep_id", "device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, "u", ["command_id", "device_id"], "UNIQUE (command_id, device_id)"),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, "u", ["transcript_id", "command_id", "sweep_id", "device_id"], "UNIQUE (transcript_id, command_id, sweep_id, device_id)"),
  ...checks(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, ["transcript_contract_version = 1", "transcript_schema_version = 'tinder-unbound-inbox-conversation-sweep-transcript-v1'", "source_platform = 'tinder'", "source_package = 'com.tinder'", "layout_schema_version = 'tinder-zte-visible-chat-scroll-v1'", "initial_visible_node_count BETWEEN 1 AND 5000", "final_visible_node_count BETWEEN 1 AND 5000", "segment_count BETWEEN 1 AND 8", "overlap_count BETWEEN 0 AND 100", "transcript_fingerprint ~ '^[0-9a-f]{64}$'", "jsonb_typeof(visible_messages) = 'array'", "transcript_safety_status = 'SAFE'", "mapping_status = 'NEEDS_HUMAN_MAPPING'", "human_review_status = 'PENDING'", "sync_completed_at >= sync_started_at", "sync_completed_at <= sync_started_at + '00:01:30'::interval"]),

  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE, "p", ["audit_id"], "PRIMARY KEY (audit_id)"),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE, "f", ["sweep_id"], `FOREIGN KEY (sweep_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}(sweep_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, referenceColumns: ["sweep_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE, "f", ["command_id"], `FOREIGN KEY (command_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE}(command_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, referenceColumns: ["command_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE, "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", { referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE, "f", ["sweep_id", "device_id"], `FOREIGN KEY (sweep_id, device_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE}(sweep_id, device_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE, referenceColumns: ["sweep_id", "device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE, "f", ["transcript_id"], `FOREIGN KEY (transcript_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE}(transcript_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, referenceColumns: ["transcript_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE, "f", ["command_id", "sweep_id", "device_id"], `FOREIGN KEY (command_id, sweep_id, device_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE}(command_id, sweep_id, device_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE, referenceColumns: ["command_id", "sweep_id", "device_id"], deleteAction: "r", updateAction: "a" }),
  tinderFoundationKey(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE, "f", ["transcript_id", "command_id", "sweep_id", "device_id"], `FOREIGN KEY (transcript_id, command_id, sweep_id, device_id) REFERENCES ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE}(transcript_id, command_id, sweep_id, device_id) ON DELETE RESTRICT`, { referenceTable: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE, referenceColumns: ["transcript_id", "command_id", "sweep_id", "device_id"], deleteAction: "r", updateAction: "a" }),
  ...checks(TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE, ["action IN ('SWEEP_ISSUED', 'READ_ISSUED', 'READ_STAGED', 'READ_TRANSCRIPT_ACCEPTED', 'RETURN_ISSUED', 'RETURN_STAGED', 'RETURN_ACCEPTED', 'SWEEP_COMPLETED', 'SWEEP_STOPPED', 'CHILD_EXPIRED', 'SWEEP_EXPIRED')", "actor IN ('ANDROID_RUNTIME', 'SIGNED_TRANSCRIPT_INGRESS', 'SIGNED_RETURN_INGRESS', 'SERVER_AUTOMATION', 'SERVER_EXPIRY')", "source IN ('SIGNED_DEVICE_INGRESS', 'SIGNED_TRANSCRIPT_INGRESS', 'SIGNED_RETURN_INGRESS', 'SERVER_AUTOMATION', 'SERVER_MAINTENANCE')", "details = '{}'::jsonb", AUDIT_REASON_CHECK, "(action IN ('READ_ISSUED', 'READ_STAGED', 'READ_TRANSCRIPT_ACCEPTED', 'RETURN_ISSUED', 'RETURN_STAGED', 'RETURN_ACCEPTED', 'SWEEP_STOPPED', 'CHILD_EXPIRED')) = (command_id IS NOT NULL AND slot_ordinal IS NOT NULL)", "(action = 'READ_TRANSCRIPT_ACCEPTED') = (transcript_id IS NOT NULL)"])
]);

function mapColumns(rows, relation) {
  return new Map(rows.filter(row => row.relation_name === relation).map(row => [row.column_name, {
    dataType: row.data_type, notNull: row.not_null === true,
    defaultExpression: canonicalTinderFoundationDefault(row.column_default)
  }]));
}

function exactColumns(actual, contract, defaults = {}) {
  return actual.size === Object.keys(contract).length && Object.entries(contract).every(([name, [dataType, notNull]]) => {
    const column = actual.get(name);
    return column?.dataType === dataType && column?.notNull === notNull
      && matchesTinderFoundationDefault(column.defaultExpression, defaults[name] ?? TINDER_FOUNDATION_DEFAULT.NONE);
  });
}

function relationKind(rows, relation) {
  const matches = rows.filter(row => row.relation_name === relation);
  return matches.length === 1 ? matches[0]?.relkind : null;
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function indexMatches(rows, name, { unique, columns, descending, predicate = "" }) {
  const row = rows.find(candidate => candidate.index_name === name);
  return Boolean(row) && row.indisvalid === true && row.indisready === true && row.indisunique === unique
    && sameArray(row.column_names, columns) && sameArray(row.descending, descending)
    && canonicalSchemaPredicate(row.predicate) === canonicalSchemaPredicate(predicate);
}

function indexesCanonical(rows) {
  return Array.isArray(rows)
    && rows.length === TARGET_INDEX_NAMES.length
    && rows.every(row => TARGET_INDEX_NAMES.includes(row?.index_name))
    && indexMatches(rows, "idx_tinder_unbound_inbox_conversation_sweep_active_device", { unique: true, columns: ["device_id"], descending: [false], predicate: "sweep_state = 'ACTIVE'" })
    && indexMatches(rows, "idx_tinder_unbound_inbox_conversation_sweep_device_expiry", { unique: false, columns: ["device_id", "sweep_state", "expires_at"], descending: [false, false, true] })
    && indexMatches(rows, "idx_tinder_unbound_inbox_conversation_sweep_active_child_device", { unique: true, columns: ["device_id"], descending: [false], predicate: "child_state IN ('ISSUED', 'STAGED', 'RETURN_STAGED')" })
    && indexMatches(rows, "idx_tinder_unbound_inbox_conversation_sweep_steps_sweep_slot", { unique: false, columns: ["sweep_id", "slot_ordinal", "child_kind"], descending: [false, false, false] })
    && indexMatches(rows, "idx_tinder_unbound_inbox_conversation_sweep_steps_device_expiry", { unique: false, columns: ["device_id", "child_state", "expires_at"], descending: [false, false, true] })
    && indexMatches(rows, "idx_tinder_unbound_inbox_conversation_sweep_transcript_device_received", { unique: false, columns: ["device_id", "received_at"], descending: [false, true] })
    && indexMatches(rows, "idx_tinder_unbound_inbox_conversation_sweep_transcript_pending_received", { unique: false, columns: ["mapping_status", "human_review_status", "received_at"], descending: [false, false, true] })
    && indexMatches(rows, "idx_tinder_unbound_inbox_conversation_sweep_audit_sweep_created", { unique: false, columns: ["sweep_id", "created_at"], descending: [false, true] })
    && indexMatches(rows, "idx_tinder_unbound_inbox_conversation_sweep_audit_command_created", { unique: false, columns: ["command_id", "created_at"], descending: [false, true], predicate: "command_id IS NOT NULL" });
}

function canonicalTrigger(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase()
    .replace(/\b(after|before)\s+((?:(?:insert|delete|update)(?:\s+or\s+)?)+)(?=\s+on\b)/g, (_whole, timing, eventList) => {
      const events = String(eventList).split(/\s+or\s+/).map(event => event.trim()).filter(Boolean).sort();
      return `${timing} ${events.join(" or ")}`;
    });
}

const IMMUTABLE_GUARD_BODY = `
BEGIN
  IF TG_OP <> 'DELETE'
     AND TG_TABLE_NAME = 'tinder_unbound_inbox_conversation_sweeps'
     AND NEW.inbox_observation_nonce IS DISTINCT FROM OLD.inbox_observation_nonce THEN
    RAISE EXCEPTION 'unbound Inbox sweep observation nonce is immutable';
  END IF;
  IF TG_TABLE_NAME = 'tinder_unbound_inbox_conversation_sweeps'
     AND OLD.sweep_state IN ('COMPLETED', 'STOPPED', 'EXPIRED') THEN
    RAISE EXCEPTION 'terminal unbound Inbox sweep is immutable';
  END IF;
  IF TG_TABLE_NAME = 'tinder_unbound_inbox_conversation_sweep_steps'
     AND OLD.child_state IN ('TRANSCRIPT_ACCEPTED', 'RETURN_ACCEPTED', 'EXPIRED', 'CANCELLED') THEN
    RAISE EXCEPTION 'terminal unbound Inbox sweep step is immutable';
  END IF;
  IF TG_TABLE_NAME IN ('tinder_unbound_inbox_conversation_sweep_transcripts', 'tinder_unbound_inbox_conversation_sweep_audit') THEN
    RAISE EXCEPTION 'unbound Inbox sweep evidence is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
`;

const ACTIVE_CHILD_GUARD_BODY = `
BEGIN
  IF EXISTS (
    SELECT 1
      FROM tinder_unbound_inbox_conversation_sweeps parent
     WHERE parent.sweep_state = 'ACTIVE'
       AND NOT EXISTS (
         SELECT 1
           FROM tinder_unbound_inbox_conversation_sweep_steps step
          WHERE step.command_id = parent.active_command_id
            AND step.sweep_id = parent.sweep_id
            AND step.device_id = parent.device_id
            AND step.child_state IN ('ISSUED', 'STAGED', 'RETURN_STAGED')
       )
  ) THEN
    RAISE EXCEPTION 'unbound Inbox sweep active command is outside its scope';
  END IF;
  RETURN NULL;
END;
`;

const AUDIT_SCOPE_GUARD_BODY = `
BEGIN
  IF NEW.command_id IS NULL THEN
    IF NEW.slot_ordinal IS NOT NULL OR NEW.transcript_id IS NOT NULL THEN
      RAISE EXCEPTION 'unbound Inbox sweep parent audit cannot carry child evidence';
    END IF;
  ELSIF NEW.slot_ordinal IS NULL OR NOT EXISTS (
    SELECT 1
      FROM tinder_unbound_inbox_conversation_sweep_steps step
     WHERE step.command_id = NEW.command_id
       AND step.sweep_id = NEW.sweep_id
       AND step.device_id = NEW.device_id
       AND step.slot_ordinal = NEW.slot_ordinal
  ) THEN
    RAISE EXCEPTION 'unbound Inbox sweep child audit slot is outside its scope';
  END IF;
  RETURN NEW;
END;
`;

const TRIGGER_CONTRACT = Object.freeze([
  Object.freeze({
    name: "tinder_unbound_inbox_conversation_sweep_terminal_immutable",
    table: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE,
    functionName: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION,
    definition: `CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_terminal_immutable BEFORE UPDATE OR DELETE ON ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE} FOR EACH ROW EXECUTE FUNCTION ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION}()`,
    source: IMMUTABLE_GUARD_BODY, deferrable: false, initiallyDeferred: false
  }),
  Object.freeze({
    name: "tinder_unbound_inbox_conversation_sweep_step_terminal_immutable",
    table: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE,
    functionName: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION,
    definition: `CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_step_terminal_immutable BEFORE UPDATE OR DELETE ON ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE} FOR EACH ROW EXECUTE FUNCTION ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION}()`,
    source: IMMUTABLE_GUARD_BODY, deferrable: false, initiallyDeferred: false
  }),
  Object.freeze({
    name: "tinder_unbound_inbox_conversation_sweep_transcript_immutable",
    table: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE,
    functionName: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION,
    definition: `CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_transcript_immutable BEFORE UPDATE OR DELETE ON ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE} FOR EACH ROW EXECUTE FUNCTION ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION}()`,
    source: IMMUTABLE_GUARD_BODY, deferrable: false, initiallyDeferred: false
  }),
  Object.freeze({
    name: "tinder_unbound_inbox_conversation_sweep_audit_immutable",
    table: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE,
    functionName: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION,
    definition: `CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_audit_immutable BEFORE UPDATE OR DELETE ON ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE} FOR EACH ROW EXECUTE FUNCTION ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_IMMUTABLE_GUARD_FUNCTION}()`,
    source: IMMUTABLE_GUARD_BODY, deferrable: false, initiallyDeferred: false
  }),
  Object.freeze({
    name: "tinder_unbound_inbox_conversation_sweep_active_child_scope",
    table: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE,
    functionName: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE_CHILD_GUARD_FUNCTION,
    definition: `CREATE CONSTRAINT TRIGGER tinder_unbound_inbox_conversation_sweep_active_child_scope AFTER INSERT OR UPDATE ON ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE_CHILD_GUARD_FUNCTION}()`,
    source: ACTIVE_CHILD_GUARD_BODY, deferrable: true, initiallyDeferred: true
  }),
  Object.freeze({
    name: "tinder_unbound_inbox_conversation_sweep_step_active_child_scope",
    table: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE,
    functionName: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE_CHILD_GUARD_FUNCTION,
    definition: `CREATE CONSTRAINT TRIGGER tinder_unbound_inbox_conversation_sweep_step_active_child_scope AFTER INSERT OR DELETE OR UPDATE ON ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE} DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_ACTIVE_CHILD_GUARD_FUNCTION}()`,
    source: ACTIVE_CHILD_GUARD_BODY, deferrable: true, initiallyDeferred: true
  }),
  Object.freeze({
    name: "tinder_unbound_inbox_conversation_sweep_audit_scope",
    table: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE,
    functionName: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_SCOPE_GUARD_FUNCTION,
    definition: `CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_audit_scope BEFORE INSERT OR UPDATE ON ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE} FOR EACH ROW EXECUTE FUNCTION ${TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_SCOPE_GUARD_FUNCTION}()`,
    source: AUDIT_SCOPE_GUARD_BODY, deferrable: false, initiallyDeferred: false
  })
]);

function triggersCanonical(rows) {
  return rows.length === TRIGGER_CONTRACT.length && TRIGGER_CONTRACT.every(expected => {
    const row = rows.find(candidate => candidate.trigger_name === expected.name && candidate.relation_name === expected.table);
    return row?.enabled === "O"
      && row?.function_name === expected.functionName
      && row?.deferrable === expected.deferrable
      && row?.initially_deferred === expected.initiallyDeferred
      && canonicalTrigger(row.trigger_definition) === canonicalTrigger(expected.definition)
      && canonicalTrigger(row.function_source) === canonicalTrigger(expected.source);
  });
}

async function readRelations(client) {
  return client.query(`SELECT c.relname AS relation_name, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1)`, [TARGET_RELATIONS]);
}
async function readColumns(client) {
  return client.query(`SELECT c.relname AS relation_name, a.attname AS column_name, format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null, COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '') AS column_default FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname=current_schema() AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`, [TARGET_RELATIONS]);
}
async function readIndexes(client) {
  return client.query(`SELECT idx.relname AS index_name, i.indisunique, i.indisvalid, i.indisready, ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality) JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum ORDER BY key.ordinality) AS column_names, ARRAY(SELECT (option & 1)=1 FROM unnest(i.indoption) WITH ORDINALITY AS option_value(option, ordinality) ORDER BY ordinality) AS descending, COALESCE(pg_get_expr(i.indpred, i.indrelid, true), '') AS predicate FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_class relation ON relation.oid=i.indrelid JOIN pg_namespace n ON n.oid=relation.relnamespace WHERE n.nspname=current_schema() AND relation.relname=ANY($1) AND NOT EXISTS (SELECT 1 FROM pg_constraint constraint_index WHERE constraint_index.conindid=i.indexrelid)`, [TARGET_RELATIONS]);
}
async function readTriggers(client) {
  return client.query(`SELECT t.tgname AS trigger_name, c.relname AS relation_name, t.tgenabled AS enabled, t.tgdeferrable AS deferrable, t.tginitdeferred AS initially_deferred, p.proname AS function_name, pg_get_triggerdef(t.oid, true) AS trigger_definition, p.prosrc AS function_source FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid WHERE n.nspname=current_schema() AND c.relname=ANY($1) AND NOT t.tgisinternal`, [TARGET_RELATIONS]);
}
async function currentCommandConstraintName(client, inspectDeviceBridgeSchema) {
  const inspection = await inspectDeviceBridgeSchema(client);
  if (!inspection?.ready) return null;
  const command = inspection.constraints?.find(item => item.specification?.table === "device_bridge_commands" && item.specification?.column === "command_type");
  return command?.constraintName || null;
}

function absentCatalog({ relations, columns, indexes, constraints, triggers }) {
  return TARGET_RELATIONS.every(relation => relationKind(relations.rows, relation) === null && mapColumns(columns.rows, relation).size === 0)
    && indexes.rows.length === 0
    && constraints.rows.every(row => !TARGET_RELATIONS.includes(row.table_name))
    && triggers.rows.length === 0;
}

/** Reads exact V8 catalog facts only. No write, DDL, lock, or runtime action. */
export async function inspectTinderUnboundInboxConversationSweepSchema(client, {
  inspectV6Schema = inspectTinderLocalConversationAttestationSchema,
  inspectDeviceBridgeSchema = inspectDeviceBridgeT1Schema
} = {}) {
  const v6 = await inspectV6Schema(client);
  if (v6?.state !== TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.CANONICAL) {
    return { state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID };
  }
  const [relations, columns, indexes, constraints, triggers, commandConstraintName] = await Promise.all([
    readRelations(client), readColumns(client), readIndexes(client), readTinderFoundationConstraints(client, TARGET_RELATIONS), readTriggers(client), currentCommandConstraintName(client, inspectDeviceBridgeSchema)
  ]);
  const catalog = { relations, columns, indexes, constraints, triggers };
  if (absentCatalog(catalog)) {
    return { state: commandConstraintName === TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE_CONSTRAINT_NAME
      ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.UPGRADE_REQUIRED
      : TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID };
  }
  const canonical = commandConstraintName === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_TYPE_CONSTRAINT_NAME
    && relationKind(relations.rows, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE) === "r"
    && relationKind(relations.rows, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE) === "r"
    && relationKind(relations.rows, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE) === "r"
    && relationKind(relations.rows, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE) === "r"
    && exactColumns(mapColumns(columns.rows, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TABLE), SWEEP_COLUMNS, SWEEP_DEFAULTS)
    && exactColumns(mapColumns(columns.rows, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_STEP_TABLE), STEP_COLUMNS, STEP_DEFAULTS)
    && exactColumns(mapColumns(columns.rows, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_TRANSCRIPT_TABLE), TRANSCRIPT_COLUMNS, TRANSCRIPT_DEFAULTS)
    && exactColumns(mapColumns(columns.rows, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_AUDIT_TABLE), AUDIT_COLUMNS, AUDIT_DEFAULTS)
    && indexesCanonical(indexes.rows)
    && hasExpectedTinderFoundationConstraints(constraints.rows, TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_CONSTRAINT_CONTRACT, { exactTables: TARGET_RELATIONS })
    && triggersCanonical(triggers.rows);
  return { state: canonical ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL : TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID };
}

/** Read-only pre-DDL gate for direct V6 -> V8 transition. */
export async function preflightTinderUnboundInboxConversationSweepMigration(client, options) {
  const foundation = await inspectTinderUnboundInboxConversationSweepSchema(client, options);
  if (foundation.state === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID) throw new Error("Tinder unbound Inbox conversation sweep schema is incompatible.");
  return { foundation, mutate: foundation.state === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.UPGRADE_REQUIRED };
}

export async function assertTinderUnboundInboxConversationSweepSchemaReady(client, options) {
  const inspection = await inspectTinderUnboundInboxConversationSweepSchema(client, options);
  if (inspection.state !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL) throw new Error("Tinder unbound Inbox conversation sweep schema is not ready.");
  return inspection;
}
