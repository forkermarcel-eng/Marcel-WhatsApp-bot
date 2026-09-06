import crypto from "node:crypto";
import {
  TINDER_IDENTIFIER_TYPE,
  TINDER_IDENTITY_RESOLUTION_STATUS,
  captureSafetyStatus,
  normalizeTinderIdentifier
} from "./tinder-identity-resolution.js";
import {
  TINDER_CAPTURE_MAPPING_STATUS,
  TINDER_CAPTURE_REVIEW_STATUS
} from "./tinder-capture-store.js";

const TINDER_MAPPING_ACTION = Object.freeze({
  MAP_EXISTING: "MAP_EXISTING",
  CREATE_NEW: "CREATE_NEW"
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class TinderHumanMappingError extends Error {
  constructor(message, code = "INVALID_TINDER_MAPPING", statusCode = 400) {
    super(message);
    this.name = "TinderHumanMappingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function numberId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function rowContactId(row) {
  return numberId(row?.contactId ?? row?.contact_id);
}

function rowIdentifierId(row) {
  return numberId(row?.identifierId ?? row?.identifier_id ?? row?.id);
}

function rowNormalizedValue(row) {
  return String(row?.normalizedValue ?? row?.normalized_value ?? "").trim();
}

function rowHumanVerified(row) {
  return row?.humanVerified ?? row?.human_verified ?? false;
}

function captureMappingStatus(capture) {
  return String(capture?.mappingStatus ?? capture?.mapping_status ?? "").trim().toUpperCase();
}

function captureReviewStatus(capture) {
  return String(capture?.humanReviewStatus ?? capture?.human_review_status ?? "").trim().toUpperCase();
}

function captureResolvedContactId(capture) {
  return numberId(capture?.resolvedContactId ?? capture?.resolved_contact_id);
}

function normalizeCaptureId(value) {
  const captureId = String(value || "").trim();
  if (!UUID_V4.test(captureId)) {
    throw new TinderHumanMappingError("Die Capture-ID ist ungültig.", "INVALID_CAPTURE_ID");
  }
  return captureId;
}

function normalizeAction(value) {
  const action = String(value || "").trim().toUpperCase();
  if (!Object.hasOwn(TINDER_MAPPING_ACTION, action)) {
    throw new TinderHumanMappingError("Die Mapping-Aktion ist ungültig.", "INVALID_MAPPING_ACTION");
  }
  return action;
}

function normalizeActor(value) {
  const actor = String(value || "marcel_dashboard").trim();
  if (!actor || actor.length > 80) {
    throw new TinderHumanMappingError("Der Mapping-Akteur ist ungültig.", "INVALID_MAPPING_ACTOR");
  }
  return actor;
}

function normalizeNewContactName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 160) {
    throw new TinderHumanMappingError("Ein neuer Tinder-Kontakt braucht einen bestätigten Namen.", "INVALID_NEW_CONTACT_NAME");
  }
  return name;
}

function normalizeGeneratedIdentityKey(value) {
  const identityKey = String(value || "").trim();
  if (!/^[a-z0-9_-]{8,160}$/i.test(identityKey)) {
    throw new TinderHumanMappingError(
      "Der technische Tinder-Identitätsschlüssel ist ungültig.",
      "INVALID_GENERATED_IDENTITY_KEY"
    );
  }
  return identityKey;
}

function conflictResult(code, details = {}) {
  return Object.freeze({
    status: TINDER_IDENTITY_RESOLUTION_STATUS.CONFLICT,
    conflictCode: code,
    ...details
  });
}

function needsHumanMapping(code) {
  return Object.freeze({
    status: TINDER_IDENTITY_RESOLUTION_STATUS.NEEDS_HUMAN_MAPPING,
    code
  });
}

function isConfirmedResolvedCapture(capture) {
  return (
    captureMappingStatus(capture) === TINDER_CAPTURE_MAPPING_STATUS.RESOLVED
    && captureReviewStatus(capture) === TINDER_CAPTURE_REVIEW_STATUS.CONFIRMED
    && captureResolvedContactId(capture) !== null
  );
}

function identifierConflictRows(rows, requestedNormalizedValue, selectedContactId) {
  const values = Array.isArray(rows) ? rows : [];
  const foreignOwner = values.find((row) => rowContactId(row) !== selectedContactId);
  if (foreignOwner) return "TINDER_IDENTIFIER_OWNED_BY_ANOTHER_CONTACT";

  const differentValue = values.find((row) => rowNormalizedValue(row) !== requestedNormalizedValue);
  if (differentValue) return "SELECTED_CONTACT_HAS_DIFFERENT_TINDER_IDENTIFIER";
  return null;
}

function mappingAudit({ capture, action, actor, newMappingStatus, newContactId, identifierId, code = null }) {
  return Object.freeze({
    captureId: String(capture.captureId ?? capture.capture_id),
    action,
    actor,
    source: "manual_dashboard",
    oldMappingStatus: captureMappingStatus(capture) || null,
    newMappingStatus,
    oldContactId: captureResolvedContactId(capture),
    newContactId,
    identifierId,
    details: Object.freeze({
      identifierType: TINDER_IDENTIFIER_TYPE,
      ...(code ? { code } : {})
    })
  });
}

function requireRepository(repository) {
  for (const method of [
    "withTransaction",
    "getCaptureForUpdate",
    "lockTinderIdentifierForMapping",
    "findTinderIdentifiersByNormalizedValueForUpdate",
    "findTinderIdentifiersForContactForUpdate",
    "getContactForUpdate",
    "createTinderContact",
    "insertConfirmedTinderIdentifier",
    "confirmExistingTinderIdentifier",
    "updateCaptureMapping",
    "insertMappingAudit"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

/**
 * This service is intentionally the sole T3 mutation boundary.  It receives
 * a concrete human choice and a separately entered stable Tinder identifier;
 * it never derives either from a visible display name or fingerprint.
 */
function createTinderHumanMappingService(repository, {
  createIdentityKey = () => `tinder_${crypto.randomUUID().replace(/-/g, "")}`
} = {}) {
  requireRepository(repository);

  async function recordConflict(transaction, capture, actor, code, action) {
    const preserveConfirmed = isConfirmedResolvedCapture(capture);
    if (!preserveConfirmed) {
      await repository.updateCaptureMapping(transaction, {
        captureId: String(capture.captureId ?? capture.capture_id),
        mappingStatus: TINDER_CAPTURE_MAPPING_STATUS.CONFLICT,
        humanReviewStatus: TINDER_CAPTURE_REVIEW_STATUS.PENDING,
        resolvedContactId: null,
        reviewedBy: null
      });
    }
    await repository.insertMappingAudit(
      transaction,
      mappingAudit({
        capture,
        action: "CONFLICT_BLOCKED",
        actor,
        newMappingStatus: preserveConfirmed
          ? TINDER_CAPTURE_MAPPING_STATUS.RESOLVED
          : TINDER_CAPTURE_MAPPING_STATUS.CONFLICT,
        newContactId: preserveConfirmed ? captureResolvedContactId(capture) : null,
        identifierId: null,
        code
      })
    );
    return conflictResult(code, {
      ...(preserveConfirmed ? { preservedContactId: captureResolvedContactId(capture) } : {})
    });
  }

  async function confirmMapping({
    captureId,
    action,
    contactId,
    newContactName,
    tinderIdentifier,
    confirmed = false,
    actor = "marcel_dashboard"
  } = {}) {
    const normalizedCaptureId = normalizeCaptureId(captureId);
    const normalizedAction = normalizeAction(action);
    const normalizedActor = normalizeActor(actor);

    if (confirmed !== true) {
      return needsHumanMapping("HUMAN_CONFIRMATION_REQUIRED");
    }

    const identifier = normalizeTinderIdentifier(tinderIdentifier);
    if (!identifier) {
      return needsHumanMapping("TINDER_IDENTIFIER_REQUIRED");
    }

    const requestedContactId = normalizedAction === TINDER_MAPPING_ACTION.MAP_EXISTING
      ? numberId(contactId)
      : null;
    if (normalizedAction === TINDER_MAPPING_ACTION.MAP_EXISTING && requestedContactId === null) {
      throw new TinderHumanMappingError("Der ausgewählte Kontakt ist ungültig.", "INVALID_CONTACT_ID");
    }
    const requestedNewContactName = normalizedAction === TINDER_MAPPING_ACTION.CREATE_NEW
      ? normalizeNewContactName(newContactName)
      : null;

    return repository.withTransaction(async (transaction) => {
      const capture = await repository.getCaptureForUpdate(transaction, normalizedCaptureId);
      if (!capture) {
        throw new TinderHumanMappingError("Das Tinder-Capture wurde nicht gefunden.", "CAPTURE_NOT_FOUND", 404);
      }
      if (captureSafetyStatus(capture) !== "SAFE") {
        return Object.freeze({ status: TINDER_IDENTITY_RESOLUTION_STATUS.UNSAFE });
      }

      // `FOR UPDATE` locks rows that exist, but cannot lock an absent
      // identifier.  Serialize every human mapping attempt on the normalized
      // identifier before looking it up, so a concurrent winner is observed
      // as a controlled ownership conflict instead of an insert race.
      await repository.lockTinderIdentifierForMapping(
        transaction,
        identifier.normalizedValue
      );
      const owners = await repository.findTinderIdentifiersByNormalizedValueForUpdate(
        transaction,
        identifier.normalizedValue
      );

      if (normalizedAction === TINDER_MAPPING_ACTION.MAP_EXISTING) {
        const contact = await repository.getContactForUpdate(transaction, requestedContactId);
        if (!contact) {
          throw new TinderHumanMappingError("Der ausgewählte Kontakt wurde nicht gefunden.", "CONTACT_NOT_FOUND", 404);
        }

        const selectedIdentifiers = await repository.findTinderIdentifiersForContactForUpdate(
          transaction,
          requestedContactId
        );
        const conflictCode = identifierConflictRows(
          [...owners, ...selectedIdentifiers],
          identifier.normalizedValue,
          requestedContactId
        );
        if (conflictCode) {
          return recordConflict(transaction, capture, normalizedActor, conflictCode, normalizedAction);
        }

        const existingResolvedContactId = captureResolvedContactId(capture);
        if (isConfirmedResolvedCapture(capture)) {
          if (existingResolvedContactId === requestedContactId) {
            return Object.freeze({
              status: TINDER_IDENTITY_RESOLUTION_STATUS.RESOLVED,
              contactId: requestedContactId,
              idempotent: true
            });
          }
          return recordConflict(
            transaction,
            capture,
            normalizedActor,
            "CAPTURE_ALREADY_CONFIRMED_FOR_ANOTHER_CONTACT",
            normalizedAction
          );
        }

        const matchingIdentifier = [...owners, ...selectedIdentifiers]
          .find((row) => rowContactId(row) === requestedContactId
            && rowNormalizedValue(row) === identifier.normalizedValue);
        let identifierId = rowIdentifierId(matchingIdentifier);
        if (matchingIdentifier) {
          if (rowHumanVerified(matchingIdentifier) !== true) {
            const confirmedIdentifier = await repository.confirmExistingTinderIdentifier(transaction, {
              identifierId,
              actor: normalizedActor
            });
            identifierId = rowIdentifierId(confirmedIdentifier) || identifierId;
          }
        } else {
          const insertedIdentifier = await repository.insertConfirmedTinderIdentifier(transaction, {
            contactId: requestedContactId,
            identifierValue: identifier.identifierValue,
            normalizedValue: identifier.normalizedValue,
            actor: normalizedActor
          });
          identifierId = rowIdentifierId(insertedIdentifier);
        }
        if (identifierId === null) {
          throw new TinderHumanMappingError("Der Tinder-Identifier konnte nicht bestätigt werden.", "IDENTIFIER_WRITE_FAILED");
        }

        await repository.updateCaptureMapping(transaction, {
          captureId: normalizedCaptureId,
          mappingStatus: TINDER_CAPTURE_MAPPING_STATUS.RESOLVED,
          humanReviewStatus: TINDER_CAPTURE_REVIEW_STATUS.CONFIRMED,
          resolvedContactId: requestedContactId,
          reviewedBy: normalizedActor
        });
        await repository.insertMappingAudit(
          transaction,
          mappingAudit({
            capture,
            action: normalizedAction,
            actor: normalizedActor,
            newMappingStatus: TINDER_CAPTURE_MAPPING_STATUS.RESOLVED,
            newContactId: requestedContactId,
            identifierId
          })
        );
        return Object.freeze({
          status: TINDER_IDENTITY_RESOLUTION_STATUS.RESOLVED,
          contactId: requestedContactId,
          identifierId,
          idempotent: false
        });
      }

      if (owners.length > 0) {
        return recordConflict(
          transaction,
          capture,
          normalizedActor,
          "TINDER_IDENTIFIER_OWNED_BY_ANOTHER_CONTACT",
          normalizedAction
        );
      }
      if (isConfirmedResolvedCapture(capture)) {
        return recordConflict(
          transaction,
          capture,
          normalizedActor,
          "CAPTURE_ALREADY_CONFIRMED_FOR_ANOTHER_CONTACT",
          normalizedAction
        );
      }

      const newContact = await repository.createTinderContact(transaction, {
        canonicalName: requestedNewContactName,
        memoryIdentityKey: normalizeGeneratedIdentityKey(createIdentityKey()),
        whatsappJid: null,
        sourcePlatform: "tinder",
        currentPlatform: "tinder",
        identityLocked: true
      });
      const newContactId = rowContactId(newContact) ?? numberId(newContact?.id);
      if (newContactId === null) {
        throw new TinderHumanMappingError("Der neue Tinder-Kontakt konnte nicht angelegt werden.", "CONTACT_WRITE_FAILED");
      }

      const insertedIdentifier = await repository.insertConfirmedTinderIdentifier(transaction, {
        contactId: newContactId,
        identifierValue: identifier.identifierValue,
        normalizedValue: identifier.normalizedValue,
        actor: normalizedActor
      });
      const identifierId = rowIdentifierId(insertedIdentifier);
      if (identifierId === null) {
        throw new TinderHumanMappingError("Der Tinder-Identifier konnte nicht bestätigt werden.", "IDENTIFIER_WRITE_FAILED");
      }

      await repository.updateCaptureMapping(transaction, {
        captureId: normalizedCaptureId,
        mappingStatus: TINDER_CAPTURE_MAPPING_STATUS.RESOLVED,
        humanReviewStatus: TINDER_CAPTURE_REVIEW_STATUS.CONFIRMED,
        resolvedContactId: newContactId,
        reviewedBy: normalizedActor
      });
      await repository.insertMappingAudit(
        transaction,
        mappingAudit({
          capture,
          action: normalizedAction,
          actor: normalizedActor,
          newMappingStatus: TINDER_CAPTURE_MAPPING_STATUS.RESOLVED,
          newContactId,
          identifierId
        })
      );
      return Object.freeze({
        status: TINDER_IDENTITY_RESOLUTION_STATUS.NEW_CONTACT_CONFIRMED,
        contactId: newContactId,
        identifierId,
        idempotent: false
      });
    });
  }

  return Object.freeze({ confirmMapping });
}

/**
 * PostgreSQL adapter for later route wiring.  It is not registered by this
 * module and relies on the standalone migration being deliberately applied.
 */
function createPgTinderHumanMappingRepository(pool) {
  if (!pool || typeof pool.connect !== "function") {
    throw new TypeError("pool.connect must be a function");
  }

  return Object.freeze({
    async withTransaction(work) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async getCaptureForUpdate(client, captureId) {
      const result = await client.query(
        `SELECT capture_id, capture_safety_status, mapping_status,
                human_review_status, resolved_contact_id
         FROM tinder_visible_chat_captures
         WHERE capture_id = $1
         FOR UPDATE`,
        [captureId]
      );
      return result.rows[0] || null;
    },

    async lockTinderIdentifierForMapping(client, normalizedValue) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`tinder-human-mapping:${TINDER_IDENTIFIER_TYPE}:${normalizedValue}`]
      );
    },

    async findTinderIdentifiersByNormalizedValueForUpdate(client, normalizedValue) {
      const result = await client.query(
        `SELECT id AS identifier_id, contact_id, normalized_value,
                human_verified
         FROM contact_identifiers
         WHERE identifier_type = $1
           AND normalized_value = $2
         ORDER BY contact_id ASC, id ASC
         FOR UPDATE`,
        [TINDER_IDENTIFIER_TYPE, normalizedValue]
      );
      return result.rows;
    },

    async findTinderIdentifiersForContactForUpdate(client, contactId) {
      const result = await client.query(
        `SELECT id AS identifier_id, contact_id, normalized_value,
                human_verified
         FROM contact_identifiers
         WHERE contact_id = $1
           AND identifier_type = $2
         ORDER BY id ASC
         FOR UPDATE`,
        [contactId, TINDER_IDENTIFIER_TYPE]
      );
      return result.rows;
    },

    async getContactForUpdate(client, contactId) {
      const result = await client.query(
        `SELECT id, whatsapp_jid, identity_locked
         FROM contacts
         WHERE id = $1
         FOR UPDATE`,
        [contactId]
      );
      return result.rows[0] || null;
    },

    async createTinderContact(client, input) {
      const result = await client.query(
        `INSERT INTO contacts (
           whatsapp_jid, display_name, canonical_name, memory_identity_key,
           identity_locked, source_platform, current_platform, platform_status,
           contact_status, relationship_stage, auto_reply_enabled,
           manual_review_required, first_contact_at, updated_at
         ) VALUES (
           NULL,$1,$1,$2,TRUE,$3,$4,'CONTACT_KNOWN','active','new',
           FALSE,TRUE,NOW(),NOW()
         ) RETURNING *`,
        [
          input.canonicalName,
          input.memoryIdentityKey,
          input.sourcePlatform,
          input.currentPlatform
        ]
      );
      const contact = result.rows[0] || null;
      if (contact) {
        await client.query(
          `INSERT INTO contact_memory_profiles (contact_id)
           VALUES ($1)
           ON CONFLICT (contact_id) DO NOTHING`,
          [contact.id]
        );
      }
      return contact;
    },

    async insertConfirmedTinderIdentifier(client, input) {
      const result = await client.query(
        `INSERT INTO contact_identifiers (
           contact_id, identifier_type, identifier_value, normalized_value,
           source_platform, is_primary, human_verified, verification_source,
           verified_by, verified_at, created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,'tinder',TRUE,TRUE,'manual_dashboard',$5,NOW(),NOW(),NOW()
         ) RETURNING *`,
        [
          input.contactId,
          TINDER_IDENTIFIER_TYPE,
          input.identifierValue,
          input.normalizedValue,
          input.actor
        ]
      );
      return result.rows[0] || null;
    },

    async confirmExistingTinderIdentifier(client, { identifierId, actor }) {
      const result = await client.query(
        `UPDATE contact_identifiers
         SET human_verified = TRUE,
             verification_source = 'manual_dashboard',
             verified_by = $2,
             verified_at = NOW(),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [identifierId, actor]
      );
      return result.rows[0] || null;
    },

    async updateCaptureMapping(client, input) {
      await client.query(
        `UPDATE tinder_visible_chat_captures
         SET mapping_status = $2,
             human_review_status = $3,
             resolved_contact_id = $4,
             mapping_reviewed_by = $5,
             mapping_reviewed_at = CASE WHEN $5 IS NULL THEN NULL ELSE NOW() END,
             updated_at = NOW()
         WHERE capture_id = $1`,
        [
          input.captureId,
          input.mappingStatus,
          input.humanReviewStatus,
          input.resolvedContactId,
          input.reviewedBy
        ]
      );
    },

    async insertMappingAudit(client, audit) {
      await client.query(
        `INSERT INTO tinder_identity_mapping_audit (
           capture_id, action, actor, source, old_mapping_status,
           new_mapping_status, old_contact_id, new_contact_id,
           identifier_id, details
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
        [
          audit.captureId,
          audit.action,
          audit.actor,
          audit.source,
          audit.oldMappingStatus,
          audit.newMappingStatus,
          audit.oldContactId,
          audit.newContactId,
          audit.identifierId,
          JSON.stringify(audit.details)
        ]
      );
    }
  });
}

export {
  TINDER_MAPPING_ACTION,
  TinderHumanMappingError,
  createPgTinderHumanMappingRepository,
  createTinderHumanMappingService
};
