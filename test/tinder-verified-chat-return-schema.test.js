import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectTinderVerifiedChatReturnSchema,
  preflightTinderVerifiedChatReturnMigration,
  TINDER_VERIFIED_CHAT_RETURN_CONSTRAINT_CONTRACT,
  TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE
} from "../device-bridge/tinder-verified-chat-return-schema.js";
import {
  TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
} from "../device-bridge/t1-schema.js";

const PERMIT_TABLE = "tinder_verified_chat_return_permits";
const AUDIT_TABLE = "tinder_verified_chat_return_audit";

const PERMIT_COLUMNS = [
  "command_id", "device_id", "source_capture_id", "resume_command_id",
  "binding_id", "binding_revision", "permit_contract_version",
  "permit_state", "issued_at", "expires_at", "staged_at", "returned_at",
  "closed_at", "terminal_reason", "created_at", "updated_at"
];
const AUDIT_COLUMNS = [
  "audit_id", "command_id", "device_id", "binding_id", "binding_revision",
  "action", "reason_code", "actor", "source", "details", "created_at"
];

function bridgeV9() {
  return {
    ready: true,
    constraints: [{
      specification: { table: "device_bridge_commands", column: "command_type" },
      constraintName: TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
    }]
  };
}

function triggerRows({ driftScopeGuard = false } = {}) {
  return [
    {
      trigger_name: "tinder_verified_chat_return_resume_scope",
      relation_name: PERMIT_TABLE,
      enabled: "O", deferrable: false, initially_deferred: false,
      function_name: "tinder_verified_chat_return_resume_scope_guard",
      trigger_definition: `CREATE TRIGGER tinder_verified_chat_return_resume_scope BEFORE INSERT OR UPDATE ON ${PERMIT_TABLE} FOR EACH ROW EXECUTE FUNCTION tinder_verified_chat_return_resume_scope_guard()`,
      function_source: driftScopeGuard
        ? "BEGIN RETURN NEW; END;"
        : `BEGIN
             IF TG_OP = 'INSERT' OR NEW.resume_command_id IS DISTINCT FROM OLD.resume_command_id THEN
               IF NOT EXISTS (
                 SELECT 1 FROM tinder_official_app_resume_permits resume
                  WHERE resume.command_id=NEW.resume_command_id
                    AND resume.device_id=NEW.device_id
                    AND resume.source_capture_id=NEW.source_capture_id
                    AND resume.binding_id=NEW.binding_id
                    AND resume.binding_revision=NEW.binding_revision
                    AND resume.permit_contract_version=2
                    AND resume.permit_state='DISPATCHED'
               ) THEN RAISE EXCEPTION 'invalid'; END IF;
             END IF;
             RETURN NEW;
           END;`
    },
    {
      trigger_name: "tinder_verified_chat_return_permit_immutable",
      relation_name: PERMIT_TABLE,
      enabled: "O", deferrable: false, initially_deferred: false,
      function_name: "tinder_verified_chat_return_immutable_guard",
      trigger_definition: `CREATE TRIGGER tinder_verified_chat_return_permit_immutable BEFORE UPDATE OR DELETE ON ${PERMIT_TABLE} FOR EACH ROW EXECUTE FUNCTION tinder_verified_chat_return_immutable_guard()`,
      function_source: `BEGIN
        IF OLD.permit_state IN ('RETURNED', 'CANCELLED', 'EXPIRED') THEN RAISE EXCEPTION 'immutable'; END IF;
        IF NEW.source_capture_id IS DISTINCT FROM OLD.source_capture_id THEN RAISE EXCEPTION 'scope'; END IF;
        IF OLD.permit_state = 'ISSUED' AND NEW.permit_state NOT IN ('ISSUED', 'STAGED', 'CANCELLED', 'EXPIRED') THEN RAISE EXCEPTION 'transition'; END IF;
        IF OLD.permit_state = 'STAGED' AND NEW.permit_state NOT IN ('STAGED', 'RETURNED', 'CANCELLED', 'EXPIRED') THEN RAISE EXCEPTION 'transition'; END IF;
        RETURN NEW;
      END;`
    },
    {
      trigger_name: "tinder_verified_chat_return_audit_immutable",
      relation_name: AUDIT_TABLE,
      enabled: "O", deferrable: false, initially_deferred: false,
      function_name: "tinder_verified_chat_return_immutable_guard",
      trigger_definition: `CREATE TRIGGER tinder_verified_chat_return_audit_immutable BEFORE UPDATE OR DELETE ON ${AUDIT_TABLE} FOR EACH ROW EXECUTE FUNCTION tinder_verified_chat_return_immutable_guard()`,
      function_source: "BEGIN IF TG_TABLE_NAME = 'tinder_verified_chat_return_audit' THEN RAISE EXCEPTION 'verified chat return audit is immutable'; END IF; RETURN NEW; END;"
    }
  ];
}

function canonicalConstraintRows() {
  return TINDER_VERIFIED_CHAT_RETURN_CONSTRAINT_CONTRACT.map(contract => ({
    table_name: contract.table,
    contype: contract.type,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    confdeltype: contract.deleteAction || "",
    confupdtype: contract.updateAction || "",
    confmatchtype: contract.matchType || "",
    constraint_definition: contract.type === "c"
      ? contract.sources[0]
      : contract.definition,
    reference_table: contract.referenceTable || "",
    column_names: contract.columns,
    reference_column_names: contract.referenceColumns || []
  }));
}

