BEGIN;
CREATE SCHEMA IF NOT EXISTS marcel_world;
CREATE TABLE IF NOT EXISTS marcel_world.news (
 id text PRIMARY KEY, body jsonb NOT NULL, published_at timestamptz NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 CHECK (expires_at <= fetched_at + interval '72 hours')
);
CREATE INDEX IF NOT EXISTS world_news_expiry ON marcel_world.news(expires_at);
CREATE TABLE IF NOT EXISTS marcel_world.sources (
 id text PRIMARY KEY, body jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS marcel_world.cache (
 id text PRIMARY KEY, body jsonb NOT NULL, expires_at timestamptz NOT NULL
);
COMMENT ON SCHEMA marcel_world IS 'Temporary world data only; permanent bookmarks use existing marcel_knowledge collections.';
COMMIT;
