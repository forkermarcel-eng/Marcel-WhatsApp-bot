const TINDER_IDENTIFIER_TYPE = "tinder_profile";

const TINDER_IDENTITY_RESOLUTION_STATUS = Object.freeze({
  RESOLVED: "RESOLVED",
  NEEDS_HUMAN_MAPPING: "NEEDS_HUMAN_MAPPING",
  NEW_CONTACT_CONFIRMED: "NEW_CONTACT_CONFIRMED",
  CONFLICT: "CONFLICT",
  UNSAFE: "UNSAFE"
});

class TinderIdentityResolutionError extends Error {
  constructor(message, code = "TINDER_IDENTITY_INVALID") {
    super(message);
    this.name = "TinderIdentityResolutionError";
    this.code = code;
  }
}

function normalizeIdentityValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Normalizes only an identifier which a human explicitly supplied.  This
 * helper deliberately never receives or derives an identifier from a visible
 * Tinder display name or from a temporary thread fingerprint.
 */
function normalizeTinderIdentifier(value) {
  const identifierValue = String(value || "").trim().replace(/^@/, "");
  if (!identifierValue) return null;
  if (identifierValue.length > 160 || /\s/.test(identifierValue)) {
    throw new TinderIdentityResolutionError(
      "Der Tinder-Identifier ist ungültig.",
      "INVALID_TINDER_IDENTIFIER"
    );
  }

  const normalizedValue = normalizeIdentityValue(identifierValue);
  if (!normalizedValue) {
    throw new TinderIdentityResolutionError(
      "Der Tinder-Identifier ist ungültig.",
      "INVALID_TINDER_IDENTIFIER"
    );
  }

  return Object.freeze({ identifierValue, normalizedValue });
}

function captureSafetyStatus(capture) {
  return String(
    capture?.safetyStatus
      ?? capture?.safety_status
      ?? capture?.captureSafetyStatus
      ?? capture?.capture_safety_status
      ?? ""
  )
    .trim()
    .toUpperCase();
}

function positiveContactId(row) {
  const value = Number(row?.contactId ?? row?.contact_id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function isConfirmedTinderIdentifierRow(row) {
  const identifierType = row?.identifierType ?? row?.identifier_type;
  const humanVerified = row?.humanVerified ?? row?.human_verified;
  return (
    positiveContactId(row) !== null
    && humanVerified === true
    && (!identifierType || identifierType === TINDER_IDENTIFIER_TYPE)
  );
}

function compactCandidates(rows) {
  const byContactId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isConfirmedTinderIdentifierRow(row)) continue;
    const contactId = positiveContactId(row);
    if (!byContactId.has(contactId)) {
      byContactId.set(contactId, Object.freeze({ contactId }));
    }
  }
  return [...byContactId.values()].sort((left, right) => left.contactId - right.contactId);
}

/**
 * The injected reader must return every exact, confirmed Tinder identifier
 * candidate.  It must not perform a display-name or fingerprint lookup.
 */
function createTinderIdentityResolutionService({ findConfirmedTinderIdentifierCandidates } = {}) {
  if (typeof findConfirmedTinderIdentifierCandidates !== "function") {
    throw new TypeError("findConfirmedTinderIdentifierCandidates must be a function");
  }

  async function resolve({ capture, tinderIdentifier } = {}) {
    if (captureSafetyStatus(capture) !== "SAFE") {
      return Object.freeze({
        status: TINDER_IDENTITY_RESOLUTION_STATUS.UNSAFE
      });
    }

    const identifier = normalizeTinderIdentifier(tinderIdentifier);
    if (!identifier) {
      return Object.freeze({
        status: TINDER_IDENTITY_RESOLUTION_STATUS.NEEDS_HUMAN_MAPPING
      });
    }

    const rows = await findConfirmedTinderIdentifierCandidates(identifier.normalizedValue);
    const candidates = compactCandidates(rows);

    if (candidates.length === 0) {
      return Object.freeze({
        status: TINDER_IDENTITY_RESOLUTION_STATUS.NEEDS_HUMAN_MAPPING,
        identifier: Object.freeze({ normalizedValue: identifier.normalizedValue })
      });
    }

    if (candidates.length > 1) {
      return Object.freeze({
        status: TINDER_IDENTITY_RESOLUTION_STATUS.CONFLICT,
        identifier: Object.freeze({ normalizedValue: identifier.normalizedValue }),
        candidates: Object.freeze(candidates)
      });
    }

    return Object.freeze({
      status: TINDER_IDENTITY_RESOLUTION_STATUS.RESOLVED,
      contactId: candidates[0].contactId,
      identifier: Object.freeze({ normalizedValue: identifier.normalizedValue })
    });
  }

  return Object.freeze({ resolve });
}

/**
 * PostgreSQL adapter used by future route wiring.  It intentionally has no
 * LIMIT clause: more than one confirmed contact is a conflict, never an
 * arbitrary winner.
 */
function createPgTinderIdentityResolutionRepository(pool) {
  if (!pool || typeof pool.query !== "function") {
    throw new TypeError("pool.query must be a function");
  }

  return Object.freeze({
    async findConfirmedTinderIdentifierCandidates(normalizedValue) {
      const result = await pool.query(
        `SELECT
           i.id AS identifier_id,
           i.contact_id,
           i.identifier_type,
           i.human_verified
         FROM contact_identifiers i
         JOIN contacts c ON c.id = i.contact_id
         WHERE i.identifier_type = $1
           AND i.normalized_value = $2
           AND i.human_verified = TRUE
         ORDER BY i.contact_id ASC, i.id ASC`,
        [TINDER_IDENTIFIER_TYPE, normalizedValue]
      );
      return result.rows;
    }
  });
}

export {
  TINDER_IDENTIFIER_TYPE,
  TINDER_IDENTITY_RESOLUTION_STATUS,
  TinderIdentityResolutionError,
  captureSafetyStatus,
  createPgTinderIdentityResolutionRepository,
  createTinderIdentityResolutionService,
  normalizeTinderIdentifier
};
