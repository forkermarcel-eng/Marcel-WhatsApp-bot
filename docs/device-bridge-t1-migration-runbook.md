# Device Bridge T1 migration runbook

This runbook applies only to the explicit local operator command
`npm run migrate:device-bridge-t1 -- --apply`. It is not an application
startup path, deployment hook, or automatic retry mechanism.

## Required operator gate

Before one invocation, the operator must independently confirm the intended
source commit, the deployed backend commit, and a fresh protected read-only
T1 preflight result for the same Production target. If those facts do not
unambiguously match, stop: the runner cannot safely infer source/deployment
provenance from a database connection alone.

Only one intentional runner invocation may be active. Do not invoke the
runner again after a failure without a separate read-only investigation and
an explicit operator decision.

## Transaction lifecycle

The existing runner owns one database client and one transaction:

1. `BEGIN`
2. transaction-local `lock_timeout = 5s`, `statement_timeout = 30s`, and
   `idle_in_transaction_session_timeout = 60s`
3. transaction-scoped advisory lock for the T1 runner; an unavailable lock
   aborts immediately
4. global Foundation, ACK, and T1 preflight
5. deterministic `ACCESS EXCLUSIVE` locks in the source-defined Foundation
   order: devices, keys, enrollment codes, commands, command ACKs, request
   nonces, audit events
6. the same complete preflight under those locks
7. only the existing four T1 constraint `ALTER` statements, if both T1
   constraints are still legacy and all rows are compatible
8. Foundation, ACK, T1 target-constraint, and row postcheck on the same client
9. `COMMIT` only after every check passes

The ACK gate uses the strict canonical fast path. A noncanonical
`ACK_PAYLOAD_V1` may pass only when the existing bounded 20-case semantic
classifier proves full semantic equivalence; all other ACK contracts remain
strict. The evaluator owns no transaction lifecycle and does not perform DDL
or writes.

## Abort and recovery

Before a successful `COMMIT`, any Foundation/ACK/T1 incompatibility, partial
T1 state, lock timeout, unavailable advisory lock, schema/data drift, or
postcheck failure causes `ROLLBACK`; PostgreSQL releases the transaction-held
locks and no partial constraint replacement remains.

A failed `COMMIT` has an unknown outcome. The runner discards its client and
does not issue `ROLLBACK` or retry. Stop and perform a separate read-only
verification before any future operator decision.

An already-final T1 state is a no-op. A mixed legacy/final T1 state is
ambiguous and fails closed; the runner never silently finishes a partial
migration.

## Bounded runner diagnostics

Each terminal CLI outcome emits the existing human-readable line followed by
one fixed-format diagnostic line containing only `stage`, `code`,
`transaction`, `rollback`, and `ddl_started`. The stage is one of the bounded
runner boundaries: database connection, `BEGIN`, transaction settings,
advisory lock, global preflight, table-lock acquisition, locked preflight,
DDL execution, postcheck, `COMMIT`, or cleanup. CLI argument and environment
validation use their own bounded stages.

The output never includes a raw PostgreSQL error, connection string, SQL,
parameters, or database rows. `ddl_started=true` means the runner began at
least one allowed T1 `ALTER` attempt; it does not claim that the statement or
transaction committed. A `COMMIT` failure reports an unknown commit outcome;
it is never reported as a successful migration. A failed `BEGIN` also remains
transaction-state unresolved because a network-level outcome cannot be
inferred safely.

For a future failure, `rollback=COMPLETED` documents the runner's successful
rollback attempt before `COMMIT`; `rollback=FAILED` or an unknown commit
outcome requires a separate protected read-only snapshot before any new
operator decision. Diagnostics cannot reconstruct a failure that occurred
before this observability was added.

## Scope boundary

The runner never bootstraps Foundation, repairs ACK, performs data backfills,
or changes application data. Its only possible DDL remains the existing T1
replacement of the `tinder_state` and `command_type` CHECK constraints.
