-- T7 persistent Tinder automation-control foundation — PREPARATION ONLY.
--
-- This explicit migration stores only bounded control and audit metadata. It
-- is deliberately not imported by index.js, a startup hook, a worker, a
-- route, or any Device-Bridge command path. It cannot create a draft,
-- approval, command, capture, delivery request, or Tinder action.
--
-- Prerequisite: the reviewed T3/T4 capture and contact-control foundation is
-- already canonical. The reviewed runner owns BEGIN/COMMIT/ROLLBACK.

DO $$
BEGIN
  IF to_regclass('public.contacts') IS NULL
     OR to_regclass('public.tinder_visible_chat_captures') IS NULL
     OR NOT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tinder_visible_chat_captures'
          AND column_name = 'identity_revision'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tinder_visible_chat_captures'
          AND column_name = 'human_takeover_active'
     )
     OR NOT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'tinder_visible_chat_captures'
          AND column_name = 'handoff_active'
     ) THEN
    RAISE EXCEPTION
      'T7 migration blocked: reviewed T3/T4 capture and central contact foundations are required';
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS tinder_automation_global_control (
  control_id SMALLINT PRIMARY KEY
    CHECK (control_id = 1),

  state TEXT NOT NULL DEFAULT 'STOPPED'
    CHECK (state IN ('STOPPED', 'RUNNING', 'PAUSED', 'BLOCKED')),
  operation_state TEXT NOT NULL DEFAULT 'ACTIVE'
    CHECK (operation_state IN ('ACTIVE', 'REST_PHASE')),
  explicit_approval BOOLEAN NOT NULL DEFAULT FALSE,
  policy_revision TEXT
    CHECK (policy_revision IS NULL OR char_length(policy_revision) BETWEEN 1 AND 120),
  control_revision INTEGER NOT NULL DEFAULT 1
    CHECK (control_revision > 0),
  updated_by TEXT NOT NULL DEFAULT 't7_foundation_migration'
    CHECK (char_length(updated_by) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A persisted RUNNING value is still insufficient after a process restart:
  -- T7's separate process-local runtime approval remains mandatory.
  CHECK (
    state <> 'RUNNING'
    OR (explicit_approval = TRUE AND policy_revision IS NOT NULL)
  )
);

-- The one durable global record begins fail-closed. A later protected manual
-- control surface may update it, but this foundation creates no such route.
INSERT INTO tinder_automation_global_control (
  control_id, state, operation_state, explicit_approval, policy_revision,
  control_revision, updated_by
) VALUES (
  1, 'STOPPED', 'ACTIVE', FALSE, NULL, 1, 't7_foundation_migration'
)
ON CONFLICT (control_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS tinder_automation_contact_controls (
  contact_id INTEGER PRIMARY KEY
    REFERENCES contacts(id)
    ON DELETE RESTRICT,

  state TEXT NOT NULL DEFAULT 'DISABLED'
    CHECK (state IN ('DISABLED', 'ENABLED', 'PAUSED', 'BLOCKED')),
  control_revision INTEGER NOT NULL DEFAULT 1
    CHECK (control_revision > 0),
  updated_by TEXT NOT NULL DEFAULT 't7_foundation_migration'
    CHECK (char_length(updated_by) BETWEEN 1 AND 80),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tinder_automation_contact_controls_state
ON tinder_automation_contact_controls (state, updated_at DESC);

CREATE TABLE IF NOT EXISTS tinder_automation_control_audit (
  audit_id BIGSERIAL PRIMARY KEY,

  control_scope TEXT NOT NULL
    CHECK (control_scope IN ('GLOBAL', 'CONTACT')),
  contact_id INTEGER
    REFERENCES contacts(id)
    ON DELETE RESTRICT,
  action TEXT NOT NULL
    CHECK (action IN (
      'GLOBAL_DEFAULT_INITIALIZED',
      'GLOBAL_CONTROL_UPDATED',
      'CONTACT_CONTROL_CREATED',
      'CONTACT_CONTROL_UPDATED'
    )),
  actor TEXT NOT NULL
    CHECK (char_length(actor) BETWEEN 1 AND 80),
  source TEXT NOT NULL
    CHECK (char_length(source) BETWEEN 1 AND 80),
  reason_code TEXT
    CHECK (char_length(COALESCE(reason_code, '')) <= 120),
  details JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(details) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CHECK ((control_scope = 'GLOBAL') = (contact_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_tinder_automation_control_audit_scope_time
ON tinder_automation_control_audit (control_scope, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tinder_automation_control_audit_contact_time
ON tinder_automation_control_audit (contact_id, created_at DESC)
WHERE contact_id IS NOT NULL;

-- The seed audit has no capture, profile, draft, reply, credential, or other
-- Tinder-content field. It only records that the durable global default is
-- fail-closed until a later explicitly reviewed control action exists.
INSERT INTO tinder_automation_control_audit (
  control_scope, contact_id, action, actor, source, reason_code, details
)
SELECT
  'GLOBAL', NULL, 'GLOBAL_DEFAULT_INITIALIZED',
  't7_foundation_migration', 't7_foundation_migration', NULL, '{}'::jsonb
WHERE NOT EXISTS (
  SELECT 1
    FROM tinder_automation_control_audit
   WHERE control_scope = 'GLOBAL'
     AND action = 'GLOBAL_DEFAULT_INITIALIZED'
     AND source = 't7_foundation_migration'
);
