import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { CONTACT_CHANNEL_DDL, migrateContactChannel, preflightContactChannel } from "../services/contact-channel-migration.js";
import { requireContactWhatsAppJid } from "../services/contact-channel.js";
import { attachmentOwners } from "../shared-media/attachment.js";

function database({ nullable = false, failure = null } = {}) {
  const statements = [];
  let after = false;
  return { statements, pool: { async connect() { return { release() {}, async query(sql) {
    statements.push(sql);
    if (sql === CONTACT_CHANNEL_DDL) { if (failure === "ddl") throw Error("ddl"); nullable = true; after = true; }
    if (sql === "COMMIT" && failure === "commit") throw Error("connection lost");
    if (sql.includes("information_schema.columns")) return { rows: [{ data_type: "text", is_nullable: nullable ? "YES" : "NO" }] };
    if (sql.includes("pg_index")) return { rows: failure === "unique" ? [] : [{ name: "contacts_whatsapp_jid_key", definition: "CREATE UNIQUE INDEX contacts_whatsapp_jid_key ON contacts USING btree (whatsapp_jid)" }] };
    if (sql.includes("row_to_json")) return { rows: [{ total: 3, with_jid: 1, digest: after && failure === "rows" ? "changed" : "unchanged" }] };
    return { rows: [] };
  } }; } } };
}

test("contacts migration only drops JID NOT NULL, preserves rows and UNIQUE, repeated apply is no-op", async () => {
  for (const nullable of [false,true]) {
    const db = database({ nullable });
    const result = await migrateContactChannel(db.pool);
    assert.equal(result.state,"COMMIT_CONFIRMED");
    assert.equal(result.migrated,!nullable);
    assert.equal(db.statements.filter(s => s === CONTACT_CHANNEL_DDL).length,nullable ? 0 : 1);
    assert.equal(db.statements.some(s => /^(INSERT|UPDATE|DELETE|TRUNCATE|DROP TABLE)/i.test(s)),false);
    assert.equal(result.withJid,1);
  }
});
test("contacts migration aborts on UNIQUE drift, DDL or changed data; ambiguous commit is never retried", async () => {
  for (const failure of ["unique","ddl","rows","commit"]) {
    const db = database({ failure });
    await assert.rejects(() => migrateContactChannel(db.pool));
    assert.equal(db.statements.includes("ROLLBACK"),failure !== "commit");
    assert.equal(db.statements.filter(s => s === "COMMIT").length,failure === "commit" ? 1 : 0);
  }
});
test("contacts preflight is read-only and does not apply DDL", async () => {
  const db = database();
  assert.equal((await preflightContactChannel(db.pool)).state,"ELIGIBLE_FOR_MIGRATION");
  assert.equal(db.statements[0],"BEGIN READ ONLY");
  assert.equal(db.statements.includes(CONTACT_CHANNEL_DDL),false);
});
test("real WhatsApp JID unchanged; missing route rejected without inventing an identifier", () => {
  assert.equal(requireContactWhatsAppJid({ whatsapp_jid: "491234@s.whatsapp.net" }),"491234@s.whatsapp.net");
  assert.throws(() => requireContactWhatsAppJid({ id: 7, whatsapp_jid: null }), { code: "CONTACT_HAS_NO_WHATSAPP_IDENTIFIER" });
});

const source = readFileSync(new URL("../index.js",import.meta.url),"utf8").replace(/\r\n/g,"\n");
function sourceFunction(name, sandbox = {}) {
  const pattern = new RegExp(`(?:async )?function ${name}\\(`);
  const start = source.search(pattern);
  assert.notEqual(start,-1);
  const end = source.indexOf("\n}\n",start)+3;
  return vm.runInNewContext(`(${source.slice(start,end)})`,sandbox);
}
test("NULL-JID contact detail returns an empty WhatsApp history/count, not another person's messages", async () => {
  const pool = { query() { throw Error("must not query WhatsApp for a NULL route"); } };
  assert.equal((await sourceFunction("getDashboardConversationHistory",{ pool })(null)).length,0);
  assert.equal(await sourceFunction("getDashboardMessageCount",{ pool })(null),0);
  assert.equal(sourceFunction("isTestJid")(null),false);
  assert.equal(sourceFunction("isProfileJid")(null),false);
});
test("neutral CRUD/list schema and contact-id memory/media contracts do not require or fabricate JID", () => {
  assert.match(source,/whatsapp_jid TEXT UNIQUE,/);
  const create = source.slice(source.indexOf('"/dashboard-api/contacts",\nasync',source.indexOf("DASHBOARD KONTAKT ANLEGEN")),source.indexOf("DASHBOARD KONTAKT BEARBEITEN"));
  assert.doesNotMatch(create,/createProfileJid|@memory\.local|@s\.whatsapp\.net/);
  assert.match(create,/null,\n\s*name,\n\s*identityKey/);
  assert.match(source,/c\.whatsapp_jid IS NULL/);
  assert.match(source,/if \(!contact\.whatsapp_jid\) continue;/);
  for (const method of ["getContactMemoryProfile","getRelevantMemoryItems","getAllMemoryEvents","listContactMedia"]) {
    assert.match(source,new RegExp(`${method}\\(\\s*contact\\.id`));
  }
  const links = attachmentOwners({ contactId: 7, channel: "tinder", sourceType: "profile", profileReference: "existing-mirror-reference" });
  assert.equal(links.some(l => l.ownerChannel === "contacts" && l.ownerReference === "7"),true);
  assert.doesNotMatch(JSON.stringify(links),/whatsapp|jid/i);
});
test("Contacts Tinder filter displays a NULL-JID central contact without a WhatsApp channel", () => {
  const html = readFileSync(new URL("../Kontakte/index.html",import.meta.url),"utf8");
  const expression = html.slice(html.indexOf("const channels=")+15,html.indexOf(";const last="));
  const channels = vm.runInNewContext(`(${expression})`);
  assert.deepEqual([...channels({ id: 7, jid: null, sourcePlatform: "tinder", identities: [{ channel: "tinder" }] })],["tinder"]);
});
