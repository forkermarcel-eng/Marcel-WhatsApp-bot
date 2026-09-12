-- Tinder unbound Inbox-conversation sweep foundation -- explicit migration only.
--
-- V8 is a separately audited, bounded parent/step model directly over V6.
-- It does not reuse, reset, or reinterpret V1--V3 captures, confirmed V4
-- syncs, human bindings, or contacts. Each child command has the exact empty
-- payload and is immutable once terminal. The parent itself grants no UI,
-- identity, contact, selection, or write authority.

ALTER TABLE device_bridge_commands
  DROP CONSTRAINT device_bridge_commands_command_type_check_v6;

ALTER TABLE device_bridge_commands
  ADD CONSTRAINT device_bridge_commands_command_type_check_v8
  CHECK (command_type IN (
    'PING', 'REQUEST_STATUS', 'STOP_BRIDGE',
    'CONNECT_TINDER', 'DISCONNECT_TINDER',
    'ARM_TINDER_CONVERSATION_BINDING',
    'SEND_TINDER_DRAFT',
    'SYNC_TINDER_VISIBLE_CHAT',
    'RESUME_OFFICIAL_TINDER_APP',
    'STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION',
    'READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT',
    'RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT'
  ));

CREATE TABLE tinder_unbound_inbox_conversation_sweeps (
  sweep_id UUID PRIMARY KEY,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
  sweep_contract_version SMALLINT NOT NULL
    CHECK (sweep_contract_version = 1),
  inbox_heartbeat_sequence BIGINT NOT NULL
    CHECK (inbox_heartbeat_sequence > 0),
  -- Opaque, device-local freshness fact from the signed heartbeat. It is not
  -- a conversation/person/capture identifier and is never projected to UI.
  inbox_observation_nonce UUID NOT NULL,
  sweep_state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (sweep_state IN ('ACTIVE', 'COMPLETED', 'STOPPED', 'EXPIRED')),
  max_slots SMALLINT NOT NULL
    CHECK (max_slots = 8),
  next_slot SMALLINT NOT NULL
    CHECK (next_slot BETWEEN 1 AND 9),
  active_command_id UUID
    REFERENCES device_bridge_commands(command_id)
    ON DELETE RESTRICT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sweep_id, device_id),
  UNIQUE (device_id, inbox_observation_nonce),
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + INTERVAL '30 minutes'),
  CHECK (
    (sweep_state = 'ACTIVE'
      AND active_command_id IS NOT NULL AND next_slot BETWEEN 1 AND max_slots
      AND closed_at IS NULL AND terminal_reason IS NULL)
    OR
    (sweep_state = 'COMPLETED'
      AND active_command_id IS NULL AND next_slot = max_slots + 1
      AND closed_at IS NOT NULL AND terminal_reason = 'SLOTS_EXHAUSTED')
    OR
    (sweep_state = 'STOPPED'
      AND active_command_id IS NULL AND closed_at IS NOT NULL
      AND terminal_reason IN ('THREAD_DRIFT', 'COMMAND_REJECTED', 'RUNTIME_GATE_LOST', 'CHILD_EXPIRED', 'UNKNOWN_OUTCOME'))
    OR
    (sweep_state = 'EXPIRED'
      AND active_command_id IS NULL AND closed_at IS NOT NULL
      AND terminal_reason = 'SWEEP_EXPIRED')
  ),
  CHECK (closed_at IS NULL OR closed_at >= issued_at)
);

CREATE UNIQUE INDEX idx_tinder_unbound_inbox_conversation_sweep_active_device
ON tinder_unbound_inbox_conversation_sweeps (device_id)
WHERE sweep_state = 'ACTIVE';

CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_device_expiry
ON tinder_unbound_inbox_conversation_sweeps (device_id, sweep_state, expires_at DESC);

