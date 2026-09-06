import crypto from "node:crypto";
import {
  TINDER_CAPTURE_MAPPING_STATUS,
  TINDER_CAPTURE_REVIEW_STATUS,
  TINDER_CAPTURE_SCHEMA_VERSION_V2,
  TINDER_THREAD_BINDING_EVIDENCE,
  normalizeThreadBindingEvidence
} from "./tinder-capture-store.js";

/* ==================================================
SHARED CHANNEL CONVERSATION BINDING

This service owns a durable *conversation* association, not a person/profile
identifier. It is deliberately separate from contact_identifiers and the
legacy Tinder profile mapping service. The only Tinder adapter input is a
server-loaded, Android-local-HMAC observation already stored in a SAFE V2
capture. No browser/client supplies token, raw UI ID, fingerprint or name.
================================================== */

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;

export const CHANNEL_CONVERSATION_BINDING_CHANNEL = Object.freeze({
  TINDER: "tinder",
  WHATSAPP: "whatsapp"
});
export const CHANNEL_CONVERSATION_BINDING_ACTION = Object.freeze({
  BIND_EXISTING: "BIND_EXISTING",
  BIND_CREATE: "BIND_CREATE"
});
export const CHANNEL_CONVERSATION_BINDING_STATUS = Object.freeze({
  LEGACY_CAPTURE: "LEGACY_CAPTURE",
  FOUNDATION_NOT_READY: "FOUNDATION_NOT_READY",
  AWAITING_STABILITY_EVIDENCE: "AWAITING_STABILITY_EVIDENCE",
  ELIGIBLE_FOR_HUMAN_BINDING: "ELIGIBLE_FOR_HUMAN_BINDING",
  CONFIRMED: "CONFIRMED",
  CONFLICT: "CONFLICT",
  UNSAFE: "UNSAFE"
});
export const TINDER_CONVERSATION_REFERENCE_KIND = TINDER_THREAD_BINDING_EVIDENCE.kind;

export class ChannelConversationBindingError extends Error {
  constructor(message, code = "INVALID_CONVERSATION_BINDING", statusCode = 400) {
    super(message);
    this.name = "ChannelConversationBindingError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sourceValue(source, camelCase, snakeCase) {
  return source?.[camelCase] ?? source?.[snakeCase];
}

function numberId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeCaptureId(value) {
  const captureId = String(value || "").trim().toLowerCase();
  if (!UUID_V4.test(captureId)) {
    throw new ChannelConversationBindingError("Die Capture-ID ist ungültig.", "INVALID_CAPTURE_ID");
  }
  return captureId;
}

function normalizeActor(value) {
  const actor = String(value || "marcel_dashboard").trim();
  if (!actor || actor.length > 80) {
    throw new ChannelConversationBindingError("Der Mapping-Akteur ist ungültig.", "INVALID_BINDING_ACTOR");
  }
  return actor;
}

function normalizeAction(value) {
  const action = String(value || "").trim().toUpperCase();
  if (!Object.hasOwn(CHANNEL_CONVERSATION_BINDING_ACTION, action)) {
    throw new ChannelConversationBindingError("Die Binding-Aktion ist ungültig.", "INVALID_BINDING_ACTION");
  }
  return action;
}

function normalizeNewContactName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 160) {
    throw new ChannelConversationBindingError("Ein neuer Kontakt braucht einen bestätigten Namen.", "INVALID_NEW_CONTACT_NAME");
  }
  return name;
}

function normalizeGeneratedIdentityKey(value) {
  const identityKey = String(value || "").trim();
  if (!/^[a-z0-9_-]{8,160}$/i.test(identityKey)) {
    throw new ChannelConversationBindingError("Der technische Kontaktschlüssel ist ungültig.", "INVALID_GENERATED_IDENTITY_KEY");
  }
  return identityKey;
}

function normalizedStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function rowCaptureId(row) {
  const value = String(sourceValue(row, "captureId", "capture_id") || "").trim().toLowerCase();
  return UUID_V4.test(value) ? value : null;
}

