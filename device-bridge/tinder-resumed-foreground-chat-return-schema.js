import {
  inspectDeviceBridgeT1Schema,
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME,
  TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
} from "./t1-schema.js";
import { inspectTinderVerifiedChatReturnCatalog } from "./tinder-verified-chat-return-schema.js";
import {
  hasExpectedTinderFoundationConstraints,
  readTinderFoundationConstraints,
  tinderFoundationCheck,
  tinderFoundationKey
} from "./tinder-foundation-constraint-contract.js";
import { canonicalSchemaPredicate } from "./schema-contract.js";

/* Exact V9 -> V10 catalog-only contract. */

export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE = Object.freeze({
  UPGRADE_REQUIRED: "UPGRADE_REQUIRED",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE =
  "tinder_resumed_foreground_chat_return_permits";
export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE =
  "tinder_resumed_foreground_chat_return_audit";

const TARGET_RELATIONS = Object.freeze([
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE,
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE
]);
const TARGET_INDEX_NAMES = Object.freeze([
  "idx_tinder_resumed_foreground_chat_return_active_device",
  "idx_tinder_resumed_foreground_chat_return_resume_created",
  "idx_tinder_resumed_foreground_chat_return_audit_command_created"
]);
const PERMIT_COLUMNS = Object.freeze([
  "command_id", "device_id", "resume_command_id", "permit_contract_version",
  "permit_state", "issued_at", "expires_at", "staged_at", "returned_at",
  "closed_at", "terminal_reason", "created_at", "updated_at"
]);
const AUDIT_COLUMNS = Object.freeze([
  "audit_id", "command_id", "device_id", "action", "reason_code", "actor",
  "source", "details", "created_at"
]);

function exactSet(values, expected) {
  const actual = values.map(value => String(value || "")).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((value, index) => value === wanted[index]);
}

async function commandConstraintName(client, inspectDeviceBridgeSchema) {
  const inspection = await inspectDeviceBridgeSchema(client);
  if (!inspection?.ready) return null;
  return inspection.constraints?.find(item => item.specification?.table === "device_bridge_commands"
    && item.specification?.column === "command_type")?.constraintName || null;
}

async function readRelations(client) {
  return client.query(`SELECT c.relname AS relation_name,c.relkind FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=current_schema() AND c.relname=ANY($1)`, [TARGET_RELATIONS]);
}
async function readColumns(client) {
  return client.query(`SELECT c.relname AS relation_name,a.attname AS column_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=current_schema() AND c.relname=ANY($1) AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname,a.attnum`, [TARGET_RELATIONS]);
}
async function readIndexes(client) {
  return client.query(`SELECT idx.relname AS index_name,i.indisunique,i.indisvalid,i.indisready,
      ARRAY(SELECT a.attname::text FROM unnest(i.indkey) WITH ORDINALITY AS key(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum ORDER BY key.ordinality) AS column_names,
      ARRAY(SELECT (option & 1)=1 FROM unnest(i.indoption) WITH ORDINALITY AS option_value(option,ordinality)
        ORDER BY ordinality) AS descending,
      COALESCE(pg_get_expr(i.indpred,i.indrelid,true),'') AS predicate
    FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_class relation ON relation.oid=i.indrelid JOIN pg_namespace n ON n.oid=relation.relnamespace
    WHERE n.nspname=current_schema() AND relation.relname=ANY($1)
      AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid=i.indexrelid)`, [TARGET_RELATIONS]);
}
async function readTriggers(client) {
  return client.query(`SELECT t.tgname AS trigger_name,c.relname AS relation_name,t.tgenabled AS enabled,
      t.tgdeferrable AS deferrable,t.tginitdeferred AS initially_deferred,p.proname AS function_name,
      pg_get_triggerdef(t.oid,true) AS trigger_definition,p.prosrc AS function_source
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE n.nspname=current_schema() AND c.relname=ANY($1) AND NOT t.tgisinternal`, [TARGET_RELATIONS]);
}
function relationKind(rows, name) { return rows.find(row => row.relation_name === name)?.relkind || null; }
function relationColumns(rows, name) { return rows.filter(row => row.relation_name === name).map(row => row.column_name); }
function canonicalSql(value) { return String(value || "").replace(/\s+/g, " ").trim().toLowerCase(); }
function sameArray(actual, expected) { return Array.isArray(actual) && actual.length === expected.length && actual.every((v, i) => v === expected[i]); }
function indexMatches(rows, name, { unique, columns, descending, predicate = "" }) {
  const row = rows.find(candidate => candidate.index_name === name);
  return Boolean(row) && row.indisvalid === true && row.indisready === true && row.indisunique === unique
    && sameArray(row.column_names, columns) && sameArray(row.descending, descending)
    && canonicalSchemaPredicate(row.predicate) === canonicalSchemaPredicate(predicate);
}
function indexesCanonical(rows) {
  return Array.isArray(rows) && rows.length === TARGET_INDEX_NAMES.length
    && rows.every(row => TARGET_INDEX_NAMES.includes(row?.index_name))
    && indexMatches(rows, "idx_tinder_resumed_foreground_chat_return_active_device", {
      unique: true, columns: ["device_id"], descending: [false], predicate: "permit_state IN ('ISSUED', 'STAGED')"
    })
    && indexMatches(rows, "idx_tinder_resumed_foreground_chat_return_resume_created", {
      unique: false, columns: ["resume_command_id", "created_at"], descending: [false, true]
    })
    && indexMatches(rows, "idx_tinder_resumed_foreground_chat_return_audit_command_created", {
      unique: false, columns: ["command_id", "created_at"], descending: [false, true]
    });
}

function canonicalTriggerDefinition(value) {
  return canonicalSql(value).replace(/\b(after|before)\s+((?:(?:insert|delete|update)(?:\s+or\s+)?)+)(?=\s+on\b)/g,
    (_whole, timing, events) => `${timing} ${String(events).split(/\s+or\s+/).map(v => v.trim()).filter(Boolean).sort().join(" or ")}`);
}
const TRIGGERS = Object.freeze([
  Object.freeze({ name: "tinder_resumed_foreground_chat_return_resume_scope", table: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE,
    functionName: "tinder_resumed_foreground_chat_return_resume_scope_guard",
    definition: `CREATE TRIGGER tinder_resumed_foreground_chat_return_resume_scope BEFORE INSERT OR UPDATE ON ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE} FOR EACH ROW EXECUTE FUNCTION tinder_resumed_foreground_chat_return_resume_scope_guard()`,
    fragments: ["from tinder_official_app_resume_permits resume", "resume.command_id=new.resume_command_id", "resume.device_id=new.device_id", "resume.permit_contract_version=2", "resume.permit_state='dispatched'", "resume_command.terminal_status='succeeded'"] }),
  Object.freeze({ name: "tinder_resumed_foreground_chat_return_permit_immutable", table: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE,
    functionName: "tinder_resumed_foreground_chat_return_immutable_guard",
    definition: `CREATE TRIGGER tinder_resumed_foreground_chat_return_permit_immutable BEFORE UPDATE OR DELETE ON ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE} FOR EACH ROW EXECUTE FUNCTION tinder_resumed_foreground_chat_return_immutable_guard()`,
    fragments: ["old.permit_state in ('returned', 'cancelled', 'expired')", "new.resume_command_id is distinct from old.resume_command_id", "old.permit_state = 'issued' and new.permit_state not in ('issued', 'staged', 'cancelled', 'expired')"] }),
  Object.freeze({ name: "tinder_resumed_foreground_chat_return_audit_immutable", table: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE,
    functionName: "tinder_resumed_foreground_chat_return_immutable_guard",
    definition: `CREATE TRIGGER tinder_resumed_foreground_chat_return_audit_immutable BEFORE UPDATE OR DELETE ON ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE} FOR EACH ROW EXECUTE FUNCTION tinder_resumed_foreground_chat_return_immutable_guard()`,
    fragments: ["if tg_table_name = 'tinder_resumed_foreground_chat_return_audit' then", "return audit is immutable"] })
]);
function triggersCanonical(rows) {
  return Array.isArray(rows) && rows.length === TRIGGERS.length && TRIGGERS.every(expected => {
    const row = rows.find(candidate => candidate.trigger_name === expected.name && candidate.relation_name === expected.table);
    const source = canonicalSql(row?.function_source);
    return row?.enabled === 'O' && row?.deferrable === false && row?.initially_deferred === false
      && row?.function_name === expected.functionName
      && canonicalTriggerDefinition(row?.trigger_definition) === canonicalTriggerDefinition(expected.definition)
      && expected.fragments.every(fragment => source.includes(canonicalSql(fragment)));
  });
}
function absentCatalog(catalog) {
  return catalog.relations.rows.length === 0 && catalog.columns.rows.length === 0
    && catalog.indexes.rows.length === 0 && catalog.triggers.rows.length === 0 && catalog.constraints.rows.length === 0;
}
function checks(table, definitions) { return definitions.map(definition => tinderFoundationCheck(table, definition)); }
function foreignKey(table, columns, definition, referenceTable, referenceColumns) {
  return tinderFoundationKey(table, "f", columns, definition, { referenceTable, referenceColumns, deleteAction: "r", updateAction: "a" });
}
const PERMIT_STATE_CHECK = `(permit_state = 'ISSUED' AND staged_at IS NULL AND returned_at IS NULL AND closed_at IS NULL AND terminal_reason IS NULL) OR (permit_state = 'STAGED' AND staged_at IS NOT NULL AND returned_at IS NULL AND closed_at IS NULL AND terminal_reason IS NULL) OR (permit_state = 'RETURNED' AND staged_at IS NOT NULL AND returned_at IS NOT NULL AND closed_at = returned_at AND terminal_reason IS NULL) OR (permit_state = 'CANCELLED' AND returned_at IS NULL AND closed_at IS NOT NULL AND terminal_reason IN ('COMMAND_REJECTED', 'COMMAND_FAILED', 'COMMAND_EXPIRED')) OR (permit_state = 'EXPIRED' AND returned_at IS NULL AND closed_at IS NOT NULL AND terminal_reason = 'PERMIT_EXPIRED')`;
const AUDIT_REASON_CHECK = `(action IN ('RETURN_ISSUED', 'RETURN_STAGED', 'RETURNED') AND reason_code IS NULL) OR (action = 'RETURN_CANCELLED' AND reason_code IN ('COMMAND_REJECTED', 'COMMAND_FAILED', 'COMMAND_EXPIRED')) OR (action = 'RETURN_EXPIRED' AND reason_code = 'PERMIT_EXPIRED')`;

export const TINDER_RESUMED_FOREGROUND_CHAT_RETURN_CONSTRAINT_CONTRACT = Object.freeze([
  tinderFoundationKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, 'p', ['command_id'], 'PRIMARY KEY (command_id)'),
  foreignKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, ['command_id'], 'FOREIGN KEY (command_id) REFERENCES device_bridge_commands(command_id) ON DELETE RESTRICT', 'device_bridge_commands', ['command_id']),
  foreignKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, ['device_id'], 'FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT', 'device_bridge_devices', ['device_id']),
  foreignKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, ['resume_command_id'], 'FOREIGN KEY (resume_command_id) REFERENCES tinder_official_app_resume_permits(command_id) ON DELETE RESTRICT', 'tinder_official_app_resume_permits', ['command_id']),
  foreignKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, ['command_id', 'device_id'], 'FOREIGN KEY (command_id, device_id) REFERENCES device_bridge_commands(command_id, device_id) ON DELETE RESTRICT', 'device_bridge_commands', ['command_id', 'device_id']),
  tinderFoundationKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, 'u', ['command_id', 'device_id'], 'UNIQUE (command_id, device_id)'),
  tinderFoundationKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, 'u', ['resume_command_id'], 'UNIQUE (resume_command_id)'),
  ...checks(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, [
    'permit_contract_version = 1', "permit_state IN ('ISSUED', 'STAGED', 'RETURNED', 'CANCELLED', 'EXPIRED')",
    'expires_at > issued_at', "expires_at <= (issued_at + '00:01:30'::interval)",
    "terminal_reason IS NULL OR terminal_reason IN ('COMMAND_REJECTED', 'COMMAND_FAILED', 'COMMAND_EXPIRED', 'PERMIT_EXPIRED')",
    PERMIT_STATE_CHECK, 'staged_at IS NULL OR staged_at >= issued_at',
    'returned_at IS NULL OR (staged_at IS NOT NULL AND returned_at >= staged_at)', 'closed_at IS NULL OR closed_at >= issued_at'
  ]),
  tinderFoundationKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE, 'p', ['audit_id'], 'PRIMARY KEY (audit_id)'),
  foreignKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE, ['command_id'], `FOREIGN KEY (command_id) REFERENCES ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE}(command_id) ON DELETE RESTRICT`, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, ['command_id']),
  foreignKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE, ['device_id'], 'FOREIGN KEY (device_id) REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT', 'device_bridge_devices', ['device_id']),
  foreignKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE, ['command_id', 'device_id'], `FOREIGN KEY (command_id, device_id) REFERENCES ${TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE}(command_id, device_id) ON DELETE RESTRICT`, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE, ['command_id', 'device_id']),
  tinderFoundationKey(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE, 'u', ['audit_id', 'command_id', 'device_id'], 'UNIQUE (audit_id, command_id, device_id)'),
  ...checks(TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE, [
    "action IN ('RETURN_ISSUED', 'RETURN_STAGED', 'RETURNED', 'RETURN_CANCELLED', 'RETURN_EXPIRED')",
    "actor IN ('SERVER', 'DEVICE')", "source IN ('RESUME_ACK', 'COMMAND_ACK', 'SIGNED_RECEIPT', 'EXPIRY')",
    "details = '{}'::jsonb", AUDIT_REASON_CHECK
  ])
]);