CREATE TABLE tinder_unbound_inbox_conversation_sweep_steps (
  command_id UUID PRIMARY KEY
    REFERENCES device_bridge_commands(command_id)
    ON DELETE RESTRICT,
  sweep_id UUID NOT NULL
    REFERENCES tinder_unbound_inbox_conversation_sweeps(sweep_id)
    ON DELETE RESTRICT,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
  step_contract_version SMALLINT NOT NULL
    CHECK (step_contract_version = 1),
  slot_ordinal SMALLINT NOT NULL
    CHECK (slot_ordinal BETWEEN 1 AND 8),
  child_kind TEXT NOT NULL
    CHECK (child_kind IN ('READ', 'RETURN_ONLY')),
  child_state TEXT NOT NULL DEFAULT 'ISSUED'
    CHECK (child_state IN ('ISSUED', 'STAGED', 'RETURN_STAGED', 'TRANSCRIPT_ACCEPTED', 'RETURN_ACCEPTED', 'EXPIRED', 'CANCELLED')),
  transcript_id UUID,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  staged_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (command_id, device_id),
  UNIQUE (command_id, sweep_id, device_id),
  UNIQUE (sweep_id, slot_ordinal, child_kind),
  CHECK (expires_at > issued_at),
  CHECK (
    (child_kind = 'READ' AND expires_at <= issued_at + INTERVAL '3 minutes')
    OR (child_kind = 'RETURN_ONLY' AND expires_at <= issued_at + INTERVAL '90 seconds')
  ),
  CHECK (
    (child_kind = 'READ' AND child_state = 'ISSUED'
      AND transcript_id IS NULL AND staged_at IS NULL AND accepted_at IS NULL
      AND closed_at IS NULL AND terminal_reason IS NULL)
    OR
    (child_kind = 'READ' AND child_state = 'STAGED'
      AND transcript_id IS NULL AND staged_at IS NOT NULL AND accepted_at IS NULL
      AND closed_at IS NULL AND terminal_reason IS NULL)
    OR
    (child_kind = 'READ' AND child_state = 'TRANSCRIPT_ACCEPTED'
      AND transcript_id IS NOT NULL AND staged_at IS NOT NULL AND accepted_at IS NOT NULL
      AND closed_at = accepted_at AND terminal_reason = 'TRANSCRIPT_ACCEPTED')
    OR
  (child_kind = 'RETURN_ONLY' AND child_state = 'ISSUED'
      AND transcript_id IS NULL AND staged_at IS NULL AND accepted_at IS NULL
      AND closed_at IS NULL AND terminal_reason IS NULL)
    OR
    (child_kind = 'RETURN_ONLY' AND child_state = 'RETURN_STAGED'
      AND transcript_id IS NULL AND staged_at IS NOT NULL AND accepted_at IS NULL
      AND closed_at IS NULL AND terminal_reason IS NULL)
    OR
    (child_kind = 'RETURN_ONLY' AND child_state = 'RETURN_ACCEPTED'
      AND transcript_id IS NULL AND staged_at IS NOT NULL AND accepted_at IS NOT NULL
      AND closed_at = accepted_at AND terminal_reason = 'RETURNED')
    OR
    (child_state = 'EXPIRED'
      AND transcript_id IS NULL AND accepted_at IS NULL AND closed_at IS NOT NULL
      AND terminal_reason = 'CHILD_EXPIRED')
    OR
    (child_state = 'CANCELLED'
      AND transcript_id IS NULL AND accepted_at IS NULL AND closed_at IS NOT NULL
      AND terminal_reason IN ('THREAD_DRIFT', 'COMMAND_REJECTED', 'RUNTIME_GATE_LOST', 'UNKNOWN_OUTCOME'))
  ),
  CHECK (staged_at IS NULL OR staged_at >= issued_at),
  CHECK (accepted_at IS NULL OR (staged_at IS NULL OR accepted_at >= staged_at)),
  CHECK (closed_at IS NULL OR closed_at >= issued_at)
);

ALTER TABLE tinder_unbound_inbox_conversation_sweep_steps
  ADD CONSTRAINT tinder_unbound_inbox_sweep_steps_command_device_fkey
  FOREIGN KEY (command_id, device_id)
  REFERENCES device_bridge_commands(command_id, device_id)
  ON DELETE RESTRICT;

ALTER TABLE tinder_unbound_inbox_conversation_sweep_steps
  ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_steps_sweep_device_fkey
  FOREIGN KEY (sweep_id, device_id)
  REFERENCES tinder_unbound_inbox_conversation_sweeps(sweep_id, device_id)
  ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_tinder_unbound_inbox_conversation_sweep_active_child_device
ON tinder_unbound_inbox_conversation_sweep_steps (device_id)
WHERE child_state IN ('ISSUED', 'STAGED', 'RETURN_STAGED');

CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_steps_sweep_slot
ON tinder_unbound_inbox_conversation_sweep_steps (sweep_id, slot_ordinal, child_kind);

CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_steps_device_expiry
ON tinder_unbound_inbox_conversation_sweep_steps (device_id, child_state, expires_at DESC);

