import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  inspectTinderInboundQueueFoundationSchema,
  TINDER_INBOUND_QUEUE_FOUNDATION_CONSTRAINT_CONTRACT,
  TINDER_INBOUND_QUEUE_FOUNDATION_STATE
} from "../device-bridge/tinder-inbound-queue-foundation-schema.js";
import {
  assertTinderInboundQueueFoundationMigrationSource
} from "../device-bridge/tinder-inbound-queue-foundation-migration.js";

const WORK = [
  ["work_item_id", "uuid", true], ["channel", "text", true], ["device_id", "uuid", true], ["contact_id", "integer", true],
  ["capture_id", "uuid", true], ["capture_fingerprint", "character(64)", true], ["thread_ref_kind", "text", true],
  ["runtime_thread_fingerprint", "character(64)", true], ["capture_revision", "integer", true], ["identity_revision", "integer", true],
  ["latest_inbound_message_fingerprint", "character(64)", true], ["conversation_state", "text", true], ["queue_status", "text", true],
  ["priority", "text", true], ["block_reason", "text", false], ["closed_reason", "text", false],
  ["collection_window_ms", "integer", true], ["collection_started_at", "timestamp with time zone", true],
  ["eligible_at", "timestamp with time zone", true], ["last_verified_inbound_at", "timestamp with time zone", true],
  ["created_at", "timestamp with time zone", true], ["updated_at", "timestamp with time zone", true]
];
const EVENTS = [
  ["event_id", "uuid", true], ["work_item_id", "uuid", true], ["capture_id", "uuid", true],
  ["capture_fingerprint", "character(64)", true], ["terminal_message_fingerprint", "character(64)", true],
  ["dedup_key", "character(64)", true], ["observed_at", "timestamp with time zone", true], ["created_at", "timestamp with time zone", true]
];
const AUDIT = [
  ["audit_id", "bigint", true], ["work_item_id", "uuid", true], ["action", "text", true],
  ["reason_code", "text", false], ["details", "jsonb", true], ["created_at", "timestamp with time zone", true]
];

function asRows(relation, fields, defaults = {}) {
  return fields.map(([column_name, data_type, not_null]) => ({
    relation_name: relation,
    column_name,
    data_type,
    not_null,
    column_default: defaults[column_name] || ""
  }));
}

const WORK_ITEM_DEFAULTS = {
  channel: "('tinder'::text)",
  priority: "'LIVE_INBOUND'::text",
  created_at: "CURRENT_TIMESTAMP",
  updated_at: "now()"
};
const EVENT_DEFAULTS = { created_at: "now()" };
const AUDIT_DEFAULTS = {
  audit_id: "nextval('tinder_inbound_work_audit_audit_id_seq'::regclass)",
  details: "('{}'::jsonb)",
  created_at: "CURRENT_TIMESTAMP"
};

function canonicalIndexes() {
  return [
    ["idx_tinder_inbound_work_one_open_thread", true, ["device_id", "runtime_thread_fingerprint"], [false, false], "queue_status IN ('COLLECTING', 'ELIGIBLE_FOR_NEXT_STAGE', 'BLOCKED')"],
    ["idx_tinder_inbound_work_due", false, ["eligible_at"], [false], "queue_status = 'COLLECTING'"],
    ["idx_tinder_inbound_work_contact_status", false, ["contact_id", "queue_status", "updated_at"], [false, false, true], ""],
    ["idx_tinder_inbound_work_events_work_time", false, ["work_item_id", "created_at"], [false, true], ""],
    ["idx_tinder_inbound_work_audit_work_time", false, ["work_item_id", "created_at"], [false, true], ""]
  ].map(([index_name, indisunique, column_names, descending, predicate]) => ({
    index_name, indisunique, indisvalid: true, indisready: true, column_names, descending, predicate
  }));
}

function catalogConstraints(contract) {
  return contract.map(specification => ({
    table_name: specification.table,
    contype: specification.type,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    confdeltype: specification.deleteAction || " ",
    confupdtype: specification.updateAction || " ",
    confmatchtype: specification.matchType || " ",
    reference_table: specification.referenceTable || null,
    reference_column_names: specification.referenceColumns || [],
    column_names: specification.type === "c" ? [] : specification.columns,
    constraint_definition: specification.type === "c"
      ? `CHECK (${specification.sources[0]})`
      : specification.definition
  }));
}