function incompleteConstraintRows() {
  return [
    { table_name: PERMIT_TABLE, contype: "u", convalidated: true, condeferrable: false, condeferred: false, confdeltype: "", confupdtype: "", confmatchtype: "", constraint_definition: "UNIQUE (resume_command_id)", reference_table: "", column_names: ["resume_command_id"], reference_column_names: [] },
    { table_name: PERMIT_TABLE, contype: "c", convalidated: true, condeferrable: false, condeferred: false, confdeltype: "", confupdtype: "", confmatchtype: "", constraint_definition: "CHECK (terminal_reason IS NULL OR terminal_reason IN ('COMMAND_REJECTED', 'COMMAND_FAILED', 'COMMAND_EXPIRED', 'PERMIT_EXPIRED'))", reference_table: "", column_names: [], reference_column_names: [] },
    { table_name: PERMIT_TABLE, contype: "c", convalidated: true, condeferrable: false, condeferred: false, confdeltype: "", confupdtype: "", confmatchtype: "", constraint_definition: "CHECK (permit_state = 'RETURNED')", reference_table: "", column_names: [], reference_column_names: [] }
  ];
}

function catalogClient({ driftScopeGuard = false, active = false, constraintRows = canonicalConstraintRows() } = {}) {
  return {
    async query(sql) {
      const text = String(sql);
      if (text.includes("FROM pg_class c") && text.includes("c.relkind")) {
        return { rows: [
          { relation_name: PERMIT_TABLE, relkind: "r" },
          { relation_name: AUDIT_TABLE, relkind: "r" }
        ] };
      }
      if (text.includes("a.attname AS column_name")) {
        return { rows: [
          ...PERMIT_COLUMNS.map(column_name => ({ relation_name: PERMIT_TABLE, column_name })),
          ...AUDIT_COLUMNS.map(column_name => ({ relation_name: AUDIT_TABLE, column_name }))
        ] };
      }
      if (text.includes("FROM pg_index")) {
        return { rows: [
          { index_name: "idx_tinder_verified_chat_return_active_device", indisunique: true, indisvalid: true, indisready: true, column_names: ["device_id"], descending: [false], predicate: "permit_state IN ('ISSUED', 'STAGED')" },
          { index_name: "idx_tinder_verified_chat_return_source_created", indisunique: false, indisvalid: true, indisready: true, column_names: ["source_capture_id", "created_at"], descending: [false, true], predicate: "" },
          { index_name: "idx_tinder_verified_chat_return_resume_created", indisunique: false, indisvalid: true, indisready: true, column_names: ["resume_command_id", "created_at"], descending: [false, true], predicate: "" },
          { index_name: "idx_tinder_verified_chat_return_binding_revision_created", indisunique: false, indisvalid: true, indisready: true, column_names: ["binding_id", "binding_revision", "created_at"], descending: [false, false, true], predicate: "" },
          { index_name: "idx_tinder_verified_chat_return_audit_command_created", indisunique: false, indisvalid: true, indisready: true, column_names: ["command_id", "created_at"], descending: [false, true], predicate: "" }
        ] };
      }
      if (text.includes("FROM pg_trigger")) return { rows: triggerRows({ driftScopeGuard }) };
      if (text.includes("FROM pg_constraint")) return { rows: constraintRows };
      if (text.includes("SELECT EXISTS")) return { rows: [{ active }] };
      throw new Error(`unexpected catalog query: ${text.slice(0, 80)}`);
    }
  };
}

test("V9 postcheck accepts only the complete canonical catalog contract", async () => {
  const client = catalogClient();
  assert.deepEqual(await inspectTinderVerifiedChatReturnSchema(client, {
    inspectDeviceBridgeSchema: async () => bridgeV9()
  }), { state: TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL });
  assert.deepEqual(await preflightTinderVerifiedChatReturnMigration(client, {
    inspectSchema: async () => ({ state: TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL })
  }), {
    foundation: { state: TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL },
    mutate: false
  });
});

test("V9 postcheck rejects the former incomplete three-constraint fixture", async () => {
  assert.deepEqual(await inspectTinderVerifiedChatReturnSchema(catalogClient({
    constraintRows: incompleteConstraintRows()
  }), {
    inspectDeviceBridgeSchema: async () => bridgeV9()
  }), { state: TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.INVALID });
});

test("V9 postcheck rejects a scope guard that could weaken parent-bound durability", async () => {
  assert.deepEqual(await inspectTinderVerifiedChatReturnSchema(catalogClient({ driftScopeGuard: true }), {
    inspectDeviceBridgeSchema: async () => bridgeV9()
  }), { state: TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.INVALID });
});

test("V9 preflight remains read-only and blocks an active predecessor permit", async () => {
  const queries = [];
  const client = {
    async query(sql) {
      queries.push(String(sql));
      return { rows: [{ active: true }] };
    }
  };
  await assert.rejects(
    preflightTinderVerifiedChatReturnMigration(client, {
      inspectSchema: async () => ({ state: TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED })
    }),
    error => error?.code === "TINDER_VERIFIED_CHAT_RETURN_ACTIVE_PERMIT"
  );
  for (const sql of queries) {
    assert.match(sql, /^\s*SELECT/i);
    assert.doesNotMatch(sql, /\b(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i);
  }
});
