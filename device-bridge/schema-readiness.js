import { assertDeviceBridgeAckSchemaReady } from "./ack-schema.js";
import { canonicalCheckDefinition, canonicalSchemaDefinition } from "./schema-contract.js";
import { assertDeviceBridgeT1SchemaReady } from "./t1-schema.js";

/* ==================================================
DEVICE BRIDGE — READ-ONLY RUNTIME AND T1 CONTRACT CHECKS
================================================== */

const REQUIRED_TABLES = Object.freeze([
  "device_bridge_devices",
  "device_bridge_keys",
  "device_bridge_enrollment_codes",
  "device_bridge_commands",
  "device_bridge_command_acks",
  "device_bridge_request_nonces",
  "device_bridge_audit_events"
]);

export const FOUNDATION_TABLE_COLUMNS = Object.freeze({
  device_bridge_devices: Object.freeze({
    device_id: "uuid", installation_id: "uuid", display_name: "text", enrollment_state: "text",
    bridge_service_state: "text", tinder_state: "text", automation_state: "text", app_version_name: "text",
    app_version_code: "int8", manufacturer: "text", model: "text", android_api: "int4", abis: "jsonb",
    capabilities: "jsonb", configuration_revision: "int4", last_heartbeat_sequence: "int8",
    last_heartbeat_body_sha256: "bpchar", last_accepted_heartbeat_at: "timestamptz", revoked_at: "timestamptz",
    revoked_reason: "text", created_at: "timestamptz", updated_at: "timestamptz"
  }),
  device_bridge_keys: Object.freeze({
    key_id: "uuid", device_id: "uuid", algorithm: "text", public_key_spki_der: "bytea",
    public_key_fingerprint: "bpchar", revoked_at: "timestamptz", revoked_reason: "text", created_at: "timestamptz"
  }),
  device_bridge_enrollment_codes: Object.freeze({
    enrollment_code_id: "uuid", code_digest: "bpchar", display_name: "text", expires_at: "timestamptz",
    consumed_at: "timestamptz", enrollment_attempt_id: "uuid", consumed_installation_id: "uuid",
    consumed_public_key_fingerprint: "bpchar", consumed_device_id: "uuid", consumed_key_id: "uuid",
    created_at: "timestamptz", created_by: "text"
  }),
  device_bridge_commands: Object.freeze({
    command_id: "uuid", device_id: "uuid", protocol_version: "int4", command_type: "text", payload: "jsonb",
    configuration_revision: "int4", issued_at: "timestamptz", expires_at: "timestamptz", created_by: "text",
    delivered_at: "timestamptz", terminal_status: "text", terminal_at: "timestamptz"
  }),
  device_bridge_command_acks: Object.freeze({
    ack_id: "int8", command_id: "uuid", device_id: "uuid", status: "text", occurred_at: "timestamptz",
    result: "jsonb", error: "jsonb", body_sha256: "bpchar", accepted_at: "timestamptz"
  }),
  device_bridge_request_nonces: Object.freeze({
    auth_subject: "text", request_id: "uuid", content_sha256: "bpchar", accepted_at: "timestamptz", expires_at: "timestamptz"
  }),
  device_bridge_audit_events: Object.freeze({
    audit_event_id: "int8", event_type: "text", request_id: "uuid", device_id: "uuid", key_id: "uuid",
    command_id: "uuid", result_code: "text", http_status: "int4", details: "jsonb", created_at: "timestamptz"
  })
});

const FORMAT_TYPE_BY_UDT = Object.freeze({
  uuid: "uuid",
  text: "text",
  int4: "integer",
  int8: "bigint",
  jsonb: "jsonb",
  bpchar: "character(64)",
  timestamptz: "timestamp with time zone",
  bytea: "bytea"
});