CREATE TABLE tinder_unbound_inbox_conversation_sweep_transcripts (
  transcript_id UUID PRIMARY KEY,
  command_id UUID NOT NULL
    REFERENCES tinder_unbound_inbox_conversation_sweep_steps(command_id)
    ON DELETE RESTRICT,
  sweep_id UUID NOT NULL
    REFERENCES tinder_unbound_inbox_conversation_sweeps(sweep_id)
    ON DELETE RESTRICT,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
  transcript_contract_version SMALLINT NOT NULL
    CHECK (transcript_contract_version = 1),
  transcript_schema_version TEXT NOT NULL
    CHECK (transcript_schema_version = 'tinder-unbound-inbox-conversation-sweep-transcript-v1'),
  source_platform TEXT NOT NULL DEFAULT 'tinder'
    CHECK (source_platform = 'tinder'),
  source_package TEXT NOT NULL
    CHECK (source_package = 'com.tinder'),
  layout_schema_version TEXT NOT NULL
    CHECK (layout_schema_version = 'tinder-zte-visible-chat-scroll-v1'),
  sync_started_at TIMESTAMPTZ NOT NULL,
  sync_completed_at TIMESTAMPTZ NOT NULL,
  initial_visible_node_count INTEGER NOT NULL
    CHECK (initial_visible_node_count BETWEEN 1 AND 5000),
  final_visible_node_count INTEGER NOT NULL
    CHECK (final_visible_node_count BETWEEN 1 AND 5000),
  segment_count INTEGER NOT NULL
    CHECK (segment_count BETWEEN 1 AND 8),
  overlap_count INTEGER NOT NULL
    CHECK (overlap_count BETWEEN 0 AND 100),
  transcript_fingerprint CHAR(64) NOT NULL
    CHECK (transcript_fingerprint ~ '^[0-9a-f]{64}$'),
  visible_messages JSONB NOT NULL
    CHECK (jsonb_typeof(visible_messages) = 'array'),
  transcript_safety_status TEXT NOT NULL
    CHECK (transcript_safety_status = 'SAFE'),
  mapping_status TEXT NOT NULL DEFAULT 'NEEDS_HUMAN_MAPPING'
    CHECK (mapping_status = 'NEEDS_HUMAN_MAPPING'),
  human_review_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (human_review_status = 'PENDING'),
  received_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (command_id, device_id),
  UNIQUE (transcript_id, command_id, sweep_id, device_id),
  CHECK (sync_completed_at >= sync_started_at),
  CHECK (sync_completed_at <= sync_started_at + INTERVAL '90 seconds')
);

ALTER TABLE tinder_unbound_inbox_conversation_sweep_transcripts
  ADD CONSTRAINT tinder_unbound_inbox_sweep_transcripts_command_device_fkey
  FOREIGN KEY (command_id, device_id)
  REFERENCES tinder_unbound_inbox_conversation_sweep_steps(command_id, device_id)
  ON DELETE RESTRICT;

ALTER TABLE tinder_unbound_inbox_conversation_sweep_transcripts
  ADD CONSTRAINT tinder_unbound_inbox_sweep_transcripts_step_scope_fkey
  FOREIGN KEY (command_id, sweep_id, device_id)
  REFERENCES tinder_unbound_inbox_conversation_sweep_steps(command_id, sweep_id, device_id)
  ON DELETE RESTRICT;

ALTER TABLE tinder_unbound_inbox_conversation_sweep_steps
  ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_steps_transcript_scope
  FOREIGN KEY (transcript_id, command_id, sweep_id, device_id)
  REFERENCES tinder_unbound_inbox_conversation_sweep_transcripts(transcript_id, command_id, sweep_id, device_id)
  ON DELETE RESTRICT;

CREATE INDEX idx_tinder_unbound_inbox_sweep_transcript_device_received
ON tinder_unbound_inbox_conversation_sweep_transcripts (device_id, received_at DESC);

CREATE INDEX idx_tinder_unbound_inbox_sweep_transcript_pending_received
ON tinder_unbound_inbox_conversation_sweep_transcripts (mapping_status, human_review_status, received_at DESC);

