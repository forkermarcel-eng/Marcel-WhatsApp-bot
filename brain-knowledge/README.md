# Marcel Brain document knowledge

This module adds owner-only document retrieval alongside the existing personal
Marcel Brain. It does not change WhatsApp, Tinder, Trading or the crown review
flow, and never sends imported content to an AI provider.

## Local import and lookup

Verified locally with Node 24. No new dependencies are required. From the repo:

```powershell
node scripts/import-brain-knowledge.mjs import --workflow 'C:/Users/annem/OneDrive/Bilder/Desktop/Marcel workflow' --documents 'C:/Users/annem/Documents/Codex' --downloads 'C:/Users/annem/Downloads' --chats 'C:/Users/annem/.codex' --archive 'C:/Users/annem/OneDrive/Bilder/Desktop/Marcel workflow/Marcel-Trading-Update.zip'
node scripts/import-brain-knowledge.mjs stats
node scripts/import-brain-knowledge.mjs ask --question 'Wie funktioniert mein Trading-Workflow für Gold?' --domain TRADING
```

Default private storage: `.local-knowledge/marcel-brain.sqlite`. Both Git and
Vercel ignore this directory. Source manifests and import reports are beside
the database. They contain private local paths and must remain private.

`--db` selects another absolute private SQLite path. Import never connects to
PostgreSQL and refuses to run in Railway. `--manifest` accepts a source-spec
array for a repeatable restricted import. Original documents remain untouched.

`export --out ABSOLUTE_PRIVATE_FILE` writes a complete versioned JSON bundle
(documents, entries, evidence, relations, reviews and import metadata); it
refuses to overwrite an existing file. Source originals and their media are
separate backup items. An export is not a tested database disaster recovery.

## Retrieval and authority

Search uses local multilingual concept vectors with cosine-style ranking,
explicit topic/project boundaries and an abstention threshold. It is **not a
trained neural embedding model**. There is no remote fallback. Answers are
labelled extracts with document versions and paragraph/line/JSON locators;
documents never become executable instructions.

Sensitive personal claims, hypotheses and numerical trading parameters are
pending. `review --id ID --version N --action confirm|reject|correct` requires
`--allow-personal` for personal claims and `--resolve-conflict` for conflicts;
correction additionally takes `--text`. Reimports preserve owner corrections.
Original evidence and review history are retained. Explicit structured subject
conflicts block unreviewed claims. Unstructured prose is not automatically
asserted to be equivalent or contradictory; old/current assertions remain
source-labelled rather than silently merged. Extraction revisions retain older
fragments as historical. Current live infrastructure is never inferred from a
document's modification date.

DOCX uses bounded ZIP/XML extraction without macros or external entities.
PDF requires an already installed local `pdftotext`; scanned documents require
a separate local OCR step. Missing/oversized/unreadable sources are registered.
Chat ingestion uses only user messages, never tool/system/assistant output;
archives larger than 256 MiB require a targeted user-message export. The known
third-party WhatsApp export is explicitly excluded.

## Existing Brain integration

The additional `Dokumentenwissen` tab is lazy-loaded and uses the existing
authenticated Vercel function with `resource=knowledge`. It offers questions,
source evidence, missing-source registry, owner reviews and private export.

The backend route is disabled unless `BRAIN_KNOWLEDGE_ENABLED=true`. For a local
owner instance set `BRAIN_KNOWLEDGE_FILE` to the imported absolute file path.
GET opens it read-only. Set `BRAIN_KNOWLEDGE_WRITES=true` only when owner reviews
are explicitly intended. A local file is rejected on Railway.

Without a file the adapter reuses the existing PostgreSQL pool and the separate
`marcel_knowledge` schema. **No startup DDL exists.** The SQL foundation in
`migrations/20261018_brain_knowledge_foundation.sql` is prepared only. Production
schema creation/import remains blocked until a verified backup, correct target
and explicit production action are established. Nothing in this module enables
an automatic production import or deployment.

Targeted tests: `node --test test/brain-knowledge.test.js`.