const NOT_NULL_COLUMNS = new Set([
  "device_bridge_devices.device_id", "device_bridge_devices.installation_id", "device_bridge_devices.display_name",
  "device_bridge_devices.enrollment_state", "device_bridge_devices.bridge_service_state", "device_bridge_devices.tinder_state",
  "device_bridge_devices.automation_state", "device_bridge_devices.abis", "device_bridge_devices.capabilities",
  "device_bridge_devices.configuration_revision", "device_bridge_devices.created_at", "device_bridge_devices.updated_at",
  "device_bridge_keys.key_id", "device_bridge_keys.device_id", "device_bridge_keys.algorithm",
  "device_bridge_keys.public_key_spki_der", "device_bridge_keys.public_key_fingerprint", "device_bridge_keys.created_at",
  "device_bridge_enrollment_codes.enrollment_code_id", "device_bridge_enrollment_codes.code_digest",
  "device_bridge_enrollment_codes.expires_at", "device_bridge_enrollment_codes.created_at", "device_bridge_enrollment_codes.created_by",
  "device_bridge_commands.command_id", "device_bridge_commands.device_id", "device_bridge_commands.protocol_version",
  "device_bridge_commands.command_type", "device_bridge_commands.payload", "device_bridge_commands.configuration_revision",
  "device_bridge_commands.issued_at", "device_bridge_commands.expires_at", "device_bridge_commands.created_by",
  "device_bridge_command_acks.ack_id", "device_bridge_command_acks.command_id", "device_bridge_command_acks.device_id",
  "device_bridge_command_acks.status", "device_bridge_command_acks.occurred_at", "device_bridge_command_acks.body_sha256",
  "device_bridge_command_acks.accepted_at",
  "device_bridge_request_nonces.auth_subject", "device_bridge_request_nonces.request_id",
  "device_bridge_request_nonces.content_sha256", "device_bridge_request_nonces.accepted_at", "device_bridge_request_nonces.expires_at",
  "device_bridge_audit_events.audit_event_id", "device_bridge_audit_events.event_type",
  "device_bridge_audit_events.details", "device_bridge_audit_events.created_at"
]);

const COLUMN_DEFAULTS = Object.freeze({
  "device_bridge_devices.enrollment_state": "'ACTIVE'",
  "device_bridge_devices.bridge_service_state": "'STOPPED'",
  "device_bridge_devices.tinder_state": "'UNKNOWN'",
  "device_bridge_devices.automation_state": "'STOPPED'",
  "device_bridge_devices.abis": "'[]'",
  "device_bridge_devices.capabilities": "'[]'",
  "device_bridge_devices.configuration_revision": "1",
  "device_bridge_devices.created_at": "now()",
  "device_bridge_devices.updated_at": "now()",
  "device_bridge_keys.created_at": "now()",
  "device_bridge_enrollment_codes.created_at": "now()",
  "device_bridge_enrollment_codes.created_by": "'dashboard'",
  "device_bridge_commands.protocol_version": "1",
  "device_bridge_commands.issued_at": "now()",
  "device_bridge_commands.created_by": "'dashboard'",
  "device_bridge_command_acks.ack_id": "nextval('device_bridge_command_acks_ack_id_seq')",
  "device_bridge_command_acks.accepted_at": "now()",
  "device_bridge_request_nonces.accepted_at": "now()",
  "device_bridge_audit_events.audit_event_id": "nextval('device_bridge_audit_events_audit_event_id_seq')",
  "device_bridge_audit_events.details": "'{}'",
  "device_bridge_audit_events.created_at": "now()"
});

export const FOUNDATION_COLUMN_CONTRACT = Object.freeze(Object.fromEntries(
  Object.entries(FOUNDATION_TABLE_COLUMNS).map(([table, columns]) => [table, Object.freeze(
    Object.fromEntries(Object.entries(columns).map(([column, udt]) => {
      const key = `${table}.${column}`;
      return [column, immutableColumnContract({
        dataType: FORMAT_TYPE_BY_UDT[udt],
        notNull: NOT_NULL_COLUMNS.has(key),
        defaultExpression: COLUMN_DEFAULTS[key] || ""
      })];
    }))
  )])
));

function immutableColumnContract(value) {
  return Object.freeze({ ...value, identityKind: "", generatedKind: "" });
}

function immutableRecord(value) {
  return Object.freeze(value);
}

function check(table, ...definitions) {
  return immutableRecord({
    table,
    type: "c",
    columns: null,
    sources: definitions,
    definitions: definitions.map(definition => canonicalCheckDefinition(definition))
  });
}

function key(table, type, columns, definition, extra = {}) {
  return immutableRecord({
    table,
    type,
    columns,
    source: definition,
    definition: canonicalSchemaDefinition(definition),
    referenceTable: extra.referenceTable || "",
    referenceColumns: extra.referenceColumns || [],
    deleteAction: extra.deleteAction || "",
    updateAction: extra.updateAction || "",
    matchType: extra.matchType || (type === "f" ? "s" : "")
  });
}

