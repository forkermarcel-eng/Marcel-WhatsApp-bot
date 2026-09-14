import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedTinderOfficialResumeSchemaEvidence,
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES,
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS,
  TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES
} from "../device-bridge/tinder-official-resume-schema-evidence-contract.js";

function counts(fields, values = {}) {
  return Object.fromEntries(fields.map(field => [field, values[field] || 0]));
}

function evidence(overrides = {}) {
  const value = {
    evidence_version: "tinder-official-resume-schema-profile-v1",
    safety_status: "BLOCKED_UNKNOWN_STRUCTURE",
    tree_truncated: false,
    visible_node_count: 7,
    maximum_visible_depth: 4,
    class_family_counts: counts(TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES, {
      TEXT_VIEW: 2, EDIT_TEXT: 1, IMAGE_VIEW: 1, RECYCLER_VIEW: 1, FRAME_LAYOUT: 2
    }),
    view_id_state_counts: counts(TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES, {
      ABSENT: 3, STATIC_TINDER_ID: 4
    }),
    role_counts: counts(TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS, {
      HEADER_CONTAINER: 1, HEADER_TITLE_LEAF: 1, MESSAGE_LIST: 1,
      COMPOSER_CONTAINER: 1, COMPOSER_EDITABLE: 1, MESSAGE_TEXT_LEAF: 2
    }),
    relation_flags: {
      header_before_message_list: true,
      message_list_before_composer: true,
      message_list_has_text_leaf: true,
      composer_has_editable_leaf: true,
      has_clickable_node: true,
      has_long_clickable_node: false,
      has_scrollable_node: true,
      has_text_present_node: true,
      has_content_description_present_node: false
    }
  };
  return { ...value, ...overrides };
}

test("official-resume schema evidence projects only an exact bounded aggregate profile", () => {
  const source = evidence();
  const projected = boundedTinderOfficialResumeSchemaEvidence(source);
  assert.notEqual(projected, null);
  assert.notEqual(projected, source);
  assert.deepEqual(projected, source);
  assert.equal(Object.isFrozen(projected), true);
  assert.equal(Object.isFrozen(projected.class_family_counts), true);
  assert.equal(Object.isFrozen(projected.role_counts), true);
});

test("official-resume schema evidence rejects raw-tree and identifier-shaped additions", () => {
  for (const invalid of [
    { ...evidence(), node_shapes: [] },
    { ...evidence(), raw_accessibility_tree: "forbidden" },
    { ...evidence(), structure_fingerprint: "forbidden" },
    { ...evidence(), package_name: "forbidden" },
    { ...evidence(), view_id_tokens: ["forbidden"] },
    { ...evidence(), class_names: ["forbidden"] },
    { ...evidence(), class_family_counts: {
      ...evidence().class_family_counts, raw_class_name: "forbidden"
    } }
  ]) {
    assert.equal(boundedTinderOfficialResumeSchemaEvidence(invalid), null);
  }
});

test("official-resume schema evidence rejects malformed aggregate invariants", () => {
  for (const invalid of [
    evidence({ visible_node_count: 8 }),
    evidence({ maximum_visible_depth: 13 }),
    evidence({ visible_node_count: 0, maximum_visible_depth: 1,
      class_family_counts: counts(TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES),
      view_id_state_counts: counts(TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES),
      role_counts: counts(TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS),
      relation_flags: {
        ...evidence().relation_flags,
        header_before_message_list: false,
        message_list_before_composer: false,
        message_list_has_text_leaf: false,
        composer_has_editable_leaf: false,
        has_clickable_node: false,
        has_scrollable_node: false,
        has_text_present_node: false
      } }),
    evidence({ role_counts: counts(TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS, {
      MESSAGE_LIST: 0, COMPOSER_CONTAINER: 1
    }), relation_flags: {
      ...evidence().relation_flags, message_list_before_composer: true,
      message_list_has_text_leaf: false
    } }),
    evidence({ role_counts: counts(TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS, {
      MESSAGE_LIST: 1, COMPOSER_CONTAINER: 1, COMPOSER_EDITABLE: 0, MESSAGE_TEXT_LEAF: 0
    }), relation_flags: {
      ...evidence().relation_flags, composer_has_editable_leaf: true,
      message_list_has_text_leaf: false
    } }),
    evidence({ safety_status: "SAFE" })
  ]) {
    assert.equal(boundedTinderOfficialResumeSchemaEvidence(invalid), null);
  }
});
