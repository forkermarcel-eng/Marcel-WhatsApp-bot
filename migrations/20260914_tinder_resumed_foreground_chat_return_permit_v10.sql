-- Resumed foreground official chat -> Inbox return -- explicit V10 only.
--
-- This identity-free child is separately audited after an exact terminal
-- Resume V2 acknowledgement. It never carries a capture, binding, revision,
-- thread, profile, row, or content fact and it grants no reader/write right.

ALTER TABLE device_bridge_commands
  DROP CONSTRAINT device_bridge_commands_command_type_check_v9;

ALTER TABLE device_bridge_commands
  ADD CONSTRAINT device_bridge_commands_command_type_check_v10
  CHECK (command_type IN (
    'PING', 'REQUEST_STATUS', 'STOP_BRIDGE',
    'CONNECT_TINDER', 'DISCONNECT_TINDER',
    'ARM_TINDER_CONVERSATION_BINDING',
    'SEND_TINDER_DRAFT',
    'SYNC_TINDER_VISIBLE_CHAT',
    'RESUME_OFFICIAL_TINDER_APP',
    'STAGE_TINDER_LOCAL_CONVERSATION_ATTESTATION',
    'READ_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT',
    'RETURN_TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_SLOT',
    'RETURN_TINDER_VERIFIED_CHAT_TO_INBOX',
    'RETURN_TINDER_RESUMED_FOREGROUND_CHAT_TO_INBOX'
  ));

