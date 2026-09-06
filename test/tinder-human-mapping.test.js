import assert from "node:assert/strict";
import test from "node:test";
import {
  TINDER_MAPPING_ACTION,
  createPgTinderHumanMappingRepository,
  createTinderHumanMappingService
} from "../services/tinder-human-mapping.js";

const CAPTURE_ID = "a565e8a7-ef60-42d0-b19d-26e7904390fa";

function capture(overrides = {}) {
  return {
    capture_id: CAPTURE_ID,
    capture_safety_status: "SAFE",
    mapping_status: "NEEDS_HUMAN_MAPPING",
    human_review_status: "PENDING",
    resolved_contact_id: null,
    ...overrides
  };
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixtureRepository({
  captureRow = capture(),
  contacts = [{ id: 7 }],
  identifiers = [],
  failAudit = false,
  onIdentifierLock = null
} = {}) {
  const state = {
    capture: copy(captureRow),
    contacts: new Map(contacts.map((contact) => [Number(contact.id), copy(contact)])),
    identifiers: identifiers.map(copy),
    audits: [],
    createdContacts: [],
    transactionCalls: 0,
    calls: []
  };
  let nextContactId = 100;
  let nextIdentifierId = 200;

  const repository = {
    state,
    async withTransaction(work) {
      state.transactionCalls += 1;
      const snapshot = {
        capture: copy(state.capture),
        contacts: [...state.contacts.entries()].map(copy),
        identifiers: state.identifiers.map(copy),
        audits: state.audits.map(copy),
        createdContacts: state.createdContacts.map(copy)
      };
      try {
        return await work(repository);
      } catch (error) {
        state.capture = snapshot.capture;
        state.contacts = new Map(snapshot.contacts);
        state.identifiers = snapshot.identifiers;
        state.audits = snapshot.audits;
        state.createdContacts = snapshot.createdContacts;
        throw error;
      }
    },
    async getCaptureForUpdate(_transaction, captureId) {
      return captureId === CAPTURE_ID ? state.capture : null;
    },
    async lockTinderIdentifierForMapping(_transaction, normalizedValue) {
      state.calls.push(`lock:${normalizedValue}`);
      if (typeof onIdentifierLock === "function") {
        await onIdentifierLock(state, normalizedValue);
      }
    },
    async findTinderIdentifiersByNormalizedValueForUpdate(_transaction, normalizedValue) {
      state.calls.push(`lookup:${normalizedValue}`);
      return state.identifiers.filter((row) => row.normalized_value === normalizedValue);
    },
    async findTinderIdentifiersForContactForUpdate(_transaction, contactId) {
      return state.identifiers.filter((row) => Number(row.contact_id) === Number(contactId));
    },
    async getContactForUpdate(_transaction, contactId) {
      return state.contacts.get(Number(contactId)) || null;
    },
    async createTinderContact(_transaction, input) {
      const id = nextContactId++;
      const created = {
        id,
        contact_id: id,
        whatsapp_jid: input.whatsappJid,
        canonical_name: input.canonicalName,
        display_name: input.canonicalName,
        source_platform: input.sourcePlatform,
        current_platform: input.currentPlatform,
        identity_locked: input.identityLocked,
        memory_identity_key: input.memoryIdentityKey
      };
      state.contacts.set(id, created);
      state.createdContacts.push(copy(created));
      return created;
    },
    async insertConfirmedTinderIdentifier(_transaction, input) {
      const row = {
        id: nextIdentifierId++,
        identifier_id: nextIdentifierId - 1,
        contact_id: input.contactId,
        identifier_type: "tinder_profile",
        identifier_value: input.identifierValue,
        normalized_value: input.normalizedValue,
        human_verified: true,
        verification_source: "manual_dashboard",
        verified_by: input.actor
      };
      state.identifiers.push(row);
      return row;
    },
    async confirmExistingTinderIdentifier(_transaction, { identifierId, actor }) {
      const row = state.identifiers.find((item) => Number(item.id) === Number(identifierId));
      if (!row) return null;
      row.human_verified = true;
      row.verification_source = "manual_dashboard";
      row.verified_by = actor;
      return row;
    },
    async updateCaptureMapping(_transaction, input) {
      state.capture.mapping_status = input.mappingStatus;
      state.capture.human_review_status = input.humanReviewStatus;
      state.capture.resolved_contact_id = input.resolvedContactId;
      state.capture.mapping_reviewed_by = input.reviewedBy;
    },
    async insertMappingAudit(_transaction, audit) {
      if (failAudit) throw new Error("audit failure");
      state.audits.push(copy(audit));
    }
  };
  return repository;
}

function service(repository) {
  return createTinderHumanMappingService(repository, {
    createIdentityKey: () => "tinder_test_identity"
  });
}

test("MAP_EXISTING confirms an explicit identifier on the selected central contact", async () => {
  const repository = fixtureRepository();
  const result = await service(repository).confirmMapping({
    captureId: CAPTURE_ID,
    action: TINDER_MAPPING_ACTION.MAP_EXISTING,
    contactId: 7,
    tinderIdentifier: "real-match-7",
    confirmed: true
  });

  assert.equal(result.status, "RESOLVED");
  assert.equal(result.contactId, 7);
  assert.equal(repository.state.identifiers.length, 1);
  assert.equal(repository.state.identifiers[0].human_verified, true);
  assert.equal(repository.state.identifiers[0].verification_source, "manual_dashboard");
  assert.equal(repository.state.capture.mapping_status, "RESOLVED");
  assert.equal(repository.state.capture.resolved_contact_id, 7);
  assert.equal(repository.state.audits[0].action, "MAP_EXISTING");
});

test("the same confirmed mapping is idempotent and does not duplicate identifier or audit", async () => {
  const repository = fixtureRepository();
  const mapping = service(repository);
  await mapping.confirmMapping({
    captureId: CAPTURE_ID,
    action: "MAP_EXISTING",
    contactId: 7,
    tinderIdentifier: "real-match-7",
    confirmed: true
  });
  const repeat = await mapping.confirmMapping({
    captureId: CAPTURE_ID,
    action: "MAP_EXISTING",
    contactId: 7,
    tinderIdentifier: "real-match-7",
    confirmed: true
  });

  assert.equal(repeat.status, "RESOLVED");
  assert.equal(repeat.idempotent, true);
  assert.equal(repository.state.identifiers.length, 1);
  assert.equal(repository.state.audits.length, 1);
});

test("an identifier owned by another contact is blocked and never reassigned", async () => {
  const repository = fixtureRepository({
    identifiers: [{ id: 8, contact_id: 9, normalized_value: "real-match-7", human_verified: true }]
  });
  const result = await service(repository).confirmMapping({
    captureId: CAPTURE_ID,
    action: "MAP_EXISTING",
    contactId: 7,
    tinderIdentifier: "real-match-7",
    confirmed: true
  });

  assert.equal(result.status, "CONFLICT");
  assert.equal(result.conflictCode, "TINDER_IDENTIFIER_OWNED_BY_ANOTHER_CONTACT");
  assert.equal(repository.state.identifiers.length, 1);
  assert.equal(repository.state.capture.resolved_contact_id, null);
  assert.equal(repository.state.capture.mapping_status, "CONFLICT");
  assert.equal(repository.state.audits.at(-1).action, "CONFLICT_BLOCKED");
});

test("an absent identifier is serialized before lookup and a concurrent owner becomes a controlled conflict", async () => {
  const repository = fixtureRepository({
    onIdentifierLock(state, normalizedValue) {
      state.identifiers.push({
        id: 88,
        contact_id: 9,
        normalized_value: normalizedValue,
        human_verified: true
      });
    }
  });

  const result = await service(repository).confirmMapping({
    captureId: CAPTURE_ID,
    action: "CREATE_NEW",
    newContactName: "Must Not Be Created",
    tinderIdentifier: "real-match-serialized",
    confirmed: true
  });

  assert.equal(result.status, "CONFLICT");
  assert.equal(result.conflictCode, "TINDER_IDENTIFIER_OWNED_BY_ANOTHER_CONTACT");
  assert.equal(repository.state.createdContacts.length, 0);
  assert.deepEqual(repository.state.calls.slice(0, 2), [
    "lock:real-match-serialized",
    "lookup:real-match-serialized"
  ]);
});

test("PostgreSQL mapping repository uses a per-identifier advisory transaction lock before its ownership lookup", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return { rows: [] };
    },
    release() {}
  };
  const repository = createPgTinderHumanMappingRepository({
    async connect() {
      return client;
    }
  });

  await repository.withTransaction(async (transaction) => {
    await repository.lockTinderIdentifierForMapping(transaction, "real-match-serialized");
    await repository.findTinderIdentifiersByNormalizedValueForUpdate(
      transaction,
      "real-match-serialized"
    );
  });

  const lockIndex = calls.findIndex(({ sql }) => sql.includes("pg_advisory_xact_lock"));
  const lookupIndex = calls.findIndex(({ sql }) => sql.includes("FROM contact_identifiers"));
  assert.ok(lockIndex >= 0);
  assert.ok(lookupIndex > lockIndex);
  assert.deepEqual(calls[lockIndex].params, [
    "tinder-human-mapping:tinder_profile:real-match-serialized"
  ]);
});

