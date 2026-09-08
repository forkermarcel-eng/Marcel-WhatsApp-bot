import {
  inspectDeviceBridgeT1Schema,
  TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CHECK_EXPRESSION,
  TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME,
  T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CHECK_EXPRESSION,
  T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CONSTRAINT_NAME,
  T2_HUMAN_ARMED_COMMAND_TYPE_CHECK_EXPRESSION,
  T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME,
  T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CHECK_EXPRESSION,
  T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME
} from "./t1-schema.js";
import {
  assertTinderManualSendFoundationSchemaReady
} from "./tinder-manual-send-foundation-schema.js";

/* ==================================================
T5 SIGNED SEND-COMMAND â€” SCHEMA CONTRACT

The T5 foundation already owns the intent and its unique `command_id`
correlation.  This contract only advances the existing Device-Bridge command
vocabulary from T2 (v2) to T5 (v3).  It deliberately owns no FK, table, index
or data mutation.
================================================== */

export const TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE = Object.freeze({
  LEGACY: "LEGACY",
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

function commandConstraint(inspection) {
  return inspection?.constraints?.find(item => item?.specification?.table === "device_bridge_commands"
    && item?.specification?.column === "command_type") || null;
}

/** Read-only structural inspection of the exact v2 -> v3 delta. */
export async function inspectTinderManualSendCommandSchema(client, {
  assertManualSendFoundationReady = assertTinderManualSendFoundationSchemaReady,
  inspectDeviceBridgeSchema = inspectDeviceBridgeT1Schema
} = {}) {
  await assertManualSendFoundationReady(client);
  const bridge = await inspectDeviceBridgeSchema(client);
  const command = commandConstraint(bridge);
  if (!bridge?.ready || !command) {
    return { state: TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.INVALID, bridge, command };
  }
  if (command.constraintName === T2_HUMAN_ARMED_COMMAND_TYPE_CONSTRAINT_NAME) {
    return { state: TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.LEGACY, bridge, command };
  }
  if (command.constraintName === T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CONSTRAINT_NAME) {
    return { state: TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.CANONICAL, bridge, command };
  }
  // A later exact V4 command superset remains compatible with the completed
  // T5 vocabulary. The V4 migration, not this older runner, owns that delta.
  if (command.constraintName === T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CONSTRAINT_NAME) {
    return { state: TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.CANONICAL, bridge, command };
  }
  if (command.constraintName === TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME) {
    return { state: TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.CANONICAL, bridge, command };
  }
  return { state: TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.INVALID, bridge, command };
}

/**
 * Read-only pre-DDL validation.  The row predicate is source-owned and
 * bounded; it proves that all existing values satisfy the exact current
 * vocabulary before the fixed extension can run.
 */
export async function preflightTinderManualSendCommandMigration(client, options = {}) {
  const command = await inspectTinderManualSendCommandSchema(client, options);
  if (command.state === TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.INVALID) {
    throw new Error("T5 Tinder manual-send command schema is incompatible.");
  }
  const expression = command.state === TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.LEGACY
    ? T2_HUMAN_ARMED_COMMAND_TYPE_CHECK_EXPRESSION
    : command.command.constraintName === TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CONSTRAINT_NAME
      ? TINDER_OFFICIAL_APP_RESUME_COMMAND_TYPE_CHECK_EXPRESSION
      : command.command.constraintName === T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CONSTRAINT_NAME
        ? T4_TINDER_VISIBLE_CHAT_SYNC_COMMAND_TYPE_CHECK_EXPRESSION
        : T5_TINDER_MANUAL_SEND_COMMAND_TYPE_CHECK_EXPRESSION;
  const compatibility = await client.query(`
    SELECT EXISTS (
      SELECT 1 FROM device_bridge_commands
       WHERE (${expression}) IS NOT TRUE
    ) AS incompatible
  `);
  if (compatibility.rows[0]?.incompatible !== false) {
    throw new Error("Device Bridge data is incompatible with the T5 command extension.");
  }
  return Object.freeze({ command, mutate: command.state === TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.LEGACY });
}

export async function assertTinderManualSendCommandSchemaReady(client, options = {}) {
  const inspection = await inspectTinderManualSendCommandSchema(client, options);
  if (inspection.state !== TINDER_MANUAL_SEND_COMMAND_SCHEMA_STATE.CANONICAL) {
    throw new Error("T5 Tinder manual-send command schema is not ready.");
  }
  return inspection;
}