const FOUNDATION_CONSTRAINT_CONTRACT = Object.freeze([
  key("device_bridge_devices", "p", ["device_id"], "PRIMARY KEY (device_id)"),
  key("device_bridge_devices", "u", ["installation_id"], "UNIQUE (installation_id)"),
  check("device_bridge_devices", "char_length(display_name) >= 1 AND char_length(display_name) <= 128", "char_length(display_name) BETWEEN 1 AND 128"),
  check("device_bridge_devices", "enrollment_state IN ('ACTIVE', 'REVOKED', 'RE_ENROLL_REQUIRED')"),
  check("device_bridge_devices", "bridge_service_state IN ('STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'ERROR')"),
  check("device_bridge_devices", "automation_state IN ('STOPPED', 'RUNNING')"),
  check("device_bridge_devices", "app_version_code IS NULL OR app_version_code >= 0"),
  check("device_bridge_devices", "android_api IS NULL OR android_api >= 24"),
  check("device_bridge_devices", "jsonb_typeof(abis) = 'array'"),
  check("device_bridge_devices", "jsonb_typeof(capabilities) = 'array'"),
  check("device_bridge_devices", "configuration_revision > 0"),
  check("device_bridge_devices", "last_heartbeat_sequence IS NULL OR last_heartbeat_sequence > 0"),
  check("device_bridge_devices", "last_heartbeat_body_sha256 IS NULL OR last_heartbeat_body_sha256 ~ '^[0-9a-f]{64}$'"),
  check("device_bridge_devices", "(enrollment_state = 'REVOKED') = (revoked_at IS NOT NULL)"),

  key("device_bridge_keys", "p", ["key_id"], "PRIMARY KEY (key_id)"),
  key("device_bridge_keys", "u", ["public_key_fingerprint"], "UNIQUE (public_key_fingerprint)"),
  key("device_bridge_keys", "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  check("device_bridge_keys", "algorithm = 'EC_P256_SHA256'"),
  check("device_bridge_keys", "public_key_fingerprint ~ '^[0-9a-f]{64}$'"),

  key("device_bridge_enrollment_codes", "p", ["enrollment_code_id"], "PRIMARY KEY (enrollment_code_id)"),
  key("device_bridge_enrollment_codes", "u", ["code_digest"], "UNIQUE (code_digest)"),
  key("device_bridge_enrollment_codes", "u", ["enrollment_attempt_id"], "UNIQUE (enrollment_attempt_id)"),
  key("device_bridge_enrollment_codes", "f", ["consumed_device_id"], "FOREIGN KEY (consumed_device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  key("device_bridge_enrollment_codes", "f", ["consumed_key_id"], "FOREIGN KEY (consumed_key_id) REFERENCES device_bridge_keys(key_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_keys", referenceColumns: ["key_id"], deleteAction: "r", updateAction: "a"
  }),
  check("device_bridge_enrollment_codes", "code_digest ~ '^[0-9a-f]{64}$'"),
  check("device_bridge_enrollment_codes", "display_name IS NULL OR (char_length(display_name) >= 1 AND char_length(display_name) <= 128)", "display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 128"),
  check("device_bridge_enrollment_codes", "consumed_public_key_fingerprint IS NULL OR consumed_public_key_fingerprint ~ '^[0-9a-f]{64}$'"),
  check("device_bridge_enrollment_codes", "expires_at > created_at"),
  check("device_bridge_enrollment_codes", "(consumed_at IS NULL AND enrollment_attempt_id IS NULL AND consumed_installation_id IS NULL AND consumed_public_key_fingerprint IS NULL AND consumed_device_id IS NULL AND consumed_key_id IS NULL) OR (consumed_at IS NOT NULL AND enrollment_attempt_id IS NOT NULL AND consumed_installation_id IS NOT NULL AND consumed_public_key_fingerprint IS NOT NULL AND consumed_device_id IS NOT NULL AND consumed_key_id IS NOT NULL)"),

  key("device_bridge_commands", "p", ["command_id"], "PRIMARY KEY (command_id)"),
  key("device_bridge_commands", "u", ["command_id", "device_id"], "UNIQUE (command_id, device_id)"),
  key("device_bridge_commands", "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  check("device_bridge_commands", "protocol_version = 1"),
  check("device_bridge_commands", "jsonb_typeof(payload) = 'object'"),
  check("device_bridge_commands", "configuration_revision > 0"),
  check("device_bridge_commands", "terminal_status IS NULL OR terminal_status IN ('SUCCEEDED', 'FAILED', 'REJECTED', 'EXPIRED')"),
  check("device_bridge_commands", "expires_at > issued_at"),
  check("device_bridge_commands", "(terminal_status IS NULL) = (terminal_at IS NULL)"),

  key("device_bridge_command_acks", "p", ["ack_id"], "PRIMARY KEY (ack_id)"),
  key("device_bridge_command_acks", "u", ["command_id", "status"], "UNIQUE (command_id, status)"),
  key("device_bridge_command_acks", "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "r", updateAction: "a"
  }),
  key("device_bridge_command_acks", "f", ["command_id", "device_id"], "FOREIGN KEY (command_id, device_id) REFERENCES device_bridge_commands(command_id, device_id) ON DELETE RESTRICT", {
    referenceTable: "device_bridge_commands", referenceColumns: ["command_id", "device_id"], deleteAction: "r", updateAction: "a"
  }),

  key("device_bridge_request_nonces", "p", ["auth_subject", "request_id"], "PRIMARY KEY (auth_subject, request_id)"),
  check("device_bridge_request_nonces", "content_sha256 ~ '^[0-9a-f]{64}$'"),
  check("device_bridge_request_nonces", "expires_at > accepted_at"),

  key("device_bridge_audit_events", "p", ["audit_event_id"], "PRIMARY KEY (audit_event_id)"),
  key("device_bridge_audit_events", "f", ["device_id"], "FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE SET NULL", {
    referenceTable: "device_bridge_devices", referenceColumns: ["device_id"], deleteAction: "n", updateAction: "a"
  }),
  key("device_bridge_audit_events", "f", ["key_id"], "FOREIGN KEY (key_id) REFERENCES device_bridge_keys(key_id) ON DELETE SET NULL", {
    referenceTable: "device_bridge_keys", referenceColumns: ["key_id"], deleteAction: "n", updateAction: "a"
  }),
  key("device_bridge_audit_events", "f", ["command_id"], "FOREIGN KEY (command_id) REFERENCES device_bridge_commands(command_id) ON DELETE SET NULL", {
    referenceTable: "device_bridge_commands", referenceColumns: ["command_id"], deleteAction: "n", updateAction: "a"
  }),
  check("device_bridge_audit_events", "http_status IS NULL OR (http_status >= 100 AND http_status <= 599)", "http_status IS NULL OR http_status BETWEEN 100 AND 599"),
  check("device_bridge_audit_events", "jsonb_typeof(details) = 'object'")
]);

const FOUNDATION_INDEX_CONTRACT = Object.freeze([
  immutableRecord({ table: "device_bridge_keys", name: "device_bridge_one_active_key_per_device", unique: true, keys: ["device_id"], options: [0], predicate: "revoked_at IS NULL" }),
  immutableRecord({ table: "device_bridge_enrollment_codes", name: "device_bridge_enrollment_expiry_idx", unique: false, keys: ["expires_at"], options: [0], predicate: "consumed_at IS NULL" }),
  immutableRecord({ table: "device_bridge_commands", name: "device_bridge_commands_delivery_idx", unique: false, keys: ["device_id", "issued_at"], options: [0, 0], predicate: "terminal_status IS NULL" }),
  immutableRecord({ table: "device_bridge_command_acks", name: "device_bridge_command_acks_device_idx", unique: false, keys: ["device_id", "accepted_at"], options: [0, 3], predicate: "" }),
  immutableRecord({ table: "device_bridge_request_nonces", name: "device_bridge_request_nonces_expiry_idx", unique: false, keys: ["expires_at"], options: [0], predicate: "" }),
  immutableRecord({ table: "device_bridge_audit_events", name: "device_bridge_audit_device_time_idx", unique: false, keys: ["device_id", "created_at"], options: [0, 3], predicate: "" }),
  immutableRecord({ table: "device_bridge_audit_events", name: "device_bridge_audit_command_time_idx", unique: false, keys: ["command_id", "created_at"], options: [0, 3], predicate: "" })
]);

function sameArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function safeCanonicalDefinition(value) {
  try {
    return canonicalSchemaDefinition(value);
  } catch {
    return null;
  }
}

function safeCanonicalCheck(value) {
  try {
    return canonicalCheckDefinition(value);
  } catch {
    return null;
  }
}

function constraintFingerprint(record) {
  const definition = record.contype === "c" ? safeCanonicalCheck(record.constraint_definition) : "";
  if (record.contype === "c" && !definition) return null;
  return JSON.stringify({
    table: record.table_name,
    type: record.contype,
    columns: record.contype === "c" ? [] : record.column_names,
    definition,
    referenceTable: record.reference_table || "",
    referenceColumns: record.reference_column_names || [],
    // pg_constraint uses a blank catalog char for these fields on non-FK
    // constraints. Treat that sentinel as absent, while retaining FK codes.
    deleteAction: String(record.confdeltype || "").trim(),
    updateAction: String(record.confupdtype || "").trim(),
    matchType: String(record.confmatchtype || "").trim()
  });
}

function expectedConstraintFingerprint(contract) {
  return JSON.stringify({
    table: contract.table,
    type: contract.type,
    columns: contract.type === "c" ? [] : contract.columns,
    definition: contract.type === "c" ? contract.definitions[0] : "",
    referenceTable: contract.referenceTable || "",
    referenceColumns: contract.referenceColumns || [],
    deleteAction: contract.deleteAction || "",
    updateAction: contract.updateAction || "",
    matchType: contract.matchType || ""
  });
}

function isMutableT1Check(record) {
  return record.contype === "c" && (
    (record.table_name === "device_bridge_devices" && sameArray(record.column_names, ["tinder_state"]))
    || (record.table_name === "device_bridge_commands" && sameArray(record.column_names, ["command_type"]))
  );
}

function isAckCheck(record) {
  return record.table_name === "device_bridge_command_acks" && record.contype === "c";
}

function normalizedSmallIntArray(value) {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string") return value.replace(/[{}]/g, "").split(",").filter(Boolean).map(Number);
  return [];
}

export async function inspectDeviceBridgeFoundationTables(client) {
  const missing = [];
  for (const table of REQUIRED_TABLES) {
    const result = await client.query("SELECT to_regclass($1) AS relation_name", [table]);
    if (!result.rows[0]?.relation_name) missing.push(table);
  }
  return { ready: missing.length === 0, missing };
}

export async function assertDeviceBridgeFoundationTables(client) {
  const inspection = await inspectDeviceBridgeFoundationTables(client);
  if (!inspection.ready) throw new Error("Device Bridge schema is not ready.");
  return inspection;
}

async function readFoundationRelations(client) {
  return client.query(`
    SELECT c.relname AS table_name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = ANY($1::text[])
  `, [REQUIRED_TABLES]);
}

async function readFoundationColumns(client) {
  return client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null,
      COALESCE(pg_get_expr(d.adbin, d.adrelid, true), '') AS column_default,
      a.attidentity AS identity_kind,
      a.attgenerated AS generated_kind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = current_schema()
      AND c.relname = ANY($1::text[])
      AND a.attnum > 0
      AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum
  `, [REQUIRED_TABLES]);
}

async function readFoundationConstraints(client) {
  return client.query(`
    SELECT rel.relname AS table_name, c.contype, c.convalidated,
      c.condeferrable, c.condeferred, c.confdeltype, c.confupdtype, c.confmatchtype,
      pg_get_constraintdef(c.oid, true) AS constraint_definition,
      ref.relname AS reference_table,
      ARRAY(
        SELECT a.attname::text
        FROM unnest(c.conkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum
        ORDER BY key.ordinality
      ) AS column_names,
      ARRAY(
        SELECT a.attname::text
        FROM unnest(c.confkey) WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = key.attnum
        ORDER BY key.ordinality
      ) AS reference_column_names
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    LEFT JOIN pg_class ref ON ref.oid = c.confrelid
    WHERE n.nspname = current_schema()
      AND rel.relname = ANY($1::text[])
      AND c.contype IN ('p', 'u', 'f', 'c')
  `, [REQUIRED_TABLES]);
}

async function readFoundationIndexes(client) {
  return client.query(`
    SELECT rel.relname AS table_name, idx.relname AS index_name,
      i.indisunique, i.indisvalid, i.indisready, am.amname AS access_method,
      ARRAY(
        SELECT pg_get_indexdef(i.indexrelid, key_number.position, true)
        FROM generate_series(1, i.indnkeyatts) AS key_number(position)
        ORDER BY key_number.position
      ) AS key_expressions,
      ARRAY(
        -- int2vector preserves PostgreSQL's zero lower bound after the
        -- array cast; pg_get_indexdef above intentionally remains 1-based.
        SELECT ((i.indoption::int2[])[key_number.position - 1])::int
        FROM generate_series(1, i.indnkeyatts) AS key_number(position)
        ORDER BY key_number.position
      ) AS key_options,
      COALESCE(pg_get_expr(i.indpred, i.indrelid, true), '') AS predicate
    FROM pg_index i
    JOIN pg_class rel ON rel.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    JOIN pg_class idx ON idx.oid = i.indexrelid
    JOIN pg_am am ON am.oid = idx.relam
    LEFT JOIN pg_constraint backing ON backing.conindid = i.indexrelid
    WHERE n.nspname = current_schema()
      AND rel.relname = ANY($1::text[])
      AND backing.oid IS NULL
  `, [REQUIRED_TABLES]);
}

function hasExactColumns(rows) {
  const actual = new Map(REQUIRED_TABLES.map(table => [table, new Map()]));
  for (const row of rows) actual.get(row.table_name)?.set(row.column_name, row);
  return REQUIRED_TABLES.every(table => {
    const expected = FOUNDATION_COLUMN_CONTRACT[table];
    const columns = actual.get(table);
    return columns.size === Object.keys(expected).length
      && Object.entries(expected).every(([column, contract]) => {
        const row = columns.get(column);
        return row
          && row.data_type === contract.dataType
          && row.not_null === contract.notNull
          && (row.identity_kind || "") === contract.identityKind
          && (row.generated_kind || "") === contract.generatedKind
          && safeCanonicalDefinition(row.column_default || "")
            === safeCanonicalDefinition(contract.defaultExpression);
      });
  });
}

function hasExactConstraints(rows) {
  const remaining = rows.filter(row => !isMutableT1Check(row) && !isAckCheck(row));
  if (!remaining.every(row => row.convalidated === true && row.condeferrable === false && row.condeferred === false)) return false;
  for (const contract of FOUNDATION_CONSTRAINT_CONTRACT) {
    const expected = expectedConstraintFingerprint(contract);
    const matches = remaining.filter(row => {
      if (row.table_name !== contract.table || row.contype !== contract.type) return false;
      if (contract.type === "c") return contract.definitions.includes(safeCanonicalCheck(row.constraint_definition));
      return constraintFingerprint(row) === expected;
    });
    if (matches.length !== 1) return false;
    remaining.splice(remaining.indexOf(matches[0]), 1);
  }
  return remaining.length === 0;
}

function hasExactIndexes(rows) {
  if (rows.length !== FOUNDATION_INDEX_CONTRACT.length) return false;
  return FOUNDATION_INDEX_CONTRACT.every(contract => {
    const matches = rows.filter(row => row.table_name === contract.table && row.index_name === contract.name);
    if (matches.length !== 1) return false;
    const row = matches[0];
    return row.indisunique === contract.unique
      && row.indisvalid === true
      && row.indisready === true
      && row.access_method === "btree"
      && sameArray(row.key_expressions?.map(safeCanonicalDefinition), contract.keys.map(safeCanonicalDefinition))
      && sameArray(normalizedSmallIntArray(row.key_options), contract.options)
      && safeCanonicalDefinition(row.predicate || "") === safeCanonicalDefinition(contract.predicate);
  });
}

/**
 * Explicit T1 release preflight. This is fully read-only and requires the
 * complete, canonical T0 foundation. It never creates or repairs anything.
 */
export async function preflightDeviceBridgeFoundationForT1(client) {
  const presence = await inspectDeviceBridgeFoundationTables(client);
  if (!presence.ready) {
    throw new Error("Device Bridge T1 migration requires a complete existing foundation.");
  }
  const relations = await readFoundationRelations(client);
  const columns = await readFoundationColumns(client);
  const constraints = await readFoundationConstraints(client);
  const indexes = await readFoundationIndexes(client);
  const canonicalRelations = relations.rows.length === REQUIRED_TABLES.length
    && REQUIRED_TABLES.every(table => relations.rows.some(row => row.table_name === table && row.relkind === "r"));
  if (!canonicalRelations || !hasExactColumns(columns.rows) || !hasExactConstraints(constraints.rows) || !hasExactIndexes(indexes.rows)) {
    throw new Error("Device Bridge T1 foundation compatibility check failed.");
  }
  return { ready: true };
}

/**
 * Runtime startup check. It is deliberately read-only: no transaction,
 * locks, DDL, row updates, or migration helper is invoked here.
 */
export async function verifyDeviceBridgeSchema(pool) {
  const client = await pool.connect();
  try {
    await assertDeviceBridgeFoundationTables(client);
    await assertDeviceBridgeT1SchemaReady(client);
    await assertDeviceBridgeAckSchemaReady(client);
    return { ready: true };
  } finally {
    client.release();
  }
}

export { REQUIRED_TABLES, FOUNDATION_CONSTRAINT_CONTRACT, FOUNDATION_INDEX_CONTRACT };