function rowDeviceId(row) {
  const value = String(sourceValue(row, "deviceId", "device_id") || "").trim().toLowerCase();
  return UUID_V4.test(value) ? value : null;
}

function rowRuntimeFingerprint(row) {
  const value = String(sourceValue(row, "runtimeThreadFingerprint", "runtime_thread_fingerprint") || "").trim();
  return SHA256_HEX.test(value) ? value : null;
}

function rowMetadata(row) {
  const metadata = sourceValue(row, "visibleThreadMetadata", "visible_thread_metadata");
  return plainObject(metadata) ? metadata : null;
}

/**
 * Revalidates only persisted capture facts. Invalid/legacy metadata has no
 * candidate; it can never be promoted through a caller-provided substitute.
 */
export function normalizeStoredTinderBindingCandidate(row) {
  const captureId = rowCaptureId(row);
  const deviceId = rowDeviceId(row);
  const runtimeThreadFingerprint = rowRuntimeFingerprint(row);
  const schemaVersion = String(sourceValue(row, "schemaVersion", "capture_schema_version") || "").trim();
  const metadata = rowMetadata(row);
  if (!captureId || !deviceId || !runtimeThreadFingerprint || !metadata
      || normalizedStatus(sourceValue(row, "captureSafetyStatus", "capture_safety_status")) !== "SAFE"
      || schemaVersion !== TINDER_CAPTURE_SCHEMA_VERSION_V2) {
    return null;
  }
  let evidence;
  try {
    evidence = normalizeThreadBindingEvidence(metadata, schemaVersion);
  } catch {
    return null;
  }
  if (!evidence || evidence.kind !== TINDER_CONVERSATION_REFERENCE_KIND
      || evidence.status !== TINDER_THREAD_BINDING_EVIDENCE.status
      || !SHA256_HEX.test(evidence.token)) {
    return null;
  }
  return Object.freeze({
    captureId,
    deviceId,
    runtimeThreadFingerprint,
    channel: CHANNEL_CONVERSATION_BINDING_CHANNEL.TINDER,
    referenceKind: evidence.kind,
    referenceHash: evidence.token
  });
}

function activeBindingContactId(row) {
  const contactId = numberId(sourceValue(row, "contactId", "contact_id"));
  const deviceId = rowDeviceId(row);
  const referenceHash = String(sourceValue(row, "referenceHash", "reference_hash") || "").trim();
  const referenceKind = String(sourceValue(row, "referenceKind", "reference_kind") || "").trim();
  if (contactId === null || !deviceId || !SHA256_HEX.test(referenceHash)
      || referenceKind !== TINDER_CONVERSATION_REFERENCE_KIND
      || normalizedStatus(sourceValue(row, "bindingState", "binding_state")) !== "CONFIRMED"
      || sourceValue(row, "humanVerified", "human_verified") !== true) {
    return null;
  }
  return contactId;
}

function sameCandidate(left, right) {
  return Boolean(left && right)
    && left.channel === right.channel
    && left.referenceKind === right.referenceKind
    && left.referenceHash === right.referenceHash
    && left.deviceId === right.deviceId;
}

function validatedObservationFingerprints(rows, candidate) {
  const fingerprints = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const observation = normalizeStoredTinderBindingCandidate(row);
    if (sameCandidate(observation, candidate)) fingerprints.add(observation.runtimeThreadFingerprint);
  }
  return fingerprints;
}

