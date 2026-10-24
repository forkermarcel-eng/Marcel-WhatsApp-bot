# Brain style observer — local release

Production base: `6e24d199eaa09db003b93f51d89c727c35ecb0d0`.
Isolated branch: `release/brain-style-observer` in `.worktrees/brain-style-observer`.

## Implemented

- One central, local `observeStyle` function in `brain-chat/style-quality.js`, using the active locale. Separate `style-patterns.js` tables for `de-DE`, `en-US`, `es-CO`, `pt-BR` never merge. English-only write-good and DE/EN-only plain-prose have explicit locale gates.
- Findings include rule, `info`/`warning` severity, UTF-16 start/end offsets in the unchanged answer, review reason and source. No AI-origin probability or naturalness score. Cluster severity is a review priority, not a statement that the passage is wrong.
- Detects selected stock praise/overagreement, repeated confirmation, enthusiasm clusters, preambles/closings, connector density, generic closing questions, some regional variants, literal repeated sentences/openings/closings/information across up to three completed same-locale turns, and long verbatim user echoes. Sentence-rhythm and length-vs-briefness advisories are deliberately conservative.
- Code, quotations, blockquotes and URLs are masked with offsets preserved. Numeric/date/technical/safety repetitions and explicit requests to repeat/translate/quote bypass literal repetition alerts. Natural emotional responses, one-off connectors and ordinary politeness are permitted; nothing is prohibited or rewritten.
- `brain-chat/service.js` records `turn.styleObservation` plus compatible string `turn.styleChecks` in the existing per-conversation JSON. Existing authenticated conversation API returns those fields. No new dashboard, database schema or global history store. Only this conversation's supplied recent turns are compared. No cross-user storage or external text transfer.
- Newly generated answers are observed once after streaming. Knowledge-mode/source-original and literal outputs explicitly return `status: skipped` with a reason: original archive material and deterministic fact answers must not be evaluated as newly written Brain prose. Local-model failures that fall back to knowledge are also skipped. Diagnostic errors are fail-soft and never break an otherwise successful reply.
- No change to language selection, system instructions, model adapters, paid-model gates, retrieval, MCP tools or active improvement policy. No model call, background process, installation or network request from the observer.

Sources, licenses, actual reused functions and exclusions: [STYLE_OBSERVER_SOURCES.md](../brain-chat/STYLE_OBSERVER_SOURCES.md).

## Targeted verification

Command:

    node --test test/brain-style-observer.test.js test/brain-language.test.js test/brain-chat.test.js test/brain-learning.test.js test/brain-library-agent.test.js

Final result: **48 passed, 0 failed, 0 skipped**. No test disabled or weakened. Syntax/diff checks passed.

Per-language fixture results: each of DE, EN-US, ES-CO and PT-BR has a natural short response with zero findings and an artificial formula cluster with warning-level findings. Additional fixtures cover multi-turn repetition, user echo, locale separation, necessary warnings/technical facts/dates, quotations/code, ordinary warmth, natural isolated agreement, repeated canned agreement, and a 24-finding output cap. Chat integration verifies unchanged text/SSE, exactly one injected generator call in model mode, zero additional calls in knowledge mode, no knowledge writes and skipped source output.

A separate local evaluation reused the **16 synthetic model replies already recorded for the previous language release**. **0 of those 16 replies was flagged**. No new model calls were made. Results: [brain-style-observer-evaluation.json](brain-style-observer-evaluation.json). The near-limit probe of 59,200 characters produced at most 24 findings in approximately 24 ms on this machine (single observation, not a production benchmark). At most 128 phrase matches are retained internally; history is limited to three answers and 60,000 characters each.

## False positives, false negatives and limits

- Demonstrated potential false positive: a sincere **“Great question!”** receives an `info` stock-praise hint. This can be entirely appropriate; the observer never treats it as a factually wrong response, blocks it or rewrites it.
- Demonstrated false negative: **“Das Problem ist erledigt. Die Sache ist jetzt abgeschlossen.”** has no literal repeated sentence, so the semantic repetition is not detected. No model/embedding service was added to infer paraphrase equivalence.
- Regional variants are review hints only after clustering. A quotation or an intended nondefault audience can make them appropriate. This small rule set cannot certify native Colombian, Brazilian, American or German idiom and does not detect every British/European variant.
- Generic questions, politeness, agreement, length and enthusiasm require context that mechanical rules cannot fully infer. Factfulness, necessary clarifications and genuine empathy are not semantically assessed.
- Literal repetitions containing numbers, technical/safety markers or explicit repetition requests are intentionally protected; this can hide real unnecessary repetition. Short repeated sentences under six words are generally not flagged by history comparison, except the explicit canned-confirmation detector.
- No style score, author classification, automatic prompt mutation or future automatic improvement is enabled. A future active response improvement requires separate approval.

## Release boundaries

Only Brain diagnostic code, its integration, one retained MIT license, targeted fixtures and documentation changed. Trading, market analysis, organisation/email/calendar/DHL, other workspaces, database structure and schedulers remain unchanged. No production writes or deployment. Existing knowledge mode stays active and returns its answers unchanged.

Release is ready for separate deployment approval. Rollback is the previous application commit; added JSON observation fields are backward-compatible, so no migration or data rollback is necessary.
