-- PREPARED ONLY. No startup registration; production execution is NOT authorised.
BEGIN;
CREATE SCHEMA IF NOT EXISTS marcel_market_analysis;
CREATE TABLE IF NOT EXISTS marcel_market_analysis.sources (
 id text PRIMARY KEY,
 state jsonb NOT NULL DEFAULT '{}',
 last_success_at timestamptz,
 last_error_at timestamptz,
 error_code text,
 next_allowed_at timestamptz
);
CREATE TABLE IF NOT EXISTS marcel_market_analysis.records (
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 source_id text NOT NULL REFERENCES marcel_market_analysis.sources(id),
 kind text NOT NULL CHECK (kind IN ('instrument','mapping','bar','news','macro','calendar')),
 entity_id text NOT NULL,
 version_id text NOT NULL,
 ingestion_id uuid NOT NULL,
 body jsonb NOT NULL CHECK (jsonb_typeof(body)='object'),
 published_at timestamptz,
 fetched_at timestamptz NOT NULL,
 processed_at timestamptz NOT NULL,
 stored_at timestamptz NOT NULL,
 expires_at timestamptz,
 PRIMARY KEY(source_id,kind,entity_id,version_id),
 CHECK(fetched_at <= processed_at AND processed_at <= stored_at)
);
CREATE INDEX IF NOT EXISTS ma_records_asof ON marcel_market_analysis.records(source_id,kind,stored_at,entity_id);
CREATE INDEX IF NOT EXISTS ma_records_ingestion ON marcel_market_analysis.records(ingestion_id);
CREATE INDEX IF NOT EXISTS ma_records_model_version ON marcel_market_analysis.records(source_id,kind,(body->>'versionId'));
CREATE INDEX IF NOT EXISTS ma_records_expiry ON marcel_market_analysis.records(expires_at) WHERE expires_at IS NOT NULL;
-- Hashes/times only: no article text/URL; prevents renewed TTL after restarts.
CREATE TABLE IF NOT EXISTS marcel_market_analysis.news_seen (
 source_id text NOT NULL REFERENCES marcel_market_analysis.sources(id),
 article_hash text NOT NULL,
 first_seen_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 PRIMARY KEY(source_id,article_hash)
);
CREATE TABLE IF NOT EXISTS marcel_market_analysis.jobs (
 id uuid PRIMARY KEY,
 source_id text NOT NULL REFERENCES marcel_market_analysis.sources(id),
 type text NOT NULL CHECK(type IN ('news-sync','calendar-sync','macro-sync','catalog-sync','history-import','source-check')),
 idempotency_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','running','retry','succeeded','failed','blocked','cancelled')),
 created_at timestamptz NOT NULL,
 due_at timestamptz NOT NULL,
 started_at timestamptz,
 ended_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 max_attempts integer NOT NULL CHECK(max_attempts BETWEEN 1 AND 5),
 interval_ms integer NOT NULL CHECK(interval_ms BETWEEN 60000 AND 604800000),
 lease_token uuid,
 lease_until timestamptz,
 error_code text,
 UNIQUE(source_id,type,idempotency_key),
 CHECK((status='running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
-- Additive, local preparation: durable API input/owner/result in the existing queue.
ALTER TABLE marcel_market_analysis.jobs ADD COLUMN IF NOT EXISTS api jsonb
 CHECK(api IS NULL OR (jsonb_typeof(api)='object' AND octet_length(api::text)<=16000000));
CREATE INDEX IF NOT EXISTS ma_jobs_api_owner ON marcel_market_analysis.jobs((api->>'owner')) WHERE api IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ma_one_running_source ON marcel_market_analysis.jobs(source_id) WHERE status='running';
CREATE INDEX IF NOT EXISTS ma_jobs_due ON marcel_market_analysis.jobs(due_at) WHERE status IN ('queued','retry');
CREATE TABLE IF NOT EXISTS marcel_market_analysis.job_log (
 sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES marcel_market_analysis.jobs(id),
 at timestamptz NOT NULL,
 status text NOT NULL,
 attempt integer NOT NULL,
 error_code text
);
COMMIT;
