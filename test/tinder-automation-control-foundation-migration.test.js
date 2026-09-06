import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertTinderAutomationControlFoundationMigrationSource,
  T7_AUTOMATION_CONTROL_MIGRATION_DIAGNOSTIC_STAGES
} from "../device-bridge/tinder-automation-control-foundation-migration.js";

const migrationPath = new URL("../migrations/20260906_tinder_automation_control_foundation.sql", import.meta.url);

test("T7 control migration is explicit, starts globally STOPPED, and stores no conversational content", () => {
  const source = readFileSync(migrationPath, "utf8");
  const executableSql = source.replace(/--[^\r\n]*/g, "");
  assert.doesNotThrow(() => assertTinderAutomationControlFoundationMigrationSource(source));
  assert.match(source, /state\s+TEXT\s+NOT NULL DEFAULT 'STOPPED'/i);
  assert.match(source, /state\s+TEXT\s+NOT NULL DEFAULT 'DISABLED'/i);
  assert.match(source, /GLOBAL_DEFAULT_INITIALIZED/);
  assert.doesNotMatch(executableSql, /visible_messages|original_draft|approved_text|message_body|credential|accessibility|playwright|chromium/i);
  assert.doesNotMatch(source, /device_bridge_commands|SEND_TINDER_DRAFT|INSERT INTO messages|BEGIN\s*;|COMMIT\s*;|ROLLBACK\s*;/i);
});

test("T7 source validation rejects added DDL or transaction control before any connection", () => {
  const source = readFileSync(migrationPath, "utf8");
  assert.throws(() => assertTinderAutomationControlFoundationMigrationSource(`${source}\nCOMMIT;`));
  assert.throws(() => assertTinderAutomationControlFoundationMigrationSource(`${source}\nCREATE TABLE unexpected_t7_table (id integer);`));
  assert.equal(T7_AUTOMATION_CONTROL_MIGRATION_DIAGNOSTIC_STAGES.includes("DDL_EXECUTION"), true);
  assert.equal(T7_AUTOMATION_CONTROL_MIGRATION_DIAGNOSTIC_STAGES.includes("POSTCHECK"), true);
});

test("T7 migration stays out of normal startup and has no runtime registration seam", () => {
  const index = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const packageJson = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  assert.doesNotMatch(index, /tinder-automation-control-foundation-migration|tinder_automation_global_control|tinder_automation_contact_controls/i);
  assert.doesNotMatch(packageJson, /migrate:tinder-automation-control-foundation/i);
});
