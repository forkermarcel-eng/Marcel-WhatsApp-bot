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
  TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME
} from "./t1-schema.js";
import {
  inspectTinderOfficialAppResumePermitV2Schema,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE,
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_V2_CONSTRAINT_CONTRACT
} from "./tinder-visible-chat-sync-permit-schema.js";

/* ==================================================
TINDER LOCAL CONVERSATION ATTESTATION — SCHEMA CONTRACT

This module recognizes an additive, explicit foundation only. It stores an
opaque command handle and human-confirmed binding revision for audit; it never
stores a Tinder identifier, name, chat content, fingerprint, UI node, bounds,
or other content-derived conversation reference. No route or runtime may use
this module to create, repair, or mutate schema.
================================================== */

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE = Object.freeze({
  UPGRADE_REQUIRED: "UPGRADE_REQUIRED",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_PREFLIGHT_ERROR_CODE = Object.freeze({
  PREREQUISITE_INSPECTION_FAILED:
    "TINDER_LOCAL_CONVERSATION_ATTESTATION_PREREQUISITE_INSPECTION_FAILED",
  V1_CONSTRAINT_INSPECTION_FAILED:
    "TINDER_LOCAL_CONVERSATION_ATTESTATION_V1_CONSTRAINT_INSPECTION_FAILED",
  ACTIVE_V1_PERMIT_CHECK_FAILED:
    "TINDER_LOCAL_CONVERSATION_ATTESTATION_ACTIVE_V1_PERMIT_CHECK_FAILED"
});

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE =
  "tinder_local_conversation_attestation_permits";
export const TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE =
  "tinder_local_conversation_attestation_audit";
const VISIBLE_CHAT_SYNC_PERMIT_TABLE = "tinder_visible_chat_sync_permits";
const OFFICIAL_APP_RESUME_PERMIT_TABLE = "tinder_official_app_resume_permits";
const VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE = "tinder_visible_chat_sync_transcripts";

const TARGET_RELATIONS = Object.freeze([
  VISIBLE_CHAT_SYNC_PERMIT_TABLE,
  OFFICIAL_APP_RESUME_PERMIT_TABLE,
  VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE
]);
const NEW_RELATIONS = Object.freeze([
  TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE
]);
const TARGET_INDEX_NAMES = Object.freeze([
  "idx_tinder_visible_chat_sync_permit_active_device",
  "idx_tinder_visible_chat_sync_permit_device_expiry",
  "idx_tinder_visible_chat_sync_permit_source_capture",
  "idx_tinder_official_app_resume_permit_active_device",
  "idx_tinder_official_app_resume_permit_source_created",
  "idx_tinder_official_app_resume_permit_binding_revision_created",
  "idx_tinder_visible_chat_sync_transcript_source_received",
  "idx_tinder_visible_chat_sync_transcript_device_received",
  "idx_tinder_local_conversation_attestation_active_device",
  "idx_tinder_local_conversation_attestation_device_expiry",
  "idx_tinder_local_conversation_attestation_binding_created",
  "idx_tinder_local_conversation_attestation_audit_command_created",
  "idx_tinder_visible_chat_sync_permit_attestation_binding_created"
]);
const NEW_INDEX_NAMES = Object.freeze([
  "idx_tinder_local_conversation_attestation_active_device",
  "idx_tinder_local_conversation_attestation_device_expiry",
  "idx_tinder_local_conversation_attestation_binding_created",
  "idx_tinder_local_conversation_attestation_audit_command_created",
  "idx_tinder_visible_chat_sync_permit_attestation_binding_created"
]);

const VISIBLE_CHAT_SYNC_PERMIT_COLUMNS_V2 = Object.freeze({
  command_id: ["uuid", true],
  device_id: ["uuid", true],
  source_capture_id: ["uuid", true],
  permit_contract_version: ["smallint", true],
  attestation_command_id: ["uuid", false],
  binding_id: ["uuid", false],
  binding_revision: ["integer", false],
  permit_state: ["text", true],
  issued_at: ["timestamp with time zone", true],
  expires_at: ["timestamp with time zone", true],
  staged_at: ["timestamp with time zone", false],
  consumed_at: ["timestamp with time zone", false],
  closed_at: ["timestamp with time zone", false],
  created_at: ["timestamp with time zone", true],
  updated_at: ["timestamp with time zone", true]
});
const OFFICIAL_APP_RESUME_PERMIT_COLUMNS_V2 = Object.freeze({
  command_id: ["uuid", true],
  device_id: ["uuid", true],
  source_capture_id: ["uuid", true],
  binding_id: ["uuid", false],
  binding_revision: ["integer", false],
  permit_contract_version: ["smallint", true],
  permit_state: ["text", true],
  issued_at: ["timestamp with time zone", true],
  expires_at: ["timestamp with time zone", true],
  dispatched_at: ["timestamp with time zone", false],
  closed_at: ["timestamp with time zone", false],
  created_at: ["timestamp with time zone", true],
  updated_at: ["timestamp with time zone", true]
});
const VISIBLE_CHAT_SYNC_TRANSCRIPT_COLUMNS = Object.freeze({
  sync_id: ["uuid", true],
  command_id: ["uuid", true],
  source_capture_id: ["uuid", true],
  device_id: ["uuid", true],
  sync_schema_version: ["text", true],
  source_package: ["text", true],
  layout_schema_version: ["text", true],
  sync_started_at: ["timestamp with time zone", true],
  sync_completed_at: ["timestamp with time zone", true],
  initial_visible_node_count: ["integer", true],
  final_visible_node_count: ["integer", true],
  segment_count: ["integer", true],
  overlap_count: ["integer", true],
  transcript_fingerprint: ["character(64)", true],
  visible_messages: ["jsonb", true],
  sync_safety_status: ["text", true],
  received_at: ["timestamp with time zone", true],
  created_at: ["timestamp with time zone", true]
});
const ATTESTATION_PERMIT_COLUMNS = Object.freeze({
  command_id: ["uuid", true],
  device_id: ["uuid", true],
  binding_id: ["uuid", true],
  binding_revision: ["integer", true],
  permit_contract_version: ["smallint", true],
  permit_state: ["text", true],
  issued_at: ["timestamp with time zone", true],
  expires_at: ["timestamp with time zone", true],
  staged_at: ["timestamp with time zone", false],
  attested_at: ["timestamp with time zone", false],
  invalidated_at: ["timestamp with time zone", false],
  closed_at: ["timestamp with time zone", false],
  terminal_reason: ["text", false],
  created_at: ["timestamp with time zone", true],
  updated_at: ["timestamp with time zone", true]
});
const ATTESTATION_AUDIT_COLUMNS = Object.freeze({
  audit_id: ["uuid", true],
  command_id: ["uuid", true],
  binding_id: ["uuid", true],
  device_id: ["uuid", true],
  binding_revision: ["integer", true],
  action: ["text", true],
  reason_code: ["text", false],
  actor: ["text", true],
  source: ["text", true],
  details: ["jsonb", true],
  created_at: ["timestamp with time zone", true]
});

const VISIBLE_CHAT_SYNC_PERMIT_DEFAULTS_V2 = Object.freeze({
  permit_state: "'ISSUED'",
  issued_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW,
  updated_at: TINDER_FOUNDATION_DEFAULT.NOW
});
const OFFICIAL_APP_RESUME_PERMIT_DEFAULTS_V2 = Object.freeze({
  permit_state: "'ISSUED'",
  issued_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW,
  updated_at: TINDER_FOUNDATION_DEFAULT.NOW
});
const VISIBLE_CHAT_SYNC_TRANSCRIPT_DEFAULTS = Object.freeze({
  received_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW
});
const ATTESTATION_PERMIT_DEFAULTS = Object.freeze({
  permit_state: "'ISSUED'",
  issued_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW,
  updated_at: TINDER_FOUNDATION_DEFAULT.NOW
});
const ATTESTATION_AUDIT_DEFAULTS = Object.freeze({
  details: TINDER_FOUNDATION_DEFAULT.EMPTY_JSON_OBJECT,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const ATTESTATION_LIFECYCLE_CHECK = `
  (permit_state = 'ISSUED'
    AND staged_at IS NULL AND attested_at IS NULL AND invalidated_at IS NULL
    AND closed_at IS NULL AND terminal_reason IS NULL)
  OR
  (permit_state = 'STAGED'
    AND staged_at IS NOT NULL AND attested_at IS NULL AND invalidated_at IS NULL
    AND closed_at IS NULL AND terminal_reason IS NULL)
  OR
  (permit_state = 'ATTESTED'
    AND staged_at IS NOT NULL AND attested_at IS NOT NULL AND invalidated_at IS NULL
    AND closed_at IS NULL AND terminal_reason IS NULL)
  OR
  (permit_state = 'INVALIDATED'
    AND staged_at IS NOT NULL AND invalidated_at IS NOT NULL AND closed_at = invalidated_at
    AND terminal_reason IN (
      'BINDING_REVISION_CHANGED', 'CONVERSATION_CHANGED',
      'CONTINUITY_UNPROVEN', 'LOCAL_STATE_DESTROYED', 'AUTH_OR_REVIEW',
      'IDENTITY_CONFLICT', 'HUMAN_REBIND'
    ))
  OR
  (permit_state = 'EXPIRED'
    AND invalidated_at IS NULL AND closed_at IS NOT NULL AND terminal_reason = 'EXPIRED')
  OR
  (permit_state = 'CANCELLED'
    AND staged_at IS NULL AND attested_at IS NULL AND invalidated_at IS NULL AND closed_at IS NOT NULL
    AND terminal_reason IN ('COMMAND_REJECTED', 'BOOTSTRAP_REJECTED', 'RUNTIME_GATE_LOST'))
`;

const ATTESTATION_TIMESTAMP_CONTRACT = Object.freeze([
  "staged_at IS NULL OR staged_at >= issued_at",
  "attested_at IS NULL OR (staged_at IS NOT NULL AND attested_at >= staged_at)",
  "invalidated_at IS NULL OR (staged_at IS NOT NULL AND invalidated_at >= staged_at)",
  "closed_at IS NULL OR (closed_at >= issued_at AND (staged_at IS NULL OR closed_at >= staged_at) AND (attested_at IS NULL OR closed_at >= attested_at) AND (invalidated_at IS NULL OR closed_at >= invalidated_at))"
]);

const ATTESTATION_AUDIT_ACTION_REASON_CHECK = `
  (action IN ('ISSUED', 'STAGED', 'ATTESTED') AND reason_code IS NULL)
  OR (action = 'EXPIRED' AND reason_code = 'PERMIT_EXPIRED')
  OR (action = 'INVALIDATED' AND reason_code IN (
    'BINDING_REVISION_CHANGED', 'CONVERSATION_CHANGED',
    'CONTINUITY_UNPROVEN', 'LOCAL_STATE_DESTROYED', 'AUTH_OR_REVIEW',
    'IDENTITY_CONFLICT', 'HUMAN_REBIND'
  ))
  OR (action = 'CANCELLED' AND reason_code IN (
    'COMMAND_REJECTED', 'BOOTSTRAP_REJECTED', 'RUNTIME_GATE_LOST'
  ))
`;

export const TINDER_LOCAL_CONVERSATION_ATTESTATION_CONSTRAINT_CONTRACT = Object.freeze([
  ...TINDER_VISIBLE_CHAT_SYNC_PERMIT_V2_CONSTRAINT_CONTRACT,
  tinderFoundationKey(VISIBLE_CHAT_SYNC_PERMIT_TABLE, "f", ["attestation_command_id"],
    "FOREIGN KEY (attestation_command_id) REFERENCES tinder_local_conversation_attestation_permits(command_id) ON DELETE RESTRICT", {
      referenceTable: TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
      referenceColumns: ["command_id"], deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationKey(VISIBLE_CHAT_SYNC_PERMIT_TABLE, "f", ["binding_id"],
    "FOREIGN KEY (binding_id) REFERENCES contact_human_armed_conversation_bindings(binding_id) ON DELETE RESTRICT", {
      referenceTable: "contact_human_armed_conversation_bindings",
      referenceColumns: ["binding_id"], deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationKey(VISIBLE_CHAT_SYNC_PERMIT_TABLE, "f",
    ["attestation_command_id", "device_id", "binding_id", "binding_revision"],
    "FOREIGN KEY (attestation_command_id, device_id, binding_id, binding_revision) REFERENCES tinder_local_conversation_attestation_permits(command_id, device_id, binding_id, binding_revision) ON DELETE RESTRICT", {
      referenceTable: TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
      referenceColumns: ["command_id", "device_id", "binding_id", "binding_revision"],
      deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationCheck(VISIBLE_CHAT_SYNC_PERMIT_TABLE, "permit_contract_version IN (1, 2)"),
  tinderFoundationCheck(VISIBLE_CHAT_SYNC_PERMIT_TABLE,
    "(permit_contract_version = 1 AND attestation_command_id IS NULL AND binding_id IS NULL AND binding_revision IS NULL) OR (permit_contract_version = 2 AND attestation_command_id IS NOT NULL AND binding_id IS NOT NULL AND binding_revision IS NOT NULL AND binding_revision > 0)"),

  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE, "p", ["command_id"], "PRIMARY KEY (command_id)"),
  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE, "f", ["command_id"],
    "FOREIGN KEY (command_id) REFERENCES device_bridge_commands(command_id) ON DELETE RESTRICT", {
      referenceTable: "device_bridge_commands", referenceColumns: ["command_id"], deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE, "f", ["device_id"],
    "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
      referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE, "f", ["command_id", "device_id"],
    "FOREIGN KEY (command_id, device_id) REFERENCES device_bridge_commands(command_id, device_id) ON DELETE RESTRICT", {
      referenceTable: "device_bridge_commands", referenceColumns: ["command_id", "device_id"], deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE, "f", ["binding_id"],
    "FOREIGN KEY (binding_id) REFERENCES contact_human_armed_conversation_bindings(binding_id) ON DELETE RESTRICT", {
      referenceTable: "contact_human_armed_conversation_bindings", referenceColumns: ["binding_id"], deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE, "u",
    ["command_id", "device_id", "binding_id", "binding_revision"],
    "UNIQUE (command_id, device_id, binding_id, binding_revision)"),
  tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
    "binding_revision > 0"),
  tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
    "permit_contract_version = 1"),
  tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
    "permit_state IN ('ISSUED', 'STAGED', 'ATTESTED', 'INVALIDATED', 'EXPIRED', 'CANCELLED')"),
  tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
    "expires_at > issued_at"),
  tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE, ATTESTATION_LIFECYCLE_CHECK),
  ...ATTESTATION_TIMESTAMP_CONTRACT.map(definition =>
    tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE, definition)),

  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE, "p", ["audit_id"], "PRIMARY KEY (audit_id)"),
  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE, "f", ["command_id"],
    "FOREIGN KEY (command_id) REFERENCES tinder_local_conversation_attestation_permits(command_id) ON DELETE RESTRICT", {
      referenceTable: TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
      referenceColumns: ["command_id"], deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE, "f", ["binding_id"],
    "FOREIGN KEY (binding_id) REFERENCES contact_human_armed_conversation_bindings(binding_id) ON DELETE RESTRICT", {
      referenceTable: "contact_human_armed_conversation_bindings", referenceColumns: ["binding_id"], deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE, "f", ["device_id"],
    "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
      referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationKey(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE, "f",
    ["command_id", "device_id", "binding_id", "binding_revision"],
    "FOREIGN KEY (command_id, device_id, binding_id, binding_revision) REFERENCES tinder_local_conversation_attestation_permits(command_id, device_id, binding_id, binding_revision) ON DELETE RESTRICT", {
      referenceTable: TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE,
      referenceColumns: ["command_id", "device_id", "binding_id", "binding_revision"],
      deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE,
    "binding_revision > 0"),
  tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE,
    "action IN ('ISSUED', 'STAGED', 'ATTESTED', 'INVALIDATED', 'EXPIRED', 'CANCELLED')"),
  tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE,
    "actor IN ('DASHBOARD_HUMAN', 'ANDROID_RUNTIME', 'SERVER_EXPIRY', 'SERVER_VALIDATION')"),
  tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE,
    "source IN ('MANUAL_DASHBOARD', 'SIGNED_DEVICE_INGRESS', 'SERVER_MAINTENANCE')"),
  tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE,
    "details = '{}'::jsonb")
  ,tinderFoundationCheck(TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE,
    ATTESTATION_AUDIT_ACTION_REASON_CHECK)
]);

function mapColumns(rows, relation) {
  return new Map(rows.filter(row => row.relation_name === relation).map(row => [row.column_name, {
    dataType: row.data_type,
    notNull: row.not_null === true,
    defaultExpression: canonicalTinderFoundationDefault(row.column_default)
  }]));
}

function exactColumns(actual, contract, defaults = {}) {
  if (actual.size !== Object.keys(contract).length) return false;
  return Object.entries(contract).every(([name, [dataType, notNull]]) => {
    const column = actual.get(name);
    return column?.dataType === dataType
      && column?.notNull === notNull
      && matchesTinderFoundationDefault(
        column.defaultExpression,
        defaults[name] ?? TINDER_FOUNDATION_DEFAULT.NONE
      );
  });
}

function relationKind(rows, relation) {
  const matches = rows.filter(row => row.relation_name === relation);
  return matches.length === 1 ? matches[0]?.relkind : null;
}

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

function indexMap(rows) {
  return new Map(rows.map(row => [row.index_name, row]));
}

function indexMatches(row, { unique, columns, descending, predicate = "" }) {
  return Boolean(row)
    && row.indisvalid === true && row.indisready === true && row.indisunique === unique
    && sameArray(row.column_names, columns) && sameArray(row.descending, descending)
    && canonicalSchemaPredicate(row.predicate) === canonicalSchemaPredicate(predicate);
}

function indexesCanonical(rows) {
  const indexes = indexMap(rows);
  return indexMatches(indexes.get("idx_tinder_visible_chat_sync_permit_active_device"), {
    unique: true, columns: ["device_id"], descending: [false],
    predicate: "permit_state IN ('ISSUED', 'STAGED')"
  }) && indexMatches(indexes.get("idx_tinder_visible_chat_sync_permit_device_expiry"), {
    unique: false, columns: ["device_id", "permit_state", "expires_at"], descending: [false, false, true]
  }) && indexMatches(indexes.get("idx_tinder_visible_chat_sync_permit_source_capture"), {
    unique: false, columns: ["source_capture_id", "created_at"], descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_official_app_resume_permit_active_device"), {
    unique: true, columns: ["device_id"], descending: [false], predicate: "permit_state = 'ISSUED'"
  }) && indexMatches(indexes.get("idx_tinder_official_app_resume_permit_source_created"), {
    unique: false, columns: ["source_capture_id", "created_at"], descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_official_app_resume_permit_binding_revision_created"), {
    unique: false, columns: ["binding_id", "binding_revision", "created_at"], descending: [false, false, true],
    predicate: "binding_id IS NOT NULL"
  }) && indexMatches(indexes.get("idx_tinder_visible_chat_sync_transcript_source_received"), {
    unique: false, columns: ["source_capture_id", "received_at"], descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_visible_chat_sync_transcript_device_received"), {
    unique: false, columns: ["device_id", "received_at"], descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_local_conversation_attestation_active_device"), {
    unique: true, columns: ["device_id"], descending: [false],
    predicate: "permit_state IN ('ISSUED', 'STAGED', 'ATTESTED')"
  }) && indexMatches(indexes.get("idx_tinder_local_conversation_attestation_device_expiry"), {
    unique: false, columns: ["device_id", "permit_state", "expires_at"], descending: [false, false, true]
  }) && indexMatches(indexes.get("idx_tinder_local_conversation_attestation_binding_created"), {
    unique: false, columns: ["binding_id", "binding_revision", "created_at"], descending: [false, false, true]
  }) && indexMatches(indexes.get("idx_tinder_local_conversation_attestation_audit_command_created"), {
    unique: false, columns: ["command_id", "created_at"], descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_visible_chat_sync_permit_attestation_binding_created"), {
    unique: false,
    columns: ["attestation_command_id", "binding_id", "binding_revision", "created_at"],
    descending: [false, false, false, true],
    predicate: "attestation_command_id IS NOT NULL"
  });
}

function newFoundationAbsent({ relations, columns, indexes, constraints }) {
  return NEW_RELATIONS.every(relation => relationKind(relations.rows, relation) === null
      && mapColumns(columns.rows, relation).size === 0)
    && NEW_INDEX_NAMES.every(name => !indexMap(indexes.rows).has(name))
    && constraints.rows.every(row => !NEW_RELATIONS.includes(row.table_name))
    && !mapColumns(columns.rows, VISIBLE_CHAT_SYNC_PERMIT_TABLE).has("permit_contract_version")
    && !mapColumns(columns.rows, VISIBLE_CHAT_SYNC_PERMIT_TABLE).has("attestation_command_id")
    && !mapColumns(columns.rows, VISIBLE_CHAT_SYNC_PERMIT_TABLE).has("binding_id")
    && !mapColumns(columns.rows, VISIBLE_CHAT_SYNC_PERMIT_TABLE).has("binding_revision");
}

async function readRelations(client) {
  return client.query(`
    SELECT c.relname AS relation_name, c.relkind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=current_schema()
       AND c.relname=ANY($1)
  `, [TARGET_RELATIONS]);
}

async function readColumns(client) {
  return client.query(`
    SELECT c.relname AS relation_name,
           a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '') AS column_default
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_attribute a ON a.attrelid=c.oid
 LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
     WHERE n.nspname=current_schema()
       AND c.relname=ANY($1)
       AND a.attnum>0
       AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum
  `, [TARGET_RELATIONS]);
}

async function readIndexes(client) {
  return client.query(`
    SELECT idx.relname AS index_name,
           i.indisunique,
           i.indisvalid,
           i.indisready,
           ARRAY(
             SELECT attribute.attname::text
               FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
               JOIN pg_attribute attribute
                 ON attribute.attrelid=i.indrelid
                AND attribute.attnum=key.attnum
              ORDER BY key.ordinality
           ) AS column_names,
           ARRAY(
             SELECT (option & 1)=1
               FROM unnest(i.indoption) WITH ORDINALITY AS option_value(option, ordinality)
              ORDER BY ordinality
           ) AS descending,
           COALESCE(pg_get_expr(i.indpred, i.indrelid, true), '') AS predicate
      FROM pg_index i
      JOIN pg_class idx ON idx.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=idx.relnamespace
     WHERE n.nspname=current_schema()
       AND idx.relname=ANY($1)
  `, [TARGET_INDEX_NAMES]);
}

async function commandConstraintState(client, inspectDeviceBridgeSchema) {
  const inspection = await inspectDeviceBridgeSchema(client);
  if (!inspection?.ready) return "INVALID";
  const command = inspection.constraints?.find(item => item.specification?.table === "device_bridge_commands"
    && item.specification?.column === "command_type");
  if (command?.constraintName === TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME) return "V5";
  if (command?.constraintName === TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE_CONSTRAINT_NAME) return "V6";
  return "INVALID";
}

function boundedInspectionError(code, message, error) {
  if (error?.code === "READ_ONLY_QUERY_REJECTED") throw error;
  const diagnostic = new Error(message);
  diagnostic.code = code;
  throw diagnostic;
}

async function countActiveVisibleChatSyncPermitV1Rows(client) {
  const result = await client.query(`
    SELECT COUNT(*)::text AS active_count
      FROM tinder_visible_chat_sync_permits
     WHERE permit_state IN ('ISSUED', 'STAGED')
       AND expires_at > NOW()
  `);
  const count = Number(result.rows[0]?.active_count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Tinder local conversation attestation active V1 permit state is unresolved.");
  }
  return count;
}

function activeV1PermitError() {
  const error = new Error("Tinder local conversation attestation has an active V1 visible-chat permit.");
  error.code = "TINDER_LOCAL_CONVERSATION_ATTESTATION_ACTIVE_V1_PERMIT";
  return error;
}

/** Reads catalog facts only. It never locks, writes, or repairs schema. */
export async function inspectTinderLocalConversationAttestationSchema(client, {
  inspectDeviceBridgeSchema = inspectDeviceBridgeT1Schema,
  inspectResumeV2Schema = inspectTinderOfficialAppResumePermitV2Schema
} = {}) {
  let relations;
  let columns;
  let indexes;
  let constraints;
  let commandState;
  try {
    [relations, columns, indexes, constraints, commandState] = await Promise.all([
      readRelations(client),
      readColumns(client),
      readIndexes(client),
      readTinderFoundationConstraints(client, TARGET_RELATIONS),
      commandConstraintState(client, inspectDeviceBridgeSchema)
    ]);
  } catch (error) {
    boundedInspectionError(
      TINDER_LOCAL_CONVERSATION_ATTESTATION_PREFLIGHT_ERROR_CODE.PREREQUISITE_INSPECTION_FAILED,
      "Tinder local conversation attestation prerequisite inspection failed.",
      error
    );
  }

  const catalog = { relations, columns, indexes, constraints };
  if (newFoundationAbsent(catalog)) {
    let legacyFoundation;
    try {
      legacyFoundation = await inspectResumeV2Schema(client);
    } catch (error) {
      boundedInspectionError(
        TINDER_LOCAL_CONVERSATION_ATTESTATION_PREFLIGHT_ERROR_CODE.PREREQUISITE_INSPECTION_FAILED,
        "Tinder local conversation attestation prerequisite inspection failed.",
        error
      );
    }
    // The fixed migration drops this exact V5 constraint. A semantically
    // similar renamed or later constraint is drift; never drop by inference.
    if (legacyFoundation.state !== TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.CANONICAL
        || commandState !== "V5") {
      return { state: TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.INVALID };
    }
    return { state: TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.UPGRADE_REQUIRED };
  }

  const canonical = commandState === "V6"
    && relationKind(relations.rows, VISIBLE_CHAT_SYNC_PERMIT_TABLE) === "r"
    && relationKind(relations.rows, OFFICIAL_APP_RESUME_PERMIT_TABLE) === "r"
    && relationKind(relations.rows, VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE) === "r"
    && relationKind(relations.rows, TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE) === "r"
    && relationKind(relations.rows, TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE) === "r"
    && exactColumns(mapColumns(columns.rows, VISIBLE_CHAT_SYNC_PERMIT_TABLE), VISIBLE_CHAT_SYNC_PERMIT_COLUMNS_V2, VISIBLE_CHAT_SYNC_PERMIT_DEFAULTS_V2)
    && exactColumns(mapColumns(columns.rows, OFFICIAL_APP_RESUME_PERMIT_TABLE), OFFICIAL_APP_RESUME_PERMIT_COLUMNS_V2, OFFICIAL_APP_RESUME_PERMIT_DEFAULTS_V2)
    && exactColumns(mapColumns(columns.rows, VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE), VISIBLE_CHAT_SYNC_TRANSCRIPT_COLUMNS, VISIBLE_CHAT_SYNC_TRANSCRIPT_DEFAULTS)
    && exactColumns(mapColumns(columns.rows, TINDER_LOCAL_CONVERSATION_ATTESTATION_PERMIT_TABLE), ATTESTATION_PERMIT_COLUMNS, ATTESTATION_PERMIT_DEFAULTS)
    && exactColumns(mapColumns(columns.rows, TINDER_LOCAL_CONVERSATION_ATTESTATION_AUDIT_TABLE), ATTESTATION_AUDIT_COLUMNS, ATTESTATION_AUDIT_DEFAULTS)
    && indexesCanonical(indexes.rows)
    && hasExpectedTinderFoundationConstraints(
      constraints.rows,
      TINDER_LOCAL_CONVERSATION_ATTESTATION_CONSTRAINT_CONTRACT,
      { exactTables: TARGET_RELATIONS }
    );
  return {
    state: canonical
      ? TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.CANONICAL
      : TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.INVALID
  };
}

/** Read-only, rollback-only gate before the fixed explicit migration. */
export async function preflightTinderLocalConversationAttestationMigration(client, options) {
  const foundation = await inspectTinderLocalConversationAttestationSchema(client, options);
  if (foundation.state === TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.INVALID) {
    throw new Error("Tinder local conversation attestation schema is incompatible.");
  }
  if (foundation.state === TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.UPGRADE_REQUIRED) {
    let activeCount;
    try {
      activeCount = await countActiveVisibleChatSyncPermitV1Rows(client);
    } catch (error) {
      boundedInspectionError(
        TINDER_LOCAL_CONVERSATION_ATTESTATION_PREFLIGHT_ERROR_CODE.ACTIVE_V1_PERMIT_CHECK_FAILED,
        "Tinder local conversation attestation active V1 permit inspection failed.",
        error
      );
    }
    if (activeCount > 0) throw activeV1PermitError();
  }
  return {
    foundation,
    mutate: foundation.state === TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.UPGRADE_REQUIRED
  };
}

export async function assertTinderLocalConversationAttestationSchemaReady(client, options) {
  const inspection = await inspectTinderLocalConversationAttestationSchema(client, options);
  if (inspection.state !== TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.CANONICAL) {
    throw new Error("Tinder local conversation attestation schema is not ready.");
  }
  return inspection;
}
