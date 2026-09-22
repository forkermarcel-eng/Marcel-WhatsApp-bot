import { DeviceBridgeProtocolError, protocolErrorBody } from "./protocol-v1.js";
import { assertTinderVisibleChatCaptureBaseSchemaReady } from "./tinder-visible-chat-capture-schema.js";

/* ==================================================
PASSIVE TINDER READ â€” NARROW INGRESS READINESS
================================================== */

// The autonomous read ingress authenticates a signed device request and
// records its nonce before writing a T2 capture.  It never creates, delivers,
// or acknowledges a Device Bridge command.  Keep this catalog contract
// intentionally limited to those concrete dependencies; in particular it
// must not inherit the historical command/ACK V1…V10 vocabulary.
const AUTH_REPLAY_TABLES = Object.freeze([
  "device_bridge_devices",
  "device_bridge_keys",
  "device_bridge_request_nonces"
]);

const AUTH_REPLAY_COLUMNS = Object.freeze({
  device_bridge_devices: Object.freeze({
    device_id: Object.freeze({ type: "uuid", notNull: true }),
    enrollment_state: Object.freeze({ type: "text", notNull: true }),
    revoked_at: Object.freeze({ type: "timestamp with time zone", notNull: false })
  }),
  device_bridge_keys: Object.freeze({
    key_id: Object.freeze({ type: "uuid", notNull: true }),
    device_id: Object.freeze({ type: "uuid", notNull: true }),
    public_key_spki_der: Object.freeze({ type: "bytea", notNull: true }),
    revoked_at: Object.freeze({ type: "timestamp with time zone", notNull: false })
  }),
  device_bridge_request_nonces: Object.freeze({
    auth_subject: Object.freeze({ type: "text", notNull: true }),
    request_id: Object.freeze({ type: "uuid", notNull: true }),
    content_sha256: Object.freeze({ type: "character(64)", notNull: true }),
    accepted_at: Object.freeze({ type: "timestamp with time zone", notNull: true }),
    expires_at: Object.freeze({ type: "timestamp with time zone", notNull: true })
  })
});

function sameColumns(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasRequiredColumns(rows) {
  const actual = new Map(AUTH_REPLAY_TABLES.map(table => [table, new Map()]));
  for (const row of rows) actual.get(row.table_name)?.set(row.column_name, row);
  return AUTH_REPLAY_TABLES.every(table => Object.entries(AUTH_REPLAY_COLUMNS[table]).every(([column, expected]) => {
    const actualColumn = actual.get(table)?.get(column);
    return actualColumn?.data_type === expected.type && actualColumn?.not_null === expected.notNull;
  }));
}

function isValidConstraint(row) {
  return row?.convalidated === true && row?.condeferrable === false && row?.condeferred === false;
}

function hasUniqueKey(rows, table, columns) {
  return rows.some(row => row.table_name === table
    && (row.contype === "p" || row.contype === "u")
    && isValidConstraint(row)
    && sameColumns(row.column_names, columns));
}

function hasForeignKey(rows, table, columns, referenceTable, referenceColumns) {
  return rows.some(row => row.table_name === table
    && row.contype === "f"
    && isValidConstraint(row)
    && sameColumns(row.column_names, columns)
    && row.reference_table === referenceTable
    && sameColumns(row.reference_column_names, referenceColumns));
}

async function readRelations(client) {
  return client.query(`
    SELECT c.relname AS table_name, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = ANY($1::text[])
  `, [AUTH_REPLAY_TABLES]);
}

async function readColumns(client) {
  return client.query(`
    SELECT c.relname AS table_name, a.attname AS column_name,
      format_type(a.atttypid, a.atttypmod) AS data_type,
      a.attnotnull AS not_null
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = current_schema()
      AND c.relname = ANY($1::text[])
      AND a.attnum > 0
      AND NOT a.attisdropped
  `, [AUTH_REPLAY_TABLES]);
}

async function readConstraints(client) {
  return client.query(`
    SELECT rel.relname AS table_name, c.contype, c.convalidated,
      c.condeferrable, c.condeferred, ref.relname AS reference_table,
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
      AND c.contype IN ('p', 'u', 'f')
  `, [AUTH_REPLAY_TABLES]);
}

/**
 * Read-only schema assertion for the exact relations used by signed device
 * authentication and nonce replay.  Command, ACK, heartbeat, and audit
 * relations are deliberately absent from this query surface.
 */
export async function assertDeviceBridgeAuthReplaySchemaReady(client) {
  // A pg Client owns one wire-protocol query stream. Keep catalog reads
  // sequential just like the existing T2 schema inspector.
  const relations = await readRelations(client);
  const columns = await readColumns(client);
  const constraints = await readConstraints(client);
  const relationsReady = relations.rows.length === AUTH_REPLAY_TABLES.length
    && AUTH_REPLAY_TABLES.every(table => relations.rows.some(row => row.table_name === table && row.relkind === "r"));
  const constraintsReady = hasUniqueKey(constraints.rows, "device_bridge_devices", ["device_id"])
    && hasUniqueKey(constraints.rows, "device_bridge_keys", ["key_id"])
    && hasForeignKey(constraints.rows, "device_bridge_keys", ["device_id"], "device_bridge_devices", ["device_id"])
    && hasUniqueKey(constraints.rows, "device_bridge_request_nonces", ["auth_subject", "request_id"]);
  if (!relationsReady || !hasRequiredColumns(columns.rows) || !constraintsReady) {
    throw new Error("Tinder passive read authentication/replay schema is not ready.");
  }
  return Object.freeze({ state: "BASE_COMPATIBLE" });
}

/**
 * The passive ingress needs only signed-device authentication/replay and the
 * additive-compatible T2 capture foundation.  It intentionally does not call
 * the global Device Bridge verifier or any V1…V10 command-schema inspector.
 */
export async function assertTinderPassiveReadIngressSchemaReady(client, {
  assertAuthReplaySchemaReady = assertDeviceBridgeAuthReplaySchemaReady,
  assertCaptureSchemaReady = assertTinderVisibleChatCaptureBaseSchemaReady
} = {}) {
  await assertAuthReplaySchemaReady(client);
  await assertCaptureSchemaReady(client);
  return Object.freeze({ state: "BASE_COMPATIBLE" });
}

function requestId(req) {
  return typeof req?.get === "function" ? req.get("x-marcel-request-id") : undefined;
}

/**
 * Per-request because passive capture traffic is bounded and this prevents a
 * stale process-global readiness bit from becoming a hidden dependency.
 */
export function createTinderPassiveReadIngressFoundationMiddleware(pool, {
  assertFoundationReady = assertTinderPassiveReadIngressSchemaReady
} = {}) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("pool.connect must be a function");
  }
  if (typeof assertFoundationReady !== "function") {
    throw new TypeError("assertFoundationReady must be a function");
  }
  return async function tinderPassiveReadIngressFoundationMiddleware(req, res, next) {
    let client;
    try {
      client = await pool.connect();
      await assertFoundationReady(client);
    } catch {
      const error = new DeviceBridgeProtocolError(
        503,
        "TINDER_PASSIVE_READ_FOUNDATION_NOT_READY",
        "Tinder passive read foundation is not ready",
        true
      );
      return res.status(error.status).json(protocolErrorBody(error, requestId(req)));
    } finally {
      client?.release();
    }
    return next();
  };
}

export { AUTH_REPLAY_COLUMNS, AUTH_REPLAY_TABLES };
