-- Additive isolation: ONLY marcel_trading. No access to public/Brain/Tinder tables.
-- Run explicitly with node trading-core/migrate.js --apply (default is a dry run).
CREATE SCHEMA IF NOT EXISTS marcel_trading;
CREATE TABLE IF NOT EXISTS marcel_trading.schema_versions(version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.plans(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.snapshots(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.executions(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.reviews(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.attachments(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.playbooks(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.context(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.observations(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.events(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.news(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.settings(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.drawings(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.estimates(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.proposals(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.audit(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.commands(id text PRIMARY KEY, body jsonb NOT NULL CHECK(jsonb_typeof(body)='object'), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS marcel_trading.candles (
 contract text NOT NULL, source text NOT NULL, resolution integer NOT NULL CHECK(resolution>0),
 at timestamptz NOT NULL, open numeric NOT NULL, high numeric NOT NULL, low numeric NOT NULL, close numeric NOT NULL,
 volume numeric NOT NULL DEFAULT 0 CHECK(volume>=0), received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(contract,source,resolution,at), CHECK(low>0 AND high>=low AND high>=open AND high>=close AND low<=open AND low<=close)
);
CREATE INDEX IF NOT EXISTS trading_execution_plan_idx ON marcel_trading.executions((body->>'planId'));
CREATE INDEX IF NOT EXISTS trading_review_plan_idx ON marcel_trading.reviews((body->>'planId'));
CREATE INDEX IF NOT EXISTS trading_snapshot_plan_idx ON marcel_trading.snapshots((body->>'planId'));
CREATE INDEX IF NOT EXISTS trading_candle_recent_idx ON marcel_trading.candles(contract,at DESC);
-- Append-only decision truth, independent of later knowledge/reviews.
CREATE OR REPLACE FUNCTION marcel_trading.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable trading record: %',TG_TABLE_NAME; END; $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['plans','snapshots','executions','reviews','context','audit','commands'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trading_append_only' AND tgrelid=format('marcel_trading.%I',t)::regclass) THEN
   EXECUTE format('CREATE TRIGGER trading_append_only BEFORE UPDATE OR DELETE ON marcel_trading.%I FOR EACH ROW EXECUTE FUNCTION marcel_trading.reject_mutation()',t);
  END IF;
 END LOOP;
END $$;