CREATE TABLE tinder_unbound_inbox_conversation_sweep_audit (
  audit_id UUID PRIMARY KEY,
  sweep_id UUID NOT NULL
    REFERENCES tinder_unbound_inbox_conversation_sweeps(sweep_id)
    ON DELETE RESTRICT,
  command_id UUID
    REFERENCES tinder_unbound_inbox_conversation_sweep_steps(command_id)
    ON DELETE RESTRICT,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
  slot_ordinal SMALLINT,
  transcript_id UUID
    REFERENCES tinder_unbound_inbox_conversation_sweep_transcripts(transcript_id)
    ON DELETE RESTRICT,
  action TEXT NOT NULL
    CHECK (action IN ('SWEEP_ISSUED', 'READ_ISSUED', 'READ_STAGED', 'READ_TRANSCRIPT_ACCEPTED', 'RETURN_ISSUED', 'RETURN_STAGED', 'RETURN_ACCEPTED', 'SWEEP_COMPLETED', 'SWEEP_STOPPED', 'CHILD_EXPIRED', 'SWEEP_EXPIRED')),
  reason_code TEXT,
  actor TEXT NOT NULL
    CHECK (actor IN ('ANDROID_RUNTIME', 'SIGNED_TRANSCRIPT_INGRESS', 'SIGNED_RETURN_INGRESS', 'SERVER_AUTOMATION', 'SERVER_EXPIRY')),
  source TEXT NOT NULL
    CHECK (source IN ('SIGNED_DEVICE_INGRESS', 'SIGNED_TRANSCRIPT_INGRESS', 'SIGNED_RETURN_INGRESS', 'SERVER_AUTOMATION', 'SERVER_MAINTENANCE')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (details = '{}'::jsonb),
  CHECK (
    (action IN ('SWEEP_ISSUED', 'READ_ISSUED', 'READ_STAGED', 'READ_TRANSCRIPT_ACCEPTED', 'RETURN_ISSUED', 'RETURN_STAGED', 'RETURN_ACCEPTED', 'SWEEP_COMPLETED') AND reason_code IS NULL)
    OR (action = 'SWEEP_STOPPED' AND reason_code IN ('THREAD_DRIFT', 'COMMAND_REJECTED', 'RUNTIME_GATE_LOST', 'CHILD_EXPIRED', 'UNKNOWN_OUTCOME'))
    OR (action = 'CHILD_EXPIRED' AND reason_code = 'CHILD_EXPIRED')
    OR (action = 'SWEEP_EXPIRED' AND reason_code = 'SWEEP_EXPIRED')
  ),
  CHECK ((action IN ('READ_ISSUED', 'READ_STAGED', 'READ_TRANSCRIPT_ACCEPTED', 'RETURN_ISSUED', 'RETURN_STAGED', 'RETURN_ACCEPTED', 'SWEEP_STOPPED', 'CHILD_EXPIRED')) = (command_id IS NOT NULL AND slot_ordinal IS NOT NULL)),
  CHECK ((action = 'READ_TRANSCRIPT_ACCEPTED') = (transcript_id IS NOT NULL)),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tinder_unbound_inbox_conversation_sweep_audit
  ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_audit_sweep_device_fkey
  FOREIGN KEY (sweep_id, device_id)
  REFERENCES tinder_unbound_inbox_conversation_sweeps(sweep_id, device_id)
  ON DELETE RESTRICT;

ALTER TABLE tinder_unbound_inbox_conversation_sweep_audit
  ADD CONSTRAINT tinder_unbound_inbox_conversation_sweep_audit_step_scope_fkey
  FOREIGN KEY (command_id, sweep_id, device_id)
  REFERENCES tinder_unbound_inbox_conversation_sweep_steps(command_id, sweep_id, device_id)
  ON DELETE RESTRICT;

ALTER TABLE tinder_unbound_inbox_conversation_sweep_audit
  ADD CONSTRAINT tinder_unbound_inbox_sweep_audit_transcript_scope_fkey
  FOREIGN KEY (transcript_id, command_id, sweep_id, device_id)
  REFERENCES tinder_unbound_inbox_conversation_sweep_transcripts(transcript_id, command_id, sweep_id, device_id)
  ON DELETE RESTRICT;

CREATE INDEX idx_tinder_unbound_inbox_conversation_sweep_audit_sweep_created
ON tinder_unbound_inbox_conversation_sweep_audit (sweep_id, created_at DESC);

CREATE INDEX idx_tinder_unbound_inbox_sweep_audit_command_created
ON tinder_unbound_inbox_conversation_sweep_audit (command_id, created_at DESC)
WHERE command_id IS NOT NULL;

CREATE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_OP <> 'DELETE'
     AND TG_TABLE_NAME = 'tinder_unbound_inbox_conversation_sweeps'
     AND NEW.inbox_observation_nonce IS DISTINCT FROM OLD.inbox_observation_nonce THEN
    RAISE EXCEPTION 'unbound Inbox sweep observation nonce is immutable';
  END IF;
  IF TG_TABLE_NAME = 'tinder_unbound_inbox_conversation_sweeps'
     AND OLD.sweep_state IN ('COMPLETED', 'STOPPED', 'EXPIRED') THEN
    RAISE EXCEPTION 'terminal unbound Inbox sweep is immutable';
  END IF;
  IF TG_TABLE_NAME = 'tinder_unbound_inbox_conversation_sweep_steps'
     AND OLD.child_state IN ('TRANSCRIPT_ACCEPTED', 'RETURN_ACCEPTED', 'EXPIRED', 'CANCELLED') THEN
    RAISE EXCEPTION 'terminal unbound Inbox sweep step is immutable';
  END IF;
  IF TG_TABLE_NAME IN ('tinder_unbound_inbox_conversation_sweep_transcripts', 'tinder_unbound_inbox_conversation_sweep_audit') THEN
    RAISE EXCEPTION 'unbound Inbox sweep evidence is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$guard$;

-- A parent is inserted before its first child step, and an active child may
-- later be replaced inside one transaction.  Both parent and step mutations
-- therefore defer this reciprocal final-state check until commit.  It prevents
-- either side from being moved or deleted outside the exact parent/device
-- scope without weakening the normal non-deferrable scope foreign keys.
CREATE FUNCTION tinder_unbound_inbox_conversation_sweep_active_child_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM tinder_unbound_inbox_conversation_sweeps parent
     WHERE parent.sweep_state = 'ACTIVE'
       AND NOT EXISTS (
         SELECT 1
           FROM tinder_unbound_inbox_conversation_sweep_steps step
          WHERE step.command_id = parent.active_command_id
            AND step.sweep_id = parent.sweep_id
            AND step.device_id = parent.device_id
            AND step.child_state IN ('ISSUED', 'STAGED', 'RETURN_STAGED')
       )
  ) THEN
    RAISE EXCEPTION 'unbound Inbox sweep active command is outside its scope';
  END IF;
  RETURN NULL;
END;
$guard$;

-- Nullable parent-level audit rows legitimately carry no child command. When
-- a child command is present, the composite FK above proves its exact scope;
-- this guard rejects the otherwise-null-bypassing transcript/slot shapes.
CREATE FUNCTION tinder_unbound_inbox_conversation_sweep_audit_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF NEW.command_id IS NULL THEN
    IF NEW.slot_ordinal IS NOT NULL OR NEW.transcript_id IS NOT NULL THEN
      RAISE EXCEPTION 'unbound Inbox sweep parent audit cannot carry child evidence';
    END IF;
  ELSIF NEW.slot_ordinal IS NULL OR NOT EXISTS (
    SELECT 1
      FROM tinder_unbound_inbox_conversation_sweep_steps step
     WHERE step.command_id = NEW.command_id
       AND step.sweep_id = NEW.sweep_id
       AND step.device_id = NEW.device_id
       AND step.slot_ordinal = NEW.slot_ordinal
  ) THEN
    RAISE EXCEPTION 'unbound Inbox sweep child audit slot is outside its scope';
  END IF;
  RETURN NEW;
END;
$guard$;

CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_terminal_immutable
BEFORE UPDATE OR DELETE ON tinder_unbound_inbox_conversation_sweeps
FOR EACH ROW EXECUTE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard();

CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_step_terminal_immutable
BEFORE UPDATE OR DELETE ON tinder_unbound_inbox_conversation_sweep_steps
FOR EACH ROW EXECUTE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard();

CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_transcript_immutable
BEFORE UPDATE OR DELETE ON tinder_unbound_inbox_conversation_sweep_transcripts
FOR EACH ROW EXECUTE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard();

CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_audit_immutable
BEFORE UPDATE OR DELETE ON tinder_unbound_inbox_conversation_sweep_audit
FOR EACH ROW EXECUTE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard();

CREATE CONSTRAINT TRIGGER tinder_unbound_inbox_conversation_sweep_active_child_scope
AFTER INSERT OR UPDATE ON tinder_unbound_inbox_conversation_sweeps
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION tinder_unbound_inbox_conversation_sweep_active_child_guard();

CREATE CONSTRAINT TRIGGER tinder_unbound_inbox_conversation_sweep_step_active_child_scope
AFTER INSERT OR DELETE OR UPDATE ON tinder_unbound_inbox_conversation_sweep_steps
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION tinder_unbound_inbox_conversation_sweep_active_child_guard();

CREATE TRIGGER tinder_unbound_inbox_conversation_sweep_audit_scope
BEFORE INSERT OR UPDATE ON tinder_unbound_inbox_conversation_sweep_audit
FOR EACH ROW EXECUTE FUNCTION tinder_unbound_inbox_conversation_sweep_audit_scope_guard();
