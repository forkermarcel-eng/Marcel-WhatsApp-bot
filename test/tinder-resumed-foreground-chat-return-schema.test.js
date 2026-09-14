import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectTinderResumedForegroundChatReturnSchema,
  preflightTinderResumedForegroundChatReturnMigration,
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_CONSTRAINT_CONTRACT,
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE
} from "../device-bridge/tinder-resumed-foreground-chat-return-schema.js";
import {
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME,
  TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
} from "../device-bridge/t1-schema.js";

const PERMIT = "tinder_resumed_foreground_chat_return_permits";
const AUDIT = "tinder_resumed_foreground_chat_return_audit";
const PERMIT_COLUMNS = [
  "command_id", "device_id", "resume_command_id", "permit_contract_version",
  "permit_state", "issued_at", "expires_at", "staged_at", "returned_at",
  "closed_at", "terminal_reason", "created_at", "updated_at"
];
const AUDIT_COLUMNS = [
  "audit_id", "command_id", "device_id", "action", "reason_code", "actor",
  "source", "details", "created_at"
];

function bridge(constraintName) {
  return {
    ready: true,
    constraints: [{
      specification: { table: "device_bridge_commands", column: "command_type" },
      constraintName
    }]
  };
}

function constraints() {
  return TINDER_RESUMED_FOREGROUND_CHAT_RETURN_CONSTRAINT_CONTRACT.map(contract => ({
    table_name: contract.table,
    contype: contract.type,
    convalidated: true,
    condeferrable: false,
    condeferred: false,
    confdeltype: contract.deleteAction || "",
    confupdtype: contract.updateAction || "",
    confmatchtype: contract.matchType || "",
    constraint_definition: contract.type === "c" ? contract.sources[0] : contract.definition,
    reference_table: contract.referenceTable || "",
    column_names: contract.columns,
    reference_column_names: contract.referenceColumns || []
  }));
}

function triggers({ drift = false } = {}) {
  const permitScope = "CREATE TRIGGER tinder_resumed_foreground_chat_return_resume_scope BEFORE INSERT OR UPDATE ON tinder_resumed_foreground_chat_return_permits FOR EACH ROW EXECUTE FUNCTION tinder_resumed_foreground_chat_return_resume_scope_guard()";
  const permitImmutable = "CREATE TRIGGER tinder_resumed_foreground_chat_return_permit_immutable BEFORE UPDATE OR DELETE ON tinder_resumed_foreground_chat_return_permits FOR EACH ROW EXECUTE FUNCTION tinder_resumed_foreground_chat_return_immutable_guard()";
  const auditImmutable = "CREATE TRIGGER tinder_resumed_foreground_chat_return_audit_immutable BEFORE UPDATE OR DELETE ON tinder_resumed_foreground_chat_return_audit FOR EACH ROW EXECUTE FUNCTION tinder_resumed_foreground_chat_return_immutable_guard()";
  return [
    {
      trigger_name: "tinder_resumed_foreground_chat_return_resume_scope",
      relation_name: PERMIT, enabled: "O", deferrable: false, initially_deferred: false,
      function_name: "tinder_resumed_foreground_chat_return_resume_scope_guard",
      trigger_definition: permitScope,
      function_source: drift ? "BEGIN RETURN NEW; END;" : [
        "FROM tinder_official_app_resume_permits resume",
        "resume.command_id=NEW.resume_command_id",
        "resume.device_id=NEW.device_id",
        "resume.permit_contract_version=2",
        "resume.permit_state='DISPATCHED'",
        "resume_command.terminal_status='SUCCEEDED'"
      ].join(" ")
    },
    {
      trigger_name: "tinder_resumed_foreground_chat_return_permit_immutable",
      relation_name: PERMIT, enabled: "O", deferrable: false, initially_deferred: false,
      function_name: "tinder_resumed_foreground_chat_return_immutable_guard",
      trigger_definition: permitImmutable,
      function_source: [
        "OLD.permit_state IN ('RETURNED', 'CANCELLED', 'EXPIRED')",
        "NEW.resume_command_id IS DISTINCT FROM OLD.resume_command_id",
        "OLD.permit_state = 'ISSUED' AND NEW.permit_state NOT IN ('ISSUED', 'STAGED', 'CANCELLED', 'EXPIRED')"
      ].join(" ")
    },
    {
      trigger_name: "tinder_resumed_foreground_chat_return_audit_immutable",
      relation_name: AUDIT, enabled: "O", deferrable: false, initially_deferred: false,
      function_name: "tinder_resumed_foreground_chat_return_immutable_guard",
      trigger_definition: auditImmutable,
      function_source: "IF TG_TABLE_NAME = 'tinder_resumed_foreground_chat_return_audit' THEN RETURN audit is immutable"
    }
  ];
}

