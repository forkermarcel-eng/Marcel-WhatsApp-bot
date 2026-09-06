-- T5 Human-approved Tinder send contract — PREPARATION ONLY.
--
-- This migration is deliberately NOT imported by index.js, a Device Bridge
-- initializer, a Railway startup hook, or a deployment hook.  It creates a
-- sealed approval/intent outbox only; it does NOT alter device_bridge_commands
-- and therefore cannot make a live Device Bridge command deliverable.
--
-- Prerequisites: reviewed T3 identity/capture and T4 draft foundations.
-- A separately reviewed future T5 writer/protocol release is required before
-- any intent may be promoted into the active Device Bridge command path. The
-- reviewed runner owns the transaction; this source must not BEGIN or COMMIT.

DO $$
BEGIN
  IF to_regclass('public.tinder_reply_drafts') IS NULL
     OR to_regclass('public.tinder_visible_chat_captures') IS NULL
     OR to_regclass('public.device_bridge_devices') IS NULL THEN
    RAISE EXCEPTION
      'T5 migration blocked: reviewed T3/T4 and Device Bridge foundations are required';
  END IF;
END
$$;

-- T4 does not expose a draft editor.  This revision is the T5 binding point:
-- a future edit must atomically advance it and receives a new approval.
ALTER TABLE tinder_reply_drafts
  ADD COLUMN IF NOT EXISTS draft_revision INTEGER NOT NULL DEFAULT 1
    CHECK (draft_revision > 0);

