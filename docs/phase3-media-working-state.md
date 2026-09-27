# Phase 3 — local working state, not a release / completion report

The user's sections 0–55 are one mission. Both supplied prompt parts were read.
Base HEAD: `0ad355db2466e5345c20cf4d728b99bdb5d20368`.
Worktree: `.worktrees/night-integration`. No commit, push, deployment, device
action, model download or AI call was made for this candidate. The separately
authorized Contacts Production runner completed as a verified no-op on 2026-09-27.

## Implemented locally

- Preserve original image bytes; screenshot crops retain only the crop. Separate
  display/thumbnail derivatives; original animation remains separate from preview.
- Bounded binary input, byte-derived file-type, SHA-256 and channel-neutral usage context.
- Repository transaction/advisory lock plus proposed unique DB index for exact-byte
  dedupe; separate owner links. SQL and restart behavior tested in isolated PGlite;
  parallel orchestration additionally tested with a repository double, not yet
  proved against a multi-client PostgreSQL server.
- Opt-in shared gallery alongside legacy media; protected Express Range/HEAD delivery
  and streaming proxy through the existing Contacts API function.
- Configurable filesystem root; Railway activation requires a persistent volume path.
- Baileys adapter tested with streams for all five types through actual ingress,
  isolated SQL, storage, gallery and ordered context. No socket. Video/audio
  header fixtures prove transport/type, not playable codec or ffprobe coverage.
- ffprobe/FFmpeg process adapter, bounded output, timeout/abort/temp cleanup; process
  control tested using Node doubles. Real ffmpeg/ffprobe not found on PATH and not run.
- Ordered media-context reader/repository query; asset-only analysis persistence,
  replaceable analyzer interface, explicitly disabled pg-boss job integration.
- Channel-neutral avatar selector wired to Contacts detail projection.
- Confirmed Tinder-to-contact binding using existing identifiers and NULL JID;
  separate source profiles in Contacts, not inferred Woman Brain facts.
- Existing profile-media adapter accepts universal ingress. Pager observes actual
  cropped pixels in RAM instead of treating a swipe result as proof of movement.
- Opt-in protected Tinder media ingress/projection and dashboard avatar/profile
  rendering. Fresh visible row/tile crop adapter accepts no tap/navigation
  capability; optional integration into the existing inventory/reconciliation
  runners is implemented locally. Physical media proof remains outstanding.
- Optional initial-profile media hook in the existing full reader: bounded RAM
  crops until accepted conversation ID, existing bearer upload, explicit media
  failure status without gating the working text mirror. No second profile open.
- Contact gallery derives all channel usages for the same contact and same asset;
  channel filters retain both usages without duplicating the visible image.
- `index.js`: runtime composition plus minimal nullable-Contacts consequences.
- Direct dependency declaration: existing file-type 21.3.4. node_modules remains untracked.

## Verification

All `test/*.test.js`: **360/360 PASS**, including Match-profile SQL/transport, source-only Contacts and contact-proxy regressions. Includes tests omitted by previous npm test
selection, Tinder runtime/reconciliation/delta, ACK, legacy gallery, auth/UI checks.
`git diff --check`: PASS. New shared media tests included in npm test:shared-media.
HTTP delivery test uses an actual localhost Express server and proves 206/HEAD,
owner mismatch denial, unauthenticated denial, safe unknown-file disposition.
SQL migration tests use both catalog/transaction doubles and an isolated PGlite
PostgreSQL engine. Production Contacts preflight/apply/postcheck is documented
separately in `contacts-channel-neutrality.md`; no product rows were changed.

## Authorized Production media migrations (APPLIED, 2026-09-27)

Runner: `scripts/shared-media-content-migration.js`.
Commands: `npm run preflight:shared-media-content`, `npm run migrate:shared-media-content`.
DDL hash: `cb1af412534b21a430ce1ecc4ed5d7a31d473df7eea804e84b9d03967b0fbe1b`.

- Existing `media_asset_links`: JSONB context column.
- Existing `media_assets`: unique sourceSha256 expression index + digest format check.
- Existing `media_asset_links`: unique owner/role/ordinal usage index.
- No backfill, no cleanup, no product row rewrite. Existing duplicates abort.
- Explicit transaction/lock/preflight/postcheck; failures roll back before commit;
  ambiguous commit is reported unresolved, never automatically retried.
- Foundation: ELIGIBLE_FOR_MIGRATION -> COMMIT_CONFIRMED / MIGRATION_APPLIED
  -> separate postcheck ALREADY_CANONICAL. legacy_media=0, assets=0, links=0.
