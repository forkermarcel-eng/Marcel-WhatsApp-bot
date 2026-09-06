-- T6 Tinder inbound queue foundation — PREPARATION ONLY.
--
-- This migration is deliberately NOT imported by index.js, a Device Bridge
-- initializer, a Railway startup hook, a deployment hook, or a package script.
-- It creates persistent, T3-capture-bound queue state only.  It does not
-- register a timer, start a scanner, generate drafts, create Device Bridge
-- commands, or send anything through Tinder.
--
-- Prerequisites: reviewed T3 identity/capture and T4 capture-control
-- foundations. Apply only through a separately approved explicit migration.
-- The reviewed runner owns the transaction; this source must not BEGIN or
-- COMMIT independently.

DO $$
BEGIN
  IF to_regclass('public.tinder_visible_chat_captures') IS NULL
     OR to_regclass('public.contacts') IS NULL THEN
    RAISE EXCEPTION
      'T6 migration blocked: reviewed T3 capture and central contact foundations are required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tinder_visible_chat_captures'
       AND column_name = 'identity_revision'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tinder_visible_chat_captures'
       AND column_name = 'human_takeover_active'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'tinder_visible_chat_captures'
       AND column_name = 'handoff_active'
  ) THEN
    RAISE EXCEPTION
      'T6 migration blocked: reviewed T4 capture-control columns are required';
  END IF;
END
$$;

-- One item represents one currently open Tinder thread work cycle.  The
-- raw message is never copied here: content authority remains the referenced
-- verified T3 capture and all dedup fields are technical hashes only.
CREATE TABLE IF NOT EXISTS tinder_inbound_work_items (
  work_item_id UUID PRIMARY KEY,

  channel TEXT NOT NULL DEFAULT 'tinder'
    CHECK (channel = 'tinder'),

  device_id UUID NOT NULL
    REFERENCES device_bridge_devices(device_id)
    ON DELETE RESTRICT,
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
  capture_revision INTEGER NOT NULL
    CHECK (capture_revision > 0),
  identity_revision INTEGER NOT NULL
    CHECK (identity_revision > 0),
  latest_inbound_message_fingerprint CHAR(64) NOT NULL
    CHECK (latest_inbound_message_fingerprint ~ '^[0-9a-f]{64}$'),

  -- The full lifecycle is reserved now, but this T6 foundation only creates
  -- WAITING_FOR_US/HANDOFF from a verified terminal inbound and observes
  -- WAITING_FOR_HER after a verified terminal outgoing capture.
  conversation_state TEXT NOT NULL
    CHECK (conversation_state IN (
      'NEW_MATCH', 'WAITING_FOR_US', 'WAITING_FOR_HER',
      'ACTIVE_CHAT', 'DORMANT', 'HANDOFF'
    )),
  queue_status TEXT NOT NULL
    CHECK (queue_status IN (
      'COLLECTING', 'ELIGIBLE_FOR_NEXT_STAGE', 'BLOCKED', 'CLOSED'
    )),
  priority TEXT NOT NULL DEFAULT 'LIVE_INBOUND'
    CHECK (priority = 'LIVE_INBOUND'),
  block_reason TEXT,
  closed_reason TEXT,

  -- This exact 3:00–4:00-minute window is Tinder-only. It is persisted as
  -- timestamps; no process-local timer is authoritative across a restart.
  collection_window_ms INTEGER NOT NULL
    CHECK (collection_window_ms BETWEEN 180000 AND 240000),
  collection_started_at TIMESTAMPTZ NOT NULL,
  eligible_at TIMESTAMPTZ NOT NULL,
  last_verified_inbound_at TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK (eligible_at = collection_started_at + (collection_window_ms * INTERVAL '1 millisecond')),
  CHECK ((queue_status = 'BLOCKED') = (block_reason IS NOT NULL)),
  CHECK ((queue_status = 'CLOSED') = (closed_reason IS NOT NULL)),
  CHECK (block_reason IS NULL OR block_reason IN (
    'AUTO_REPLY_DISABLED', 'DATE_LOCK_ACTIVE', 'MANUAL_REVIEW_REQUIRED',
    'HUMAN_TAKEOVER_ACTIVE', 'HANDOFF_ACTIVE',
    'CONTACT_CONTROL_UNVERIFIABLE', 'CAPTURE_REVISION_STALE',
    'CONTEXT_REFRESH_REQUIRED', 'IDENTITY_NOT_CONFIRMED', 'CAPTURE_NOT_SAFE'
  )),
  CHECK (closed_reason IS NULL OR closed_reason IN ('VERIFIED_OUTBOUND', 'IDENTITY_CHANGED')),
  CHECK (conversation_state <> 'HANDOFF' OR queue_status = 'BLOCKED')
);

-- A thread can have at most one retained open work cycle. A later inbound
-- resets its own window in that item; it does not create another work item.
CREATE UNIQUE INDEX IF NOT EXISTS idx_tinder_inbound_work_one_open_thread
ON tinder_inbound_work_items (device_id, runtime_thread_fingerprint)
WHERE queue_status IN ('COLLECTING', 'ELIGIBLE_FOR_NEXT_STAGE', 'BLOCKED');

CREATE INDEX IF NOT EXISTS idx_tinder_inbound_work_due
ON tinder_inbound_work_items (eligible_at ASC)
WHERE queue_status = 'COLLECTING';

CREATE INDEX IF NOT EXISTS idx_tinder_inbound_work_contact_status
ON tinder_inbound_work_items (contact_id, queue_status, updated_at DESC);

-- Exactly one verified T3 capture-frame observation gets one technical event.
-- It stores no notification payload or message body. A notification may later
-- request controlled T2 verification, but is never stored as message truth.
CREATE TABLE IF NOT EXISTS tinder_inbound_work_events (
  event_id UUID PRIMARY KEY,
  work_item_id UUID NOT NULL
    REFERENCES tinder_inbound_work_items(work_item_id)
    ON DELETE RESTRICT,
  capture_id UUID NOT NULL
    REFERENCES tinder_visible_chat_captures(capture_id)
    ON DELETE RESTRICT,
  capture_fingerprint CHAR(64) NOT NULL
    CHECK (capture_fingerprint ~ '^[0-9a-f]{64}$'),
  terminal_message_fingerprint CHAR(64) NOT NULL
    CHECK (terminal_message_fingerprint ~ '^[0-9a-f]{64}$'),
  dedup_key CHAR(64) NOT NULL UNIQUE
    CHECK (dedup_key ~ '^[0-9a-f]{64}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tinder_inbound_work_events_work_time
ON tinder_inbound_work_events (work_item_id, created_at DESC);

-- Bounded operational history only. Details are IDs, revisions and window
-- lengths; no captured text, credentials, command payload, or raw signal is
-- stored here.
CREATE TABLE IF NOT EXISTS tinder_inbound_work_audit (
  audit_id BIGSERIAL PRIMARY KEY,
  work_item_id UUID NOT NULL
    REFERENCES tinder_inbound_work_items(work_item_id)
    ON DELETE RESTRICT,
  action TEXT NOT NULL
    CHECK (action IN (
      'INBOUND_ENQUEUED', 'COLLECTION_WINDOW_RESET', 'WORK_ITEM_BLOCKED',
      'WORK_ITEM_ELIGIBLE', 'VERIFIED_OUTBOUND_OBSERVED', 'IDENTITY_CHANGED'
    )),
  reason_code TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tinder_inbound_work_audit_work_time
ON tinder_inbound_work_audit (work_item_id, created_at DESC);
