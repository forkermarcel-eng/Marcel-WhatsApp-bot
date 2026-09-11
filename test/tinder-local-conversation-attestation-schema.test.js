import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertTinderLocalConversationAttestationMigrationSource
} from "../device-bridge/tinder-local-conversation-attestation-migration.js";
import {
  inspectTinderLocalConversationAttestationSchema,
  preflightTinderLocalConversationAttestationMigration,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_PREFLIGHT_ERROR_CODE
} from "../device-bridge/tinder-local-conversation-attestation-schema.js";
import {
  inspectTinderVisibleChatSyncPermitSchema,
  TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE,
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE
} from "../device-bridge/tinder-visible-chat-sync-permit-schema.js";
import {
  TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE_CONSTRAINT_NAME,
  TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME
} from "../device-bridge/t1-schema.js";

function bridgeInspection(constraintName) {
  return {
    ready: true,
    constraints: [{
      specification: { table: "device_bridge_commands", column: "command_type" },
      constraintName
    }]
  };
}

function catalogClient({ active = 0 } = {}) {
  const queries = [];
  return {
    queries,
    async query(sql) {
      const text = String(sql);
      queries.push(text);
      if (text.includes("COUNT(*)::text AS active_count")) {
        return { rows: [{ active_count: String(active) }] };
      }
      return { rows: [] };
    }
  };
}

const canonicalV2 = async () => ({
  state: TINDER_OFFICIAL_APP_RESUME_PERMIT_V2_FOUNDATION_STATE.CANONICAL
});

test("attestation preflight accepts only an exact V5 predecessor, is catalog-read-only, and blocks active V1 sync permits", async () => {
  const client = catalogClient();
  const checked = await preflightTinderLocalConversationAttestationMigration(client, {
    inspectResumeV2Schema: canonicalV2,
    inspectDeviceBridgeSchema: async () => bridgeInspection(
      TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME
    )
  });
  assert.deepEqual(checked, {
    foundation: { state: TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.UPGRADE_REQUIRED },
    mutate: true
  });
  for (const sql of client.queries) {
    assert.match(sql, /^\s*SELECT/i);
    assert.doesNotMatch(sql, /\b(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE|LOCK)\b/i);
  }

  await assert.rejects(
    () => preflightTinderLocalConversationAttestationMigration(catalogClient({ active: 1 }), {
      inspectResumeV2Schema: canonicalV2,
      inspectDeviceBridgeSchema: async () => bridgeInspection(
        TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME
      )
    }),
    error => error?.code === "TINDER_LOCAL_CONVERSATION_ATTESTATION_ACTIVE_V1_PERMIT"
  );
});

test("V6 without the exact extension is invalid rather than being accepted as old V4 canonical", async () => {
  const client = catalogClient();
  assert.deepEqual(await inspectTinderLocalConversationAttestationSchema(client, {
    inspectResumeV2Schema: canonicalV2,
    inspectDeviceBridgeSchema: async () => bridgeInspection(
      TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE_CONSTRAINT_NAME
    )
  }), {
    state: TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.INVALID
  });

  const legacyV4 = await inspectTinderVisibleChatSyncPermitSchema(catalogClient(), {
    assertHumanArmedFoundationReady: async () => ({ state: "CANONICAL" }),
    inspectDeviceBridgeSchema: async () => bridgeInspection(
      TINDER_LOCAL_CONVERSATION_ATTESTATION_COMMAND_TYPE_CONSTRAINT_NAME
    )
  });
  assert.equal(legacyV4.state, TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.INVALID);
});

test("attestation inspection classifies prerequisite catalog failure with a bounded code", async () => {
  await assert.rejects(
    () => inspectTinderLocalConversationAttestationSchema({
      async query() { throw new Error("fixture catalog failure"); }
    }, {
      inspectResumeV2Schema: canonicalV2,
      inspectDeviceBridgeSchema: async () => bridgeInspection(
        TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME
      )
    }),
    error => error?.code
      === TINDER_LOCAL_CONVERSATION_ATTESTATION_PREFLIGHT_ERROR_CODE.PREREQUISITE_INSPECTION_FAILED
  );
});

test("fixed attestation DDL is exact and contains no durable Tinder/UI identity material", () => {
  const source = readFileSync(
    new URL("../migrations/20260911_tinder_local_conversation_attestation_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.doesNotThrow(() => assertTinderLocalConversationAttestationMigrationSource(source));
  assert.match(source, /DROP CONSTRAINT device_bridge_commands_command_type_check_v5/i);
  assert.match(source, /ADD CONSTRAINT device_bridge_commands_command_type_check_v6/i);
  assert.match(source, /STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION/i);
  assert.match(source, /permit_contract_version SMALLINT NOT NULL CHECK \(permit_contract_version = 1\)/i);
  assert.match(source, /binding_revision INTEGER NOT NULL CHECK \(binding_revision > 0\)/i);
  assert.match(
    source,
    /CREATE UNIQUE INDEX idx_tinder_local_conversation_attestation_active_device\s+ON tinder_local_conversation_attestation_permits \(device_id\)\s+WHERE permit_state IN \('ISSUED', 'STAGED', 'ATTESTED'\)/i
  );
  assert.match(source, /attestation_command_id UUID/i);
  assert.match(source, /permit_contract_version IN \(1, 2\)/i);
  assert.match(
    source,
    /FOREIGN KEY \(command_id, device_id\)\s+REFERENCES device_bridge_commands\(command_id, device_id\)\s+ON DELETE RESTRICT/i
  );
  assert.match(
    source,
    /FOREIGN KEY \(attestation_command_id, device_id, binding_id, binding_revision\)\s+REFERENCES tinder_local_conversation_attestation_permits\s+\(command_id, device_id, binding_id, binding_revision\)\s+ON DELETE RESTRICT/i
  );
  assert.match(
    source,
    /FOREIGN KEY \(command_id, device_id, binding_id, binding_revision\)\s+REFERENCES tinder_local_conversation_attestation_permits\s+\(command_id, device_id, binding_id, binding_revision\)\s+ON DELETE RESTRICT/i
  );
  assert.match(source, /action IN \('ISSUED', 'STAGED', 'ATTESTED'\) AND reason_code IS NULL/i);
  assert.match(source, /details JSONB NOT NULL DEFAULT '\{\}'::jsonb CHECK \(details = '\{\}'::jsonb\)/i);
  const executable = source.replace(/--[^\r\n]*/g, " ");
  assert.doesNotMatch(executable, /(?:visible_name|message|thread_fingerprint|runtime_thread_fingerprint|capture_fingerprint|accessibility|uniqueid|bounds|snapshot|component|intent|url)/i);
  assert.throws(() => assertTinderLocalConversationAttestationMigrationSource(
    `${source}\nALTER TABLE contacts ADD COLUMN forbidden text;`
  ));
});
