import test from "node:test";
import assert from "node:assert/strict";
import { createTinderContactBinding, tinderContactReference } from "../tinder-mirror/contact-binding.js";

const target = { deviceId: "11111111-1111-4111-8111-111111111111", conversationId: "22222222-2222-4222-8222-222222222222" };
function db(owner = null) {
  const calls = [];
  const pool = { async connect() { return { release() {}, async query(sql,args) {
    calls.push({ sql,args });
    if (sql.startsWith("SELECT profile")) return { rows: [{ profile: { display_name: "same-name-fixture" } }] };
    if (sql.startsWith("SELECT contact_id")) return { rows: owner == null ? [] : [{ contact_id: owner }] };
    if (sql.startsWith("SELECT id FROM contacts")) return { rows: [{ id: args[0] }] };
    if (sql.startsWith("INSERT INTO contacts")) return { rows: [{ id: 7 }] };
    if (sql.startsWith("INSERT INTO contact_identifiers")) owner = args[0];
    return { rows: [] };
  } }; } };
  return { pool,calls };
}
test("confirmed new Tinder contact has NULL JID, same id on repeated binding and an empty contact-id memory profile", async () => {
  const fixture = db(), service = createTinderContactBinding(fixture);
  const first = await service.bind({ ...target, confirmed: true });
  const again = await service.bind({ ...target, confirmed: true });
  assert.equal(first.contactId,7); assert.equal(again.contactId,7); assert.equal(again.idempotent,true);
  assert.equal(fixture.calls.filter(c => c.sql.startsWith("INSERT INTO contacts")).length,1);
  assert.match(fixture.calls.find(c => c.sql.startsWith("INSERT INTO contacts")).sql,/VALUES \(NULL/);
  assert.equal(fixture.calls.some(c => /WHERE.*(name|display_name)/i.test(c.sql)),false);
  assert.equal(fixture.calls.some(c => c.sql.startsWith("INSERT INTO contact_memory_profiles") && c.args[0] === 7),true);
  assert.doesNotMatch(JSON.stringify(fixture.calls),/@memory|@s.whatsapp|memory_items|memory_events/);
});
test("confirmed existing contact reused, no implicit merge, no generic unconfirmed binding", async () => {
  const fixture = db(7), service = createTinderContactBinding(fixture);
  await assert.rejects(() => service.bind(target),e => e.code === "CONTACT_BINDING_CONFIRMATION_REQUIRED");
  assert.equal(fixture.calls.length,0);
  await assert.rejects(() => service.bind({ ...target, confirmed: true, contactId: 8 }),e => e.code === "CONTACT_BINDING_CONFLICT");
  assert.equal(fixture.calls.some(c => /^(INSERT|UPDATE|DELETE)/.test(c.sql)),false);
  assert.equal((await service.bind({ ...target, confirmed: true, contactId: 7 })).contactId,7);
  assert.equal(tinderContactReference(target).startsWith("mirror:"),true);
});
test("existing-media attachment belongs to the confirmed binding transaction and failure rolls back", async () => {
  const fixture = db();
  const service = createTinderContactBinding({ ...fixture, async attachMedia(client, context) {
    assert.equal(context.contactId,7);
    assert.equal(context.conversationId,target.conversationId);
    assert.equal(typeof client.query,"function");
    assert.equal(fixture.calls.some(c => c.sql === "COMMIT"),false);
    throw new Error("fixture media failure");
  } });
  await assert.rejects(() => service.bind({...target,confirmed:true}),/fixture media failure/);
  assert.equal(fixture.calls.at(-1).sql,"ROLLBACK");
  assert.equal(fixture.calls.some(c => c.sql === "COMMIT"),false);
});
