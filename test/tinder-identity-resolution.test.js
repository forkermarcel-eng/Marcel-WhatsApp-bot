import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_IDENTITY_RESOLUTION_STATUS,
  TinderIdentityResolutionError,
  createPgTinderIdentityResolutionRepository,
  createTinderIdentityResolutionService,
  normalizeTinderIdentifier
} from "../services/tinder-identity-resolution.js";

const SAFE_CAPTURE = Object.freeze({
  safetyStatus: "SAFE",
  visibleThreadMetadata: Object.freeze({
    visibleName: "Sandry",
    threadFingerprint: "a".repeat(64)
  })
});

function resolverWith(rows, calls = []) {
  return createTinderIdentityResolutionService({
    async findConfirmedTinderIdentifierCandidates(normalizedValue) {
      calls.push(normalizedValue);
      return rows;
    }
  });
}

test("an unsafe capture cannot resolve an identity", async () => {
  const calls = [];
  const result = await resolverWith([{ contact_id: 8, human_verified: true }], calls)
    .resolve({ capture: { safetyStatus: "BLOCKED_UNKNOWN_STRUCTURE" }, tinderIdentifier: "real-id" });

  assert.equal(result.status, TINDER_IDENTITY_RESOLUTION_STATUS.UNSAFE);
  assert.deepEqual(calls, []);
});

test("a visible name and temporary fingerprint never become a Tinder identifier", async () => {
  const calls = [];
  const result = await resolverWith([{ contact_id: 8, human_verified: true }], calls)
    .resolve({ capture: SAFE_CAPTURE });

  assert.equal(result.status, TINDER_IDENTITY_RESOLUTION_STATUS.NEEDS_HUMAN_MAPPING);
  assert.deepEqual(calls, []);
});

test("one exact human-confirmed Tinder identifier resolves one central contact", async () => {
  const calls = [];
  const result = await resolverWith([
    { identifier_id: 11, contact_id: 8, identifier_type: "tinder_profile", human_verified: true }
  ], calls).resolve({ capture: SAFE_CAPTURE, tinderIdentifier: "@Stable.Match-42" });

  assert.equal(result.status, TINDER_IDENTITY_RESOLUTION_STATUS.RESOLVED);
  assert.equal(result.contactId, 8);
  assert.deepEqual(calls, ["stable.match-42"]);
});

test("unconfirmed or malformed repository rows cannot resolve an identity", async () => {
  const result = await resolverWith([
    { identifier_id: 11, contact_id: 8, identifier_type: "tinder_profile", human_verified: false },
    { identifier_id: 12, contact_id: 0, identifier_type: "tinder_profile", human_verified: true }
  ]).resolve({ capture: SAFE_CAPTURE, tinderIdentifier: "stable-id" });

  assert.equal(result.status, TINDER_IDENTITY_RESOLUTION_STATUS.NEEDS_HUMAN_MAPPING);
});

test("more than one confirmed contact is a conflict, never an arbitrary first row", async () => {
  const result = await resolverWith([
    { identifier_id: 11, contact_id: 8, identifier_type: "tinder_profile", human_verified: true },
    { identifier_id: 12, contact_id: 19, identifier_type: "tinder_profile", human_verified: true }
  ]).resolve({ capture: SAFE_CAPTURE, tinderIdentifier: "stable-id" });

  assert.equal(result.status, TINDER_IDENTITY_RESOLUTION_STATUS.CONFLICT);
  assert.deepEqual(result.candidates, [{ contactId: 8 }, { contactId: 19 }]);
});

test("duplicate rows for the same central contact remain one candidate", async () => {
  const result = await resolverWith([
    { identifier_id: 11, contact_id: 8, identifier_type: "tinder_profile", human_verified: true },
    { identifier_id: 12, contact_id: 8, identifier_type: "tinder_profile", human_verified: true }
  ]).resolve({ capture: SAFE_CAPTURE, tinderIdentifier: "stable-id" });

  assert.equal(result.status, TINDER_IDENTITY_RESOLUTION_STATUS.RESOLVED);
  assert.equal(result.contactId, 8);
});

test("only an explicit identifier is normalized and invalid values fail closed", () => {
  assert.deepEqual(normalizeTinderIdentifier(" @Sándry "), {
    identifierValue: "Sándry",
    normalizedValue: "sandry"
  });
  assert.equal(normalizeTinderIdentifier(""), null);
  assert.throws(
    () => normalizeTinderIdentifier("not an identifier"),
    TinderIdentityResolutionError
  );
});

test("the PostgreSQL resolver queries all exact confirmed candidates without LIMIT", async () => {
  let call;
  const repository = createPgTinderIdentityResolutionRepository({
    async query(sql, values) {
      call = { sql, values };
      return { rows: [] };
    }
  });

  await repository.findConfirmedTinderIdentifierCandidates("stable-id");

  assert.match(call.sql, /identifier_type = \$1/);
  assert.match(call.sql, /human_verified = TRUE/);
  assert.doesNotMatch(call.sql, /LIMIT\s+1/i);
  assert.deepEqual(call.values, ["tinder_profile", "stable-id"]);
});