test("PostgreSQL CREATE_NEW contact insert has one well-formed contacts VALUES clause", async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/^\s*INSERT INTO contacts\s*\(/.test(sql)) {
        return { rows: [{ id: 101 }] };
      }
      return { rows: [] };
    }
  };
  const repository = createPgTinderHumanMappingRepository({
    async connect() {
      return client;
    }
  });

  const contact = await repository.createTinderContact(client, {
    canonicalName: "Verified Tinder Contact",
    memoryIdentityKey: "tinder_verified_contact",
    sourcePlatform: "tinder",
    currentPlatform: "tinder"
  });

  const insert = calls.find(({ sql }) => /^\s*INSERT INTO contacts\s*\(/.test(sql));
  const normalizedSql = insert.sql.replace(/\s+/g, " ").trim();
  const shape = normalizedSql.match(/^INSERT INTO contacts \(([^)]*)\) VALUES \((.*)\) RETURNING \*$/);
  assert.ok(shape, "contacts INSERT must have a single column list and VALUES list");
  assert.equal((normalizedSql.match(/\) VALUES \(/g) || []).length, 1);
  assert.equal(shape[1].split(",").length, 14);
  assert.equal(shape[2].split(",").length, 14);
  assert.deepEqual(insert.params, [
    "Verified Tinder Contact",
    "tinder_verified_contact",
    "tinder",
    "tinder"
  ]);
  assert.equal(contact.id, 101);
});

