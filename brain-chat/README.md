# Marcel Brain Chat V1

The Chat tab extends `/Brain/`. It reuses the existing authenticated Brain
function, OpenAI Responses client/model, knowledge repository and review service.
The dating reply persona is intentionally not used for the owner's assistant.

Conversations are namespaced `brain-chat:<uuid>` records in the existing `meta`
collection, not a separate knowledge database. Normal messages update only those
records. Explicit remember requests produce pending entries using the existing
document review service. Human confirmation still happens in Dokumentenwissen.
Imported knowledge is never rewritten on chat startup or a normal chat request.

Retrieval caches the local corpus briefly and selects up to 12 excerpts, about
14,000 characters, across relevant domains/projects. Context includes the last
12 complete turns (maximum about 24,000 characters). Pending, conflict, unreviewed
personal and intimate sources are excluded. For owner-reviewed personal data,
each request requires the visible opt-in; public writing contexts exclude it.
PostgreSQL Memory is read only, human-verified, active and allowed for replies.
No contact memory is supplied to this V1. No live news tool is currently wired;
the model must disclose the lack of current verification.

## Local start

Use Node 24 (the existing import uses `node:sqlite`). In a new local terminal set
`DASHBOARD_USERNAME`, `DASHBOARD_PASSWORD`, and `OPENAI_API_KEY` in the environment
or use Node's `--env-file` with an ignored private file. Never paste keys in Git.
The existing `OPENAI_MODEL` is reused; `BRAIN_CHAT_MODEL` is an optional override.

    node scripts/start-brain-chat.mjs

Open `http://localhost:3088/Brain/` and use the existing Dashboard login. The host
binds only to loopback. `BRAIN_KNOWLEDGE_FILE` can select an existing absolute
SQLite path; by default it opens `.local-knowledge/marcel-brain.sqlite`.
It never starts `index.js`, channel workers, schema migration or news collectors.
It enables local owner reviews and chat writes, not automatic memory approval.
Legacy PostgreSQL Memory/Live State are unavailable in this standalone local
host; its visible warning/empty state is not a production data snapshot.

On the main backend the route stays off unless `BRAIN_CHAT_ENABLED=true`.
Production PostgreSQL still requires the separately prepared knowledge schema;
there is no startup DDL, migration, deployment or production import here.
Do not deploy the private SQLite file. Local conversations inherit the private
file's storage/OneDrive policy. They are not encrypted by this module.

The provider adapter is `model.js`: injected async iterable of text chunks.
OpenAI requests use streaming, `store:false`, a bounded output, no tools and no
automatic retries. Replacing this adapter supports a future local model without
changing the UI or retrieval/store. Interrupted turns stay marked as errors;
retries with the same request ID do not duplicate complete answers or API cost.

## Verification

    node --test test/brain-chat.test.js

`test/brain-chat.browser.js` explicitly simulates provider responses for UI
checks. Passing those checks does not prove a real API response. A live model
smoke check requires the server-side API key; without it the UI shows a clear
configuration error, not a fabricated answer.

Streaming protocol follows the official OpenAI documentation:
https://developers.openai.com/api/docs/guides/streaming-responses
