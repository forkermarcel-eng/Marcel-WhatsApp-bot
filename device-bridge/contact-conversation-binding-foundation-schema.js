import {
  assertTinderIdentityFoundationSchemaReady
} from "./tinder-identity-foundation-schema.js";
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

/* ==================================================
SHARED CHANNEL CONVERSATION BINDING — SCHEMA CONTRACT

Read-only recognition for an additive, human-confirmed conversation binding.
It is deliberately separate from profile identifiers and has no route,
startup or runtime side effect.
================================================== */

export const CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE = Object.freeze({
  ABSENT: "ABSENT",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

const BINDING_TABLE = "contact_conversation_bindings";
const AUDIT_TABLE = "contact_conversation_binding_audit";
const TARGET_RELATIONS = Object.freeze([BINDING_TABLE, AUDIT_TABLE]);
const TARGET_INDEX_NAMES = Object.freeze([
  "idx_contact_conversation_binding_active_device_ref",
  "idx_contact_conversation_binding_active_unscoped_ref",
  "idx_contact_conversation_binding_contact_state",
  "idx_contact_conversation_binding_source_capture",
  "idx_contact_conversation_binding_audit_binding_time",
  "idx_contact_conversation_binding_audit_capture_time"
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

const AUDIT_DEFAULTS = Object.freeze({
  audit_id: TINDER_FOUNDATION_DEFAULT.BIGSERIAL,
  source: "'manual_dashboard'",
  details: TINDER_FOUNDATION_DEFAULT.EMPTY_JSON_OBJECT,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW
});

export const CONTACT_CONVERSATION_BINDING_CONSTRAINT_CONTRACT = Object.freeze([
  tinderFoundationKey(BINDING_TABLE, "p", ["binding_id"], "PRIMARY KEY (binding_id)"),
  tinderFoundationKey(BINDING_TABLE, "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(BINDING_TABLE, "f", ["contact_id"], "FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(BINDING_TABLE, "f", ["source_capture_id"], "FOREIGN KEY (source_capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck(BINDING_TABLE, "channel IN ('tinder', 'whatsapp')"),
  tinderFoundationCheck(BINDING_TABLE, "reference_hash ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck(BINDING_TABLE, "binding_state IN ('CONFIRMED', 'REVOKED')"),
  tinderFoundationCheck(BINDING_TABLE, "binding_revision > 0"),
  tinderFoundationCheck(BINDING_TABLE, "human_verified = TRUE"),
  tinderFoundationCheck(BINDING_TABLE, "verification_source = 'manual_dashboard'"),
  tinderFoundationCheck(BINDING_TABLE, "char_length(verified_by) BETWEEN 1 AND 80", "char_length(verified_by) >= 1 AND char_length(verified_by) <= 80"),
  tinderFoundationCheck(BINDING_TABLE,
    "(channel = 'tinder' AND reference_kind = 'tinder_accessibility_header_unique_id_hmac_v1' AND device_id IS NOT NULL AND source_capture_id IS NOT NULL) OR (channel = 'whatsapp' AND reference_kind = 'whatsapp_conversation_ref_hmac_v1' AND device_id IS NULL AND source_capture_id IS NULL)"
  ),
  tinderFoundationCheck(BINDING_TABLE,
    "(binding_state = 'CONFIRMED' AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL) OR (binding_state = 'REVOKED' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND revocation_reason IN ('HUMAN_REVOKED', 'CONFLICT_SUPERSEDED'))"
  ),

  tinderFoundationKey(AUDIT_TABLE, "p", ["audit_id"], "PRIMARY KEY (audit_id)"),
  tinderFoundationKey(AUDIT_TABLE, "f", ["binding_id"], "FOREIGN KEY (binding_id) REFERENCES contact_conversation_bindings(binding_id) ON DELETE RESTRICT", {
    referenceTable: BINDING_TABLE, referenceColumns: ["binding_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(AUDIT_TABLE, "f", ["capture_id"], "FOREIGN KEY (capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey(AUDIT_TABLE, "f", ["old_contact_id"], "FOREIGN KEY (old_contact_id) REFERENCES contacts(id) ON DELETE SET NULL", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "n", updateAction: "a"
  }),
  tinderFoundationKey(AUDIT_TABLE, "f", ["new_contact_id"], "FOREIGN KEY (new_contact_id) REFERENCES contacts(id) ON DELETE SET NULL", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "n", updateAction: "a"
  }),
  tinderFoundationCheck(AUDIT_TABLE, "action IN ('CREATE', 'CONFIRM', 'REVOKE', 'CONFLICT_BLOCKED')"),
  tinderFoundationCheck(AUDIT_TABLE, "char_length(actor) BETWEEN 1 AND 80", "char_length(actor) >= 1 AND char_length(actor) <= 80"),
  tinderFoundationCheck(AUDIT_TABLE, "source = 'manual_dashboard'"),
  tinderFoundationCheck(AUDIT_TABLE, "old_binding_revision IS NULL OR old_binding_revision > 0"),
  tinderFoundationCheck(AUDIT_TABLE, "new_binding_revision IS NULL OR new_binding_revision > 0"),
  tinderFoundationCheck(AUDIT_TABLE, "jsonb_typeof(details) = 'object'"),
  tinderFoundationCheck(AUDIT_TABLE,
    "NOT (details ?| ARRAY['reference_hash', 'reference_token', 'raw_unique_id', 'visible_name', 'message_text', 'capture_fingerprint', 'runtime_thread_fingerprint'])",
    // PostgreSQL's catalog deparser may elide the parentheses immediately
    // after unary NOT here. This fixed equivalent preserves the exact
    // prohibited-key set; it does not accept a broader JSONB predicate.
    "NOT details ?| ARRAY['reference_hash', 'reference_token', 'raw_unique_id', 'visible_name', 'message_text', 'capture_fingerprint', 'runtime_thread_fingerprint']"
  )
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
  return indexMatches(indexes.get("idx_contact_conversation_binding_active_device_ref"), {
    unique: true,
    columns: ["channel", "reference_kind", "device_id", "reference_hash"],
    descending: [false, false, false, false],
    predicate: "binding_state = 'CONFIRMED' AND device_id IS NOT NULL"
  }) && indexMatches(indexes.get("idx_contact_conversation_binding_active_unscoped_ref"), {
    unique: true,
    columns: ["channel", "reference_kind", "reference_hash"],
    descending: [false, false, false],
    predicate: "binding_state = 'CONFIRMED' AND device_id IS NULL"
  }) && indexMatches(indexes.get("idx_contact_conversation_binding_contact_state"), {
    unique: false,
    columns: ["contact_id", "binding_state", "updated_at"],
    descending: [false, false, true]
  }) && indexMatches(indexes.get("idx_contact_conversation_binding_source_capture"), {
    unique: false,
    columns: ["source_capture_id"],
    descending: [false],
    predicate: "source_capture_id IS NOT NULL"
  }) && indexMatches(indexes.get("idx_contact_conversation_binding_audit_binding_time"), {
    unique: false,
    columns: ["binding_id", "created_at"],
    descending: [false, true]
  }) && indexMatches(indexes.get("idx_contact_conversation_binding_audit_capture_time"), {
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

/** Reads catalog facts only; it never repairs an absent or drifted schema. */
export async function inspectContactConversationBindingFoundationSchema(client, {
  assertIdentityReady = assertTinderIdentityFoundationSchemaReady
} = {}) {
  await assertIdentityReady(client);
  const relations = await readRelations(client);
  const columns = await readColumns(client);
  const indexes = await readIndexes(client);
  const constraints = await readTinderFoundationConstraints(client, TARGET_RELATIONS);
  const binding = mapColumns(columns.rows, BINDING_TABLE);
  const audit = mapColumns(columns.rows, AUDIT_TABLE);
  const bindingKind = relationKind(relations.rows, BINDING_TABLE);
  const auditKind = relationKind(relations.rows, AUDIT_TABLE);
  const bothAbsent = bindingKind === null && auditKind === null
    && binding.size === 0 && audit.size === 0 && indexesAbsent(indexes.rows)
    && constraints.rows.length === 0;
  if (bothAbsent) return { state: CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.ABSENT };

  const canonical = bindingKind === "r" && auditKind === "r"
    && exactColumns(binding, BINDING_COLUMNS, BINDING_DEFAULTS)
    && exactColumns(audit, AUDIT_COLUMNS, AUDIT_DEFAULTS)
    && indexesCanonical(indexes.rows)
    && hasExpectedTinderFoundationConstraints(
      constraints.rows,
      CONTACT_CONVERSATION_BINDING_CONSTRAINT_CONTRACT,
      { exactTables: TARGET_RELATIONS }
    );
  return {
    state: canonical
      ? CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.CANONICAL
      : CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.INVALID
  };
}

export async function preflightContactConversationBindingFoundationMigration(client, {
  assertIdentityReady = assertTinderIdentityFoundationSchemaReady
} = {}) {
  const binding = await inspectContactConversationBindingFoundationSchema(client, { assertIdentityReady });
  if (binding.state === CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.INVALID) {
    throw new Error("Conversation binding foundation schema is incompatible.");
  }
  return { binding, mutate: binding.state === CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.ABSENT };
}

export async function assertContactConversationBindingFoundationSchemaReady(client) {
  const inspection = await inspectContactConversationBindingFoundationSchema(client);
  if (inspection.state !== CONTACT_CONVERSATION_BINDING_FOUNDATION_STATE.CANONICAL) {
    throw new Error("Conversation binding foundation schema is not ready.");
  }
  return inspection;
}
