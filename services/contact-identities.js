const CHANNEL_TYPES = Object.freeze({
  instagram: "instagram_username",
  x: "x_username",
  tinder: "tinder_profile"
});

function identityError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeChannel(value) {
  const channel = String(value || "").trim().toLowerCase();
  if (!CHANNEL_TYPES[channel]) throw identityError("Nicht unterstützter Kanal.");
  return channel;
}

function normalizeIdentifierValue(channel, value) {
  const clean = String(value || "").trim().replace(/^@/, "");
  if (!clean || clean.length > 160) throw identityError("Bitte einen gültigen Identifier eingeben.");
  if (["instagram", "x"].includes(channel) && !/^[a-zA-Z0-9._-]{1,80}$/.test(clean)) {
    throw identityError("Dieser Username enthält ungültige Zeichen.");
  }
  if (/\s/.test(clean)) throw identityError("Der Identifier darf keine Leerzeichen enthalten.");
  return clean;
}

function normalizeIdentityRow(row) {
  const channel = Object.entries(CHANNEL_TYPES).find(([, type]) => type === row.identifier_type)?.[0]
    || (row.identifier_type === "whatsapp_username" || row.identifier_type === "whatsapp_jid" || row.identifier_type === "phone" ? "whatsapp" : null);
  return {
    id: row.id,
    contactId: row.contact_id,
    channel,
    type: row.identifier_type,
    value: row.identifier_value,
    displayValue: ["instagram", "x"].includes(channel) ? `@${row.identifier_value}` : row.identifier_value,
    humanVerified: row.human_verified === true,
    primary: row.is_primary === true,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function createContactIdentityService(pool) {
  async function listContactIdentities(contactId) {
    const result = await pool.query(
      `SELECT id, contact_id, identifier_type, identifier_value,
              is_primary, human_verified, created_at, updated_at
       FROM contact_identifiers
       WHERE contact_id = $1
         AND identifier_type IN ('phone','whatsapp_jid','whatsapp_username','instagram_username','x_username','tinder_profile')
       ORDER BY is_primary DESC, id ASC`,
      [contactId]
    );
    return result.rows.map(normalizeIdentityRow).filter(item => item.channel);
  }

  async function listContactIdentityMap(contactIds) {
    if (!contactIds.length) return new Map();
    const result = await pool.query(
      `SELECT id, contact_id, identifier_type, identifier_value,
              is_primary, human_verified, created_at, updated_at
       FROM contact_identifiers
       WHERE contact_id = ANY($1::int[])
         AND identifier_type IN ('phone','whatsapp_jid','whatsapp_username','instagram_username','x_username','tinder_profile')
       ORDER BY is_primary DESC, id ASC`,
      [contactIds]
    );
    const map = new Map();
    for (const row of result.rows) {
      const item = normalizeIdentityRow(row);
      if (!item.channel) continue;
      map.set(String(row.contact_id), [...(map.get(String(row.contact_id)) || []), item]);
    }
    return map;
  }

  async function upsertContactIdentity(contactId, input) {
    const channel = normalizeChannel(input?.channel);
    const value = normalizeIdentifierValue(channel, input?.value);
    const type = CHANNEL_TYPES[channel];
    const normalized = value.toLowerCase();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`contact:${contactId}:${type}`]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${type}:${normalized}`]);
      const owner = await client.query(
        `SELECT id, contact_id, identifier_type, identifier_value,
                is_primary, human_verified, created_at, updated_at
         FROM contact_identifiers
         WHERE identifier_type = $1 AND normalized_value = $2 LIMIT 1`,
        [type, normalized]
      );
      if (owner.rows[0] && Number(owner.rows[0].contact_id) !== Number(contactId)) {
        throw identityError("Dieser Identifier ist bereits einem anderen Kontakt zugeordnet.", 409);
      }
      if (owner.rows[0]) {
        await client.query("COMMIT");
        return { identity: normalizeIdentityRow(owner.rows[0]), idempotent: true };
      }
      await client.query(`DELETE FROM contact_identifiers WHERE contact_id = $1 AND identifier_type = $2`, [contactId, type]);
      const inserted = await client.query(
        `INSERT INTO contact_identifiers
          (contact_id, identifier_type, identifier_value, normalized_value, source_platform, is_primary, human_verified, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,FALSE,TRUE,NOW(),NOW()) RETURNING *`,
        [contactId, type, value, normalized, channel]
      );
      await client.query("COMMIT");
      return { identity: normalizeIdentityRow(inserted.rows[0]), idempotent: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function removeContactIdentity(contactId, channelValue) {
    const channel = normalizeChannel(channelValue);
    const result = await pool.query(
      `DELETE FROM contact_identifiers WHERE contact_id = $1 AND identifier_type = $2 RETURNING id`,
      [contactId, CHANNEL_TYPES[channel]]
    );
    return { removed: result.rowCount > 0 };
  }

  return Object.freeze({ listContactIdentities, listContactIdentityMap, upsertContactIdentity, removeContactIdentity });
}

export { createContactIdentityService, normalizeIdentifierValue, normalizeIdentityRow };
