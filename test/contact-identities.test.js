import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createContactIdentityService, normalizeIdentifierValue, normalizeIdentityRow } from "../services/contact-identities.js";

function database(owner = null) {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (/SELECT id, contact_id, identifier_type/.test(sql) && /normalized_value/.test(sql)) return { rows: owner ? [owner] : [] };
      if (/INSERT INTO contact_identifiers/.test(sql)) return { rows: [{ id: 8, contact_id: values[0], identifier_type: values[1], identifier_value: values[2], normalized_value: values[3], human_verified: true }] };
      if (/DELETE FROM contact_identifiers/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    release() { calls.push({ sql: "RELEASE" }); }
  };
  return { pool: { connect: async () => client, query: (...args) => client.query(...args) }, calls };
}

test("channel identifiers normalize to the existing neutral display contract", () => {
  assert.equal(normalizeIdentifierValue("instagram", "@Sandry.Name"), "Sandry.Name");
  assert.throws(() => normalizeIdentifierValue("x", "bad handle"));
  const identity = normalizeIdentityRow({ id: 1, contact_id: 5, identifier_type: "instagram_username", identifier_value: "sandry", human_verified: true });
  assert.equal(identity.channel, "instagram");
  assert.equal(identity.displayValue, "@sandry");
  assert.equal(identity.humanVerified, true);
});

test("manual identity insert remains on the selected contact and is human verified", async () => {
  const db = database();
  const result = await createContactIdentityService(db.pool).upsertContactIdentity(5, { channel: "instagram", value: "@sandry" });
  assert.equal(result.idempotent, false);
  assert.equal(result.identity.contactId, 5);
  assert.equal(result.identity.humanVerified, true);
  assert.ok(db.calls.some(call => /VALUES \(\$1,\$2,\$3,\$4,\$5,FALSE,TRUE/.test(call.sql)));
});

test("same identifier on the same contact is idempotent", async () => {
  const db = database({ id: 3, contact_id: 5, identifier_type: "x_username", identifier_value: "sandry", human_verified: true });
  const result = await createContactIdentityService(db.pool).upsertContactIdentity(5, { channel: "x", value: "sandry" });
  assert.equal(result.idempotent, true);
  assert.equal(db.calls.some(call => /INSERT INTO/.test(call.sql)), false);
});

test("same identifier on another contact conflicts without mutation", async () => {
  const db = database({ id: 3, contact_id: 9, identifier_type: "instagram_username", identifier_value: "sandry", human_verified: true });
  await assert.rejects(
    createContactIdentityService(db.pool).upsertContactIdentity(5, { channel: "instagram", value: "sandry" }),
    error => error.statusCode === 409
  );
  assert.equal(db.calls.some(call => /INSERT INTO/.test(call.sql)), false);
  assert.ok(db.calls.some(call => call.sql === "ROLLBACK"));
});

test("contact identity routes stay orchestration-only and use the existing proxy", () => {
  const backend = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const proxy = readFileSync(new URL("../api/dashboard/contacts.js", import.meta.url), "utf8");
  assert.match(backend, /createContactIdentityService\(pool\)/);
  assert.match(backend, /upsertContactIdentity\(contactId, req\.body \|\| \{\}\)/);
  assert.match(backend, /removeContactIdentity\(contactId, req\.body\?\.channel\)/);
  assert.doesNotMatch(backend, /instagram_username|x_username|tinder_profile/);
  assert.match(proxy, /resource === "identities"/);
  assert.match(proxy, /\+ \(resource === "identities" \? "\/identities" : ""\)/);
});