function canonicalCatalog(catalog) {
  return relationKind(catalog.relations.rows, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE) === 'r'
    && relationKind(catalog.relations.rows, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE) === 'r'
    && exactSet(relationColumns(catalog.columns.rows, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_PERMIT_TABLE), PERMIT_COLUMNS)
    && exactSet(relationColumns(catalog.columns.rows, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_AUDIT_TABLE), AUDIT_COLUMNS)
    && indexesCanonical(catalog.indexes.rows) && triggersCanonical(catalog.triggers.rows)
    && hasExpectedTinderFoundationConstraints(catalog.constraints.rows,
      TINDER_RESUMED_FOREGROUND_CHAT_RETURN_CONSTRAINT_CONTRACT, { exactTables: TARGET_RELATIONS });
}

export async function inspectTinderResumedForegroundChatReturnSchema(client, {
  inspectDeviceBridgeSchema = inspectDeviceBridgeT1Schema,
  inspectV9Catalog = inspectTinderVerifiedChatReturnCatalog
} = {}) {
  const commandConstraint = await commandConstraintName(client, inspectDeviceBridgeSchema);
  const relations = await readRelations(client);
  const columns = await readColumns(client);
  const indexes = await readIndexes(client);
  const constraints = await readTinderFoundationConstraints(client, TARGET_RELATIONS);
  const triggers = await readTriggers(client);
  const catalog = { relations, columns, indexes, constraints, triggers };
  const v9Catalog = await inspectV9Catalog(client);
  if (commandConstraint === TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
      && v9Catalog === true && absentCatalog(catalog)) {
    return { state: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED };
  }
  if (commandConstraint === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
      && v9Catalog === true && !absentCatalog(catalog) && !canonicalCatalog(catalog)) {
    return { state: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.INVALID };
  }
  if (commandConstraint === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
      && v9Catalog === true && canonicalCatalog(catalog)) {
    return { state: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.CANONICAL };
  }
  return { state: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.INVALID };
}

