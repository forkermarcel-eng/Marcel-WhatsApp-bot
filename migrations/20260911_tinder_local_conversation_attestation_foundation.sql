-- Tinder local-conversation attestation foundation — explicit migration only.
--
-- This foundation records a human-bootstraped, device-local continuity
-- attestation. It never stores a Tinder identifier, name, message, timestamp,
-- UI snapshot, bounds, fingerprint, Accessibility unique ID, or other
-- content-derived conversation reference. The server records only the opaque
-- command handle and the confirmed human-armed binding revision that issued
-- it. Android may use the handle only while its separate local continuity
-- proof remains live; loss of that proof must fail closed.
--
-- No startup path, route import, capture ingress, scheduler, reader or
-- launcher invokes this migration. It is executable only by its explicit
-- approved runner.

ALTER TABLE device_bridge_commands
  DROP CONSTRAINT device_bridge_commands_command_type_check_v5;

ALTER TABLE device_bridge_commands
  ADD CONSTRAINT device_bridge_commands_command_type_check_v6
  CHECK (command_type IN (
    'PING', 'REQUEST_STATUS', 'STOP_BRIDGE',
    'CONNECT_TINDER', 'DISCONNECT_TINDER',
    'ARM_TINDER_CONVERSATION_BINDING',
    'SEND_TINDER_DRAFT',
    'SYNC_TINDER_VISIBLE_CHAT',
    'RESUME_OFFICIAL_TINDER_APP',
    'STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION'
  ));