function fixtureClient({ canonical = false, partial = false } = {}) {
  const relations = [];
  const columns = [];
  let indexes = [];
  let constraints = [];
  if (canonical) {
    relations.push({ relation_name: "tinder_inbound_work_items", relkind: "r" });
    relations.push({ relation_name: "tinder_inbound_work_events", relkind: "r" });
    relations.push({ relation_name: "tinder_inbound_work_audit", relkind: "r" });
    columns.push(...asRows("tinder_inbound_work_items", WORK, WORK_ITEM_DEFAULTS));
    columns.push(...asRows("tinder_inbound_work_events", EVENTS, EVENT_DEFAULTS));
    columns.push(...asRows("tinder_inbound_work_audit", AUDIT, AUDIT_DEFAULTS));
    indexes = canonicalIndexes();
    constraints = catalogConstraints(TINDER_INBOUND_QUEUE_FOUNDATION_CONSTRAINT_CONTRACT);
  }
  if (partial) columns.push(...asRows("tinder_inbound_work_items", [WORK[0]]));
  return {
    async query(sql) {
      if (sql.includes("FROM pg_constraint c")) return { rows: constraints };
      if (sql.includes("FROM pg_index")) return { rows: indexes };
      if (sql.includes("JOIN pg_attribute")) return { rows: columns };
      if (sql.includes("FROM pg_class c") && sql.includes("c.relname = ANY($1)")) return { rows: relations };
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

const draftReady = async () => ({ state: "CANONICAL" });

test("T6 recognizes only the complete persisted queue post-state or an untouched prerequisite state", async () => {
  assert.deepEqual(
    await inspectTinderInboundQueueFoundationSchema(fixtureClient(), { assertDraftReady: draftReady }),
    { state: TINDER_INBOUND_QUEUE_FOUNDATION_STATE.ABSENT }
  );
  assert.deepEqual(
    await inspectTinderInboundQueueFoundationSchema(fixtureClient({ canonical: true }), { assertDraftReady: draftReady }),
    { state: TINDER_INBOUND_QUEUE_FOUNDATION_STATE.CANONICAL }
  );
  assert.deepEqual(
    await inspectTinderInboundQueueFoundationSchema(fixtureClient({ partial: true }), { assertDraftReady: draftReady }),
    { state: TINDER_INBOUND_QUEUE_FOUNDATION_STATE.INVALID }
  );
});

test("T6 rejects a column-complete queue whose deduplication UNIQUE contract is absent", async () => {
  const client = fixtureClient({ canonical: true });
  const original = client.query.bind(client);
  client.query = async sql => {
    const result = await original(sql);
    if (sql.includes("FROM pg_constraint c")) {
      return { rows: result.rows.filter(row => !(row.table_name === "tinder_inbound_work_events" && row.contype === "u")) };
    }
    return result;
  };
  assert.deepEqual(
    await inspectTinderInboundQueueFoundationSchema(client, { assertDraftReady: draftReady }),
    { state: TINDER_INBOUND_QUEUE_FOUNDATION_STATE.INVALID }
  );
});

test("T6 rejects a queue whose lifecycle default has drifted despite canonical columns and constraints", async () => {
  const drifts = [
    ["tinder_inbound_work_items", "priority", "'BACKGROUND'::text"],
    ["tinder_inbound_work_items", "created_at", "'2026-09-01T00:00:00Z'::timestamptz"],
    ["tinder_inbound_work_audit", "details", "'[]'::jsonb"]
  ];
  for (const [relation, column, columnDefault] of drifts) {
    const client = fixtureClient({ canonical: true });
    const original = client.query.bind(client);
    client.query = async sql => {
      const result = await original(sql);
      if (sql.includes("JOIN pg_attribute")) {
        return {
          rows: result.rows.map(row => row.relation_name === relation && row.column_name === column
            ? { ...row, column_default: columnDefault }
            : row)
        };
      }
      return result;
    };
    assert.deepEqual(
      await inspectTinderInboundQueueFoundationSchema(client, { assertDraftReady: draftReady }),
      { state: TINDER_INBOUND_QUEUE_FOUNDATION_STATE.INVALID }
    );
  }
});

test("T6 fixed source has no independent transaction control and rejects appended DDL", () => {
  const source = readFileSync(new URL("../migrations/20260905_tinder_inbound_queue_foundation.sql", import.meta.url), "utf8");
  assert.doesNotThrow(() => assertTinderInboundQueueFoundationMigrationSource(source));
  assert.throws(() => assertTinderInboundQueueFoundationMigrationSource(`${source}\nCREATE TABLE surprise (id integer);`));
});
