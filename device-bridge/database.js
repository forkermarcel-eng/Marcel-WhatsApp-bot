import {
  ensureDeviceBridgeAckSchema,
  FINAL_ACK_CHECK_EXPRESSION,
  FINAL_ACK_CONSTRAINT_NAME
} from "./ack-schema.js";

/* ==================================================
DEVICE BRIDGE T0 — PROTOCOL V1 DATABASE
================================================== */

export async function ensureDeviceBridgeTables(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_bridge_devices (
        device_id UUID PRIMARY KEY,
        installation_id UUID NOT NULL UNIQUE,
        display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 128),
        enrollment_state TEXT NOT NULL DEFAULT 'ACTIVE'
          CHECK (enrollment_state IN ('ACTIVE', 'REVOKED', 'RE_ENROLL_REQUIRED')),
        bridge_service_state TEXT NOT NULL DEFAULT 'STOPPED'
          CHECK (bridge_service_state IN ('STOPPED', 'STARTING', 'RUNNING', 'STOPPING', 'ERROR')),
        tinder_state TEXT NOT NULL DEFAULT 'UNKNOWN'
          CHECK (tinder_state IN ('DISCONNECTED', 'CONNECTED', 'AUTH_REQUIRED', 'REVIEW_REQUIRED', 'UNKNOWN')),
        automation_state TEXT NOT NULL DEFAULT 'STOPPED'
          CHECK (automation_state IN ('STOPPED', 'RUNNING')),
        app_version_name TEXT,
        app_version_code BIGINT CHECK (app_version_code IS NULL OR app_version_code >= 0),
        manufacturer TEXT,
        model TEXT,
        android_api INTEGER CHECK (android_api IS NULL OR android_api >= 24),
        abis JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(abis) = 'array'),
        capabilities JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(capabilities) = 'array'),
        configuration_revision INTEGER NOT NULL DEFAULT 1 CHECK (configuration_revision > 0),
        last_heartbeat_sequence BIGINT CHECK (last_heartbeat_sequence IS NULL OR last_heartbeat_sequence > 0),
        last_heartbeat_body_sha256 CHAR(64)
          CHECK (last_heartbeat_body_sha256 IS NULL OR last_heartbeat_body_sha256 ~ '^[0-9a-f]{64}$'),
        last_accepted_heartbeat_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        revoked_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK ((enrollment_state = 'REVOKED') = (revoked_at IS NOT NULL))
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_bridge_keys (
        key_id UUID PRIMARY KEY,
        device_id UUID NOT NULL REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT,
        algorithm TEXT NOT NULL CHECK (algorithm = 'EC_P256_SHA256'),
        public_key_spki_der BYTEA NOT NULL,
        public_key_fingerprint CHAR(64) NOT NULL UNIQUE
          CHECK (public_key_fingerprint ~ '^[0-9a-f]{64}$'),
        revoked_at TIMESTAMPTZ,
        revoked_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS device_bridge_one_active_key_per_device
      ON device_bridge_keys(device_id) WHERE revoked_at IS NULL
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_bridge_enrollment_codes (
        enrollment_code_id UUID PRIMARY KEY,
        code_digest CHAR(64) NOT NULL UNIQUE CHECK (code_digest ~ '^[0-9a-f]{64}$'),
        display_name TEXT CHECK (display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 128),
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        enrollment_attempt_id UUID UNIQUE,
        consumed_installation_id UUID,
        consumed_public_key_fingerprint CHAR(64)
          CHECK (consumed_public_key_fingerprint IS NULL OR consumed_public_key_fingerprint ~ '^[0-9a-f]{64}$'),
        consumed_device_id UUID REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT,
        consumed_key_id UUID REFERENCES device_bridge_keys(key_id) ON DELETE RESTRICT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_by TEXT NOT NULL DEFAULT 'dashboard',
        CHECK (expires_at > created_at),
        CHECK (
          (consumed_at IS NULL AND enrollment_attempt_id IS NULL AND consumed_installation_id IS NULL
            AND consumed_public_key_fingerprint IS NULL AND consumed_device_id IS NULL AND consumed_key_id IS NULL)
          OR
          (consumed_at IS NOT NULL AND enrollment_attempt_id IS NOT NULL AND consumed_installation_id IS NOT NULL
            AND consumed_public_key_fingerprint IS NOT NULL AND consumed_device_id IS NOT NULL AND consumed_key_id IS NOT NULL)
        )
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS device_bridge_enrollment_expiry_idx
      ON device_bridge_enrollment_codes(expires_at) WHERE consumed_at IS NULL
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_bridge_commands (
        command_id UUID PRIMARY KEY,
        device_id UUID NOT NULL REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT,
        protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version = 1),
        command_type TEXT NOT NULL CHECK (command_type IN ('PING', 'REQUEST_STATUS', 'STOP_BRIDGE')),
        payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
        configuration_revision INTEGER NOT NULL CHECK (configuration_revision > 0),
        issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        created_by TEXT NOT NULL DEFAULT 'dashboard',
        delivered_at TIMESTAMPTZ,
        terminal_status TEXT CHECK (terminal_status IS NULL OR terminal_status IN ('SUCCEEDED', 'FAILED', 'REJECTED', 'EXPIRED')),
        terminal_at TIMESTAMPTZ,
        UNIQUE (command_id, device_id),
        CHECK (expires_at > issued_at),
        CHECK ((terminal_status IS NULL) = (terminal_at IS NULL))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS device_bridge_commands_delivery_idx
      ON device_bridge_commands(device_id, issued_at) WHERE terminal_status IS NULL
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_bridge_command_acks (
        ack_id BIGSERIAL PRIMARY KEY,
        command_id UUID NOT NULL,
        device_id UUID NOT NULL REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT,
        status TEXT NOT NULL CHECK (status IN ('RECEIVED', 'SUCCEEDED', 'FAILED', 'REJECTED', 'EXPIRED')),
        occurred_at TIMESTAMPTZ NOT NULL,
        result JSONB,
        error JSONB,
        body_sha256 CHAR(64) NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (command_id, status),
        FOREIGN KEY (command_id, device_id)
          REFERENCES device_bridge_commands(command_id, device_id) ON DELETE RESTRICT,
        CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
        CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
        CONSTRAINT ${FINAL_ACK_CONSTRAINT_NAME}
          CHECK (${FINAL_ACK_CHECK_EXPRESSION})
      )
    `);
    await ensureDeviceBridgeAckSchema(client);
    await client.query(`
      CREATE INDEX IF NOT EXISTS device_bridge_command_acks_device_idx
      ON device_bridge_command_acks(device_id, accepted_at DESC)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_bridge_request_nonces (
        auth_subject TEXT NOT NULL,
        request_id UUID NOT NULL,
        content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
        accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (auth_subject, request_id),
        CHECK (expires_at > accepted_at)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS device_bridge_request_nonces_expiry_idx
      ON device_bridge_request_nonces(expires_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_bridge_audit_events (
        audit_event_id BIGSERIAL PRIMARY KEY,
        event_type TEXT NOT NULL,
        request_id UUID,
        device_id UUID REFERENCES device_bridge_devices(device_id) ON DELETE SET NULL,
        key_id UUID REFERENCES device_bridge_keys(key_id) ON DELETE SET NULL,
        command_id UUID REFERENCES device_bridge_commands(command_id) ON DELETE SET NULL,
        result_code TEXT,
        http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
        details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS device_bridge_audit_device_time_idx
      ON device_bridge_audit_events(device_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS device_bridge_audit_command_time_idx
      ON device_bridge_audit_events(command_id, created_at DESC)
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