function client({ catalog = true, active = false, driftTrigger = false } = {}) {
  return {
    async query(sql) {
      const text = String(sql);
      if (text.includes("c.relkind")) {
        return { rows: catalog ? [
          { relation_name: PERMIT, relkind: "r" },
          { relation_name: AUDIT, relkind: "r" }
        ] : [] };
      }
      if (text.includes("a.attname AS column_name")) {
        return { rows: catalog ? [
          ...PERMIT_COLUMNS.map(column_name => ({ relation_name: PERMIT, column_name })),
          ...AUDIT_COLUMNS.map(column_name => ({ relation_name: AUDIT, column_name }))
        ] : [] };
      }
      if (text.includes("FROM pg_index")) {
        return { rows: catalog ? [
          { index_name: "idx_tinder_resumed_foreground_chat_return_active_device", indisunique: true, indisvalid: true, indisready: true, column_names: ["device_id"], descending: [false], predicate: "permit_state IN ('ISSUED', 'STAGED')" },
          { index_name: "idx_tinder_resumed_foreground_chat_return_resume_created", indisunique: false, indisvalid: true, indisready: true, column_names: ["resume_command_id", "created_at"], descending: [false, true], predicate: "" },
          { index_name: "idx_tinder_resumed_foreground_chat_return_audit_command_created", indisunique: false, indisvalid: true, indisready: true, column_names: ["command_id", "created_at"], descending: [false, true], predicate: "" }
        ] : [] };
      }
      if (text.includes("FROM pg_trigger")) return { rows: catalog ? triggers({ drift: driftTrigger }) : [] };
      if (text.includes("FROM pg_constraint")) return { rows: catalog ? constraints() : [] };
      if (text.includes("SELECT EXISTS")) return { rows: [{ active }] };
      throw new Error(`unexpected query: ${text.slice(0, 80)}`);
    }
  };
}

test("V10 reports UPGRADE_REQUIRED only from exact retained V9 with an absent V10 catalog", async () => {
  const inspection = await inspectTinderResumedForegroundChatReturnSchema(client({ catalog: false }), {
    inspectDeviceBridgeSchema: async () => bridge(
      TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
    ),
    inspectV9Catalog: async () => true
  });
  assert.equal(inspection.state, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED);
});

test("V10 accepts only its own command constraint plus exact retained V9/V10 catalogs", async () => {
  const inspection = await inspectTinderResumedForegroundChatReturnSchema(client(), {
    inspectDeviceBridgeSchema: async () => bridge(
      TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
    ),
    inspectV9Catalog: async () => true
  });
  assert.equal(inspection.state, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.CANONICAL);
});

test("V10 never treats a V9 command vocabulary with an accidental target catalog as canonical", async () => {
  const inspection = await inspectTinderResumedForegroundChatReturnSchema(client(), {
    inspectDeviceBridgeSchema: async () => bridge(
      TINDER_VERIFIED_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
    ),
    inspectV9Catalog: async () => true
  });
  assert.equal(inspection.state, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.INVALID);
});

test("V10 never upgrades a V10 vocabulary without the exact retained V9 catalog", async () => {
  const inspection = await inspectTinderResumedForegroundChatReturnSchema(client(), {
    inspectDeviceBridgeSchema: async () => bridge(
      TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
    ),
    inspectV9Catalog: async () => false
  });
  assert.equal(inspection.state, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.INVALID);
});

test("V10 rejects a drifted immutable/scope trigger rather than weakening postcheck", async () => {
  const inspection = await inspectTinderResumedForegroundChatReturnSchema(client({ driftTrigger: true }), {
    inspectDeviceBridgeSchema: async () => bridge(
      TINDER_RESUMED_FOREGROUND_CHAT_RETURN_COMMAND_TYPE_CONSTRAINT_NAME
    ),
    inspectV9Catalog: async () => true
  });
  assert.equal(inspection.state, TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.INVALID);
});

test("V10 preflight blocks any live predecessor permit before a command vocabulary change", async () => {
  await assert.rejects(
    preflightTinderResumedForegroundChatReturnMigration(client({ catalog: false, active: true }), {
      inspectSchema: async () => ({
        state: TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.UPGRADE_REQUIRED
      })
    }),
    error => error?.code === "TINDER_RESUMED_FOREGROUND_CHAT_RETURN_ACTIVE_PERMIT"
  );
});
