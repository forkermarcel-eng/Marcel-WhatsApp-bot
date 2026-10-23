-- Phase 6 additive extension. LOCAL TEST ONLY; not registered with startup.
BEGIN;
CREATE SCHEMA IF NOT EXISTS marcel_market_analysis;
CREATE TABLE IF NOT EXISTS marcel_market_analysis.alert_rules (
 owner_id text NOT NULL,
 id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 created_at timestamptz NOT NULL,
 updated_at timestamptz NOT NULL,
 PRIMARY KEY(owner_id,id)
);
CREATE TABLE IF NOT EXISTS marcel_market_analysis.alert_states (
 owner_id text NOT NULL,
 rule_id uuid NOT NULL,
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 PRIMARY KEY(owner_id,rule_id),
 FOREIGN KEY(owner_id,rule_id) REFERENCES marcel_market_analysis.alert_rules(owner_id,id)
);
CREATE TABLE IF NOT EXISTS marcel_market_analysis.alert_history (
 sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 owner_id text NOT NULL,
 id text NOT NULL,
 rule_id uuid NOT NULL,
 triggered_at timestamptz NOT NULL,
 data_at timestamptz NOT NULL,
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 PRIMARY KEY(owner_id,id),
 FOREIGN KEY(owner_id,rule_id) REFERENCES marcel_market_analysis.alert_rules(owner_id,id)
);
CREATE INDEX IF NOT EXISTS ma_alert_history_recent ON marcel_market_analysis.alert_history(owner_id,rule_id,triggered_at DESC);
CREATE INDEX IF NOT EXISTS ma_alert_history_cursor ON marcel_market_analysis.alert_history(owner_id,rule_id,sequence DESC);
CREATE TABLE IF NOT EXISTS marcel_market_analysis.event_studies (
 owner_id text NOT NULL,
 id text NOT NULL,
 created_at timestamptz NOT NULL,
 body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'),
 PRIMARY KEY(owner_id,id)
);
COMMIT;