CREATE TABLE tinder_resumed_foreground_chat_return_permits (
  command_id UUID PRIMARY KEY
    REFERENCES device_bridge_commands(command_id) ON DELETE RESTRICT,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT,
  resume_command_id UUID NOT NULL
    REFERENCES tinder_official_app_resume_permits(command_id) ON DELETE RESTRICT,
  permit_contract_version SMALLINT NOT NULL CHECK (permit_contract_version = 1),
  permit_state TEXT NOT NULL DEFAULT 'ISSUED'
    CHECK (permit_state IN ('ISSUED', 'STAGED', 'RETURNED', 'CANCELLED', 'EXPIRED')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  staged_at TIMESTAMPTZ,
  returned_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  terminal_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (command_id, device_id),
  CONSTRAINT tinder_resumed_foreground_chat_return_permits_resume_command_id_key
    UNIQUE (resume_command_id),
  CHECK (expires_at > issued_at),
  CHECK (expires_at <= issued_at + INTERVAL '90 seconds'),
  CONSTRAINT tinder_resumed_foreground_chat_return_permits_terminal_reason_check
    CHECK (terminal_reason IS NULL OR terminal_reason IN ('COMMAND_REJECTED', 'COMMAND_FAILED', 'COMMAND_EXPIRED', 'PERMIT_EXPIRED')),
  CONSTRAINT tinder_resumed_foreground_chat_return_permits_state_check
  CHECK (
    (permit_state = 'ISSUED' AND staged_at IS NULL AND returned_at IS NULL AND closed_at IS NULL AND terminal_reason IS NULL)
    OR (permit_state = 'STAGED' AND staged_at IS NOT NULL AND returned_at IS NULL AND closed_at IS NULL AND terminal_reason IS NULL)
    OR (permit_state = 'RETURNED' AND staged_at IS NOT NULL AND returned_at IS NOT NULL AND closed_at = returned_at AND terminal_reason IS NULL)
    OR (permit_state = 'CANCELLED' AND returned_at IS NULL AND closed_at IS NOT NULL AND terminal_reason IN ('COMMAND_REJECTED', 'COMMAND_FAILED', 'COMMAND_EXPIRED'))
    OR (permit_state = 'EXPIRED' AND returned_at IS NULL AND closed_at IS NOT NULL AND terminal_reason = 'PERMIT_EXPIRED')
  ),
  CHECK (staged_at IS NULL OR staged_at >= issued_at),
  CHECK (returned_at IS NULL OR (staged_at IS NOT NULL AND returned_at >= staged_at)),
  CHECK (closed_at IS NULL OR closed_at >= issued_at)
);

ALTER TABLE tinder_resumed_foreground_chat_return_permits
  ADD CONSTRAINT tinder_resumed_foreground_chat_return_permits_command_device_fkey
  FOREIGN KEY (command_id, device_id)
  REFERENCES device_bridge_commands(command_id, device_id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_tinder_resumed_foreground_chat_return_active_device
ON tinder_resumed_foreground_chat_return_permits (device_id)
WHERE permit_state IN ('ISSUED', 'STAGED');

CREATE INDEX idx_tinder_resumed_foreground_chat_return_resume_created
ON tinder_resumed_foreground_chat_return_permits (resume_command_id, created_at DESC);

CREATE TABLE tinder_resumed_foreground_chat_return_audit (
  audit_id UUID PRIMARY KEY,
  command_id UUID NOT NULL
    REFERENCES tinder_resumed_foreground_chat_return_permits(command_id) ON DELETE RESTRICT,
  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id) ON DELETE RESTRICT,
  action TEXT NOT NULL
    CHECK (action IN ('RETURN_ISSUED', 'RETURN_STAGED', 'RETURNED', 'RETURN_CANCELLED', 'RETURN_EXPIRED')),
  reason_code TEXT,
  actor TEXT NOT NULL CHECK (actor IN ('SERVER', 'DEVICE')),
  source TEXT NOT NULL CHECK (source IN ('RESUME_ACK', 'COMMAND_ACK', 'SIGNED_RECEIPT', 'EXPIRY')),
  details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (details = '{}'::jsonb),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (audit_id, command_id, device_id),
  CHECK (
    (action IN ('RETURN_ISSUED', 'RETURN_STAGED', 'RETURNED') AND reason_code IS NULL)
    OR (action = 'RETURN_CANCELLED' AND reason_code IN ('COMMAND_REJECTED', 'COMMAND_FAILED', 'COMMAND_EXPIRED'))
    OR (action = 'RETURN_EXPIRED' AND reason_code = 'PERMIT_EXPIRED')
  )
);

ALTER TABLE tinder_resumed_foreground_chat_return_audit
  ADD CONSTRAINT tinder_resumed_foreground_chat_return_audit_scope_fkey
  FOREIGN KEY (command_id, device_id)
  REFERENCES tinder_resumed_foreground_chat_return_permits(command_id, device_id) ON DELETE RESTRICT;

CREATE INDEX idx_tinder_resumed_foreground_chat_return_audit_command_created
ON tinder_resumed_foreground_chat_return_audit (command_id, created_at DESC);

CREATE FUNCTION tinder_resumed_foreground_chat_return_immutable_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'tinder_resumed_foreground_chat_return_audit' THEN
    RAISE EXCEPTION 'resumed foreground chat return audit is immutable';
  END IF;
  IF TG_TABLE_NAME <> 'tinder_resumed_foreground_chat_return_permits' THEN
    RAISE EXCEPTION 'resumed foreground chat return immutable guard received an invalid relation';
  END IF;
  IF OLD.permit_state IN ('RETURNED', 'CANCELLED', 'EXPIRED') THEN
    RAISE EXCEPTION 'terminal resumed foreground chat return permit is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'resumed foreground chat return permit cannot be deleted';
  END IF;
  IF NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id
     OR NEW.resume_command_id IS DISTINCT FROM OLD.resume_command_id
     OR NEW.permit_contract_version IS DISTINCT FROM OLD.permit_contract_version
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'resumed foreground chat return permit scope is immutable';
  END IF;
  IF OLD.permit_state = 'ISSUED' AND NEW.permit_state NOT IN ('ISSUED', 'STAGED', 'CANCELLED', 'EXPIRED') THEN
    RAISE EXCEPTION 'resumed foreground chat return permit transition is invalid';
  END IF;
  IF OLD.permit_state = 'STAGED' AND NEW.permit_state NOT IN ('STAGED', 'RETURNED', 'CANCELLED', 'EXPIRED') THEN
    RAISE EXCEPTION 'resumed foreground chat return permit transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

-- This trigger establishes only device/Resume provenance. It deliberately
-- does not read or project a V2 Resume source/binding/revision into V10.
CREATE FUNCTION tinder_resumed_foreground_chat_return_resume_scope_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.resume_command_id IS DISTINCT FROM OLD.resume_command_id
     OR NEW.device_id IS DISTINCT FROM OLD.device_id THEN
    IF NOT EXISTS (
      SELECT 1
        FROM tinder_official_app_resume_permits resume
        JOIN device_bridge_commands resume_command ON resume_command.command_id=resume.command_id
       WHERE resume.command_id=NEW.resume_command_id
         AND resume.device_id=NEW.device_id
         AND resume.permit_contract_version=2
         AND resume.permit_state='DISPATCHED'
         AND resume.expires_at > NOW()
         AND resume_command.device_id=resume.device_id
         AND resume_command.command_type='RESUME_OFFICIAL_TINDER_APP'
         AND resume_command.terminal_status='SUCCEEDED'
         AND resume_command.payload='{}'::jsonb
    ) THEN
      RAISE EXCEPTION 'resumed foreground chat return resume scope is invalid';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tinder_resumed_foreground_chat_return_resume_scope
BEFORE INSERT OR UPDATE ON tinder_resumed_foreground_chat_return_permits
FOR EACH ROW EXECUTE FUNCTION tinder_resumed_foreground_chat_return_resume_scope_guard();

CREATE TRIGGER tinder_resumed_foreground_chat_return_permit_immutable
BEFORE UPDATE OR DELETE ON tinder_resumed_foreground_chat_return_permits
FOR EACH ROW EXECUTE FUNCTION tinder_resumed_foreground_chat_return_immutable_guard();

CREATE TRIGGER tinder_resumed_foreground_chat_return_audit_immutable
BEFORE UPDATE OR DELETE ON tinder_resumed_foreground_chat_return_audit
FOR EACH ROW EXECUTE FUNCTION tinder_resumed_foreground_chat_return_immutable_guard();