CREATE TABLE tinder_local_conversation_attestation_permits (
  -- This opaque command correlation handle is never a Tinder or person ID.
  command_id UUID PRIMARY KEY
    REFERENCES device_bridge_commands(command_id)
    ON DELETE RESTRICT,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
  binding_id UUID NOT NULL
    REFERENCES contact_human_armed_conversation_bindings(binding_id)
    ON DELETE RESTRICT,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  permit_contract_version SMALLINT NOT NULL CHECK (permit_contract_version = 1),
  permit_state TEXT NOT NULL DEFAULT 'ISSUED'
    CHECK (permit_state IN ('ISSUED', 'STAGED', 'ATTESTED', 'INVALIDATED', 'EXPIRED', 'CANCELLED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  staged_at TIMESTAMPTZ,
  attested_at TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (command_id, device_id, binding_id, binding_revision),
  CHECK (expires_at > issued_at),
  CHECK (
    (permit_state = 'ISSUED'
      AND staged_at IS NULL AND attested_at IS NULL AND invalidated_at IS NULL
      AND closed_at IS NULL AND terminal_reason IS NULL)
    OR
    (permit_state = 'STAGED'
      AND staged_at IS NOT NULL AND attested_at IS NULL AND invalidated_at IS NULL
      AND closed_at IS NULL AND terminal_reason IS NULL)
    OR
    (permit_state = 'ATTESTED'
      AND staged_at IS NOT NULL AND attested_at IS NOT NULL AND invalidated_at IS NULL
      AND closed_at IS NULL AND terminal_reason IS NULL)
    OR
    (permit_state = 'INVALIDATED'
      AND staged_at IS NOT NULL AND invalidated_at IS NOT NULL
      AND closed_at = invalidated_at
      AND terminal_reason IN (
        'BINDING_REVISION_CHANGED', 'CONVERSATION_CHANGED',
        'CONTINUITY_UNPROVEN', 'LOCAL_STATE_DESTROYED', 'AUTH_OR_REVIEW',
        'IDENTITY_CONFLICT', 'HUMAN_REBIND'
      ))
    OR
    (permit_state = 'EXPIRED'
      AND invalidated_at IS NULL AND closed_at IS NOT NULL
      AND terminal_reason = 'EXPIRED')
    OR
    (permit_state = 'CANCELLED'
      AND staged_at IS NULL AND attested_at IS NULL AND invalidated_at IS NULL
      AND closed_at IS NOT NULL
      AND terminal_reason IN ('COMMAND_REJECTED', 'BOOTSTRAP_REJECTED', 'RUNTIME_GATE_LOST'))
  ),
  CHECK (staged_at IS NULL OR staged_at >= issued_at),
  CHECK (attested_at IS NULL OR (staged_at IS NOT NULL AND attested_at >= staged_at)),
  CHECK (invalidated_at IS NULL OR (staged_at IS NOT NULL AND invalidated_at >= staged_at)),
  CHECK (closed_at IS NULL OR (
    closed_at >= issued_at
    AND (staged_at IS NULL OR closed_at >= staged_at)
    AND (attested_at IS NULL OR closed_at >= attested_at)
    AND (invalidated_at IS NULL OR closed_at >= invalidated_at)
  ))
);

-- The opaque command handle is device-bound at the protocol layer as well as
-- at the database layer.  The separate command and device foreign keys above
-- are retained for their direct referential semantics; this pair prevents a
-- malformed writer from combining a valid command from one device with a
-- valid device from another.
ALTER TABLE tinder_local_conversation_attestation_permits
  ADD CONSTRAINT tinder_local_conversation_attestation_permits_command_device_fkey
  FOREIGN KEY (command_id, device_id)
  REFERENCES device_bridge_commands(command_id, device_id)
  ON DELETE RESTRICT;

-- Android deliberately retains one current local continuity proof per
-- device/process.  Do not permit parallel active proofs whose opaque command
-- handles could be confused after foreground navigation.  A different
-- conversation first requires explicit invalidation of the prior proof and a
-- new human bootstrap; terminal history remains immutable.
CREATE UNIQUE INDEX idx_tinder_local_conversation_attestation_active_device
ON tinder_local_conversation_attestation_permits (device_id)
WHERE permit_state IN ('ISSUED', 'STAGED', 'ATTESTED');

CREATE INDEX idx_tinder_local_conversation_attestation_device_expiry
ON tinder_local_conversation_attestation_permits (device_id, permit_state, expires_at DESC);

CREATE INDEX idx_tinder_local_conversation_attestation_binding_created
ON tinder_local_conversation_attestation_permits (binding_id, binding_revision, created_at DESC);

CREATE TABLE tinder_local_conversation_attestation_audit (
  audit_id UUID PRIMARY KEY,
  command_id UUID NOT NULL
    REFERENCES tinder_local_conversation_attestation_permits(command_id)
    ON DELETE RESTRICT,
  binding_id UUID NOT NULL
    REFERENCES contact_human_armed_conversation_bindings(binding_id)
    ON DELETE RESTRICT,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
  binding_revision INTEGER NOT NULL CHECK (binding_revision > 0),
  action TEXT NOT NULL
    CHECK (action IN ('ISSUED', 'STAGED', 'ATTESTED', 'INVALIDATED', 'EXPIRED', 'CANCELLED')),
  reason_code TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('DASHBOARD_HUMAN', 'ANDROID_RUNTIME', 'SERVER_EXPIRY', 'SERVER_VALIDATION')),
  source TEXT NOT NULL CHECK (source IN ('MANUAL_DASHBOARD', 'SIGNED_DEVICE_INGRESS', 'SERVER_MAINTENANCE')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (details = '{}'::jsonb),
  CHECK (
    (action IN ('ISSUED', 'STAGED', 'ATTESTED') AND reason_code IS NULL)
    OR (action = 'EXPIRED' AND reason_code = 'PERMIT_EXPIRED')
    OR (action = 'INVALIDATED' AND reason_code IN (
      'BINDING_REVISION_CHANGED', 'CONVERSATION_CHANGED',
      'CONTINUITY_UNPROVEN', 'LOCAL_STATE_DESTROYED', 'AUTH_OR_REVIEW',
      'IDENTITY_CONFLICT', 'HUMAN_REBIND'
    ))
    OR (action = 'CANCELLED' AND reason_code IN (
      'COMMAND_REJECTED', 'BOOTSTRAP_REJECTED', 'RUNTIME_GATE_LOST'
    ))
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An audit event is not merely correlated with an opaque command.  It must
-- attest the exact device, binding and revision carried by that command's
-- permit.  The composite reference prevents a malformed writer from mixing
-- otherwise valid rows from different human-confirmed bindings.
ALTER TABLE tinder_local_conversation_attestation_audit
  ADD CONSTRAINT tinder_local_conversation_attestation_audit_scope_fkey
  FOREIGN KEY (command_id, device_id, binding_id, binding_revision)
  REFERENCES tinder_local_conversation_attestation_permits
    (command_id, device_id, binding_id, binding_revision)
  ON DELETE RESTRICT;

CREATE INDEX idx_tinder_local_conversation_attestation_audit_command_created
ON tinder_local_conversation_attestation_audit (command_id, created_at DESC);

ALTER TABLE tinder_visible_chat_sync_permits
  ADD COLUMN permit_contract_version SMALLINT NOT NULL DEFAULT 1;

ALTER TABLE tinder_visible_chat_sync_permits
  ALTER COLUMN permit_contract_version DROP DEFAULT;

ALTER TABLE tinder_visible_chat_sync_permits
  ADD COLUMN attestation_command_id UUID;

ALTER TABLE tinder_visible_chat_sync_permits
  ADD COLUMN binding_id UUID;

ALTER TABLE tinder_visible_chat_sync_permits
  ADD COLUMN binding_revision INTEGER;

ALTER TABLE tinder_visible_chat_sync_permits
  ADD CONSTRAINT tinder_visible_chat_sync_permits_attestation_command_id_fkey
  FOREIGN KEY (attestation_command_id)
  REFERENCES tinder_local_conversation_attestation_permits(command_id)
  ON DELETE RESTRICT;

ALTER TABLE tinder_visible_chat_sync_permits
  ADD CONSTRAINT tinder_visible_chat_sync_permits_binding_id_fkey
  FOREIGN KEY (binding_id)
  REFERENCES contact_human_armed_conversation_bindings(binding_id)
  ON DELETE RESTRICT;

-- A V2 reader permit can only be derivative authority for the same local
-- proof tuple.  Separate single-column foreign keys are insufficient here:
-- they would allow an attestation command from one binding to be combined
-- with a valid binding/revision from another.
ALTER TABLE tinder_visible_chat_sync_permits
  ADD CONSTRAINT tinder_visible_chat_sync_permits_attestation_scope_fkey
  FOREIGN KEY (attestation_command_id, device_id, binding_id, binding_revision)
  REFERENCES tinder_local_conversation_attestation_permits
    (command_id, device_id, binding_id, binding_revision)
  ON DELETE RESTRICT;

ALTER TABLE tinder_visible_chat_sync_permits
  ADD CONSTRAINT tinder_visible_chat_sync_permits_contract_version_check
  CHECK (permit_contract_version IN (1, 2));

ALTER TABLE tinder_visible_chat_sync_permits
  ADD CONSTRAINT tinder_visible_chat_sync_permits_contract_attestation_check
  CHECK (
    (permit_contract_version = 1
      AND attestation_command_id IS NULL AND binding_id IS NULL AND binding_revision IS NULL)
    OR
    (permit_contract_version = 2
      AND attestation_command_id IS NOT NULL AND binding_id IS NOT NULL
      AND binding_revision IS NOT NULL AND binding_revision > 0)
  );

CREATE INDEX idx_tinder_visible_chat_sync_permit_attestation_binding_created
ON tinder_visible_chat_sync_permits
  (attestation_command_id, binding_id, binding_revision, created_at DESC)
WHERE attestation_command_id IS NOT NULL;