-- The approval snapshot is immutable as to draft/contact/capture/thread/text
-- truth.  State only records a later fail-closed invalidation or cancellation;
-- the exact approved text remains in the existing T4 draft and is represented
-- here by its SHA-256, never duplicated into an unrelated message table.
CREATE TABLE IF NOT EXISTS tinder_reply_send_approvals (
  approval_id UUID PRIMARY KEY,

  draft_id UUID NOT NULL
    REFERENCES tinder_reply_drafts(draft_id)
    ON DELETE RESTRICT,
  draft_revision INTEGER NOT NULL
    CHECK (draft_revision > 0),

  contact_id INTEGER NOT NULL
    REFERENCES contacts(id)
    ON DELETE RESTRICT,
  capture_id UUID NOT NULL
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,
  capture_fingerprint CHAR(64) NOT NULL
    CHECK (capture_fingerprint ~ '^[0-9a-f]{64}$'),

  -- T3 does not currently expose a stable external Tinder thread ID.  This is
  -- explicitly a versioned technical runtime-fingerprint binding, not a claim
  -- of an external thread reference.
  thread_ref_kind TEXT NOT NULL
    CHECK (thread_ref_kind = 'runtime_thread_fingerprint_v1'),
  runtime_thread_fingerprint CHAR(64) NOT NULL
    CHECK (runtime_thread_fingerprint ~ '^[0-9a-f]{64}$'),

  capture_revision INTEGER NOT NULL
    CHECK (capture_revision > 0),
  identity_revision INTEGER NOT NULL
    CHECK (identity_revision > 0),

  approved_text_sha256 CHAR(64) NOT NULL
    CHECK (approved_text_sha256 ~ '^[0-9a-f]{64}$'),
  approval_binding_sha256 CHAR(64) NOT NULL
    CHECK (approval_binding_sha256 ~ '^[0-9a-f]{64}$'),

  approved_by TEXT NOT NULL
    CHECK (char_length(approved_by) BETWEEN 1 AND 80),
  approved_at TIMESTAMPTZ NOT NULL,

  state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (state IN ('ACTIVE', 'INVALIDATED', 'CANCELLED')),
  invalidated_reason TEXT,
  invalidated_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- One human approval can never float to a second logical send attempt.  A
  -- changed draft requires a new revision and therefore a new approval.
  UNIQUE (draft_id, draft_revision),
  CHECK (
    (state = 'ACTIVE' AND invalidated_reason IS NULL AND invalidated_at IS NULL)
    OR
    (state IN ('INVALIDATED', 'CANCELLED') AND invalidated_reason IS NOT NULL AND invalidated_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tinder_reply_send_approvals_active_draft
ON tinder_reply_send_approvals (draft_id, draft_revision)
WHERE state = 'ACTIVE';

-- A send intent is a sealed future-command reservation, not an active
-- device_bridge_commands row.  It cannot be selected by heartbeat delivery,
-- acknowledged by the active T0/T1 ACK handler, or retried automatically.
CREATE TABLE IF NOT EXISTS tinder_reply_send_intents (
  intent_id UUID PRIMARY KEY,
  approval_id UUID NOT NULL UNIQUE
    REFERENCES tinder_reply_send_approvals(approval_id)
    ON DELETE RESTRICT,

  draft_id UUID NOT NULL
    REFERENCES tinder_reply_drafts(draft_id)
    ON DELETE RESTRICT,
  draft_revision INTEGER NOT NULL
    CHECK (draft_revision > 0),
  contact_id INTEGER NOT NULL
    REFERENCES contacts(id)
    ON DELETE RESTRICT,
  capture_id UUID NOT NULL
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,
  capture_fingerprint CHAR(64) NOT NULL
    CHECK (capture_fingerprint ~ '^[0-9a-f]{64}$'),
  thread_ref_kind TEXT NOT NULL
    CHECK (thread_ref_kind = 'runtime_thread_fingerprint_v1'),
  runtime_thread_fingerprint CHAR(64) NOT NULL
    CHECK (runtime_thread_fingerprint ~ '^[0-9a-f]{64}$'),
  identity_revision INTEGER NOT NULL
    CHECK (identity_revision > 0),

  -- Reserved now for correlation only.  It is intentionally NOT a foreign
  -- key into device_bridge_commands until a durable writer protocol exists.
  command_id UUID NOT NULL UNIQUE,
  command_type TEXT NOT NULL
    CHECK (command_type = 'SEND_TINDER_DRAFT'),
  protocol_version INTEGER NOT NULL
    CHECK (protocol_version = 1),

  approved_text_sha256 CHAR(64) NOT NULL
    CHECK (approved_text_sha256 ~ '^[0-9a-f]{64}$'),
  approval_binding_sha256 CHAR(64) NOT NULL
    CHECK (approval_binding_sha256 ~ '^[0-9a-f]{64}$'),

  delivery_policy_revision TEXT NOT NULL
    CHECK (char_length(delivery_policy_revision) BETWEEN 1 AND 120),
  not_before TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  typing_duration_ms INTEGER NOT NULL
    CHECK (typing_duration_ms BETWEEN 0 AND 900000),

  state TEXT NOT NULL DEFAULT 'PENDING_T5_WRITER'
    CHECK (state IN (
      'PENDING_T5_WRITER', 'DISPATCHING', 'SENT', 'FAILED',
      'STALE', 'CANCELLED', 'SEND_RESULT_UNKNOWN'
    )),
  received_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result_code TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,

  CHECK (expires_at > not_before),
  CHECK (char_length(COALESCE(result_code, '')) <= 120),
  CHECK (
    (state IN ('PENDING_T5_WRITER', 'DISPATCHING') AND completed_at IS NULL)
    OR
    (state IN ('SENT', 'FAILED', 'STALE', 'CANCELLED', 'SEND_RESULT_UNKNOWN') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_tinder_reply_send_intents_pending
ON tinder_reply_send_intents (state, not_before, expires_at)
WHERE state IN ('PENDING_T5_WRITER', 'DISPATCHING');

-- Bounded audit information only: IDs, hashes, policy revision and fixed
-- reason/result codes.  No raw capture content, credentials or copied Tinder
-- text is written here, and no fake WhatsApp message/JID is created.
CREATE TABLE IF NOT EXISTS tinder_reply_send_audit (
  send_audit_id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL
    CHECK (action IN (
      'APPROVAL_CREATED', 'APPROVAL_INVALIDATED', 'APPROVAL_CANCELLED',
      'DRAFT_REJECTED',
      'SEND_INTENT_RESERVED', 'SEND_RECEIVED', 'SEND_SUCCEEDED',
      'SEND_FAILED', 'SEND_CANCELLED', 'SEND_RESULT_UNKNOWN'
    )),
  actor TEXT NOT NULL
    CHECK (char_length(actor) BETWEEN 1 AND 80),
  source TEXT NOT NULL DEFAULT 'tinder_manual_send'
    CHECK (source = 'tinder_manual_send'),
  draft_id UUID NOT NULL
    REFERENCES tinder_reply_drafts(draft_id)
    ON DELETE RESTRICT,
  approval_id UUID
    REFERENCES tinder_reply_send_approvals(approval_id)
    ON DELETE RESTRICT,
  intent_id UUID
    REFERENCES tinder_reply_send_intents(intent_id)
    ON DELETE RESTRICT,
  reason_code TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (char_length(COALESCE(reason_code, '')) <= 120)
);

CREATE INDEX IF NOT EXISTS idx_tinder_reply_send_audit_draft_time
ON tinder_reply_send_audit (draft_id, created_at DESC);