/** A candidate needs independent rediscovery after runtime fingerprint change. */
export function bindingReadinessFromEvidence({ capture, observations, activeBinding } = {}) {
  const candidate = normalizeStoredTinderBindingCandidate(capture);
  if (normalizedStatus(sourceValue(capture, "captureSafetyStatus", "capture_safety_status")) !== "SAFE") {
    return Object.freeze({ status: CHANNEL_CONVERSATION_BINDING_STATUS.UNSAFE });
  }
  if (!candidate) {
    return Object.freeze({ status: CHANNEL_CONVERSATION_BINDING_STATUS.LEGACY_CAPTURE });
  }
  const boundContactId = activeBindingContactId(activeBinding);
  if (boundContactId !== null) {
    if (activeBindingContactId(activeBinding) !== null
        && sameCandidate(candidate, {
          channel: CHANNEL_CONVERSATION_BINDING_CHANNEL.TINDER,
          referenceKind: sourceValue(activeBinding, "referenceKind", "reference_kind"),
          referenceHash: sourceValue(activeBinding, "referenceHash", "reference_hash"),
          deviceId: sourceValue(activeBinding, "deviceId", "device_id")
        })) {
      return Object.freeze({ status: CHANNEL_CONVERSATION_BINDING_STATUS.CONFIRMED, contactId: boundContactId });
    }
    return Object.freeze({ status: CHANNEL_CONVERSATION_BINDING_STATUS.CONFLICT });
  }
  const fingerprints = validatedObservationFingerprints(observations, candidate);
  return Object.freeze({
    status: fingerprints.size >= 2
      ? CHANNEL_CONVERSATION_BINDING_STATUS.ELIGIBLE_FOR_HUMAN_BINDING
      : CHANNEL_CONVERSATION_BINDING_STATUS.AWAITING_STABILITY_EVIDENCE
  });
}

function requireRepository(repository) {
  for (const method of [
    "withTransaction",
    "getCaptureForRead",
    "getCaptureForUpdate",
    "findEvidenceObservations",
    "findEvidenceObservationsForUpdate",
    "findActiveBinding",
    "findActiveBindingForUpdate",
    "lockConversationReference",
    "getContactForUpdate",
    "createChannelContact",
    "insertConfirmedBinding",
    "updateCaptureMapping",
    "insertBindingAudit"
  ]) {
    if (typeof repository?.[method] !== "function") {
      throw new TypeError(`repository.${method} must be a function`);
    }
  }
}

function auditRecord({ bindingId, captureId, action, actor, oldContactId = null, newContactId = null,
  oldBindingRevision = null, newBindingRevision = null, reasonCode = null } = {}) {
  return Object.freeze({
    bindingId,
    captureId,
    action,
    actor,
    source: "manual_dashboard",
    oldContactId,
    newContactId,
    oldBindingRevision,
    newBindingRevision,
    reasonCode,
    // No technical reference, name, fingerprint or content goes into audit JSON.
    details: Object.freeze({ channel: CHANNEL_CONVERSATION_BINDING_CHANNEL.TINDER })
  });
}

function bindingIdFromRow(row) {
  const value = String(sourceValue(row, "bindingId", "binding_id") || "").trim().toLowerCase();
  return UUID_V4.test(value) ? value : null;
}