test("a selected contact with a different confirmed Tinder identity is not silently replaced", async () => {
  const repository = fixtureRepository({
    identifiers: [{ id: 8, contact_id: 7, normalized_value: "old-match", human_verified: true }]
  });
  const result = await service(repository).confirmMapping({
    captureId: CAPTURE_ID,
    action: "MAP_EXISTING",
    contactId: 7,
    tinderIdentifier: "new-match",
    confirmed: true
  });

  assert.equal(result.status, "CONFLICT");
  assert.equal(result.conflictCode, "SELECTED_CONTACT_HAS_DIFFERENT_TINDER_IDENTIFIER");
  assert.equal(repository.state.identifiers[0].normalized_value, "old-match");
});

test("confirmation and explicit Tinder identifier are required before any mapping transaction", async () => {
  const repository = fixtureRepository();
  const mapping = service(repository);
  const noConfirmation = await mapping.confirmMapping({
    captureId: CAPTURE_ID,
    action: "MAP_EXISTING",
    contactId: 7,
    tinderIdentifier: "real-match-7"
  });
  const noIdentifier = await mapping.confirmMapping({
    captureId: CAPTURE_ID,
    action: "MAP_EXISTING",
    contactId: 7,
    confirmed: true
  });

  assert.equal(noConfirmation.status, "NEEDS_HUMAN_MAPPING");
  assert.equal(noConfirmation.code, "HUMAN_CONFIRMATION_REQUIRED");
  assert.equal(noIdentifier.code, "TINDER_IDENTIFIER_REQUIRED");
  assert.equal(repository.state.transactionCalls, 0);
  assert.equal(repository.state.identifiers.length, 0);
});

