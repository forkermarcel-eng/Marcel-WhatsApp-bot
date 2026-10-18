-- PREPARED ONLY. Not executed by startup or by the local import command.
-- Production apply requires a verified backup and separately scoped approval.
CREATE SCHEMA IF NOT EXISTS marcel_knowledge;
CREATE TABLE IF NOT EXISTS marcel_knowledge.documents(id TEXT PRIMARY KEY, body JSONB NOT NULL CHECK(jsonb_typeof(body)='object'));
CREATE TABLE IF NOT EXISTS marcel_knowledge.entries(id TEXT PRIMARY KEY, body JSONB NOT NULL CHECK(jsonb_typeof(body)='object'));
CREATE TABLE IF NOT EXISTS marcel_knowledge.evidence(id TEXT PRIMARY KEY, body JSONB NOT NULL CHECK(jsonb_typeof(body)='object'));
CREATE TABLE IF NOT EXISTS marcel_knowledge.relations(id TEXT PRIMARY KEY, body JSONB NOT NULL CHECK(jsonb_typeof(body)='object'));
CREATE TABLE IF NOT EXISTS marcel_knowledge.reviews(id TEXT PRIMARY KEY, body JSONB NOT NULL CHECK(jsonb_typeof(body)='object'));
CREATE TABLE IF NOT EXISTS marcel_knowledge.meta(id TEXT PRIMARY KEY, body JSONB NOT NULL CHECK(jsonb_typeof(body)='object'));
