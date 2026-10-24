# Brain language release

Base: `be6cfeb4ea2274d767579a62d64e5f3df7af9653` (latest approved production release). Isolated worktree `.worktrees/brain-language-release`, branch `release/brain-language-20261024`. No deployment, push, migration, production setting change or model activation is part of this release.

## Implemented

- `brain-chat/language.js`: static, reviewed `de-DE`, `en-US`, `es-CO`, `pt-BR` profiles, local deterministic language detection and explicit switches, register selection (casual/business/technical/personal), register continuity on brief follow-ups. Ambiguous short messages retain the conversation language. Existing conversations without profile metadata infer it from recent user messages. Quotes, URLs and code do not vote on the input language. This is a bounded heuristic, not a universal language classifier.
- `brain-chat/service.js`: the same generator receives the selected profile plus existing security and source instructions. No new model, rewrite call or tools. Turn language/register and advisory style flags use existing conversation JSON. Knowledge-mode wrappers follow the language; factual source excerpts remain verbatim. Existing deterministic `context.answer` results and original external library templates remain unchanged, not silently translated.
- `brain-chat/style-quality.js`: write-good's dependency-free duplicate-word check for English prose, and advisory repeated-opening checks against recent complete turns. No automatic deletion, no blocked answer and no second generation. Diagnostics are metadata, not a truth or naturalness score.
- `brain-chat/learning.js`: `prepareStyleExample` prepares bounded before/after examples for the existing STILREGEL TXT import. Secret/marker validation; import only creates an open review candidate. No automatic system-prompt updates and no new persistent store. There is no new style-training UI or training pipeline.
- Selected open-source rule adaptations and original checkers, with pinned revisions/full licenses/notices in `brain-chat/LANGUAGE_SOURCES.md` and `brain-chat/vendor/`. No package dependency change. LangMem and promptfoo deliberately not installed; the existing reviewed memory and Node tests meet this scope.
- `scripts/check-brain-language.mjs`: manual, approval-gated acceptance runner for 16 synthetic messages using only the existing model adapter. Never runs on startup/tests, never loads production memories, and never installs skills. In-memory conversations only. Honors the existing local/paid model gate. Requires an explicit `--model-check` plus `BRAIN_LANGUAGE_TEST_APPROVED=true`; these flags alone do not bypass the model gate.

## Architecture review actually performed

Read the central Brain chat service, paid/local adapters, retrieval, learning TXT review and library integration. The central model path is `createBrainChat().send` → existing `generate` adapter; the current model does not receive executable tools. The deterministic optional library supplement remains unchanged and external references remain untrusted data. Existing retrieval/confirmed memory and separate personal-history rules are unchanged. `services/communication-policies.js` contains separate legacy channel/persona policies; those are intentionally not changed because Trading/other channels and workflows must remain stable. The new language rules apply only to Brain chat, not every application message or legacy service.

## Local checks (2026-10-24)

Command:

    node --test test/brain-language.test.js test/brain-chat.test.js test/brain-library-agent.test.js test/brain-learning.test.js test/prompts-library.test.js

Result: **41 passed, 0 failed, 0 skipped**. Existing tests were not disabled or weakened.

| Language | Local three-turn chat checks | Actual language-quality acceptance |
|---|---|---|
| de-DE | Passed: locale, follow-ups, criticism context, streamed response, retry/idempotency, stored facts retained in history | Passed bounded real-model sample (4 replies, including language switch) |
| en-US | Passed: same checks, plus upstream repeated-word advisory / plain-prose diagnostic fixture | Passed bounded real-model sample (4 replies, including language switch) |
| es-CO | Passed: same checks, explicit switch and Colombian profile selection | Passed bounded real-model sample (4 replies, including language switch) |
| pt-BR | Passed: same checks, explicit switch and Brazilian profile selection | Passed bounded real-model sample (4 replies, including language switch) |

Those four integration cases use an injected deterministic generator to verify the actual chat orchestration. Their hand-authored example answers are test fixtures, **not generated model answers and not evidence of native-speaker fluency**. Additional cases verify cross-language switching in one conversation, old conversations, quotes/code, safe bounded instructions, review-only style examples, knowledge mode without LLM use and absence of context crossover. Existing authenticated HTTP/SSE and Vercel proxy tests passed. No UI was changed.

`node --check` for changed runtime modules and the manual acceptance runner, plus `git diff --check`, passed. The manually invoked model runner without approval refused to call a model as intended.

## Approved real-model acceptance completed

The user separately approved a bounded test of at most 16 synthetic messages. Exactly **16 model calls** completed using the existing central model, **gpt-5.6-sol**, through the unchanged Brain model adapter. Candidate language/service code was loaded into a short-lived isolated process via in-memory modules. No production source file was replaced or deployed. Conversations used only an in-memory repository, empty retrieval and disabled library supplementation; **0 knowledge entries**, no production conversation writes, migrations or account changes. The paid gate was set only for that test process, not the running application.

Full synthetic inputs and actual model replies: [brain-language-model-acceptance.json](brain-language-model-acceptance.json). This file records the code candidate tested; the final release differs only by acceptance documentation.

Manual review of all 16 replies:

- **de-DE:** direct, fluent German; criticism led to a plainer explanation without praise/apology loops; correctly rejected the prime-number claim.
- **en-US:** natural professional US English, ordinary terminology; same direct correction and no stock praise.
- **es-CO:** nationally understandable Colombian-compatible Spanish; no forced slang, vosotros or unsolicited voseo; criticism handled directly. This neutral technical sample does not certify every Colombian social register.
- **pt-BR:** natural Brazilian phrasing, no bureaucratic gerundism or imposed slang; correct factual disagreement.
- **Across turns:** no identical opening/closing sentence repeated within the three-turn scenarios; all 16 selected locales matched the requested language. All four language-switch reminders preserved Tuesday at 14:00 / 2 PM.
- **Factual disagreement:** all four languages rejected the false claim that 5432 is prime. Explanations gave a valid factorization (2 × 2716 or 56 × 97).
- **Limits:** API examples remained explanatory illustrations, not actual live infrastructure claims. The Portuguese example introduced localhost as an illustration; it is not evidence of an actual endpoint. No native-speaker panel or broad statistical quality claim. Personal/empathic and business register routing is locally tested; this bounded model run focuses on technical explanations, criticism and meeting reminders.

A final separate read-only runtime check confirmed production remains on **be6cfeb4ea2274d767579a62d64e5f3df7af9653**, **knowledge** mode, **paidEnabled=false**, **localApproved=false**. No production model activation was performed.

The bounded acceptance blocker is resolved. **Production release still needs separate deployment approval.** Deploying this release alone does not enable free-form generative replies: the existing knowledge-mode gate remains in place until separately authorized.

## Boundaries and rollback

No files in Trading, market analysis, organisation, email/calendar, financial/news/workspace code, database schemas or schedulers changed. No model SDK/dependency/config change, new service or automatic third-party text evaluation. Existing optional prompts.chat requests retain their public-query constraints. Language rules alone make no network requests.

Rollback is to keep/redeploy the base application commit; the extra JSON metadata is backward-compatible. No data deletion, schema rollback or restore from an old dump is needed. Production is unchanged. A later deployment requires the user's separate explicit permission.
