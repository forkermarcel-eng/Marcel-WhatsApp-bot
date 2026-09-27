import { TinderMirrorError } from "./conversation.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function tinderContactReference({ deviceId, conversationId, matchId }) {
  const id=matchId ?? conversationId;
  if (!UUID.test(deviceId) || !UUID.test(id) || (matchId && conversationId)) throw new TinderMirrorError("INVALID_CONTACT_BINDING", "Invalid mirror reference");
  // Explicitly an internal mirror reference, never advertised as a native Tinder ID.
  return `${matchId ? "mirror-match" : "mirror"}:${deviceId.toLowerCase()}:${id.toLowerCase()}`;
}

export function createTinderContactBinding({ pool, attachMedia = null }) {
  async function bind({ deviceId, conversationId, matchId, contactId = null, confirmed = false }) {
    if (confirmed !== true) throw new TinderMirrorError("CONTACT_BINDING_CONFIRMATION_REQUIRED", "Explicit contact selection required", 409);
    const reference = tinderContactReference({ deviceId, conversationId, matchId });
    if (contactId !== null && (!Number.isSafeInteger(contactId) || contactId < 1)) throw new TinderMirrorError("INVALID_CONTACT_BINDING", "Invalid contact id");
    const client = await pool.connect();
    let committing = false, discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`tinder-contact:${reference}`]);
      const source = matchId
        ? await client.query(`SELECT profile FROM tinder_matches WHERE match_id=$1 AND device_id=$2 FOR SHARE`,[matchId,deviceId])
        : await client.query(`SELECT profile FROM tinder_conversations
        WHERE conversation_id=$1 AND device_id=$2 FOR SHARE`, [conversationId, deviceId]);
      if (source.rows.length !== 1) throw new TinderMirrorError("TINDER_CONVERSATION_NOT_FOUND", "Conversation not found", 404);
      const binding = await client.query(`SELECT contact_id FROM contact_identifiers
        WHERE identifier_type='tinder_profile' AND normalized_value=$1 FOR UPDATE`, [reference]);
      if (binding.rows.length > 1 || (binding.rows[0] && contactId !== null && Number(binding.rows[0].contact_id) !== contactId)) {
        throw new TinderMirrorError("CONTACT_BINDING_CONFLICT", "No merge or reassignment performed", 409);
      }
      let selected = binding.rows[0]?.contact_id ?? contactId;
      const existing = selected == null ? null : await client.query("SELECT id FROM contacts WHERE id=$1 FOR UPDATE", [selected]);
      if (selected != null && existing.rows.length !== 1) throw new TinderMirrorError("CONTACT_NOT_FOUND", "Contact not found", 404);
      if (selected == null) {
        const name = source.rows[0].profile?.display_name || source.rows[0].profile?.name || null;
        const created = await client.query(`INSERT INTO contacts
          (whatsapp_jid, display_name, source_platform, current_platform, auto_reply_enabled, created_at, updated_at)
          VALUES (NULL,$1,'tinder','tinder',FALSE,NOW(),NOW()) RETURNING id`, [name]);
        selected = created.rows[0].id;
      }
      if (!binding.rows.length) await client.query(`INSERT INTO contact_identifiers
        (contact_id,identifier_type,identifier_value,normalized_value,source_platform,is_primary,human_verified,created_at,updated_at)
        VALUES ($1,'tinder_profile',$2,$2,'tinder',FALSE,TRUE,NOW(),NOW())`, [selected,reference]);
      await client.query(`INSERT INTO contact_memory_profiles (contact_id) VALUES ($1)
        ON CONFLICT (contact_id) DO NOTHING`, [selected]);
      if (attachMedia) await attachMedia(client, { contactId: Number(selected), ...(matchId?{matchId}:{conversationId}) });
      committing = true;
      await client.query("COMMIT");
      return { contactId: Number(selected), ...(matchId?{matchId}:{conversationId}), reference, profile: source.rows[0].profile,
        idempotent: Boolean(binding.rows.length) };
    } catch (error) {
      if (committing) { discard = true; throw new Error("CONTACT_BINDING_COMMIT_OUTCOME_UNKNOWN", { cause: error }); }
      try { await client.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally { client.release(discard); }
  }
  return Object.freeze({ bind });
}