- Content extension, only after foundation success: ELIGIBLE_FOR_MIGRATION
  -> COMMIT_CONFIRMED -> separate postcheck ALREADY_CANONICAL.
  assets=0, links=0, legacyMedia=0. No backfill or product row mutation.
- Executed via the existing Railway private SSH tunnel and local runner,
  with the connection URL exclusively in process memory. The temporary tunnel
  opened for these applies was closed afterwards; no worker was changed.
- Existing foundation runner: scripts/shared-media-migration.js; DDL SHA-256
  (statements joined with semicolon/newline):
  `9da6b7e9b2699baea74705def19ac2abfe3100a81982edc4ed40220bfeba754c`.
  Creates media_assets/media_asset_links, existing checks/indexes and RESTRICT FK.
  Both exact migrations were explicitly authorized and successfully applied.
  This does not authorize additional DDL or activate the media runtime.

## Contacts decision implemented locally

The user authorized preparing exactly DROP NOT NULL for contacts.whatsapp_jid.
Migration, source audit, rollback limits and tests are documented in
`contacts-channel-neutrality.md`. Existing JIDs and UNIQUE remain unchanged.
Production apply was authorized and returned COMMIT_CONFIRMED as a no-op: the
column was already nullable, 57 rows / 56 JIDs unchanged, UNIQUE unchanged.
PGlite is a pinned dev dependency, not a new deployed database service.

## Required remaining work — do not call Phase 3 DONE

- Browser contact-binding interaction is implemented locally; proxy regression
  proves authentication, confirmation, field whitelisting and conflict forwarding.
  Contacts accepts the linked contact ID to open the same detail view.
  Legacy/shared duplicate projection review remains part of release checks.
  Existing media is linked in the confirmed binding
  transaction; local SQL proves gallery/context use the same asset without copies.
- Verify the opt-in visible-avatar integration into existing inventory runtime,
  without allowing ambiguous/unbound rows to choose an owner.
- Real pager verification remains outstanding; local observed-pixel tests pass.
- Process Match only to PROFILE_CONTEXT_READY; initial-profile media is locally
  wired but still needs the controlled real single-profile proof after release.
  The user authorized local preparation of tinder_matches.profile JSONB NULL.
  The migration, store, confirmed Match binding, explicit Conversation handoff,
  asset reuse and existing queue/executor composition are implemented locally.
  See `tinder-match-profile-storage.md`. Production apply was authorized and
  returned COMMIT_CONFIRMED with a separate ALREADY_CANONICAL postcheck;
  no live PROCESS MATCH job has been enqueued or executed.
- Multi-client PostgreSQL race and real FFmpeg codec proof remain unclaimed;
  isolated PostgreSQL SQL/restart tests and parallel repository doubles pass.
  Video/audio fixtures now traverse the processor metadata/poster contract into
  persisted assets; repeated bytes do not rerun the processor. No codec binary
  was installed or invoked on this host. Production video/audio processing needs
  existing FFmpeg/ffprobe binaries configured via FFMPEG_PATH/FFPROBE_PATH or PATH.
- Exact unavailable source usage is reused transactionally without a fabricated
  content hash. Conflicting Contact media ownership aborts a verified handoff.
- Contacts Gallery uses source_only=1: both translation-generation functions are
  bypassed; a throwing-generator regression proves zero calls. Ordinary legacy
  translation requests retain their prior behavior. Legacy/shared items collapse
  only by explicit source-row reference or exact resource, never by caption/name.
- Gallery exposes protected originals separately and labels screenshot crops.
- Review all untracked new files explicitly; git diff alone omits them.
- All authorized Production DDL is now applied/canonical. No additional DDL is
  included. Candidate commit does not authorize an unreviewed main push.
- After release/schema approval: isolated match avatar/contact/gallery/profile media
  proofs, repeat dedupe; only then controlled old-profile media backfill.

Production Tinder runtime, pg-boss discovery worker and all existing profile/message
data remain untouched. Do not reread profiles as a substitute for local completion.

## Release configuration and single proofs (not executed)

Existing Railway volume: `/app/auth_ino`. A contained media-only directory such
as `/app/auth_ino/shared-media` can be configured as MEDIA_STORAGE_ROOT after
release approval; do not put media in an ephemeral application directory.
SHARED_MEDIA_ENABLED remains opt-in on backend and existing local worker.
No new volume, database, queue, bridge, model or worker service was provisioned.
The code and fixtures wire existing discovery, initial profile reading and
PROCESS MATCH through the same protected ingress. Real avatar bounds/pager,
Gallery visibility, exact repeat dedupe and PROFILE_CONTEXT_READY are still
post-deployment single-proof acceptance items, not inferred from unit tests.
