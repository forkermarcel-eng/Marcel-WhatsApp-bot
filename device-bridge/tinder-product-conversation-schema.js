import { assertTinderVisibleChatCaptureBaseSchemaReady } from "./tinder-visible-chat-capture-schema.js";
import {
  hasExpectedTinderFoundationConstraints,
  matchesTinderFoundationDefault,
  readTinderFoundationConstraints,
  TINDER_FOUNDATION_DEFAULT,
  tinderFoundationCheck,
  tinderFoundationKey
} from "./tinder-foundation-constraint-contract.js";
import { canonicalSchemaPredicate } from "./schema-contract.js";

/* ==================================================
TINDER PRODUCT CONVERSATION SCHEMA

One additive product entity plus immutable capture links.  It deliberately
does not inspect command types, permits, receipts, sweeps, V8/V9/V10, or
human mapping state.  The target is usable for UNASSIGNED conversations.
================================================== */

export const TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE = Object.freeze({
  ABSENT: "ABSENT",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

export const TINDER_PRODUCT_CONVERSATION_TABLE = "tinder_thread_conversations";
export const TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE = "tinder_thread_conversation_capture_links";

const TARGET_TABLES = Object.freeze([
  TINDER_PRODUCT_CONVERSATION_TABLE,
  TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE
]);

const CONVERSATION_COLUMNS = Object.freeze({
  conversation_id: column("uuid", false, TINDER_FOUNDATION_DEFAULT.NONE),
  device_id: column("uuid", false, TINDER_FOUNDATION_DEFAULT.NONE),
  runtime_thread_fingerprint_hint: column("character(64)", false, TINDER_FOUNDATION_DEFAULT.NONE),
  identity_binding_state: column("text", false, "'UNASSIGNED'"),
  resolved_contact_id: column("integer", true, TINDER_FOUNDATION_DEFAULT.NONE),
  correlation_state: column("text", false, "'PROVISIONAL'"),
  history_state: column("text", false, "'PARTIAL'"),
  profile_state: column("jsonb", false, TINDER_FOUNDATION_DEFAULT.EMPTY_JSON_OBJECT),
  first_observed_at: column("timestamp with time zone", false, TINDER_FOUNDATION_DEFAULT.NONE),
  last_observed_at: column("timestamp with time zone", false, TINDER_FOUNDATION_DEFAULT.NONE),
  last_history_at: column("timestamp with time zone", false, TINDER_FOUNDATION_DEFAULT.NONE),
  last_profile_at: column("timestamp with time zone", true, TINDER_FOUNDATION_DEFAULT.NONE),
  created_at: column("timestamp with time zone", false, TINDER_FOUNDATION_DEFAULT.NOW),
  updated_at: column("timestamp with time zone", false, TINDER_FOUNDATION_DEFAULT.NOW)
});

const CAPTURE_LINK_COLUMNS = Object.freeze({
  conversation_id: column("uuid", false, TINDER_FOUNDATION_DEFAULT.NONE),
  capture_id: column("uuid", false, TINDER_FOUNDATION_DEFAULT.NONE),
  device_id: column("uuid", false, TINDER_FOUNDATION_DEFAULT.NONE),
  link_method: column("text", false, TINDER_FOUNDATION_DEFAULT.NONE),
  linked_at: column("timestamp with time zone", false, TINDER_FOUNDATION_DEFAULT.NOW)
});

function column(dataType, nullable, defaultExpression) {
  return Object.freeze({ dataType, nullable, defaultExpression });
}

export const TINDER_PRODUCT_CONVERSATION_CONSTRAINT_CONTRACT = Object.freeze([
  tinderFoundationKey(TINDER_PRODUCT_CONVERSATION_TABLE, "p", ["conversation_id"], "PRIMARY KEY (conversation_id)"),
  tinderFoundationKey(TINDER_PRODUCT_CONVERSATION_TABLE, "u", ["conversation_id", "device_id"], "UNIQUE (conversation_id, device_id)"),
  tinderFoundationKey(
    TINDER_PRODUCT_CONVERSATION_TABLE,
    "f",
    ["device_id"],
    "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT",
    { referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a" }
  ),
  tinderFoundationKey(
    TINDER_PRODUCT_CONVERSATION_TABLE,
    "f",
    ["resolved_contact_id"],
    "FOREIGN KEY (resolved_contact_id) REFERENCES contacts(id) ON DELETE RESTRICT",
    { referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "r", updateAction: "a" }
  ),
  tinderFoundationCheck(TINDER_PRODUCT_CONVERSATION_TABLE, "runtime_thread_fingerprint_hint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck(TINDER_PRODUCT_CONVERSATION_TABLE, "identity_binding_state IN ('UNASSIGNED', 'BOUND', 'CONFLICT')"),
  tinderFoundationCheck(TINDER_PRODUCT_CONVERSATION_TABLE, "correlation_state IN ('PROVISIONAL', 'CORRELATED', 'AMBIGUOUS')"),
  tinderFoundationCheck(TINDER_PRODUCT_CONVERSATION_TABLE, "history_state IN ('PARTIAL', 'COMPLETE')"),
  tinderFoundationCheck(TINDER_PRODUCT_CONVERSATION_TABLE, "jsonb_typeof(profile_state) = 'object'"),
  tinderFoundationCheck(TINDER_PRODUCT_CONVERSATION_TABLE, "(identity_binding_state = 'BOUND') = (resolved_contact_id IS NOT NULL)"),
  tinderFoundationCheck(TINDER_PRODUCT_CONVERSATION_TABLE, "last_observed_at >= first_observed_at"),
  tinderFoundationCheck(TINDER_PRODUCT_CONVERSATION_TABLE, "last_history_at >= first_observed_at"),
  tinderFoundationCheck(TINDER_PRODUCT_CONVERSATION_TABLE, "last_profile_at IS NULL OR last_profile_at >= first_observed_at"),

  tinderFoundationKey(
    TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE,
    "p",
    ["conversation_id", "capture_id"],
    "PRIMARY KEY (conversation_id, capture_id)"
  ),
  tinderFoundationKey(
    TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE,
    "u",
    ["capture_id"],
    "UNIQUE (capture_id)"
  ),
  tinderFoundationKey(
    TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE,
    "f",
    ["conversation_id", "device_id"],
    `FOREIGN KEY (conversation_id, device_id) REFERENCES ${TINDER_PRODUCT_CONVERSATION_TABLE}(conversation_id, device_id) ON DELETE RESTRICT`,
    { referenceTable: TINDER_PRODUCT_CONVERSATION_TABLE, referenceColumns: ["conversation_id", "device_id"], deleteAction: "r", updateAction: "a" }
  ),
  tinderFoundationKey(
    TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE,
    "f",
    ["capture_id", "device_id"],
    "FOREIGN KEY (capture_id, device_id) REFERENCES tinder_visible_chat_captures(capture_id, device_id) ON DELETE RESTRICT",
    { referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id", "device_id"], deleteAction: "r", updateAction: "a" }
  ),
  tinderFoundationCheck(TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE, "link_method IN ('INITIAL', 'ORDERED_MESSAGE_OVERLAP')")
]);

export const TINDER_PRODUCT_CONVERSATION_INDEX_CONTRACT = Object.freeze([
  Object.freeze({
    name: "idx_tinder_visible_chat_captures_capture_device",
    table: "tinder_visible_chat_captures",
    accessMethod: "btree",
    unique: true,
    columns: ["capture_id", "device_id"],
    descending: [false, false],
    predicate: ""
  }),
  Object.freeze({
    name: "idx_tinder_thread_conversations_device_hint",
    table: TINDER_PRODUCT_CONVERSATION_TABLE,
    accessMethod: "btree",
    unique: false,
    columns: ["device_id", "runtime_thread_fingerprint_hint", "updated_at"],
    descending: [false, false, true],
    predicate: ""
  }),
  Object.freeze({
    name: "idx_tinder_thread_conversations_device_updated",
    table: TINDER_PRODUCT_CONVERSATION_TABLE,
    accessMethod: "btree",
    unique: false,
    columns: ["device_id", "updated_at"],
    descending: [false, true],
    predicate: ""
  }),
  Object.freeze({
    name: "idx_tinder_thread_conversation_capture_links_conversation_time",
    table: TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE,
    accessMethod: "btree",
    unique: false,
    columns: ["conversation_id", "linked_at"],
    descending: [false, false],
    predicate: ""
  })
]);

function columnMap(rows, tableName) {
  return new Map(rows
    .filter(row => row.table_name === tableName)
    .map(row => [row.column_name, {
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
      defaultExpression: row.column_default
    }]));
}

function columnContractMatches(actual, expected) {
  return Boolean(actual)
    && actual.dataType === expected.dataType
    && actual.nullable === expected.nullable
    && matchesTinderFoundationDefault(actual.defaultExpression, expected.defaultExpression);
}

function hasExactColumns(rows, tableName, contract) {
  const columns = columnMap(rows, tableName);
  return columns.size === Object.keys(contract).length
    && Object.entries(contract).every(([name, expected]) => columnContractMatches(columns.get(name), expected));
}

function sameArray(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function indexMap(rows) {
  return new Map(rows.map(row => [row.index_name, row]));
}

function indexMatches(row, expected) {
  return Boolean(row)
    && row.table_name === expected.table
    && row.access_method === expected.accessMethod
    && row.indisvalid === true
    && row.indisready === true
    && row.indisunique === expected.unique
    && sameArray(row.column_names, expected.columns)
    && sameArray(row.descending, expected.descending)
    && canonicalSchemaPredicate(row.predicate) === canonicalSchemaPredicate(expected.predicate);
}

function indexesAreCanonical(rows) {
  const indexes = indexMap(rows);
  return TINDER_PRODUCT_CONVERSATION_INDEX_CONTRACT.every(expected => indexMatches(indexes.get(expected.name), expected));
}

/** Pure catalog-row predicate used by the strict postcheck and focused tests. */
export function hasCanonicalTinderProductConversationIndexes(rows) {
  return Array.isArray(rows) && indexesAreCanonical(rows);
}

function noTargetIndexes(rows) {
  const indexes = indexMap(rows);
  return TINDER_PRODUCT_CONVERSATION_INDEX_CONTRACT.every(expected => !indexes.has(expected.name));
}

async function readTargetRelations(client) {
  return client.query(`
    SELECT rel.relname AS table_name, rel.relkind
      FROM pg_class rel
      JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
     WHERE namespace.nspname = current_schema()
       AND rel.relname = ANY($1)
  `, [TARGET_TABLES]);
}

async function readTargetColumns(client) {
  return client.query(`
    SELECT rel.relname AS table_name,
           attribute.attname AS column_name,
           format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
           CASE WHEN attribute.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
           COALESCE(pg_get_expr(default_value.adbin, default_value.adrelid, true), '') AS column_default
      FROM pg_class rel
      JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid = rel.oid
      LEFT JOIN pg_attrdef default_value
        ON default_value.adrelid = attribute.attrelid
       AND default_value.adnum = attribute.attnum
     WHERE namespace.nspname = current_schema()
       AND rel.relname = ANY($1)
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  `, [TARGET_TABLES]);
}

async function readTargetIndexes(client) {
  const names = TINDER_PRODUCT_CONVERSATION_INDEX_CONTRACT.map(index => index.name);
  const tables = [...new Set(TINDER_PRODUCT_CONVERSATION_INDEX_CONTRACT.map(index => index.table))];
  return client.query(`
    SELECT idx.relname AS index_name,
           table_rel.relname AS table_name,
           index_method.amname AS access_method,
           index_meta.indisunique,
           index_meta.indisvalid,
           index_meta.indisready,
           ARRAY(
             SELECT attribute.attname::text
               FROM unnest(index_meta.indkey) WITH ORDINALITY AS key(attnum, ordinality)
               JOIN pg_attribute attribute ON attribute.attrelid = index_meta.indrelid AND attribute.attnum = key.attnum
              ORDER BY key.ordinality
           ) AS column_names,
           ARRAY(
             SELECT (option_value.option & 1) = 1
               FROM unnest(index_meta.indoption) WITH ORDINALITY AS option_value(option, ordinality)
              ORDER BY option_value.ordinality
           ) AS descending,
           COALESCE(pg_get_expr(index_meta.indpred, index_meta.indrelid, true), '') AS predicate
      FROM pg_index index_meta
      JOIN pg_class idx ON idx.oid = index_meta.indexrelid
      JOIN pg_namespace namespace ON namespace.oid = idx.relnamespace
      JOIN pg_class table_rel ON table_rel.oid = index_meta.indrelid
      JOIN pg_am index_method ON index_method.oid = idx.relam
     WHERE namespace.nspname = current_schema()
       AND idx.relname = ANY($1)
       AND table_rel.relname = ANY($2)
  `, [names, tables]);
}

async function assertPredecessorReferences(client) {
  const result = await client.query(`
    SELECT rel.relname AS table_name,
           attribute.attname AS column_name,
           format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
           attribute.attnotnull AS not_null,
           rel.relkind
      FROM pg_class rel
      JOIN pg_namespace namespace ON namespace.oid = rel.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid = rel.oid
     WHERE namespace.nspname = current_schema()
       AND ((rel.relname = 'device_bridge_devices' AND attribute.attname = 'device_id')
         OR (rel.relname = 'contacts' AND attribute.attname = 'id')
         OR (rel.relname = 'tinder_visible_chat_captures' AND attribute.attname IN ('capture_id', 'device_id')))
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
  `);
  const fields = new Map(result.rows.map(row => [`${row.table_name}.${row.column_name}`, row]));
  const deviceId = fields.get("device_bridge_devices.device_id");
  const contactId = fields.get("contacts.id");
  const captureId = fields.get("tinder_visible_chat_captures.capture_id");
  const captureDeviceId = fields.get("tinder_visible_chat_captures.device_id");
  if (!deviceId || deviceId.relkind !== "r" || deviceId.data_type !== "uuid" || deviceId.not_null !== true
      || !contactId || contactId.relkind !== "r" || contactId.data_type !== "integer" || contactId.not_null !== true
      || !captureId || captureId.relkind !== "r" || captureId.data_type !== "uuid" || captureId.not_null !== true
      || !captureDeviceId || captureDeviceId.relkind !== "r" || captureDeviceId.data_type !== "uuid" || captureDeviceId.not_null !== true) {
    throw new Error("Tinder product conversation migration requires compatible Device Bridge and contacts references.");
  }
}

/** Read-only schema inspection. It never creates, changes, or links rows. */
export async function inspectTinderProductConversationSchema(client) {
  await assertTinderVisibleChatCaptureBaseSchemaReady(client);
  await assertPredecessorReferences(client);
  const relations = await readTargetRelations(client);
  const columns = await readTargetColumns(client);
  const constraints = await readTinderFoundationConstraints(client, TARGET_TABLES);
  const indexes = await readTargetIndexes(client);
  const present = new Map(relations.rows.map(row => [row.table_name, row]));
  const absent = present.size === 0
    && columns.rows.length === 0
    && constraints.rows.length === 0
    && noTargetIndexes(indexes.rows);
  if (absent) return Object.freeze({ state: TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.ABSENT });

  const canonical = present.size === TARGET_TABLES.length
    && TARGET_TABLES.every(table => present.get(table)?.relkind === "r")
    && hasExactColumns(columns.rows, TINDER_PRODUCT_CONVERSATION_TABLE, CONVERSATION_COLUMNS)
    && hasExactColumns(columns.rows, TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE, CAPTURE_LINK_COLUMNS)
    && hasExpectedTinderFoundationConstraints(
      constraints.rows,
      TINDER_PRODUCT_CONVERSATION_CONSTRAINT_CONTRACT,
      { exactTables: TARGET_TABLES }
    )
    && hasCanonicalTinderProductConversationIndexes(indexes.rows);
  return Object.freeze({ state: canonical
    ? TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.CANONICAL
    : TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.INVALID });
}

export async function preflightTinderProductConversationMigration(client) {
  const foundation = await inspectTinderProductConversationSchema(client);
  if (foundation.state === TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.INVALID) {
    throw new Error("Tinder product conversation schema is incompatible.");
  }
  return Object.freeze({
    foundation,
    mutate: foundation.state === TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.ABSENT
  });
}

export async function assertTinderProductConversationSchemaReady(client) {
  const foundation = await inspectTinderProductConversationSchema(client);
  if (foundation.state !== TINDER_PRODUCT_CONVERSATION_FOUNDATION_STATE.CANONICAL) {
    throw new Error("Tinder product conversation schema is not ready.");
  }
  return foundation;
}

export const TINDER_PRODUCT_CONVERSATION_COLUMN_CONTRACT = Object.freeze({
  [TINDER_PRODUCT_CONVERSATION_TABLE]: CONVERSATION_COLUMNS,
  [TINDER_PRODUCT_CONVERSATION_CAPTURE_LINK_TABLE]: CAPTURE_LINK_COLUMNS
});
