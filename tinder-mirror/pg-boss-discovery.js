/*
 * TINDER_DISCOVERY is deliberately only a durable transport envelope for an
 * already authenticated, content-free device hint. It neither carries Tinder
 * content nor makes an action decision. The local Appium executor remains the
 * only component that observes the official Tinder UI.
 */

export const PG_BOSS_SCHEMA = "pgboss";
export const TINDER_DISCOVERY_QUEUE = "TINDER_DISCOVERY";
export const TINDER_POSSIBLE_CHANGE_EVENT_TYPE = "TINDER_POSSIBLE_CHANGE";

// Bounded lifecycle values. retryLimit=0 is intentional: a failed local
// read is not silently replayed. A job which has not been claimed while the
// Windows worker is offline remains available until retention expires.
export const TINDER_DISCOVERY_JOB_OPTIONS = Object.freeze({
  retryLimit: 0,
  heartbeatSeconds: null,
  expireInSeconds: 900,
  retentionSeconds: 86_400,
  deleteAfterSeconds: 3_600
});

export const TINDER_DISCOVERY_DEBOUNCE_SECONDS = 15;

const TINDER_DISCOVERY_JOB_OPTION_KEYS = Object.freeze([
  "retryLimit",
  "heartbeatSeconds",
  "expireInSeconds",
  "retentionSeconds",
  "deleteAfterSeconds"
]);

export const PG_BOSS_RUNTIME_OPTIONS = Object.freeze({
  schema: PG_BOSS_SCHEMA,
  migrate: false,
  createSchema: false,
  // This is pg-boss's built-in transport lifecycle, not a product gate. It
  // expires/deletes terminal jobs and marks a claim abandoned after its fixed
  // expiry. It never authorizes a Tinder action or retries one (retryLimit=0).
  supervise: true,
  schedule: false,
  reindex: false,
  persistWarnings: false,
  persistQueueStats: false,
  useListenNotify: false
});

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validDeviceId(value) {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function assertBoundedInteger(value, name, { minimum, maximum }) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

export function normalizeTinderPossibleChangeHint(value) {
  if (!plainObject(value)
    || Object.keys(value).some((key) => key !== "device_id" && key !== "event_type")
    || !validDeviceId(value.device_id)
    || value.event_type !== TINDER_POSSIBLE_CHANGE_EVENT_TYPE) {
    throw new TypeError("A content-free Tinder possible-change hint is required");
  }
  return Object.freeze({
    device_id: value.device_id,
    event_type: TINDER_POSSIBLE_CHANGE_EVENT_TYPE
  });
}

export function normalizeTinderDiscoveryJob(value) {
  if (!plainObject(value)
    || Object.keys(value).length !== 1
    || !Object.hasOwn(value, "device_id")
    || !validDeviceId(value.device_id)) {
    throw new TypeError("A content-free Tinder discovery job is required");
  }
  return Object.freeze({ device_id: value.device_id });
}

export function createPgBossTransactionDb(client) {
  if (!client || typeof client.query !== "function") {
    throw new TypeError("A PostgreSQL transaction client is required");
  }
  return Object.freeze({
    executeSql(sql, values = []) {
      return client.query(sql, values);
    }
  });
}

/*
 * The existing device-hint transaction can pass its already locked `client`.
 * pg-boss then writes the job in that same transaction; a committed accepted
 * hint therefore has its coalesced job, while an enqueue error rolls both
 * back. This is transport atomicity only, not an action authorization gate.
 */
export function createTinderDiscoveryEnqueuer({
  boss,
  debounceSeconds = TINDER_DISCOVERY_DEBOUNCE_SECONDS,
  jobOptions = TINDER_DISCOVERY_JOB_OPTIONS
} = {}) {
  if (!boss || typeof boss.sendDebounced !== "function") {
    throw new TypeError("A pg-boss instance with sendDebounced() is required");
  }
  assertBoundedInteger(debounceSeconds, "debounceSeconds", { minimum: 1, maximum: 300 });
  if (!plainObject(jobOptions)) throw new TypeError("jobOptions must be an object");
  if (Object.keys(jobOptions).some((key) => !TINDER_DISCOVERY_JOB_OPTION_KEYS.includes(key))) {
    throw new TypeError("Only bounded Tinder discovery job lifecycle options are allowed");
  }
  const options = {
    ...TINDER_DISCOVERY_JOB_OPTIONS,
    ...jobOptions
  };
  assertBoundedInteger(options.retryLimit, "jobOptions.retryLimit", { minimum: 0, maximum: 0 });
  assertBoundedInteger(options.expireInSeconds, "jobOptions.expireInSeconds", { minimum: 1, maximum: 3_600 });
  assertBoundedInteger(options.retentionSeconds, "jobOptions.retentionSeconds", { minimum: 1, maximum: 604_800 });
  assertBoundedInteger(options.deleteAfterSeconds, "jobOptions.deleteAfterSeconds", { minimum: 1, maximum: 604_800 });
  if (options.heartbeatSeconds !== null) {
    throw new TypeError("Tinder discovery jobs must not use heartbeatSeconds");
  }
  const immutableOptions = Object.freeze({ ...options });

  async function enqueue(hint, { transactionClient = null } = {}) {
    const normalizedHint = normalizeTinderPossibleChangeHint(hint);
    const payload = normalizeTinderDiscoveryJob({ device_id: normalizedHint.device_id });
    const sendOptions = transactionClient
      ? { ...immutableOptions, db: createPgBossTransactionDb(transactionClient) }
      : { ...immutableOptions };
    return boss.sendDebounced(
      TINDER_DISCOVERY_QUEUE,
      payload,
      sendOptions,
      debounceSeconds,
      normalizedHint.device_id
    );
  }

  return Object.freeze({ enqueue });
}

export function createTinderDiscoveryPgBoss(PgBoss, { connectionString } = {}) {
  if (typeof PgBoss !== "function") throw new TypeError("PgBoss constructor is required");
  if (typeof connectionString !== "string" || !connectionString) {
    throw new TypeError("A PostgreSQL connection string is required");
  }
  // Runtime instances never construct or migrate the pgboss schema. The
  // dedicated migration runner must have completed before either producer or
  // Windows worker is started.
  return new PgBoss({ connectionString, ...PG_BOSS_RUNTIME_OPTIONS });
}
