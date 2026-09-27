# Contacts channel neutrality — local candidate

Production execution authorized and completed on 2026-09-27; no deployment,
contact-data change or AI call was performed.

## Production result

Target: spirited-peace / production, existing Postgres via Railway SSH tunnel.
The existing Railway variables were injected locally, with URL host/port changed
only in RAM to the private localhost tunnel. No credentials were printed/stored.

- Preflight: ALREADY_CANONICAL, 57 contacts, 56 non-NULL JIDs.
- Authorized runner --apply: COMMIT_CONFIRMED (existing nullable schema, no-op).
- Immediate separate read-only postcheck: ALREADY_CANONICAL, 57 / 56 unchanged.
- Runner compared full contact-row digest and exact UNIQUE definitions inside
  the locked transaction: unchanged. No ALTER was needed or issued.
- Only the temporary migration tunnel was stopped afterwards, not the worker.

This proves current nullable/UNIQUE behavior, not who previously relaxed the
column. No second schema, contact creation, media migration or release was applied.

## Migration

Runner: `scripts/contact-channel-migration.js`.
Implementation: `services/contact-channel-migration.js`.

```sql
ALTER TABLE contacts ALTER COLUMN whatsapp_jid DROP NOT NULL
```

DDL SHA-256: `69882bd3a38868fc8bb8fa5552c46133988ed2d638a3cdc98da7f808c757d902`.

Only the column's NOT NULL property changes. No rows, defaults, indexes,
foreign keys or other columns are changed. A valid single-key ordinary UNIQUE
index must already exist; NULLS NOT DISTINCT or missing uniqueness aborts.
The existing UNIQUE definition is compared before/after and left unchanged.
Multiple NULLs are accepted; duplicate non-NULL JIDs remain rejected.

Explicit preflight and apply commands used by the checked runner:

- `npm run preflight:contacts-channel-neutral`
- `npm run migrate:contacts-channel-neutral`

Apply uses one transaction, advisory lock and table lock, with bounded lock and
statement timeouts. It compares counts and an internal digest of every existing
contact row before/after. Postcheck mismatch or pre-commit failure rolls back.
The digest and contact data are not printed by the runner. Ambiguous COMMIT is
reported as unknown and is not retried automatically. Repeated successful apply
is a no-op.

After a successful commit, restoring NOT NULL would require **zero NULL rows**.
No automatic reverse migration or deletion/fake-JID conversion is provided.
Any later reversal requires separate review; transaction rollback covers failures
before commit, not a later destructive reversal.

## Source audit and minimum changes

- `index.js` schema bootstrap: nullable JID for new databases only; existing
  Production schema is never automatically altered by this change.
- Contact creation: inserts NULL rather than generating a synthetic profile JID.
- Contacts list/detail: marks NULL-JID contacts as profile-only; nullable JSON
  serialization stays unchanged. Central edit/delete paths already use contact.id.
- WhatsApp history/count: NULL route returns empty/zero, without a message query.
- WhatsApp imports/duplicate-cleanup/ensureContact: reject missing routing JID.
- Legacy WhatsApp selector excludes NULL routes instead of coercing NULL to a
  string. Central Contacts still lists those persons and their Tinder channel.
- `services/contact-identities.js`: nullable-safe; existing Tinder confirmation
  restriction retained. No name matching or generic Tinder identity edits added.
- Existing phone/WhatsApp identifier binding may retain the same contact.id when
  a genuine WhatsApp identifier is subsequently available. No new merge policy.
- Woman Brain/contact_memory_profiles/memory_items/memory_events: remain keyed
  by contact.id. No productive Brain calls or inferred memory facts are added.
- Shared Media owner links: central contact.id, no JID dependency.
- WhatsApp import CLI already validates exact expected JID and contact; unchanged.
- Historical memory queries use the existing contact.id profile and optional
  WhatsApp route; no universal person lookup by NULL JID is introduced.

## Evidence and limits

`test/contact-channel-postgres.test.js` runs actual PostgreSQL SQL in isolated
in-memory PGlite, with representative table fixtures and the actual migration /
Tinder binder. It proves unchanged old rows, real JID uniqueness, multiple NULL
contacts, same-name contacts remaining distinct, repeated binding to the same ID,
contact-ID memory associations and repeated no-op migration.

`test/contact-channel.test.js` covers migration failure/rollback/unknown commit,
actual extracted NULL history/count functions, routing rejection, CRUD source
contracts and actual Contacts channel-filter execution. The full legacy suite
also runs; this is not a real WhatsApp send or a live Production CRUD proof.

`test/shared-media-postgres.test.js` exercises actual media repository SQL and
contact-owner links; `test/tinder-contact-binding.test.js` covers confirmation,
idempotence and conflicting bindings. No name-based merge and no fake JID.

The Production nullable requirement is now verified. Other media DDL still needs
its separate approval; Phase 3 is not complete merely because this check passed.
