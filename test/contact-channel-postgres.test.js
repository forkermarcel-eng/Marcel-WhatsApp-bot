import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { migrateContactChannel } from "../services/contact-channel-migration.js";
import { createTinderContactBinding } from "../tinder-mirror/contact-binding.js";

// Actual isolated PostgreSQL engine in memory; no URL, network or Production pool.
test("PostgreSQL accepts multiple NULL JIDs, preserves real JID uniqueness and contact-id associations", async () => {
  const db = new PGlite();
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) };
  try {
    await db.exec(`CREATE TABLE contacts (id SERIAL PRIMARY KEY, whatsapp_jid TEXT UNIQUE NOT NULL,
      display_name TEXT, source_platform TEXT, current_platform TEXT, auto_reply_enabled BOOLEAN,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TABLE contact_memory_profiles (contact_id INTEGER PRIMARY KEY REFERENCES contacts(id));
      CREATE TABLE memory_items (id SERIAL PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id), content TEXT);
      CREATE TABLE memory_events (id SERIAL PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id), content TEXT);
      CREATE TABLE media_asset_links (id SERIAL PRIMARY KEY, owner_reference TEXT);
      CREATE TABLE contact_identifiers (id SERIAL PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id),
        identifier_type TEXT, identifier_value TEXT, normalized_value TEXT, source_platform TEXT,
        is_primary BOOLEAN, human_verified BOOLEAN, created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ);
      CREATE TABLE tinder_conversations (conversation_id UUID PRIMARY KEY, device_id UUID, profile JSONB);
      INSERT INTO contacts (whatsapp_jid,display_name) VALUES ('491234@s.whatsapp.net','WhatsApp fixture');`);
    const original = (await db.query("SELECT * FROM contacts")).rows;
    assert.equal((await migrateContactChannel(pool)).state,"COMMIT_CONFIRMED");
    assert.deepEqual((await db.query("SELECT * FROM contacts")).rows,original);
    await assert.rejects(() => db.query("INSERT INTO contacts (whatsapp_jid) VALUES ('491234@s.whatsapp.net')"), e => e.code === "23505");
    const deviceId = "11111111-1111-4111-8111-111111111111";
    const ids = ["22222222-2222-4222-8222-222222222222","33333333-3333-4333-8333-333333333333"];
    const binder = createTinderContactBinding({ pool });
    const selected = [];
    for (const conversationId of ids) {
      await db.query("INSERT INTO tinder_conversations VALUES ($1,$2,$3::jsonb)",[conversationId,deviceId,JSON.stringify({ display_name: "same name" })]);
      selected.push((await binder.bind({ deviceId,conversationId,confirmed: true })).contactId);
    }
    assert.notEqual(selected[0],selected[1]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM contacts WHERE whatsapp_jid IS NULL")).rows[0].n,2);
    assert.equal((await binder.bind({ deviceId,conversationId: ids[0],confirmed: true })).contactId,selected[0]);
    await db.query("UPDATE contacts SET display_name=$2 WHERE id=$1",[selected[0],"edited fixture"]);
    for (const table of ["memory_items","memory_events"]) await db.query(`INSERT INTO ${table} (contact_id,content) VALUES ($1,'fixture')`,[selected[0]]);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM contact_memory_profiles WHERE contact_id=ANY($1::int[])",[selected])).rows[0].n,2);
    await db.query("INSERT INTO media_asset_links (owner_reference) VALUES ($1)",[String(selected[0])]);
    assert.equal((await migrateContactChannel(pool)).migrated,false);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM contacts")).rows[0].n,3);
    assert.equal((await db.query("SELECT whatsapp_jid FROM contacts WHERE id=$1",[selected[0]])).rows[0].whatsapp_jid,null);
  } finally { await db.close(); }
});
