import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertTinderVisibleChatSyncPermitSchemaReady,
  inspectTinderVisibleChatSyncPermitSchema,
  preflightTinderVisibleChatSyncPermitMigration,
  TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE
} from "../device-bridge/tinder-visible-chat-sync-permit-schema.js";
import { assertTinderVisibleChatSyncPermitMigrationSource } from "../device-bridge/tinder-visible-chat-sync-permit-migration.js";
import {
  TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME,
  T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME
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

function absentClient() {
  const queries = [];
  return {
    queries,
    async query(sql) {
      queries.push(String(sql));
      return { rows: [] };
    }
  };
}

const humanArmedReady = async () => ({ state: "CANONICAL" });

test("resume-enabled permit schema recognizes only an absent V3 predecessor or a fully canonical V5 shape", async () => {
  const legacy = await inspectTinderVisibleChatSyncPermitSchema(absentClient(), {
    assertHumanArmedFoundationReady: humanArmedReady,
    inspectDeviceBridgeSchema: async () => bridgeInspection(T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME)
  });
  assert.equal(legacy.state, TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.ABSENT);

  const partial = await inspectTinderVisibleChatSyncPermitSchema(absentClient(), {
    assertHumanArmedFoundationReady: humanArmedReady,
    inspectDeviceBridgeSchema: async () => bridgeInspection(TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME)
  });
  assert.equal(partial.state, TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.INVALID);
});

test("resume-enabled permit preflight is read-only and requires the exact V3 command predecessor", async () => {
  const client = absentClient();
  const checked = await preflightTinderVisibleChatSyncPermitMigration(client, {
    assertHumanArmedFoundationReady: humanArmedReady,
    inspectDeviceBridgeSchema: async () => bridgeInspection(T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME)
  });
  assert.equal(checked.mutate, true);
  assert.equal(checked.foundation.state, TINDER_VISIBLE_CHAT_SYNC_PERMIT_FOUNDATION_STATE.ABSENT);
  assert.ok(client.queries.length >= 4);
  for (const sql of client.queries) {
    assert.match(sql, /^\s*SELECT/i);
    assert.doesNotMatch(sql, /\b(?:ALTER|CREATE|DROP|INSERT|UPDATE|DELETE)\b/i);
  }
  await assert.rejects(
    () => assertTinderVisibleChatSyncPermitSchemaReady(absentClient(), {
      assertHumanArmedFoundationReady: humanArmedReady,
      inspectDeviceBridgeSchema: async () => bridgeInspection(T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME)
    }),
    /not ready/
  );
});

test("fixed V5 DDL stores only server-side capture references and no Android Tinder target", () => {
  const source = readFileSync(
    new URL("../migrations/20260907_tinder_visible_chat_sync_permit_foundation.sql", import.meta.url),
    "utf8"
  );
  assert.doesNotThrow(() => assertTinderVisibleChatSyncPermitMigrationSource(source));
  assert.match(source, /DROP CONSTRAINT device_bridge_commands_command_type_check_v3/i);
  assert.match(source, /ADD CONSTRAINT device_bridge_commands_command_type_check_v5/i);
  assert.match(source, /SYNC_TINDER_VISIBLE_CHAT/);
  assert.match(source, /RESUME_OFFICIAL_TINDER_APP/);
  const permit = source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS tinder_visible_chat_sync_permits"), source.indexOf("CREATE UNIQUE INDEX"));
  const resumePermit = source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS tinder_official_app_resume_permits"), source.indexOf("CREATE TABLE IF NOT EXISTS tinder_visible_chat_sync_transcripts"));
  const transcript = source.slice(source.indexOf("CREATE TABLE IF NOT EXISTS tinder_visible_chat_sync_transcripts"));
  assert.match(permit, /source_capture_id UUID NOT NULL/i);
  assert.match(permit, /command_id UUID PRIMARY KEY/i);
  assert.match(permit, /UNIQUE \(command_id, device_id, source_capture_id\)/i);
  assert.match(permit, /device_id UUID NOT NULL/i);
  assert.match(permit, /permit_state TEXT NOT NULL DEFAULT 'ISSUED'/i);
  assert.match(resumePermit, /source_capture_id UUID NOT NULL/i);
  assert.match(resumePermit, /command_id UUID PRIMARY KEY/i);
  assert.match(resumePermit, /permit_state IN \('ISSUED', 'DISPATCHED', 'EXPIRED', 'CANCELLED'\)/i);
  assert.match(resumePermit, /UNIQUE \(command_id, device_id, source_capture_id\)/i);
  assert.match(resumePermit, /UNIQUE \(source_capture_id\)/i);
  assert.doesNotMatch(resumePermit, /(?:visible_name|thread_fingerprint|runtime_thread_fingerprint|capture_fingerprint|contact_id|binding_id|reference_hash|component|intent|url)/i);
  assert.match(transcript, /source_capture_id UUID NOT NULL/i);
  assert.match(transcript, /transcript_fingerprint CHAR\(64\) NOT NULL/i);
  assert.match(transcript, /FOREIGN KEY \(command_id, device_id, source_capture_id\)[\s\S]*REFERENCES tinder_visible_chat_sync_permits\(command_id, device_id, source_capture_id\)/i);
  assert.match(transcript, /visible_messages JSONB NOT NULL/i);
  assert.doesNotMatch(transcript, /(?:visible_name|thread_fingerprint|runtime_thread_fingerprint|capture_fingerprint|contact_id|binding_id|reference_hash)/i);
  assert.throws(() => assertTinderVisibleChatSyncPermitMigrationSource(
    `${source}\nALTER TABLE contacts ADD COLUMN forbidden text;`
  ));
});
