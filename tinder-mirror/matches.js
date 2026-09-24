import crypto from "node:crypto";
import { TinderMirrorError, normalizeTinderProfile } from "./conversation.js";

/*
 * A Tinder Match is deliberately separate from a Conversation.  This module
 * stores only the visible Match-tile product state and an optional already
 * verified Conversation relation.  It never derives a relation from a name,
 * image, carousel position, or any heuristic.
 */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TinderMirrorError("INVALID_TINDER_MATCH_PAYLOAD", `${field} must be a non-negative integer`);
  }
  return value;
}

function optionalUuid(value, field) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UUID_V4.test(value)) {
    throw new TinderMirrorError("INVALID_TINDER_MATCH_PAYLOAD", `${field} is invalid`);
  }
  return value;
}

function asTile(value) {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  return plainObject(value) ? value : {};
}

function publicMatch(row) {
  return Object.freeze({
    id: row.match_id,
    device_id: row.device_id,
    conversation_id: row.conversation_id ?? null,
    tile: asTile(row.tile),
    carousel_position: Number(row.carousel_position),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
  });
}

function isSchemaMissing(error) {
  return error?.code === "42P01" || error?.code === "42703";
}

function mapDatabaseError(error) {
  if (error instanceof TinderMirrorError) return error;
  if (isSchemaMissing(error)) {
    return new TinderMirrorError(
      "TINDER_MATCH_SCHEMA_UNAVAILABLE",
      "Tinder Match schema is not available",
      503
    );
  }
  return error;
}

async function assertExistingDevice(client, deviceId, { lock = false } = {}) {
  const result = await client.query(
    `SELECT device_id FROM device_bridge_devices WHERE device_id=$1${lock ? " FOR UPDATE" : ""}`,
    [deviceId]
  );
  if (!result.rows[0]) {
    throw new TinderMirrorError("TINDER_DEVICE_NOT_FOUND", "The selected device is not enrolled", 404);
  }
}

async function assertVerifiedConversationLink(client, deviceId, conversationId) {
  if (!conversationId) return;
  const result = await client.query(
    `SELECT conversation_id FROM tinder_conversations
      WHERE conversation_id=$1 AND device_id=$2
      FOR KEY SHARE`,
    [conversationId, deviceId]
  );
  if (!result.rows[0]) {
    throw new TinderMirrorError(
      "TINDER_MATCH_CONVERSATION_UNVERIFIED",
      "The requested Tinder Conversation is not verified for this device",
      409
    );
  }
}

export function normalizeTinderMatchPayload(value) {
  if (!plainObject(value)) {
    throw new TinderMirrorError("INVALID_TINDER_MATCH_PAYLOAD", "payload must be an object");
  }
  const allowed = new Set(["tile", "carousel_position", "conversation_id"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new TinderMirrorError("INVALID_TINDER_MATCH_PAYLOAD", "payload contains unsupported fields");
  }
  return Object.freeze({
    // Reuse the ordinary visible-profile product shape.  It is tile state,
    // not a Match identity and not a full Profile crawl.
    tile: normalizeTinderProfile(value.tile),
    carousel_position: requiredNonNegativeInteger(value.carousel_position, "carousel_position"),
    conversation_id: optionalUuid(value.conversation_id, "conversation_id")
  });
}

export function createTinderMatchMirror({ pool, now = () => new Date(), idFactory = crypto.randomUUID }) {
  if (!pool || typeof pool.connect !== "function") throw new TypeError("A PostgreSQL pool is required");

  async function sync({ deviceId, payload }) {
    if (!UUID_V4.test(deviceId || "")) {
      throw new TinderMirrorError("INVALID_TINDER_MATCH_PAYLOAD", "device id is invalid");
    }
    const match = normalizeTinderMatchPayload(payload);
    const timestamp = now();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // The ordinary device row serializes one device's initial Match import.
      // It is not a heartbeat, permit, or readiness gate.
      await assertExistingDevice(client, deviceId, { lock: true });
      await assertVerifiedConversationLink(client, deviceId, match.conversation_id);

      if (match.conversation_id) {
        const linked = await client.query(
          `SELECT match_id, device_id, conversation_id, tile, carousel_position, created_at, updated_at
             FROM tinder_matches
            WHERE device_id=$1 AND conversation_id=$2
            FOR UPDATE`,
          [deviceId, match.conversation_id]
        );
        if (linked.rows[0]) {
          await client.query(
            `UPDATE tinder_matches
                SET tile=$2::jsonb, carousel_position=$3, updated_at=$4
              WHERE match_id=$1`,
            [linked.rows[0].match_id, JSON.stringify(match.tile), match.carousel_position, timestamp]
          );
          await client.query("COMMIT");
          return Object.freeze({
            created: false,
            match: publicMatch({
              ...linked.rows[0],
              tile: match.tile,
              carousel_position: match.carousel_position,
              updated_at: timestamp
            })
          });
        }
      }

      const matchId = idFactory();
      const result = await client.query(
        `INSERT INTO tinder_matches
           (match_id, device_id, conversation_id, tile, carousel_position, created_at, updated_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$6)
         RETURNING match_id, device_id, conversation_id, tile, carousel_position, created_at, updated_at`,
        [matchId, deviceId, match.conversation_id, JSON.stringify(match.tile), match.carousel_position, timestamp]
      );
      await client.query("COMMIT");
      return Object.freeze({ created: true, match: publicMatch(result.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async function list() {
    try {
      const result = await pool.query(
        `SELECT match_id, device_id, conversation_id, tile, carousel_position, created_at, updated_at
           FROM tinder_matches
          ORDER BY carousel_position ASC, match_id ASC`
      );
      return result.rows.map(publicMatch);
    } catch (error) {
      throw mapDatabaseError(error);
    }
  }

  return Object.freeze({ sync, list });
}
