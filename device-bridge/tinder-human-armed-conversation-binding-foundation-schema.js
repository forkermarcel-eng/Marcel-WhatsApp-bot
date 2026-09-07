import {
  assertContactConversationBindingFoundationSchemaReady
} from "./contact-conversation-binding-foundation-schema.js";
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
  T1_COMMAND_TYPE_CONSTRAINT_NAME,
  T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME,
  T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME
} from "./t1-schema.js";

/* ==================================================
T2 HUMAN-ARMED CONVERSATION BINDING — SCHEMA CONTRACT

This is a distinct authority from source-observed V2 conversation evidence.
It owns only a durable human-confirmed association plus a server-issued,
device-bound, one-use command permit.  It never turns display data, message
text, capture/runtime fingerprints, or a Tinder UI value into identity.
================================================== */

export const HUMAN_ARMED_CONVERSATION_BINDING_FOUNDATION_STATE = Object.freeze({
  ABSENT: "ABSENT",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

export const HUMAN_ARMED_CONVERSATION_BINDING_TABLE =
  "contact_human_armed_conversation_bindings";
export const HUMAN_ARMED_CONVERSATION_PERMIT_TABLE =
  "contact_human_armed_conversation_binding_permits";
export const HUMAN_ARMED_CONVERSATION_AUDIT_TABLE =
  "contact_human_armed_conversation_binding_audit";

const TARGET_RELATIONS = Object.freeze([
  HUMAN_ARMED_CONVERSATION_BINDING_TABLE,
  HUMAN_ARMED_CONVERSATION_PERMIT_TABLE,
  HUMAN_ARMED_CONVERSATION_AUDIT_TABLE
]);

const TARGET_INDEX_NAMES = Object.freeze([
  "idx_human_armed_conversation_binding_active_device_ref",
  "idx_human_armed_conversation_binding_active_unscoped_ref",
  "idx_human_armed_conversation_binding_contact_state",
  "idx_human_armed_conversation_binding_source_capture",
  "idx_harmed_conv_binding_permit_state_expiry",
  "idx_harmed_conv_binding_permit_consumed_capture",
  "idx_human_armed_conversation_binding_audit_binding_time",
  "idx_human_armed_conversation_binding_audit_capture_time"
]);

const BINDING_COLUMNS = Object.freeze({
  binding_id: ["uuid", true],
  channel: ["text", true],
  reference_kind: ["text", true],
  reference_hash: ["character(64)", true],
  device_id: ["uuid", false],
  contact_id: ["integer", true],
  source_capture_id: ["uuid", false],
  binding_state: ["text", true],
  binding_revision: ["integer", true],
  human_verified: ["boolean", true],
  verification_source: ["text", true],
  verified_by: ["text", true],
  verified_at: ["timestamp with time zone", true],
  revoked_by: ["text", false],
  revoked_at: ["timestamp with time zone", false],
  revocation_reason: ["text", false],
  created_at: ["timestamp with time zone", true],
  updated_at: ["timestamp with time zone", true]
});

const PERMIT_COLUMNS = Object.freeze({
  command_id: ["uuid", true],
  binding_id: ["uuid", true],
  device_id: ["uuid", true],
  binding_revision: ["integer", true],
  permit_state: ["text", true],
  issued_at: ["timestamp with time zone", true],
  expires_at: ["timestamp with time zone", true],
  consumed_at: ["timestamp with time zone", false],
  consumed_capture_id: ["uuid", false],
  created_at: ["timestamp with time zone", true],
  updated_at: ["timestamp with time zone", true]
});

const AUDIT_COLUMNS = Object.freeze({
  audit_id: ["bigint", true],
  binding_id: ["uuid", true],
  capture_id: ["uuid", false],
  action: ["text", true],
  actor: ["text", true],
  source: ["text", true],
  old_contact_id: ["integer", false],
  new_contact_id: ["integer", false],
  old_binding_revision: ["integer", false],
  new_binding_revision: ["integer", false],
  reason_code: ["text", false],
  details: ["jsonb", true],
  created_at: ["timestamp with time zone", true]
});

const BINDING_DEFAULTS = Object.freeze({
  binding_state: "'CONFIRMED'",
  binding_revision: "1",
  human_verified: "true",
  verification_source: "'manual_dashboard'",
  verified_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW,
  updated_at: TINDER_FOUNDATION_DEFAULT.NOW
});
const PERMIT_DEFAULTS = Object.freeze({
  permit_state: "'ISSUED'",
  issued_at: TINDER_FOUNDATION_DEFAULT.NOW,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW,
  updated_at: TINDER_FOUNDATION_DEFAULT.NOW
});
const AUDIT_DEFAULTS = Object.freeze({
  audit_id: TINDER_FOUNDATION_DEFAULT.BIGSERIAL,
  source: "'manual_dashboard'",
  details: TINDER_FOUNDATION_DEFAULT.EMPTY_JSON_OBJECT,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const SENSITIVE_AUDIT_KEYS = "'reference_hash', 'reference_token', 'permit_id', 'command_id', 'raw_unique_id', 'visible_name', 'message_text', 'capture_fingerprint', 'runtime_thread_fingerprint'";

export const HUMAN_ARMED_CONVERSATION_BINDING_CONSTRAINT_CONTRACT = Object.freeze([
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_BINDING_TABLE, "p", ["binding_id"], "PRIMARY KEY (binding_id)"),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_BINDING_TABLE, "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_BINDING_TABLE, "f", ["contact_id"], "FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_BINDING_TABLE, "f", ["source_capture_id"], "FOREIGN KEY (source_capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_BINDING_TABLE, "channel IN ('tinder', 'whatsapp')"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_BINDING_TABLE, "reference_hash ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_BINDING_TABLE, "binding_state IN ('CONFIRMED', 'REVOKED')"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_BINDING_TABLE, "binding_revision > 0"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_BINDING_TABLE, "human_verified = TRUE"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_BINDING_TABLE, "verification_source = 'manual_dashboard'"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_BINDING_TABLE,
    "char_length(verified_by) BETWEEN 1 AND 80",
    "char_length(verified_by) >= 1 AND char_length(verified_by) <= 80"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_BINDING_TABLE,
    "(channel = 'tinder' AND reference_kind = 'tinder_human_armed_conversation_v1' AND device_id IS NOT NULL AND source_capture_id IS NOT NULL) OR (channel = 'whatsapp' AND reference_kind = 'whatsapp_human_armed_conversation_ref_v1' AND device_id IS NULL AND source_capture_id IS NULL)"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_BINDING_TABLE,
    "(binding_state = 'CONFIRMED' AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL) OR (binding_state = 'REVOKED' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revocation_reason IN ('HUMAN_REVOKED', 'CONFLICT_SUPERSEDED'))"),

  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_PERMIT_TABLE, "p", ["command_id"], "PRIMARY KEY (command_id)"),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_PERMIT_TABLE, "f", ["command_id"], "FOREIGN KEY (command_id) REFERENCES device_bridge_commands(command_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_commands", referenceColumns: ["command_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_PERMIT_TABLE, "f", ["binding_id"], `FOREIGN KEY (binding_id) REFERENCES ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE}(binding_id) ON DELETE RESTRICT`, {
    referenceTable: HUMAN_ARMED_CONVERSATION_BINDING_TABLE, referenceColumns: ["binding_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_PERMIT_TABLE, "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_PERMIT_TABLE, "f", ["consumed_capture_id"], "FOREIGN KEY (consumed_capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_PERMIT_TABLE, "binding_revision > 0"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_PERMIT_TABLE, "permit_state IN ('ISSUED', 'CONSUMED')"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_PERMIT_TABLE, "expires_at > issued_at"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_PERMIT_TABLE,
    "(permit_state = 'ISSUED' AND consumed_at IS NULL AND consumed_capture_id IS NULL) OR (permit_state = 'CONSUMED' AND consumed_at IS NOT NULL AND consumed_capture_id IS NOT NULL)"),

  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE, "p", ["audit_id"], "PRIMARY KEY (audit_id)"),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE, "f", ["binding_id"], `FOREIGN KEY (binding_id) REFERENCES ${HUMAN_ARMED_CONVERSATION_BINDING_TABLE}(binding_id) ON DELETE RESTRICT`, {
    referenceTable: HUMAN_ARMED_CONVERSATION_BINDING_TABLE, referenceColumns: ["binding_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE, "f", ["capture_id"], "FOREIGN KEY (capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE, "f", ["old_contact_id"], "FOREIGN KEY (old_contact_id) REFERENCES contacts(id) ON DELETE SET NULL", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "n", updateAction: "a"
  }),
  tinderFoundationKey(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE, "f", ["new_contact_id"], "FOREIGN KEY (new_contact_id) REFERENCES contacts(id) ON DELETE SET NULL", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "n", updateAction: "a"
  }),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE, "action IN ('CREATE', 'ARM_ISSUED', 'PERMIT_CONSUMED', 'REVOKE', 'CONFLICT_BLOCKED')"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE,
    "char_length(actor) BETWEEN 1 AND 80",
    "char_length(actor) >= 1 AND char_length(actor) <= 80"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE, "source = 'manual_dashboard'"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE, "old_binding_revision IS NULL OR old_binding_revision > 0"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE, "new_binding_revision IS NULL OR new_binding_revision > 0"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE, "jsonb_typeof(details) = 'object'"),
  tinderFoundationCheck(HUMAN_ARMED_CONVERSATION_AUDIT_TABLE,
    `NOT (details ?| ARRAY[${SENSITIVE_AUDIT_KEYS}])`,
    // PostgreSQL may deparse the unary NOT without its immediate wrapping
    // parentheses. Both fixed forms protect the same complete key set.
    `NOT details ?| ARRAY[${SENSITIVE_AUDIT_KEYS}]`)
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
      && matchesTinderFoundationDefault(column.defaultExpression, defaults[name] ?? TINDER_FOUNDATION_DEFAULT.NONE);
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
  return indexMatches(indexes.get("idx_human_armed_conversation_binding_active_device_ref"), {
    unique: true,
    columns: ["channel", "reference_kind", "device_id", "reference_hash"],
    descending: [false, false, false, false],
    predicate: "binding_state = 'CONFIRMED' AND device_id IS NOT NULL"
  }) && indexMatches(indexes.get("idx_human_armed_conversation_binding_active_unscoped_ref"), {
    unique: true,
    columns: ["channel", "reference_kind", "reference_hash"],
    descending: [false, false, false],
    predicate: "binding_state = 'CONFIRMED' AND device_id IS NULL"
  }) && indexMatches(indexes.get("idx_human_armed_conversation_binding_contact_state"), {
    unique: false,
    columns: ["contact_id", "binding_state", "updated_at"],
    descending: [false, false, true]
  }) && indexMatches(indexes.get("idx_human_armed_conversation_binding_source_capture"), {
    unique: false,
    columns: ["source_capture_id"],
    descending: [false],
    predicate: "source_capture_id IS NOT NULL"
  }) && indexMatches(indexes.get("idx_harmed_conv_binding_permit_state_expiry"), {
    unique: false,
    columns: ["binding_id", "device_id", "permit_state", "expires_at"],
    descending: [false, false, false, true]
  }) && indexMatches(indexes.get("idx_harmed_conv_binding_permit_consumed_capture"), {
    unique: true,
    columns: ["consumed_capture_id"],
    descending: [false],
    predicate: "consumed_capture_id IS NOT NULL"
  }) && indexMatches(indexes.get("idx_human_armed_conversation_binding_audit_binding_time"), {
    unique: false,
    columns: ["binding_id", "created_at"],
    descending: [false, true]
  }) && indexMatches(indexes.get("idx_human_armed_conversation_binding_audit_capture_time"), {
    unique: false,
    columns: ["capture_id", "created_at"],
    descending: [false, true],
    predicate: "capture_id IS NOT NULL"
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
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema()
       AND c.relname = ANY($1)
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
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
 LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = current_schema()
       AND c.relname = ANY($1)
       AND a.attnum > 0
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
                 ON attribute.attrelid = i.indrelid
                AND attribute.attnum = key.attnum
              ORDER BY key.ordinality
           ) AS column_names,
           ARRAY(
             SELECT (option & 1) = 1
               FROM unnest(i.indoption) WITH ORDINALITY AS option_value(option, ordinality)
              ORDER BY ordinality
           ) AS descending,
           COALESCE(pg_get_expr(i.indpred, i.indrelid, true), '') AS predicate
      FROM pg_index i
      JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
     WHERE n.nspname = current_schema()
       AND idx.relname = ANY($1)
  `, [TARGET_INDEX_NAMES]);
}

async function commandConstraintState(client) {
  const inspection = await inspectDeviceBridgeT1Schema(client);
  if (!inspection.ready) return "INVALID";
  const command = inspection.constraints.find(item => item.specification.table === "device_bridge_commands"
    && item.specification.column === "command_type");
  if (command?.constraintName === T1_COMMAND_TYPE_CONSTRAINT_NAME) return "T1";
  if (command?.constraintName === T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME ||
      command?.constraintName === T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME) return "T2";
  return "INVALID";
}

/** Reads catalog facts only; it never creates or repairs schema. */
export async function inspectHumanArmedConversationBindingFoundationSchema(client, {
  assertBaseReady = assertContactConversationBindingFoundationSchemaReady
} = {}) {
  await assertBaseReady(client);
  const commandState = await commandConstraintState(client);
  const relations = await readRelations(client);
  const columns = await readColumns(client);
  const indexes = await readIndexes(client);
  const constraints = await readTinderFoundationConstraints(client, TARGET_RELATIONS);
  const binding = mapColumns(columns.rows, HUMAN_ARMED_CONVERSATION_BINDING_TABLE);
  const permit = mapColumns(columns.rows, HUMAN_ARMED_CONVERSATION_PERMIT_TABLE);
  const audit = mapColumns(columns.rows, HUMAN_ARMED_CONVERSATION_AUDIT_TABLE);
  const bindingKind = relationKind(relations.rows, HUMAN_ARMED_CONVERSATION_BINDING_TABLE);
  const permitKind = relationKind(relations.rows, HUMAN_ARMED_CONVERSATION_PERMIT_TABLE);
  const auditKind = relationKind(relations.rows, HUMAN_ARMED_CONVERSATION_AUDIT_TABLE);
  const allAbsent = bindingKind === null && permitKind === null && auditKind === null
    && binding.size === 0 && permit.size === 0 && audit.size === 0
    && indexesAbsent(indexes.rows) && constraints.rows.length === 0;
  if (allAbsent && commandState === "T1") {
    return { state: HUMAN_ARMED_CONVERSATION_BINDING_FOUNDATION_STATE.ABSENT };
  }

  const canonical = commandState === "T2"
    && bindingKind === "r" && permitKind === "r" && auditKind === "r"
    && exactColumns(binding, BINDING_COLUMNS, BINDING_DEFAULTS)
    && exactColumns(permit, PERMIT_COLUMNS, PERMIT_DEFAULTS)
    && exactColumns(audit, AUDIT_COLUMNS, AUDIT_DEFAULTS)
    && indexesCanonical(indexes.rows)
    && hasExpectedTinderFoundationConstraints(
      constraints.rows,
      HUMAN_ARMED_CONVERSATION_BINDING_CONSTRAINT_CONTRACT,
      { exactTables: TARGET_RELATIONS }
    );
  return {
    state: canonical
      ? HUMAN_ARMED_CONVERSATION_BINDING_FOUNDATION_STATE.CANONICAL
      : HUMAN_ARMED_CONVERSATION_BINDING_FOUNDATION_STATE.INVALID
  };
}

export async function preflightHumanArmedConversationBindingFoundationMigration(client, options) {
  const foundation = await inspectHumanArmedConversationBindingFoundationSchema(client, options);
  if (foundation.state === HUMAN_ARMED_CONVERSATION_BINDING_FOUNDATION_STATE.INVALID) {
    throw new Error("Human-armed conversation binding foundation schema is incompatible.");
  }
  return { foundation, mutate: foundation.state === HUMAN_ARMED_CONVERSATION_BINDING_FOUNDATION_STATE.ABSENT };
}

export async function assertHumanArmedConversationBindingFoundationSchemaReady(client) {
  const inspection = await inspectHumanArmedConversationBindingFoundationSchema(client);
  if (inspection.state !== HUMAN_ARMED_CONVERSATION_BINDING_FOUNDATION_STATE.CANONICAL) {
    throw new Error("Human-armed conversation binding foundation schema is not ready.");
  }
  return inspection;
}
