import {
  assertHumanArmedConversationBindingFoundationSchemaReady
} from "./tinder-human-armed-conversation-binding-foundation-schema.js";
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
  TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME,
  T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CONSTRAINT_NAME,
  T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME
} from "./t1-schema.js";

/* ==================================================
TINDER V4 VISIBLE-CHAT SYNC PERMIT — SCHEMA CONTRACT

This is a separate device/command-scoped permit plus an identity-free bounded
transcript relation. The source capture is selected server-side from an
already confirmed conversation; Android provides no capture, contact, binding,
name, thread, or conversation reference. Its only hash is a command-scoped
transcript integrity/dedupe value. This module has no ingress or DDL authority.
================================================== */

export const TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE = Object.freeze({
  ABSENT: "ABSENT",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

// V2 is an additive, explicitly migrated upgrade of only the launcher-only
// permit relation.  V4's sync and transcript contracts stay untouched.  The
// version marker makes a new permit's binding snapshot auditable without
// reinterpreting or mutating any historical V1 permit.
export const TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION = Object.freeze({
  V1: 1,
  V2: 2
});
export const TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE = Object.freeze({
  UPGRADE_REQUIRED: "UPGRADE_REQUIRED",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});
// These codes are intentionally finite and content-free. They let the
// explicit read-only V2 preflight distinguish its fixed validation boundaries
// without exposing catalog definitions, rows, identifiers, or database error
// text to its operational output.
export const TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_PREFLIGHT_ERROR_CODE = Object.freeze({
  PREREQUISITE_INSPECTION_FAILED:
    "TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_PREREQUISITE_INSPECTION_FAILED",
  V1_CONSTRAINT_INSPECTION_FAILED:
    "TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_V1_CONSTRAINT_INSPECTION_FAILED",
  ACTIVE_LEGACY_PERMIT_CHECK_FAILED:
    "TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT_CHECK_FAILED"
});

export const TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE = "tinder_visible_chat_sync_permits";
export const TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE = "tinder_visible_chat_sync_transcripts";
export const TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE = "tinder_official_app_resume_permits";
const TINDER_OFFICIAL_APP_RESUME_PERMIT_V1_SOURCE_CAPTURE_UNIQUE_CONSTRAINT =
  "tinder_official_app_resume_permits_source_capture_id_key";

const TARGET_RELATIONS = Object.freeze([
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE,
  TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE
]);
const TARGET_INDEX_NAMES = Object.freeze([
  "idx_tinder_visible_chat_sync_permit_active_device",
  "idx_tinder_visible_chat_sync_permit_device_expiry",
  "idx_tinder_visible_chat_sync_permit_source_capture",
  "idx_tinder_official_app_resume_permit_active_device",
  "idx_tinder_official_app_resume_permit_source_created",
  "idx_tinder_official_app_resume_permit_binding_revision_created",
  "idx_tinder_visible_chat_sync_transcript_source_received",
  "idx_tinder_visible_chat_sync_transcript_device_received"
]);

const PERMIT_COLUMNS = Object.freeze({
  command_id: ["uuid", true],
  device_id: ["uuid", true],
  source_capture_id: ["uuid", true],
  permit_state: ["text", true],
  issued_at: ["timestamp with time zone", true],
  expires_at: ["timestamp with time zone", true],
  staged_at: ["timestamp with time zone", false],
  consumed_at: ["timestamp with time zone", false],
  closed_at: ["timestamp with time zone", false],
  created_at: ["timestamp with time zone", true],
  updated_at: ["timestamp with time zone", true]
});

const TRANSCRIPT_COLUMNS = Object.freeze({
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

const OFFICIAL_APP_RESUME_PERMIT_COLUMNS_V1 = Object.freeze({
  command_id: ["uuid", true],
  device_id: ["uuid", true],
  source_capture_id: ["uuid", true],
  permit_state: ["text", true],
  issued_at: ["timestamp with time zone", true],
  expires_at: ["timestamp with time zone", true],
  dispatched_at: ["timestamp with time zone", false],
  closed_at: ["timestamp with time zone", false],
  created_at: ["timestamp with time zone", true],
  updated_at: ["timestamp with time zone", true]
});

const OFFICIAL_APP_RESUME_PERMIT_COLUMNS_V2 = Object.freeze({
  command_id: ["uuid", true],
  device_id: ["uuid", true],
  source_capture_id: ["uuid", true],
  // Historical V1 permits remain immutable and therefore have no binding
  // snapshot.  The V2 check constraint requires these facts for every newly
  // issued V2 permit.
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

const PERMIT_DEFAULTS = Object.freeze({
  permit_state: "'ISSUED'",
  issued_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW,
  updated_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const TRANSCRIPT_DEFAULTS = Object.freeze({
  received_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const OFFICIAL_APP_RESUME_PERMIT_DEFAULTS_V1 = Object.freeze({
  permit_state: "'ISSUED'",
  issued_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW,
  updated_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const OFFICIAL_APP_RESUME_PERMIT_DEFAULTS_V2 = Object.freeze({
  ...OFFICIAL_APP_RESUME_PERMIT_DEFAULTS_V1
});

export const TINDER_VISIBLE_CHAT_SYNC_PERMIT_CONSTRAINT_CONTRACT = Object.freeze([
  tinderFoundationKey(TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE, "p", ["command_id"], "PRIMARY KEY (command_id)"),
  tinderFoundationKey(TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE, "f", ["command_id"], "FOREIGN KEY (command_id) REFERENCES device_bridge_commands(command_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_commands", referenceColumns: ["command_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE, "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE, "f", ["source_capture_id"], "FOREIGN KEY (source_capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE, "u", ["command_id", "device_id", "source_capture_id"], "UNIQUE (command_id, device_id, source_capture_id)"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE,
    "permit_state IN ('ISSUED', 'STAGED', 'CONSUMED', 'EXPIRED', 'CANCELLED')"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE, "expires_at > issued_at"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE,
    "(permit_state = 'ISSUED' AND staged_at IS NULL AND consumed_at IS NULL AND closed_at IS NULL) OR (permit_state = 'STAGED' AND staged_at IS NOT NULL AND consumed_at IS NULL AND closed_at IS NULL) OR (permit_state = 'CONSUMED' AND staged_at IS NOT NULL AND consumed_at IS NOT NULL AND closed_at IS NULL) OR (permit_state IN ('EXPIRED', 'CANCELLED') AND consumed_at IS NULL AND closed_at IS NOT NULL)"),

  tinderFoundationKey(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE, "p", ["command_id"], "PRIMARY KEY (command_id)"),
  tinderFoundationKey(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE, "f", ["command_id"], "FOREIGN KEY (command_id) REFERENCES device_bridge_commands(command_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_commands", referenceColumns: ["command_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE, "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE, "f", ["source_capture_id"], "FOREIGN KEY (source_capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE, "u", ["command_id", "device_id", "source_capture_id"], "UNIQUE (command_id, device_id, source_capture_id)"),
  tinderFoundationKey(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE, "u", ["source_capture_id"], "UNIQUE (source_capture_id)"),
  tinderFoundationCheck(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE,
    "permit_state IN ('ISSUED', 'DISPATCHED', 'EXPIRED', 'CANCELLED')"),
  tinderFoundationCheck(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE, "expires_at > issued_at"),
  tinderFoundationCheck(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE,
    "(permit_state = 'ISSUED' AND dispatched_at IS NULL AND closed_at IS NULL) OR (permit_state = 'DISPATCHED' AND dispatched_at IS NOT NULL AND closed_at IS NULL) OR (permit_state IN ('EXPIRED', 'CANCELLED') AND dispatched_at IS NULL AND closed_at IS NOT NULL)"),

  tinderFoundationKey(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "p", ["sync_id"], "PRIMARY KEY (sync_id)"),
  tinderFoundationKey(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "u", ["command_id"], "UNIQUE (command_id)"),
  tinderFoundationKey(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "f", ["command_id", "device_id", "source_capture_id"], "FOREIGN KEY (command_id, device_id, source_capture_id) REFERENCES tinder_visible_chat_sync_permits(command_id, device_id, source_capture_id) ON DELETE RESTRICT", {
    referenceTable: TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE,
    referenceColumns: ["command_id", "device_id", "source_capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "sync_schema_version = 'tinder-visible-chat-sync-v1'"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "source_package = 'com.tinder'"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "layout_schema_version = 'tinder-zte-visible-chat-scroll-v1'"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "initial_visible_node_count > 0"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "final_visible_node_count > 0"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "segment_count BETWEEN 1 AND 8", "segment_count >= 1 AND segment_count <= 8"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "overlap_count BETWEEN 0 AND 100", "overlap_count >= 0 AND overlap_count <= 100"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "transcript_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "jsonb_typeof(visible_messages) = 'array'"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "jsonb_array_length(visible_messages) BETWEEN 1 AND 100", "jsonb_array_length(visible_messages) >= 1 AND jsonb_array_length(visible_messages) <= 100"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "sync_safety_status = 'SAFE'"),
  tinderFoundationCheck(TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE, "sync_completed_at >= sync_started_at")
]);

export const TINDER_VISIBLE_CHAT_SYNC_PERMIT_V2_CONSTRAINT_CONTRACT = Object.freeze([
  ...TINDER_VISIBLE_CHAT_SYNC_PERMIT_CONSTRAINT_CONTRACT.filter(contract => !(
    contract.table === TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE
    && contract.type === "u"
    && Array.isArray(contract.columns)
    && contract.columns.length === 1
    && contract.columns[0] === "source_capture_id"
  )),
  // The V1 source uniqueness is deliberately absent above.  A fresh V2
  // permit is a new audit record, not a reuse of the historic source permit.
  tinderFoundationKey(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE, "f", ["binding_id"],
    "FOREIGN KEY (binding_id) REFERENCES contact_human_armed_conversation_bindings(binding_id) ON DELETE RESTRICT", {
      referenceTable: "contact_human_armed_conversation_bindings", referenceColumns: ["binding_id"], deleteAction: "r", updateAction: "a"
    }),
  tinderFoundationCheck(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE,
    "permit_contract_version IN (1, 2)"),
  tinderFoundationCheck(TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE,
    "(permit_contract_version = 1 AND binding_id IS NULL AND binding_revision IS NULL) OR (permit_contract_version = 2 AND binding_id IS NOT NULL AND binding_revision IS NOT NULL AND binding_revision > 0)")
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

function indexesCanonical(rows, { resumePermitVersion = TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V1 } = {}) {
  const indexes = indexMap(rows);
  const shared = indexMatches(indexes.get("idx_tinder_visible_chat_sync_permit_active_device"), {
    unique: true,
    columns: ["device_id"],
    descending: [false],
    predicate: "permit_state IN ('ISSUED', 'STAGED')"
  }) && indexMatches(indexes.get("idx_tinder_visible_chat_sync_permit_device_expiry"), {
    unique: false,
    columns: ["device_id", "permit_state", "expires_at"],
    descending: [false, false, true]
  }) && indexMatches(indexes.get("idx_tinder_visible_chat_sync_permit_source_capture"), {
    unique: false,
    columns: ["source_capture_id", "created_at"],
    descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_official_app_resume_permit_active_device"), {
    unique: true,
    columns: ["device_id"],
    descending: [false],
    predicate: "permit_state = 'ISSUED'"
  }) && indexMatches(indexes.get("idx_tinder_official_app_resume_permit_source_created"), {
    unique: false,
    columns: ["source_capture_id", "created_at"],
    descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_visible_chat_sync_transcript_source_received"), {
    unique: false,
    columns: ["source_capture_id", "received_at"],
    descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_visible_chat_sync_transcript_device_received"), {
    unique: false,
    columns: ["device_id", "received_at"],
    descending: [false, true]
  });
  if (!shared) return false;
  const bindingRevisionIndex = indexes.get("idx_tinder_official_app_resume_permit_binding_revision_created");
  if (resumePermitVersion === TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V1) {
    return !bindingRevisionIndex;
  }
  return resumePermitVersion === TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V2
    && indexMatches(bindingRevisionIndex, {
      unique: false,
      columns: ["binding_id", "binding_revision", "created_at"],
      descending: [false, false, true],
      predicate: "binding_id IS NOT NULL"
    });
}

function indexesAbsent(rows) {
  const indexes = indexMap(rows);
  return TARGET_INDEX_NAMES.every(name => !indexes.has(name));
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
  if (command?.constraintName === T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME) return "V3";
  if (command?.constraintName === T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CONSTRAINT_NAME) return "V4";
  if (command?.constraintName === TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME) return "V5";
  return "INVALID";
}

/** Reads catalog facts only; it never creates or repairs schema. */
export async function inspectTinderVisibleChatSyncPermitSchema(client, {
  assertHumanArmedFoundationReady = assertHumanArmedConversationBindingFoundationSchemaReady,
  inspectDeviceBridgeSchema = inspectDeviceBridgeT1Schema
} = {}) {
  await assertHumanArmedFoundationReady(client);
  const commandState = await commandConstraintState(client, inspectDeviceBridgeSchema);
  const relations = await readRelations(client);
  const columns = await readColumns(client);
  const indexes = await readIndexes(client);
  const constraints = await readTinderFoundationConstraints(client, TARGET_RELATIONS);
  const permit = mapColumns(columns.rows, TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE);
  const resumePermit = mapColumns(columns.rows, TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE);
  const transcript = mapColumns(columns.rows, TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE);
  const permitKind = relationKind(relations.rows, TINDER_VISIBLE_CHAT_SYNC_PERMIT_TABLE);
  const resumePermitKind = relationKind(relations.rows, TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE);
  const transcriptKind = relationKind(relations.rows, TINDER_VISIBLE_CHAT_SYNC_TRANSCRIPT_TABLE);
  const allAbsent = permitKind === null && permit.size === 0
    && resumePermitKind === null && resumePermit.size === 0
    && transcriptKind === null && transcript.size === 0
    && indexesAbsent(indexes.rows) && constraints.rows.length === 0;
  if (allAbsent && commandState === "V3") {
    return { state: TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.ABSENT };
  }

  const v1Canonical = commandState === "V5"
    && permitKind === "r"
    && resumePermitKind === "r"
    && transcriptKind === "r"
    && exactColumns(permit, PERMIT_COLUMNS, PERMIT_DEFAULTS)
    && exactColumns(resumePermit, OFFICIAL_APP_RESUME_PERMIT_COLUMNS_V1, OFFICIAL_APP_RESUME_PERMIT_DEFAULTS_V1)
    && exactColumns(transcript, TRANSCRIPT_COLUMNS, TRANSCRIPT_DEFAULTS)
    && indexesCanonical(indexes.rows, {
      resumePermitVersion: TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V1
    })
    && hasExpectedTinderFoundationConstraints(
      constraints.rows,
      TINDER_VISIBLE_CHAT_SYNC_PERMIT_CONSTRAINT_CONTRACT,
      { exactTables: TARGET_RELATIONS }
    );
  const v2Canonical = commandState === "V5"
    && permitKind === "r"
    && resumePermitKind === "r"
    && transcriptKind === "r"
    && exactColumns(permit, PERMIT_COLUMNS, PERMIT_DEFAULTS)
    && exactColumns(resumePermit, OFFICIAL_APP_RESUME_PERMIT_COLUMNS_V2, OFFICIAL_APP_RESUME_PERMIT_DEFAULTS_V2)
    && exactColumns(transcript, TRANSCRIPT_COLUMNS, TRANSCRIPT_DEFAULTS)
    && indexesCanonical(indexes.rows, {
      resumePermitVersion: TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V2
    })
    && hasExpectedTinderFoundationConstraints(
      constraints.rows,
      TINDER_VISIBLE_CHAT_SYNC_PERMIT_V2_CONSTRAINT_CONTRACT,
      { exactTables: TARGET_RELATIONS }
    );
  return {
    state: v1Canonical || v2Canonical
      ? TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.CANONICAL
      : TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.INVALID,
    ...(v1Canonical ? { official_app_resume_permit_schema_version: TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V1 } : {}),
    ...(v2Canonical ? { official_app_resume_permit_schema_version: TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V2 } : {})
  };
}

export async function preflightTinderVisibleChatSyncPermitMigration(client, options) {
  const foundation = await inspectTinderVisibleChatSyncPermitSchema(client, options);
  if (foundation.state === TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.INVALID) {
    throw new Error("Tinder visible-chat sync permit schema is incompatible.");
  }
  return { foundation, mutate: foundation.state === TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.ABSENT };
}

export async function assertTinderVisibleChatSyncPermitSchemaReady(client, options) {
  const inspection = await inspectTinderVisibleChatSyncPermitSchema(client, options);
  if (inspection.state !== TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.CANONICAL) {
    throw new Error("Tinder visible-chat sync permit schema is not ready.");
  }
  return inspection;
}

/**
 * Read-only recognition of the narrow V2 launcher-permit upgrade.  It keeps
 * V4's existing foundation valid in either reviewed version, while the V2
 * runner itself may mutate only the canonical V1 predecessor.
 */
async function hasExpectedOfficialAppResumePermitV1SourceCaptureUniqueConstraint(client) {
  const result = await client.query(
    `SELECT EXISTS (
       SELECT 1
         FROM pg_constraint c
         JOIN pg_class relation ON relation.oid=c.conrelid
         JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
        WHERE namespace.nspname=current_schema()
          AND relation.relname=$1
          AND c.conname=$2
          AND c.contype='u'
          AND c.convalidated
          AND NOT c.condeferrable
          AND NOT c.condeferred
          AND ARRAY(
            SELECT attribute.attname::text
              FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
              JOIN pg_attribute attribute
                ON attribute.attrelid=c.conrelid
               AND attribute.attnum=key.attnum
             ORDER BY key.ordinality
          ) = ARRAY['source_capture_id']::text[]
     ) AS canonical`,
    [
      TINDER_OFFICIAL_APP_RESUME_PERMIT_TABLE,
      TINDER_OFFICIAL_APP_RESUME_PERMIT_V1_SOURCE_CAPTURE_UNIQUE_CONSTRAINT
    ]
  );
  return result.rows.length === 1 && result.rows[0]?.canonical === true;
}

function activeLegacyPermitError() {
  const error = new Error("Tinder official-app resume permit V2 has an active legacy permit.");
  error.code = "TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_ACTIVE_LEGACY_PERMIT";
  return error;
}

function preflightInspectionError(code, message, error) {
  // The read-only guard is already a bounded operational reason. Do not hide
  // it behind a catalog stage if a future fixed query accidentally violates
  // that guard.
  if (error?.code === "READ_ONLY_QUERY_REJECTED") throw error;
  const diagnostic = new Error(message);
  diagnostic.code = code;
  throw diagnostic;
}

async function countActiveOfficialAppResumePermitV1Rows(client) {
  const result = await client.query(
    `SELECT COUNT(*)::text AS active_count
       FROM tinder_official_app_resume_permits
      WHERE permit_state='ISSUED'
        AND expires_at>NOW()`,
    []
  );
  const count = Number(result.rows[0]?.active_count);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Tinder official-app resume permit V2 active legacy state is unresolved.");
  }
  return count;
}

export async function inspectTinderOfficialAppResumePermitV2Schema(client, {
  hasExpectedV1SourceCaptureUniqueConstraint = hasExpectedOfficialAppResumePermitV1SourceCaptureUniqueConstraint,
  ...visibleChatSyncOptions
} = {}) {
  let foundation;
  try {
    foundation = await inspectTinderVisibleChatSyncPermitSchema(client, visibleChatSyncOptions);
  } catch (error) {
    preflightInspectionError(
      TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_PREFLIGHT_ERROR_CODE.PREREQUISITE_INSPECTION_FAILED,
      "Tinder official-app resume permit V2 prerequisite inspection failed.",
      error
    );
  }
  if (foundation.state !== TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.CANONICAL) {
    return { state: TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.INVALID, foundation };
  }
  let hasExpectedV1SourceCaptureConstraint = false;
  if (foundation.official_app_resume_permit_schema_version
      === TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V1) {
    try {
      hasExpectedV1SourceCaptureConstraint = await hasExpectedV1SourceCaptureUniqueConstraint(client);
    } catch (error) {
      preflightInspectionError(
        TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_PREFLIGHT_ERROR_CODE.V1_CONSTRAINT_INSPECTION_FAILED,
        "Tinder official-app resume permit V2 V1 constraint inspection failed.",
        error
      );
    }
  }
  if (foundation.official_app_resume_permit_schema_version
      === TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V1
      && !hasExpectedV1SourceCaptureConstraint) {
    // The fixed V2 migration must hard-drop this exact V1 constraint. A
    // semantically similar renamed constraint is drift, not a safe upgrade.
    return { state: TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.INVALID, foundation };
  }
  return {
    state: foundation.official_app_resume_permit_schema_version
      === TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V2
      ? TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.CANONICAL
      : TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.UPGRADE_REQUIRED,
    foundation
  };
}

export async function preflightTinderOfficialAppResumePermitV2Migration(client, options) {
  const foundation = await inspectTinderOfficialAppResumePermitV2Schema(client, options);
  if (foundation.state === TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.INVALID) {
    throw new Error("Tinder official-app resume permit V2 schema is incompatible.");
  }
  let activeLegacyPermitCount = 0;
  if (foundation.state === TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.UPGRADE_REQUIRED) {
    try {
      activeLegacyPermitCount = await countActiveOfficialAppResumePermitV1Rows(client);
    } catch (error) {
      preflightInspectionError(
        TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_PREFLIGHT_ERROR_CODE.ACTIVE_LEGACY_PERMIT_CHECK_FAILED,
        "Tinder official-app resume permit V2 active legacy permit check failed.",
        error
      );
    }
  }
  if (foundation.state === TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.UPGRADE_REQUIRED
      && activeLegacyPermitCount > 0) {
    // An unacknowledged V1 launcher must never be reinterpreted as V2. The
    // caller waits for its finite expiry or terminal ACK, then re-runs a new
    // read-only preflight; it may not reset or replay the legacy row.
    throw activeLegacyPermitError();
  }
  return {
    foundation,
    mutate: foundation.state === TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.UPGRADE_REQUIRED
  };
}

export async function assertTinderOfficialAppResumePermitV2SchemaReady(client, options) {
  const inspection = await inspectTinderOfficialAppResumePermitV2Schema(client, options);
  if (inspection.state !== TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.CANONICAL) {
    throw new Error("Tinder official-app resume permit V2 schema is not ready.");
  }
  return inspection;
}
