import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertTinderOfficialAppResumePermitV2SchemaReady,
  inspectTinderOfficialAppResumePermitV2Schema,
  inspectTinderVisibleChatSyncPermitSchema,
  preflightTinderOfficialAppResumePermitV2Migration,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE,
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_CONSTRAINT_CONTRACT,
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE,
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_V2_CONSTRAINT_CONTRACT
} from "../device-bridge/tinder-visible-chat-sync-permit-schema.js";
import {
  assertTinderOfficialAppResumePermitV2MigrationSource
} from "../device-bridge/tinder-official-app-resume-permit-v2-migration.js";
import {
  TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME
} from "../device-bridge/t1-schema.js";

const V4_PERMIT_COLUMNS = [
  ["command_id", "uuid", true, ""],
  ["device_id", "uuid", true, ""],
  ["source_capture_id", "uuid", true, ""],
  ["permit_state", "text", true, "'ISSUED'"],
  ["issued_at", "timestamp with time zone", true, "now()"],
  ["expires_at", "timestamp with time zone", true, ""],
  ["staged_at", "timestamp with time zone", false, ""],
  ["consumed_at", "timestamp with time zone", false, ""],
  ["closed_at", "timestamp with time zone", false, ""],
  ["created_at", "timestamp with time zone", true, "now()"],
  ["updated_at", "timestamp with time zone", true, "now()"]
];
const TRANSCRIPT_COLUMNS = [
  ["sync_id", "uuid", true, ""],
  ["command_id", "uuid", true, ""],
  ["source_capture_id", "uuid", true, ""],
  ["device_id", "uuid", true, ""],
  ["sync_schema_version", "text", true, ""],
  ["source_package", "text", true, ""],
  ["layout_schema_version", "text", true, ""],
  ["sync_started_at", "timestamp with time zone", true, ""],
  ["sync_completed_at", "timestamp with time zone", true, ""],
  ["initial_visible_node_count", "integer", true, ""],
  ["final_visible_node_count", "integer", true, ""],
  ["segment_count", "integer", true, ""],
  ["overlap_count", "integer", true, ""],
  ["transcript_fingerprint", "character(64)", true, ""],
  ["visible_messages", "jsonb", true, ""],
  ["sync_safety_status", "text", true, ""],
  ["received_at", "timestamp with time zone", true, "now()"],
  ["created_at", "timestamp with time zone", true, "now()"]
];
const RESUME_V1_COLUMNS = [
  ["command_id", "uuid", true, ""],
  ["device_id", "uuid", true, ""],
  ["source_capture_id", "uuid", true, ""],
  ["permit_state", "text", true, "'ISSUED'"],
  ["issued_at", "timestamp with time zone", true, "now()"],
  ["expires_at", "timestamp with time zone", true, ""],
  ["dispatched_at", "timestamp with time zone", false, ""],
  ["closed_at", "timestamp with time zone", false, ""],
  ["created_at", "timestamp with time zone", true, "now()"],
  ["updated_at", "timestamp with time zone", true, "now()"]
];
const RESUME_V2_COLUMNS = [
  ...RESUME_V1_COLUMNS.slice(0, 3),
  ["binding_id", "uuid", false, ""],
  ["binding_revision", "integer", false, ""],
  ["permit_contract_version", "smallint", true, ""],
  ...RESUME_V1_COLUMNS.slice(3)
];

function bridgeInspection() {
  return {
    ready: true,
    constraints: [{
      specification: { table: "device_bridge_commands", column: "command_type" },
      constraintName: TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME
    }]
  };
}

function constraintRows(contract) {
  return contract.map(item => ({
    table_name: item.table,
    contype: item.type,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    confdeltype: item.deleteAction,
    confupdtype: item.updateAction,
    confmatchtype: item.matchType,
    constraint_definition: item.type === "c" ? item.sources[0] : item.definition,
    reference_table: item.referenceTable,
    column_names: item.columns,
    reference_column_names: item.referenceColumns
  }));
}

function index(name, unique, columns, descending, predicate = "") {
  return {
    index_name: name,
    indisunique: unique,
    indisvalid: true,
    indisready: true,
    column_names: columns,
    descending,
    predicate
  };
}

