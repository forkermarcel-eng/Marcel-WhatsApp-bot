-- Explicit V8 catalog repair only.  This does not create tables, change
-- commands, mutate application rows, or replay historical sweep state.
-- It replaces precisely the legacy shared immutable-trigger function whose
-- parent-only field reference can fail when a child step is updated.

CREATE OR REPLACE FUNCTION tinder_unbound_inbox_sweep_immutable_terminal_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $guard$
BEGIN
  IF TG_TABLE_NAME = 'tinder_unbound_inbox_conversation_sweeps' THEN
    IF TG_OP <> 'DELETE' THEN
      IF NEW.inbox_observation_nonce IS DISTINCT FROM OLD.inbox_observation_nonce THEN
        RAISE EXCEPTION 'unbound Inbox sweep observation nonce is immutable';
      END IF;
    END IF;
    IF OLD.sweep_state IN ('COMPLETED', 'STOPPED', 'EXPIRED') THEN
      RAISE EXCEPTION 'terminal unbound Inbox sweep is immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'tinder_unbound_inbox_conversation_sweep_steps' THEN
    IF OLD.child_state IN ('TRANSCRIPT_ACCEPTED', 'RETURN_ACCEPTED', 'EXPIRED', 'CANCELLED') THEN
      RAISE EXCEPTION 'terminal unbound Inbox sweep step is immutable';
    END IF;
  ELSIF TG_TABLE_NAME IN ('tinder_unbound_inbox_conversation_sweep_transcripts', 'tinder_unbound_inbox_conversation_sweep_audit') THEN
    RAISE EXCEPTION 'unbound Inbox sweep evidence is immutable';
  ELSE
    RAISE EXCEPTION 'unbound Inbox sweep immutable guard received an invalid relation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$guard$;
