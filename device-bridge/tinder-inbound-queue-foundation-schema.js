import {
  assertTinderDraftFoundationSchemaReady
} from "./tinder-draft-foundation-schema.js";
import {
  canonicalTinderFoundationDefault,
  hasExpectedTinderFoundationConstraints,
  matchesTinderFoundationDefault,
  readTinderFoundationConstraints,
  TINDER_FOUNDATION_DEFAULT,
  tinderFoundationCheck,
  tinderFoundationKey
} from "./tinder-foundation-constraint-contract.js";

/* ==================================================
T6 — INBOUND QUEUE FOUNDATION SCHEMA CONTRACT

This is read-only schema recognition for the persisted collection window. It
contains neither a notification ingress nor a scheduler and cannot create a
capture, draft, command, or send.
================================================== */

export const TINDER_INBOUND_QUEUE_FOUNDATION_STATE = Object.freeze({
  ABSENT: "ABSENT",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

const WORK_ITEM_COLUMNS = Object.freeze({
  work_item_id: ["uuid", true], channel: ["text", true], device_id: ["uuid", true], contact_id: ["integer", true],
  capture_id: ["uuid", true], capture_fingerprint: ["character(64)", true], thread_ref_kind: ["text", true],
  runtime_thread_fingerprint: ["character(64)", true], capture_revision: ["integer", true], identity_revision: ["integer", true],
  latest_inbound_message_fingerprint: ["character(64)", true], conversation_state: ["text", true],
  queue_status: ["text", true], priority: ["text", true], block_reason: ["text", false], closed_reason: ["text", false],
  collection_window_ms: ["integer", true], collection_started_at: ["timestamp with time zone", true],
  eligible_at: ["timestamp with time zone", true], last_verified_inbound_at: ["timestamp with time zone", true],
  created_at: ["timestamp with time zone", true], updated_at: ["timestamp with time zone", true]
});

const EVENT_COLUMNS = Object.freeze({
  event_id: ["uuid", true], work_item_id: ["uuid", true], capture_id: ["uuid", true],
  capture_fingerprint: ["character(64)", true], terminal_message_fingerprint: ["character(64)", true],
  dedup_key: ["character(64)", true], observed_at: ["timestamp with time zone", true], created_at: ["timestamp with time zone", true]
});

const AUDIT_COLUMNS = Object.freeze({
  audit_id: ["bigint", true], work_item_id: ["uuid", true], action: ["text", true],
  reason_code: ["text", false], details: ["jsonb", true], created_at: ["timestamp with time zone", true]
});

const WORK_ITEM_DEFAULTS = Object.freeze({
  channel: "'tinder'",
  priority: "'LIVE_INBOUND'",
  created_at: TINDER_FOUNDATION_DEFAULT.NOW,
  updated_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const EVENT_DEFAULTS = Object.freeze({
  created_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const AUDIT_DEFAULTS = Object.freeze({
  audit_id: TINDER_FOUNDATION_DEFAULT.BIGSERIAL,
  details: TINDER_FOUNDATION_DEFAULT.EMPTY_JSON_OBJECT,
  created_at: TINDER_FOUNDATION_DEFAULT.NOW
});

const TARGET_RELATIONS = Object.freeze([
  "tinder_inbound_work_items", "tinder_inbound_work_events", "tinder_inbound_work_audit"
]);
const TARGET_INDEX_NAMES = Object.freeze([
  "idx_tinder_inbound_work_one_open_thread",
  "idx_tinder_inbound_work_due",
  "idx_tinder_inbound_work_contact_status",
  "idx_tinder_inbound_work_events_work_time",
  "idx_tinder_inbound_work_audit_work_time"
]);

const T6_INBOUND_QUEUE_CONSTRAINT_CONTRACT = Object.freeze([
  tinderFoundationKey("tinder_inbound_work_items", "p", ["work_item_id"], "PRIMARY KEY (work_item_id)"),
  tinderFoundationKey("tinder_inbound_work_items", "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_inbound_work_items", "f", ["contact_id"], "FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE RESTRICT", {
    referenceTable: "contacts", referenceColumns: ["id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_inbound_work_items", "f", ["capture_id"], "FOREIGN KEY (capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_inbound_work_items", "channel = 'tinder'"),
  tinderFoundationCheck("tinder_inbound_work_items", "capture_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_inbound_work_items", "thread_ref_kind = 'runtime_thread_fingerprint_v1'"),
  tinderFoundationCheck("tinder_inbound_work_items", "runtime_thread_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_inbound_work_items", "capture_revision > 0"),
  tinderFoundationCheck("tinder_inbound_work_items", "identity_revision > 0"),
  tinderFoundationCheck("tinder_inbound_work_items", "latest_inbound_message_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_inbound_work_items", "conversation_state IN ('NEW_MATCH', 'WAITING_FOR_US', 'WAITING_FOR_HER', 'ACTIVE_CHAT', 'DORMANT', 'HANDOFF')"),
  tinderFoundationCheck("tinder_inbound_work_items", "queue_status IN ('COLLECTING', 'ELIGIBLE_FOR_NEXT_STAGE', 'BLOCKED', 'CLOSED')"),
  tinderFoundationCheck("tinder_inbound_work_items", "priority = 'LIVE_INBOUND'"),
  tinderFoundationCheck("tinder_inbound_work_items", "collection_window_ms BETWEEN 180000 AND 240000", "collection_window_ms >= 180000 AND collection_window_ms <= 240000"),
  tinderFoundationCheck(
    "tinder_inbound_work_items",
    "eligible_at = collection_started_at + (collection_window_ms * INTERVAL '1 millisecond')",
    "eligible_at = collection_started_at + (collection_window_ms::double precision * '00:00:00.001'::interval)"
  ),
  tinderFoundationCheck("tinder_inbound_work_items", "(queue_status = 'BLOCKED') = (block_reason IS NOT NULL)"),
  tinderFoundationCheck("tinder_inbound_work_items", "(queue_status = 'CLOSED') = (closed_reason IS NOT NULL)"),
  tinderFoundationCheck("tinder_inbound_work_items", "block_reason IS NULL OR block_reason IN ('AUTO_REPLY_DISABLED', 'DATE_LOCK_ACTIVE', 'MANUAL_REVIEW_REQUIRED', 'HUMAN_TAKEOVER_ACTIVE', 'HANDOFF_ACTIVE', 'CONTACT_CONTROL_UNVERIFIABLE', 'CAPTURE_REVISION_STALE', 'CONTEXT_REFRESH_REQUIRED', 'IDENTITY_NOT_CONFIRMED', 'CAPTURE_NOT_SAFE')"),
  tinderFoundationCheck("tinder_inbound_work_items", "closed_reason IS NULL OR closed_reason IN ('VERIFIED_OUTBOUND', 'IDENTITY_CHANGED')"),
  tinderFoundationCheck("tinder_inbound_work_items", "conversation_state <> 'HANDOFF' OR queue_status = 'BLOCKED'"),

  tinderFoundationKey("tinder_inbound_work_events", "p", ["event_id"], "PRIMARY KEY (event_id)"),
  tinderFoundationKey("tinder_inbound_work_events", "u", ["dedup_key"], "UNIQUE (dedup_key)"),
  tinderFoundationKey("tinder_inbound_work_events", "f", ["work_item_id"], "FOREIGN KEY (work_item_id) REFERENCES tinder_inbound_work_items(work_item_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_inbound_work_items", referenceColumns: ["work_item_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationKey("tinder_inbound_work_events", "f", ["capture_id"], "FOREIGN KEY (capture_id) REFERENCES tinder_visible_chat_captures(capture_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_visible_chat_captures", referenceColumns: ["capture_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_inbound_work_events", "capture_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_inbound_work_events", "terminal_message_fingerprint ~ '^[0-9a-f]{64}$'"),
  tinderFoundationCheck("tinder_inbound_work_events", "dedup_key ~ '^[0-9a-f]{64}$'"),

  tinderFoundationKey("tinder_inbound_work_audit", "p", ["audit_id"], "PRIMARY KEY (audit_id)"),
  tinderFoundationKey("tinder_inbound_work_audit", "f", ["work_item_id"], "FOREIGN KEY (work_item_id) REFERENCES tinder_inbound_work_items(work_item_id) ON DELETE RESTRICT", {
    referenceTable: "tinder_inbound_work_items", referenceColumns: ["work_item_id"], deleteAction: "r", updateAction: "a"
  }),
  tinderFoundationCheck("tinder_inbound_work_audit", "action IN ('INBOUND_ENQUEUED', 'COLLECTION_WINDOW_RESET', 'WORK_ITEM_BLOCKED', 'WORK_ITEM_ELIGIBLE', 'VERIFIED_OUTBOUND_OBSERVED', 'IDENTITY_CHANGED')"),
  tinderFoundationCheck("tinder_inbound_work_audit", "jsonb_typeof(details) = 'object'")
]);

function compact(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/::[a-z_][a-z_ ]*/g, "")
    .replace(/[\s()]/g, "");
}

function mapColumns(rows, relation) {
  return new Map(rows.filter(row => row.relation_name === relation).map(row => [row.column_name, {
    dataType: row.data_type,
    notNull: row.not_null === true,
    defaultExpression: canonicalTinderFoundationDefault(row.column_default)
  }]));
}

function relationKind(rows, relation) {
  const values = rows.filter(row => row.relation_name === relation);
  return values.length === 1 ? values[0]?.relkind : null;
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

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function indexMap(rows) {
  return new Map(rows.map(row => [row.index_name, row]));
}

function indexMatches(row, { unique, columns, descending, predicate = "" }) {
  return Boolean(row)
    && row.indisvalid === true && row.indisready === true && row.indisunique === unique
    && sameArray(row.column_names, columns) && sameArray(row.descending, descending)
    && compact(row.predicate) === compact(predicate);
}

function indexesCanonical(rows) {
  const indexes = indexMap(rows);
  return indexMatches(indexes.get("idx_tinder_inbound_work_one_open_thread"), {
    unique: true, columns: ["device_id", "runtime_thread_fingerprint"], descending: [false, false],
    predicate: "queue_status IN ('COLLECTING', 'ELIGIBLE_FOR_NEXT_STAGE', 'BLOCKED')"
  }) && indexMatches(indexes.get("idx_tinder_inbound_work_due"), {
    unique: false, columns: ["eligible_at"], descending: [false], predicate: "queue_status = 'COLLECTING'"
  }) && indexMatches(indexes.get("idx_tinder_inbound_work_contact_status"), {
    unique: false, columns: ["contact_id", "queue_status", "updated_at"], descending: [false, false, true]
  }) && indexMatches(indexes.get("idx_tinder_inbound_work_events_work_time"), {
    unique: false, columns: ["work_item_id", "created_at"], descending: [false, true]
  }) && indexMatches(indexes.get("idx_tinder_inbound_work_audit_work_time"), {
    unique: false, columns: ["work_item_id", "created_at"], descending: [false, true]
  });
}

function indexesAbsent(rows) {
  const indexes = indexMap(rows);
  return TARGET_INDEX_NAMES.every(name => !indexes.has(name));
}

async function readRelations(client) {
  return client.query(`
    SELECT c.relname AS relation_name, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = current_schema() AND c.relname = ANY($1)
  `, [TARGET_RELATIONS]);
}

async function readColumns(client) {
  return client.query(`
    SELECT c.relname AS relation_name, a.attname AS column_name,
           format_type(a.atttypid, a.atttypmod) AS data_type,
           a.attnotnull AS not_null,
           COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '') AS column_default
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE n.nspname = current_schema() AND c.relname = ANY($1)
       AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum
  `, [TARGET_RELATIONS]);
}

async function readIndexes(client) {
  return client.query(`
    SELECT idx.relname AS index_name, i.indisunique, i.indisvalid, i.indisready,
           ARRAY(
             SELECT attribute.attname::text
               FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum, ordinality)
               JOIN pg_attribute attribute ON attribute.attrelid = i.indrelid AND attribute.attnum = key.attnum
              ORDER BY key.ordinality
           ) AS column_names,
           ARRAY(
             SELECT (option & 1) = 1
               FROM unnest(i.indoption) WITH ORDINALITY AS option_value(option, ordinality)
              ORDER BY ordinality
           ) AS descending,
           COALESCE(pg_get_expr(i.indpred, i.indrelid, true), '') AS predicate
      FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = idx.relnamespace
     WHERE n.nspname = current_schema() AND idx.relname = ANY($1)
  `, [TARGET_INDEX_NAMES]);
}

async function readT6Constraints(client) {
  return readTinderFoundationConstraints(client, TARGET_RELATIONS);
}

/** Read-only T6 state inspection; all partial states fail closed. */
export async function inspectTinderInboundQueueFoundationSchema(client, {
  assertDraftReady = assertTinderDraftFoundationSchemaReady
} = {}) {
  await assertDraftReady(client);
  const relations = await readRelations(client);
  const columns = await readColumns(client);
  const indexes = await readIndexes(client);
  const constraints = await readT6Constraints(client);
  const workItems = mapColumns(columns.rows, "tinder_inbound_work_items");
  const events = mapColumns(columns.rows, "tinder_inbound_work_events");
  const audit = mapColumns(columns.rows, "tinder_inbound_work_audit");
  const workCanonical = relationKind(relations.rows, "tinder_inbound_work_items") === "r" && exactColumns(workItems, WORK_ITEM_COLUMNS, WORK_ITEM_DEFAULTS);
  const eventsCanonical = relationKind(relations.rows, "tinder_inbound_work_events") === "r" && exactColumns(events, EVENT_COLUMNS, EVENT_DEFAULTS);
  const auditCanonical = relationKind(relations.rows, "tinder_inbound_work_audit") === "r" && exactColumns(audit, AUDIT_COLUMNS, AUDIT_DEFAULTS);
  const absent = relationKind(relations.rows, "tinder_inbound_work_items") === null && workItems.size === 0
    && relationKind(relations.rows, "tinder_inbound_work_events") === null && events.size === 0
    && relationKind(relations.rows, "tinder_inbound_work_audit") === null && audit.size === 0;
  const constraintsCanonical = hasExpectedTinderFoundationConstraints(
    constraints.rows,
    T6_INBOUND_QUEUE_CONSTRAINT_CONTRACT,
    { exactTables: TARGET_RELATIONS }
  );
  if (workCanonical && eventsCanonical && auditCanonical && constraintsCanonical && indexesCanonical(indexes.rows)) {
    return { state: TINDER_INBOUND_QUEUE_FOUNDATION_STATE.CANONICAL };
  }
  if (absent && indexesAbsent(indexes.rows)) return { state: TINDER_INBOUND_QUEUE_FOUNDATION_STATE.ABSENT };
  return { state: TINDER_INBOUND_QUEUE_FOUNDATION_STATE.INVALID };
}

export async function preflightTinderInboundQueueFoundationMigration(client) {
  const inboundQueue = await inspectTinderInboundQueueFoundationSchema(client);
  if (inboundQueue.state === TINDER_INBOUND_QUEUE_FOUNDATION_STATE.INVALID) {
    throw new Error("T6 Tinder inbound queue foundation schema is incompatible.");
  }
  return { inboundQueue, mutate: inboundQueue.state === TINDER_INBOUND_QUEUE_FOUNDATION_STATE.ABSENT };
}

export async function assertTinderInboundQueueFoundationSchemaReady(client) {
  const inspection = await inspectTinderInboundQueueFoundationSchema(client);
  if (inspection.state !== TINDER_INBOUND_QUEUE_FOUNDATION_STATE.CANONICAL) {
    throw new Error("T6 Tinder inbound queue foundation schema is not ready.");
  }
  return inspection;
}

export { T6_INBOUND_QUEUE_CONSTRAINT_CONTRACT as TINDER_INBOUND_QUEUE_FOUNDATION_CONSTRAINT_CONTRACT };