function canonicalClient(version, {
  omitBindingIndex = false,
  expectedLegacySourceCaptureConstraint = true,
  activeLegacyPermitCount = 0
} = {}) {
  const columns = [
    ...V4_PERMIT_COLUMNS.map(([column_name, data_type, not_null, column_default]) => ({ relation_name: "tinder_visible_chat_sync_permits", column_name, data_type, not_null, column_default })),
    ...(version === 1 ? RESUME_V1_COLUMNS : RESUME_V2_COLUMNS).map(([column_name, data_type, not_null, column_default]) => ({ relation_name: "tinder_official_app_resume_permits", column_name, data_type, not_null, column_default })),
    ...TRANSCRIPT_COLUMNS.map(([column_name, data_type, not_null, column_default]) => ({ relation_name: "tinder_visible_chat_sync_transcripts", column_name, data_type, not_null, column_default }))
  ];
  const indexes = [
    index("idx_tinder_visible_chat_sync_permit_active_device", true, ["device_id"], [false], "permit_state IN ('ISSUED', 'STAGED')"),
    index("idx_tinder_visible_chat_sync_permit_device_expiry", false, ["device_id", "permit_state", "expires_at"], [false, false, true]),
    index("idx_tinder_visible_chat_sync_permit_source_capture", false, ["source_capture_id", "created_at"], [false, true]),
    index("idx_tinder_official_app_resume_permit_active_device", true, ["device_id"], [false], "permit_state = 'ISSUED'"),
    index("idx_tinder_official_app_resume_permit_source_created", false, ["source_capture_id", "created_at"], [false, true]),
    index("idx_tinder_visible_chat_sync_transcript_source_received", false, ["source_capture_id", "received_at"], [false, true]),
    index("idx_tinder_visible_chat_sync_transcript_device_received", false, ["device_id", "received_at"], [false, true])
  ];
  if (version === 2 && !omitBindingIndex) {
    indexes.push(index(
      "idx_tinder_official_app_resume_permit_binding_revision_created",
      false,
      ["binding_id", "binding_revision", "created_at"],
      [false, false, true],
      "binding_id IS NOT NULL"
    ));
  }
  const contract = version === 1
    ? TINDER_VISIBLE_CHAT_SYNC_PERMIT_CONSTRAINT_CONTRACT
    : TINDER_VISIBLE_CHAT_SYNC_PERMIT_V2_CONSTRAINT_CONTRACT;
  return {
    queries: [],
    async query(sql) {
      const text = String(sql);
      this.queries.push(text);
      if (text.includes("a.attname AS column_name")) return { rows: columns };
      if (text.includes("FROM pg_index i")) return { rows: indexes };
      if (text.includes("constraint.conname=$2")) {
        return { rows: [{ canonical: version === 1 && expectedLegacySourceCaptureConstraint }] };
      }
      if (text.includes("COUNT(*)::text AS active_count")) {
        return { rows: [{ active_count: String(activeLegacyPermitCount) }] };
      }
      if (text.includes("FROM pg_constraint c")) return { rows: constraintRows(contract) };
      if (text.includes("FROM pg_class c")) {
        return { rows: [
          { relation_name: "tinder_visible_chat_sync_permits", relkind: "r" },
          { relation_name: "tinder_official_app_resume_permits", relkind: "r" },
          { relation_name: "tinder_visible_chat_sync_transcripts", relkind: "r" }
        ] };
      }
      throw new Error(`unexpected catalog query: ${text}`);
    }
  };
}

const humanArmedReady = async () => ({ state: "CANONICAL" });
const inspectionOptions = {
  assertHumanArmedFoundationReady: humanArmedReady,
  inspectDeviceBridgeSchema: async () => bridgeInspection()
};