export function createChannelConversationBindingService(repository, {
  createBindingId = () => crypto.randomUUID(),
  createIdentityKey = () => `tinder_${crypto.randomUUID().replace(/-/g, "")}`
} = {}) {
  requireRepository(repository);

  async function getReadiness(captureId) {
    const capture = await repository.getCaptureForRead(normalizeCaptureId(captureId));
    if (!capture) {
      throw new ChannelConversationBindingError("Das Tinder-Capture wurde nicht gefunden.", "CAPTURE_NOT_FOUND", 404);
    }
    const candidate = normalizeStoredTinderBindingCandidate(capture);
    if (!candidate) return bindingReadinessFromEvidence({ capture, observations: [], activeBinding: null });
    try {
      const [observations, activeBinding] = await Promise.all([
        repository.findEvidenceObservations(candidate),
        repository.findActiveBinding(candidate)
      ]);
      return bindingReadinessFromEvidence({ capture, observations, activeBinding });
    } catch (error) {
      if (error?.code === "42P01" || error?.code === "42703") {
        return Object.freeze({ status: CHANNEL_CONVERSATION_BINDING_STATUS.FOUNDATION_NOT_READY });
      }
      throw error;
    }
  }

  async function confirmBinding({ captureId, action, contactId, newContactName, confirmed = false,
    actor = "marcel_dashboard" } = {}) {
    const normalizedCaptureId = normalizeCaptureId(captureId);
    const normalizedAction = normalizeAction(action);
    const normalizedActor = normalizeActor(actor);
    if (confirmed !== true) {
      return Object.freeze({ status: CHANNEL_CONVERSATION_BINDING_STATUS.AWAITING_STABILITY_EVIDENCE, code: "HUMAN_CONFIRMATION_REQUIRED" });
    }
    const requestedContactId = normalizedAction === CHANNEL_CONVERSATION_BINDING_ACTION.BIND_EXISTING
      ? numberId(contactId) : null;
    if (normalizedAction === CHANNEL_CONVERSATION_BINDING_ACTION.BIND_EXISTING && requestedContactId === null) {
      throw new ChannelConversationBindingError("Der ausgewählte Kontakt ist ungültig.", "INVALID_CONTACT_ID");
    }
    const requestedNewContactName = normalizedAction === CHANNEL_CONVERSATION_BINDING_ACTION.BIND_CREATE
      ? normalizeNewContactName(newContactName) : null;

    return repository.withTransaction(async transaction => {
      const capture = await repository.getCaptureForUpdate(transaction, normalizedCaptureId);
      if (!capture) {
        throw new ChannelConversationBindingError("Das Tinder-Capture wurde nicht gefunden.", "CAPTURE_NOT_FOUND", 404);
      }
      const candidate = normalizeStoredTinderBindingCandidate(capture);
      if (normalizedStatus(sourceValue(capture, "captureSafetyStatus", "capture_safety_status")) !== "SAFE") {
        return Object.freeze({ status: CHANNEL_CONVERSATION_BINDING_STATUS.UNSAFE });
      }
      if (!candidate) {
        return Object.freeze({ status: CHANNEL_CONVERSATION_BINDING_STATUS.LEGACY_CAPTURE });
      }

      // Serialize owner selection even when the active binding has not been
      // inserted yet; this prevents an absent-row race from becoming a silent
      // duplicate owner.
      await repository.lockConversationReference(transaction, candidate);
      const observations = await repository.findEvidenceObservationsForUpdate(transaction, candidate);
      const activeBinding = await repository.findActiveBindingForUpdate(transaction, candidate);
      const readiness = bindingReadinessFromEvidence({ capture, observations, activeBinding });
      if (readiness.status === CHANNEL_CONVERSATION_BINDING_STATUS.AWAITING_STABILITY_EVIDENCE
          || readiness.status === CHANNEL_CONVERSATION_BINDING_STATUS.LEGACY_CAPTURE
          || readiness.status === CHANNEL_CONVERSATION_BINDING_STATUS.UNSAFE
          || readiness.status === CHANNEL_CONVERSATION_BINDING_STATUS.CONFLICT) {
        return readiness;
      }

      const existingBindingId = bindingIdFromRow(activeBinding);
      const activeContactId = activeBindingContactId(activeBinding);
      if (existingBindingId && activeContactId !== null) {
        // A BIND_CREATE request must never create an orphan contact when this
        // exact opaque conversation reference already belongs to somebody
        // else.  Resolve the conflict before any contact-side write.
        if (normalizedAction === CHANNEL_CONVERSATION_BINDING_ACTION.BIND_CREATE) {
          await repository.insertBindingAudit(transaction, auditRecord({
            bindingId: existingBindingId, captureId: normalizedCaptureId,
            action: "CONFLICT_BLOCKED", actor: normalizedActor,
            oldContactId: activeContactId,
            reasonCode: "CONVERSATION_REFERENCE_OWNED_BY_ANOTHER_CONTACT"
          }));
          return Object.freeze({ status: CHANNEL_CONVERSATION_BINDING_STATUS.CONFLICT });
        }

        const contact = await repository.getContactForUpdate(transaction, requestedContactId);
        if (!contact) {
          throw new ChannelConversationBindingError("Der ausgewählte Kontakt wurde nicht gefunden.", "CONTACT_NOT_FOUND", 404);
        }
        if (activeContactId !== requestedContactId) {
          await repository.insertBindingAudit(transaction, auditRecord({
            bindingId: existingBindingId, captureId: normalizedCaptureId,
            action: "CONFLICT_BLOCKED", actor: normalizedActor,
            oldContactId: activeContactId, newContactId: requestedContactId,
            oldBindingRevision: Number(sourceValue(activeBinding, "bindingRevision", "binding_revision")) || null,
            reasonCode: "CONVERSATION_REFERENCE_OWNED_BY_ANOTHER_CONTACT"
          }));
          return Object.freeze({ status: CHANNEL_CONVERSATION_BINDING_STATUS.CONFLICT });
        }
        await repository.updateCaptureMapping(transaction, {
          captureId: normalizedCaptureId,
          mappingStatus: TINDER_CAPTURE_MAPPING_STATUS.RESOLVED,
          humanReviewStatus: TINDER_CAPTURE_REVIEW_STATUS.CONFIRMED,
          resolvedContactId: requestedContactId,
          reviewedBy: normalizedActor
        });
        return Object.freeze({
          status: CHANNEL_CONVERSATION_BINDING_STATUS.CONFIRMED,
          contactId: requestedContactId,
          idempotent: true
        });
      }

      let selectedContactId = requestedContactId;
      if (normalizedAction === CHANNEL_CONVERSATION_BINDING_ACTION.BIND_EXISTING) {
        const contact = await repository.getContactForUpdate(transaction, selectedContactId);
        if (!contact) {
          throw new ChannelConversationBindingError("Der ausgewählte Kontakt wurde nicht gefunden.", "CONTACT_NOT_FOUND", 404);
        }
      } else {
        const contact = await repository.createChannelContact(transaction, {
          canonicalName: requestedNewContactName,
          memoryIdentityKey: normalizeGeneratedIdentityKey(createIdentityKey()),
          sourcePlatform: CHANNEL_CONVERSATION_BINDING_CHANNEL.TINDER,
          currentPlatform: CHANNEL_CONVERSATION_BINDING_CHANNEL.TINDER
        });
        selectedContactId = numberId(sourceValue(contact, "contactId", "id"));
        if (selectedContactId === null) {
          throw new ChannelConversationBindingError("Der neue Kontakt konnte nicht angelegt werden.", "CONTACT_WRITE_FAILED");
        }
      }

      const bindingId = String(createBindingId()).trim().toLowerCase();
      if (!UUID_V4.test(bindingId)) {
        throw new ChannelConversationBindingError("Die Binding-ID ist ungültig.", "INVALID_BINDING_ID");
      }
      const binding = await repository.insertConfirmedBinding(transaction, {
        bindingId,
        ...candidate,
        contactId: selectedContactId,
        sourceCaptureId: normalizedCaptureId,
        actor: normalizedActor
      });
      const persistedBindingId = bindingIdFromRow(binding) || bindingId;
      if (activeBindingContactId(binding) !== selectedContactId) {
        throw new ChannelConversationBindingError("Die Conversation-Bindung konnte nicht bestätigt werden.", "BINDING_WRITE_FAILED");
      }
      await repository.updateCaptureMapping(transaction, {
        captureId: normalizedCaptureId,
        mappingStatus: TINDER_CAPTURE_MAPPING_STATUS.RESOLVED,
        humanReviewStatus: TINDER_CAPTURE_REVIEW_STATUS.CONFIRMED,
        resolvedContactId: selectedContactId,
        reviewedBy: normalizedActor
      });
      await repository.insertBindingAudit(transaction, auditRecord({
        bindingId: persistedBindingId, captureId: normalizedCaptureId, action: "CREATE",
        actor: normalizedActor, newContactId: selectedContactId, newBindingRevision: 1
      }));
      return Object.freeze({
        status: CHANNEL_CONVERSATION_BINDING_STATUS.CONFIRMED,
        contactId: selectedContactId,
        idempotent: false
      });
    });
  }

  return Object.freeze({ getReadiness, confirmBinding });
}