test("client-supplied authority fields cannot override manual mapping provenance", async () => {
  const repository = fixtureRepository();
  const result = await service(repository).confirmMapping({
    captureId: CAPTURE_ID,
    action: "MAP_EXISTING",
    contactId: 7,
    tinderIdentifier: "real-match-7",
    confirmed: true,
    actor: "marcel_dashboard",
    source: "untrusted_client_source",
    humanReviewStatus: "REJECTED"
  });

  assert.equal(result.status, "RESOLVED");
  assert.equal(repository.state.audits[0].source, "manual_dashboard");
  assert.equal(repository.state.capture.human_review_status, "CONFIRMED");
});

test("CREATE_NEW creates a central Tinder contact with a null WhatsApp JID", async () => {
  const repository = fixtureRepository();
  const result = await service(repository).confirmMapping({
    captureId: CAPTURE_ID,
    action: "CREATE_NEW",
    newContactName: "Sandry Confirmed",
    tinderIdentifier: "real-match-100",
    confirmed: true
  });

  assert.equal(result.status, "NEW_CONTACT_CONFIRMED");
  assert.equal(repository.state.createdContacts.length, 1);
  const created = repository.state.createdContacts[0];
  assert.equal(created.whatsapp_jid, null);
  assert.equal(created.source_platform, "tinder");
  assert.equal(created.current_platform, "tinder");
  assert.equal(created.identity_locked, true);
  assert.equal(created.memory_identity_key, "tinder_test_identity");
  assert.equal(repository.state.identifiers[0].contact_id, result.contactId);
});

test("unsafe captures cannot map or create contacts", async () => {
  const repository = fixtureRepository({
    captureRow: capture({ capture_safety_status: "BLOCKED_UNKNOWN_STRUCTURE" })
  });
  const result = await service(repository).confirmMapping({
    captureId: CAPTURE_ID,
    action: "CREATE_NEW",
    newContactName: "Not used",
    tinderIdentifier: "real-match-100",
    confirmed: true
  });

  assert.equal(result.status, "UNSAFE");
  assert.equal(repository.state.createdContacts.length, 0);
  assert.equal(repository.state.identifiers.length, 0);
  assert.equal(repository.state.audits.length, 0);
});

test("a confirmed capture mapping is preserved when a later conflicting choice arrives", async () => {
  const repository = fixtureRepository({
    captureRow: capture({
      mapping_status: "RESOLVED",
      human_review_status: "CONFIRMED",
      resolved_contact_id: 7
    }),
    contacts: [{ id: 7 }, { id: 9 }],
    identifiers: [{ id: 8, contact_id: 7, normalized_value: "real-match-7", human_verified: true }]
  });
  const result = await service(repository).confirmMapping({
    captureId: CAPTURE_ID,
    action: "MAP_EXISTING",
    contactId: 9,
    tinderIdentifier: "other-match",
    confirmed: true
  });

  assert.equal(result.status, "CONFLICT");
  assert.equal(repository.state.capture.mapping_status, "RESOLVED");
  assert.equal(repository.state.capture.resolved_contact_id, 7);
});

test("an unverified competing Tinder identifier also blocks reassignment", async () => {
  const repository = fixtureRepository({
    identifiers: [{ id: 8, contact_id: 9, normalized_value: "real-match-7", human_verified: false }]
  });
  const result = await service(repository).confirmMapping({
    captureId: CAPTURE_ID,
    action: "MAP_EXISTING",
    contactId: 7,
    tinderIdentifier: "real-match-7",
    confirmed: true
  });

  assert.equal(result.status, "CONFLICT");
  assert.equal(repository.state.identifiers.length, 1);
  assert.equal(repository.state.identifiers[0].contact_id, 9);
});

test("a transaction failure rolls back the new contact, identity and capture mapping", async () => {
  const repository = fixtureRepository({ failAudit: true });
  await assert.rejects(
    () => service(repository).confirmMapping({
      captureId: CAPTURE_ID,
      action: "CREATE_NEW",
      newContactName: "Rollback Contact",
      tinderIdentifier: "real-match-100",
      confirmed: true
    }),
    /audit failure/
  );

  assert.equal(repository.state.createdContacts.length, 0);
  assert.equal(repository.state.identifiers.length, 0);
  assert.equal(repository.state.capture.mapping_status, "NEEDS_HUMAN_MAPPING");
  assert.equal(repository.state.capture.resolved_contact_id, null);
});