test("V4 stays canonical across the reviewed V1/V2 resume-permit shapes while V2 distinguishes upgrade state", async () => {
  const v1 = canonicalClient(1);
  assert.deepEqual(await inspectTinderVisibleChatSyncPermitSchema(v1, inspectionOptions), {
    state: TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.CANONICAL,
    official_app_resume_permit_schema_version: TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V1
  });
  assert.deepEqual(await inspectTinderOfficialAppResumePermitV2Schema(canonicalClient(1), inspectionOptions), {
    state: TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.UPGRADE_REQUIRED,
    foundation: {
      state: TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.CANONICAL,
      official_app_resume_permit_schema_version: TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V1
    }
  });

  const v2 = canonicalClient(2);
  assert.deepEqual(await inspectTinderVisibleChatSyncPermitSchema(v2, inspectionOptions), {
    state: TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.CANONICAL,
    official_app_resume_permit_schema_version: TINDER_OFFICIAL_APP_RESUME_PERMIT_SCHEMA_VERSION.V2
  });
  assert.equal((await inspectTinderOfficialAppResumePermitV2Schema(canonicalClient(2), inspectionOptions)).state,
    TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.CANONICAL);
});

test("V2 preflight is catalog-read-only, mutates only from exact V1, and rejects partial V2 shape", async () => {
  const v1 = canonicalClient(1);
  const checked = await preflightTinderOfficialAppResumePermitV2Migration(v1, inspectionOptions);
  assert.equal(checked.mutate, true);
  assert.equal(checked.foundation.state, TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.UPGRADE_REQUIRED);
  for (const sql of v1.queries) {
    assert.match(sql, /^\s*SELECT/i);
    assert.doesNotMatch(sql, /\b(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i);
  }
  const v2 = canonicalClient(2);
  assert.equal((await preflightTinderOfficialAppResumePermitV2Migration(v2, inspectionOptions)).mutate, false);
  await assert.doesNotReject(() => assertTinderOfficialAppResumePermitV2SchemaReady(canonicalClient(2), inspectionOptions));
  const partial = canonicalClient(2, { omitBindingIndex: true });
  assert.equal((await inspectTinderOfficialAppResumePermitV2Schema(partial, inspectionOptions)).state,
    TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.INVALID);

  const renamedV1 = canonicalClient(1, { expectedLegacySourceCaptureConstraint: false });
  assert.equal((await inspectTinderOfficialAppResumePermitV2Schema(renamedV1, inspectionOptions)).state,
    TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.INVALID);
  await assert.rejects(
    () => preflightTinderOfficialAppResumePermitV2Migration(
      canonicalClient(1, { activeLegacyPermitCount: 1 }), inspectionOptions
    ),
    /active legacy permit/i
  );
});

test("fixed V2 DDL preserves legacy permit evidence and introduces only binding-scoped audit facts", () => {
  const source = readFileSync(
    new URL("../migrations/20260910_tinder_official_app_resume_permit_v2.sql", import.meta.url),
    "utf8"
  );
  assert.doesNotThrow(() => assertTinderOfficialAppResumePermitV2MigrationSource(source));
  assert.match(source, /ADD COLUMN permit_contract_version SMALLINT NOT NULL DEFAULT 1/i);
  assert.match(source, /ALTER COLUMN permit_contract_version DROP DEFAULT/i);
  assert.match(source, /DROP CONSTRAINT tinder_official_app_resume_permits_source_capture_id_key/i);
  assert.match(source, /binding_id UUID/i);
  assert.match(source, /binding_revision INTEGER/i);
  assert.match(source, /REFERENCES contact_human_armed_conversation_bindings\(binding_id\)\s+ON DELETE RESTRICT/i);
  assert.match(source, /permit_contract_version IN \(1, 2\)/i);
  assert.match(source, /permit_contract_version = 1 AND binding_id IS NULL AND binding_revision IS NULL/i);
  assert.match(source, /permit_contract_version = 2 AND binding_id IS NOT NULL/i);
  assert.match(source, /binding_revision > 0/i);
  assert.match(source, /binding_id, binding_revision, created_at DESC/i);
  assert.doesNotMatch(source, /(?:visible_name|runtime_thread_fingerprint|thread_fingerprint|capture_fingerprint|message|payload|component|intent|url|contact_id)/i);
  assert.throws(() => assertTinderOfficialAppResumePermitV2MigrationSource(
    `${source}\nALTER TABLE contacts ADD COLUMN forbidden text;`
  ));
  assert.throws(() => assertTinderOfficialAppResumePermitV2MigrationSource(
    source.replace(
      "ADD COLUMN binding_id UUID;",
      "ADD COLUMN binding_id UUID, ADD COLUMN forbidden text;"
    )
  ));
});