/** PostgreSQL adapter. It is inert until a protected route explicitly calls it. */
export function createPgChannelConversationBindingRepository(pool) {
  if (!pool || typeof pool.connect !== "function" || typeof pool.query !== "function") {
    throw new TypeError("pool.connect and pool.query must be functions");
  }
  const captureColumns = `capture_id, device_id, capture_schema_version,
    capture_safety_status, mapping_status, human_review_status,
    resolved_contact_id, runtime_thread_fingerprint, visible_thread_metadata`;
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

    async getCaptureForRead(captureId) {
      const result = await pool.query(
        `SELECT ${captureColumns}
           FROM tinder_visible_chat_captures
          WHERE capture_id = $1`,
        [captureId]
      );
      return result.rows[0] || null;
    },

    async getCaptureForUpdate(client, captureId) {
      const result = await client.query(
        `SELECT ${captureColumns}
           FROM tinder_visible_chat_captures
          WHERE capture_id = $1
          FOR UPDATE`,
        [captureId]
      );
      return result.rows[0] || null;
    },

    async findEvidenceObservations(candidate) {
      const result = await pool.query(
        `SELECT ${captureColumns}
           FROM tinder_visible_chat_captures
          WHERE device_id = $1
            AND capture_safety_status = 'SAFE'
            AND capture_schema_version = $2
            AND visible_thread_metadata -> 'threadBindingEvidence' ->> 'kind' = $3
            AND visible_thread_metadata -> 'threadBindingEvidence' ->> 'role' = $4
            AND visible_thread_metadata -> 'threadBindingEvidence' ->> 'status' = $5
            AND visible_thread_metadata -> 'threadBindingEvidence' ->> 'token' = $6
          ORDER BY received_at ASC, capture_id ASC
          LIMIT 32`,
        [candidate.deviceId, TINDER_CAPTURE_SCHEMA_VERSION_V2, candidate.referenceKind,
          TINDER_THREAD_BINDING_EVIDENCE.role, TINDER_THREAD_BINDING_EVIDENCE.status, candidate.referenceHash]
      );
      return result.rows;
    },

    async findEvidenceObservationsForUpdate(client, candidate) {
      const result = await client.query(
        `SELECT ${captureColumns}
           FROM tinder_visible_chat_captures
          WHERE device_id = $1
            AND capture_safety_status = 'SAFE'
            AND capture_schema_version = $2
            AND visible_thread_metadata -> 'threadBindingEvidence' ->> 'kind' = $3
            AND visible_thread_metadata -> 'threadBindingEvidence' ->> 'role' = $4
            AND visible_thread_metadata -> 'threadBindingEvidence' ->> 'status' = $5
            AND visible_thread_metadata -> 'threadBindingEvidence' ->> 'token' = $6
          ORDER BY received_at ASC, capture_id ASC
          LIMIT 32
          FOR UPDATE`,
        [candidate.deviceId, TINDER_CAPTURE_SCHEMA_VERSION_V2, candidate.referenceKind,
          TINDER_THREAD_BINDING_EVIDENCE.role, TINDER_THREAD_BINDING_EVIDENCE.status, candidate.referenceHash]
      );
      return result.rows;
    },

    async lockConversationReference(client, candidate) {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`channel-conversation-binding:${candidate.channel}:${candidate.referenceKind}:${candidate.deviceId}:${candidate.referenceHash}`]
      );
    },

    async findActiveBinding(candidate) {
      const result = await pool.query(
        `SELECT binding_id, channel, reference_kind, reference_hash, device_id,
                contact_id, binding_state, binding_revision, human_verified
           FROM contact_conversation_bindings
          WHERE channel = $1 AND reference_kind = $2 AND reference_hash = $3
            AND device_id = $4 AND binding_state = 'CONFIRMED'
          ORDER BY binding_id ASC
          LIMIT 1`,
        [candidate.channel, candidate.referenceKind, candidate.referenceHash, candidate.deviceId]
      );
      return result.rows[0] || null;
    },

    async findActiveBindingForUpdate(client, candidate) {
      const result = await client.query(
        `SELECT binding_id, channel, reference_kind, reference_hash, device_id,
                contact_id, binding_state, binding_revision, human_verified
           FROM contact_conversation_bindings
          WHERE channel = $1 AND reference_kind = $2 AND reference_hash = $3
            AND device_id = $4 AND binding_state = 'CONFIRMED'
          ORDER BY binding_id ASC
          LIMIT 1
          FOR UPDATE`,
        [candidate.channel, candidate.referenceKind, candidate.referenceHash, candidate.deviceId]
      );
      return result.rows[0] || null;
    },

    async getContactForUpdate(client, contactId) {
      const result = await client.query(
        `SELECT id FROM contacts WHERE id = $1 FOR UPDATE`,
        [contactId]
      );
      return result.rows[0] || null;
    },

    async createChannelContact(client, input) {
      const result = await client.query(
        `INSERT INTO contacts (
           whatsapp_jid, display_name, canonical_name, memory_identity_key,
           identity_locked, source_platform, current_platform, platform_status,
           contact_status, relationship_stage, auto_reply_enabled,
           manual_review_required, first_contact_at, updated_at
         ) VALUES (
           NULL,$1,$1,$2,TRUE,$3,$4,'CONTACT_KNOWN','active','new',
           FALSE,TRUE,NOW(),NOW()
         ) RETURNING id`,
        [input.canonicalName, input.memoryIdentityKey, input.sourcePlatform, input.currentPlatform]
      );
      const contact = result.rows[0] || null;
      if (contact) {
        await client.query(
          `INSERT INTO contact_memory_profiles (contact_id)
           VALUES ($1) ON CONFLICT (contact_id) DO NOTHING`,
          [contact.id]
        );
      }
      return contact;
    },

    async insertConfirmedBinding(client, input) {
      const result = await client.query(
        `INSERT INTO contact_conversation_bindings (
           binding_id, channel, reference_kind, reference_hash, device_id,
           contact_id, source_capture_id, binding_state, binding_revision,
           human_verified, verification_source, verified_by, verified_at,
           created_at, updated_at
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,'CONFIRMED',1,TRUE,
           'manual_dashboard',$8,NOW(),NOW(),NOW()
         ) RETURNING binding_id, channel, reference_kind, reference_hash,
                     device_id, contact_id, binding_state, binding_revision,
                     human_verified`,
        [input.bindingId, input.channel, input.referenceKind, input.referenceHash,
          input.deviceId, input.contactId, input.sourceCaptureId, input.actor]
      );
      return result.rows[0] || null;
    },

    async updateCaptureMapping(client, input) {
      await client.query(
        `UPDATE tinder_visible_chat_captures
            SET mapping_status = $2, human_review_status = $3,
                resolved_contact_id = $4, mapping_reviewed_by = $5,
                mapping_reviewed_at = NOW(), updated_at = NOW()
          WHERE capture_id = $1`,
        [input.captureId, input.mappingStatus, input.humanReviewStatus,
          input.resolvedContactId, input.reviewedBy]
      );
    },

    async insertBindingAudit(client, audit) {
      await client.query(
        `INSERT INTO contact_conversation_binding_audit (
           binding_id, capture_id, action, actor, source, old_contact_id,
           new_contact_id, old_binding_revision, new_binding_revision,
           reason_code, details
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
        [audit.bindingId, audit.captureId, audit.action, audit.actor, audit.source,
          audit.oldContactId, audit.newContactId, audit.oldBindingRevision,
          audit.newBindingRevision, audit.reasonCode, JSON.stringify(audit.details)]
      );
    }
  });
}
