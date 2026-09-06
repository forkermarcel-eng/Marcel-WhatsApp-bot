# Tinder T3–T6 explicit migration runbook

This runbook is a release-operation checklist, not deployment authority.  A
production database change requires a separate, concrete approval for the
named stage.  It never authorizes a retry after an ambiguous result.

## Scope and invariants

- T2 signed visible-chat capture is already the canonical predecessor.
- Every T3–T6 runner validates its fixed local SQL source before opening a
  database connection.
- Every runner owns one transaction, applies local lock/statement/idle
  timeouts, obtains its stage-specific advisory lock, runs global and locked
  preflight, and only then executes its reviewed DDL.
- `SHARE` table locks block concurrent writers but permit ordinary readers.
  The locked preflight therefore validates the same schema and rows that the
  reviewed DDL can see.
- Missing, partial, duplicate, unknown, or noncanonical prerequisites stop
  fail-closed before DDL.  No runner is registered in app startup, a route, a
  scheduler, or a Railway hook.
- No runner logs `DATABASE_URL`, database credentials, raw capture content, or
  raw application rows.

## Deployment prerequisite

1. Release the reviewed source first and confirm the normal service startup is
   healthy.  Normal startup remains `npm run start` / `node index.js`; it does
   not invoke any Tinder foundation migration.
2. Use the active Railway service container for an approved production run.
   A local CLI process may have Railway variables but cannot resolve a private
   Railway PostgreSQL hostname.
3. Confirm the deployed source contains the expected explicit runner and that
   the active service/container is the intended deployment.  Never print the
   database URL while doing so.
4. Do not combine a migration with a capture, upload, mapping, device command,
   Tinder read, or send.

## Stage order

Run at most one approved stage at a time, in this order:

| Stage | Explicit runner | Requires canonical predecessor | What it enables |
| --- | --- | --- | --- |
| T3 identity | `npm run migrate:tinder-identity-foundation` | T1, ACK, T2 and contact/contact-identifier contracts | Protected capture reader and human-only mapping audit |
| T4 draft | `npm run migrate:tinder-draft-foundation` | T3 | Shared-core Tinder drafts |
| T5 send foundation | `node scripts/migrate-tinder-manual-send-foundation.js --apply` | T4 | Human-approved sealed future writer reservations only |
| T6 inbound queue | `node scripts/migrate-tinder-inbound-queue-foundation.js --apply` | T4 | Persisted verified-inbound collection windows only |

The direct T5/T6 commands are intentionally not package/startup hooks.  Their
`--apply` flag is mandatory.  A named script or command is not authorization:
execute it only after the relevant production DDL approval.

## Required checks immediately before an approved run

1. Confirm the target service is healthy and on the intended released commit.
2. Confirm no prior run of the same stage has a `COMMIT_OUTCOME_UNRESOLVED` or
   equivalent unresolved state.  If it does, stop and obtain a read-only
   current-state snapshot; never retry blindly.
3. Confirm no unrelated migration, schema repair, or device operation is in
   progress.  The runner's advisory lock is an additional protection, not a
   substitute for this check.
4. Invoke exactly one stage runner in the verified in-container context.
   The runner's own source validation, global preflight, locks, locked
   preflight, postcheck, and transaction boundary are mandatory; do not bypass
   them with a SQL console or copied statements.

## Interpretation and stop conditions

- `MIGRATION_APPLIED` with `COMMIT_CONFIRMED` means that stage committed; run
  the stage's read-only readiness check before moving to a dependent stage.
- `ALREADY_CANONICAL` means no DDL was needed; verify the reported stage is the
  intended one before continuing.
- Any lock timeout, partial/invalid foundation, data conflict, cleanup
  failure, or preflight error is a stop.  Do not repair or rerun in the same
  operation.
- `COMMIT_OUTCOME_UNRESOLVED` is an absolute no-retry condition.  Stop, take a
  fresh read-only schema/data snapshot, and determine whether the stage is
  canonical, absent, or partial before any future decision.
- A successful T3 migration still does not map a person automatically.  The
  real capture remains `NEEDS_HUMAN_MAPPING` until Marcel consciously maps it
  in the protected dashboard.

## Human mapping boundary after T3

For a real T2 capture, the protected dashboard route is:

```
/Tinder/?captureId=<capture-id>
```

After T3 is canonical and the dashboard is authenticated, Marcel must enter a
human-confirmed Tinder identifier, choose an existing central contact or name
a new central contact, tick the confirmation, and submit the explicit mapping.
Neither a display name nor a runtime fingerprint may create or merge a contact
automatically.

## Explicit non-goals of these stages

- No Android command, UI action, Tinder navigation, capture, upload, or send.
- No T5 writer dispatch: T5 currently stores only an immutable,
  `PENDING_T5_WRITER` future reservation.
- No T6 notification listener, scheduled scan, capture trigger, draft, or
  send.
- No T7 runtime activation or automatic approval.
