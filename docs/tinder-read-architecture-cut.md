# Tinder READ architecture cut

This record classifies the historical Tinder rollout controls against the
current production read path.  It is deliberately narrow: it does not change
the shared Brain, Memory, reply, delivery, or manual-review subsystems.

## Critical read path

`signed device request -> nonce replay -> SAFE V2 capture -> immutable
capture evidence -> identity-independent conversation projection -> dashboard`

The Android UiAutomator/visual controller supplies the local Tinder
navigation and reader evidence.  It is not a Brain and it does not require
the retired Accessibility root/arity/leaf selector to admit a read.

## Classification

| Historical control | Classification | Production treatment |
| --- | --- | --- |
| V1--V10 command/ack/sweep/return chains | A — rollout gate | Not imported by the passive V2 read ingress or its readiness middleware. Legacy routes remain separately scoped. |
| Human mapping / `RESOLVED` / `CONFIRMED` | A — rollout gate | Never blocks a V2 capture or its product conversation. A contact binding is optional data care after `UNASSIGNED`. |
| Human-armed capture / attestation / return permits | A — rollout gate | Not consulted by the passive read route; they remain available only on their legacy explicit flows. |
| Heartbeat, permits, receipts, bounded diagnostics | B — async audit/monitoring | May remain historical evidence, but are not synchronous prerequisites for capture, conversation projection, dashboard read, or dedupe. |
| Capture provenance and idempotency | C — production requirement | Immutable evidence is retained. `CREATED` and `IDEMPOTENT_DUPLICATE` are distinct; duplicates do not make another product conversation. |
| Device signature, active key, nonce replay, T2 capture schema | C — production requirement | These are the narrow server boundaries for passive V2 ingress. |
| Official package / locally safe UI / auth-review stop | C — production requirement | Enforced by the control layer; login, verification, and review remain human boundaries. |
| Ordered directional overlap before durable thread correlation | C — production requirement | A header-derived runtime value is only a candidate bucket; it is never a person identity or sufficient merge proof. |
| Accessibility wrapper/parent-arity/leaf selector admission | D — obsolete | Removed from the critical UiAutomator/visual control path. |
| Capture-first dashboard and mandatory capture mapping panel | D — obsolete as primary UX | The normal dashboard reads product conversations; the legacy capture/mapping surface is folded into technical audit. |

## Data model boundary

The additive `tinder_thread_conversations` and capture-link tables are the
durable product model.  The ordinary Conversation reader uses their stable
Conversation ids and aggregates linked immutable capture history once the
foundation is canonical. Capture links carry the device scope and use
composite foreign keys to both the Conversation and capture; a cross-device
link is therefore not representable by the product foundation. Their
migration contains no backfill or data mutation. Historic capture
reconciliation is separately authorized work: it must use the same ordered
directional overlap rule and must not infer a contact from a name, time,
fingerprint, or text.

Until that migration is explicitly applied, the normal Conversation reader is
unavailable rather than promoting a capture UUID to a product handle. The
existing capture audit remains separate technical evidence; it is not a
fallback Conversation surface.
