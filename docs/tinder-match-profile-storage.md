# Match full-profile storage — local code candidate, Production schema applied

## Exact migration

Runner: `scripts/tinder-match-profile-migration.js`.

DDL SHA-256: `22364cca2cbe026f732a06ea9c15526edc55aa1f82e773a2b9894759fe61dbee`.

```sql
ALTER TABLE tinder_matches ADD COLUMN profile JSONB NULL;
```

Explicit commands:

- `npm run preflight:tinder-match-profile`
- `npm run migrate:tinder-match-profile`
- `npm run preflight:tinder-match-profile`

No runtime schema creation. No backfill, default, extra table, constraint or
index. NULL means no full profile. Existing tile state remains independent.
The migration checks the existing Match catalog after subtracting only this
one target column, then checks the target is nullable JSONB without a default.
Inside a transaction it locks the affected tables and compares counts and
digests of existing Match/Conversation/Message rows. On a canonical no-op,
existing full profiles are also included in the preservation check.

Failure before COMMIT rolls back. An uncertain COMMIT is reported explicitly;
the runner discards that connection and never retries automatically. Determine
schema state with the read-only preflight. Do not drop this column as an
automatic rollback after product profiles have been written.

## Product wiring

- `normalizeTinderProfile` is shared with Conversations; no second JSON model.
- Full-profile writes are separate from tile reconciliation, device-bound and
  compare the original selected tile before writing. Identical JSON is a no-op.
- Existing match-list readers tolerate a missing new column until the explicit
  apply; the PROCESS MATCH profile operations require the column.
- Confirmed Match binding reuses the existing contact identifier mechanism with
  an explicit internal `mirror-match` reference, never a fabricated native ID.
- A verified handoff operates on an already existing device-bound Conversation,
  reuses the confirmed contact ID and assets, and preserves normal history state.
  It creates neither a Conversation nor a person, does not infer the relation,
  and does not overwrite a pre-existing Conversation profile. The handoff is an
  explicit service contract, not an automatic name/tile-based linking algorithm.
- Match profiles without Conversations project into central Contacts; confirmed
  Gallery links reference the same assets before and after a handoff.
- PROCESS MATCH uses the existing queue/consumer/executor and Appium session.
  Its transport contains only operation, device UUID and internal Match UUID.
  The existing dispatcher serializes it with reconciliation. No second queue,
  timer, device controller or schema is created.
- The existing Match runner revalidates current UI before a tap and uses the
  existing full-profile reader plus same-visit media buffer. A complete cached
  profile with valid media skips detail reads. Partial media is not readiness:
  only a selected incomplete attempt may be retried, with byte-level asset reuse.
- Readiness requires persisted profile, confirmed contact binding and complete
  observed profile-media coverage. Coverage is recorded in existing link context,
  not a separate permit/receipt table. Missing contact binding does not discard
  the profile or prevent passive reconciliation.
- The existing dashboard proxy forwards a narrow PROCESS MATCH request and
  explicit contact selection. Backend bearer credentials remain server-side.

## Verification and remaining boundary

Isolated PGlite PostgreSQL tests exercise real DDL, NULL compatibility, unchanged
old rows, repeated apply, rollback, uncertain COMMIT, exact shared profile JSON,
idempotent processing, contact preservation, and asset/link reuse. Controller and
transport fixtures prove fresh revalidation, no repeated detail open for a cached
profile, queue reuse and exclusion of concurrent Appium operations. These are
local proofs, not a physical Tinder or Production PROCESS MATCH acceptance.

Latest whole `test/*.test.js` suite: 360/360 PASS. `git diff --check`: PASS.

Production apply was explicitly authorized and completed on 2026-09-27:
ELIGIBLE_FOR_MIGRATION -> COMMIT_CONFIRMED (changed=true) -> separate
ALREADY_CANONICAL postcheck. Existing rows preserved: 9 Matches,
14 Conversations, 81 Messages. No backfill; all new Match profiles NULL.
Only the exact additive column was applied via the reviewed runner.
No live worker was restarted, no Product WorkItem enqueued, no Tinder profile
opened, and no AI/model invoked during this local implementation.
The real persisted Match-profile proof still requires release of the reviewed
candidate; it is not implied by the schema apply or green local tests.