export async function preflightTinderResumedForegroundChatReturnMigration(client, {
  inspectSchema = inspectTinderResumedForegroundChatReturnSchema, ...options
} = {}) {
  const foundation = await inspectSchema(client, options);
  if (![TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED,
    TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.CANONICAL].includes(foundation.state)) {
    throw new Error('Tinder resumed foreground chat return schema is incompatible.');
  }
  const active = await client.query(`SELECT EXISTS (
    SELECT 1 FROM contact_human_armed_conversation_binding_permits
      WHERE permit_state='ISSUED' AND expires_at>NOW()
    UNION ALL SELECT 1 FROM tinder_visible_chat_sync_permits
      WHERE permit_state IN ('ISSUED','STAGED') AND expires_at>NOW()
    UNION ALL SELECT 1 FROM tinder_unbound_inbox_conversation_sweeps
      WHERE sweep_state='ACTIVE' AND expires_at>NOW()
    UNION ALL SELECT 1 FROM tinder_official_app_resume_permits
      WHERE permit_state IN ('ISSUED','DISPATCHED') AND expires_at>NOW()
    UNION ALL SELECT 1 FROM tinder_local_conversation_attestation_permits
      WHERE permit_state='ISSUED' AND expires_at>NOW()
    UNION ALL SELECT 1 FROM tinder_verified_chat_return_permits WHERE permit_state IN ('ISSUED','STAGED') AND expires_at>NOW()
  ) AS active`);
  if (active.rows[0]?.active !== false) {
    const error = new Error('Tinder resumed foreground chat return migration is blocked by an active permit.');
    error.code = 'TINDER_RESUMED_FOREGROUND_CHAT_RETURN_ACTIVE_PERMIT';
    throw error;
  }
  return { foundation, mutate: foundation.state === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED };
}

export async function assertTinderResumedForegroundChatReturnSchemaReady(client, options) {
  const inspection = await inspectTinderResumedForegroundChatReturnSchema(client, options);
  if (inspection.state !== TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.CANONICAL) {
    throw new Error('Tinder resumed foreground chat return schema is not ready.');
  }
  return inspection;
}
