/**
 * Exact, contentless grammar for one aggregate structural evidence profile
 * observed after an official-resume handoff reaches an otherwise safe but
 * unreviewed official Tinder surface.
 *
 * This is observational only. It cannot contain a raw Accessibility tree,
 * node sequence/topology, class name, resource identifier or token,
 * fingerprint, package name, text, description, name, permit, command,
 * capture, binding, timestamp, payload, URL, or exception material. It must
 * never participate in readiness, command, permit, reader, capture, or
 * ingress decisions.
 */

export const TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VERSION =
  "tinder-official-resume-schema-profile-v1";
export const TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_STATUS =
  "BLOCKED_UNKNOWN_STRUCTURE";
export const TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_MAXIMUM_NODE_COUNT = 128;
export const TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_MAXIMUM_DEPTH = 12;

/** Fixed class families only; a third-party class name never crosses this boundary. */
export const TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES = Object.freeze([
  "TEXT_VIEW",
  "EDIT_TEXT",
  "IMAGE_VIEW",
  "IMAGE_SWITCHER",
  "RECYCLER_VIEW",
  "FRAME_LAYOUT",
  "RELATIVE_LAYOUT",
  "LINEAR_LAYOUT",
  "VIEW_GROUP",
  "VIEW_FLIPPER",
  "VIEW",
  "OTHER"
]);

/** Presence/state only; raw and hashed resource identifiers are never transported. */
export const TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES = Object.freeze([
  "ABSENT",
  "STATIC_TINDER_ID",
  "REDACTED_OR_INVALID"
]);

/**
 * These are already-reviewed structural role *categories*, not message or
 * identity facts. A nonzero count never authorizes a reader or schema.
 */
export const TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS = Object.freeze([
  "HEADER_CONTAINER",
  "HEADER_TITLE_LEAF",
  "MESSAGE_LIST",
  "COMPOSER_CONTAINER",
  "COMPOSER_EDITABLE",
  "MESSAGE_TEXT_LEAF",
  "SYSTEM_OR_DATE_LEAF",
  "MESSAGE_ROW_CONTROL"
]);

const TOP_LEVEL_FIELDS = Object.freeze([
  "evidence_version",
  "safety_status",
  "tree_truncated",
  "visible_node_count",
  "maximum_visible_depth",
  "class_family_counts",
  "view_id_state_counts",
  "role_counts",
  "relation_flags"
]);
const RELATION_FLAG_FIELDS = Object.freeze([
  "header_before_message_list",
  "message_list_before_composer",
  "message_list_has_text_leaf",
  "composer_has_editable_leaf",
  "has_clickable_node",
  "has_long_clickable_node",
  "has_scrollable_node",
  "has_text_present_node",
  "has_content_description_present_node"
]);

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, fields) {
  return plainObject(value)
    && Object.keys(value).sort().join("|") === [...fields].sort().join("|");
}

function boundedInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function normalizedCounts(value, fields) {
  if (!exactKeys(value, fields)) return null;
  const result = {};
  for (const field of fields) {
    if (!boundedInteger(value[field], 0,
      TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_MAXIMUM_NODE_COUNT)) {
      return null;
    }
    result[field] = value[field];
  }
  return Object.freeze(result);
}

function normalizedRelationFlags(value) {
  if (!exactKeys(value, RELATION_FLAG_FIELDS)) return null;
  const result = {};
  for (const field of RELATION_FLAG_FIELDS) {
    if (typeof value[field] !== "boolean") return null;
    result[field] = value[field];
  }
  return Object.freeze(result);
}

function countsSum(counts) {
  return Object.values(counts).reduce((total, value) => total + value, 0);
}

/**
 * Projects only an exact finite aggregate profile. The result is rebuilt
 * instead of returning the input so future Android fields can never cross an
 * accepted heartbeat, durable audit event, or dashboard status boundary.
 */
export function boundedTinderOfficialResumeSchemaEvidence(value) {
  if (!exactKeys(value, TOP_LEVEL_FIELDS)
      || value.evidence_version !== TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VERSION
      || value.safety_status !== TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_STATUS
      || typeof value.tree_truncated !== "boolean"
      || !boundedInteger(value.visible_node_count, 0,
        TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_MAXIMUM_NODE_COUNT)
      || !boundedInteger(value.maximum_visible_depth, 0,
        TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_MAXIMUM_DEPTH)) {
    return null;
  }
  const classFamilyCounts = normalizedCounts(value.class_family_counts,
    TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_CLASS_FAMILIES);
  const viewIdStateCounts = normalizedCounts(value.view_id_state_counts,
    TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_VIEW_ID_STATES);
  const roleCounts = normalizedCounts(value.role_counts,
    TINDER_OFFICIAL_RESUME_SCHEMA_EVIDENCE_ROLE_COUNTS);
  const relationFlags = normalizedRelationFlags(value.relation_flags);
  if (classFamilyCounts === null || viewIdStateCounts === null || roleCounts === null
      || relationFlags === null
      || countsSum(classFamilyCounts) !== value.visible_node_count
      || countsSum(viewIdStateCounts) !== value.visible_node_count
      || (value.visible_node_count === 0 && value.maximum_visible_depth !== 0)
      || Object.values(roleCounts).some(count => count > value.visible_node_count)) {
    return null;
  }
  if ((roleCounts.HEADER_CONTAINER === 0 || roleCounts.MESSAGE_LIST === 0)
      && relationFlags.header_before_message_list) {
    return null;
  }
  if ((roleCounts.MESSAGE_LIST === 0 || roleCounts.COMPOSER_CONTAINER === 0)
      && relationFlags.message_list_before_composer) {
    return null;
  }
  if (roleCounts.COMPOSER_EDITABLE === 0 && relationFlags.composer_has_editable_leaf) {
    return null;
  }
  if (roleCounts.MESSAGE_TEXT_LEAF === 0 && relationFlags.message_list_has_text_leaf) {
    return null;
  }
  return Object.freeze({
    evidence_version: value.evidence_version,
    safety_status: value.safety_status,
    tree_truncated: value.tree_truncated,
    visible_node_count: value.visible_node_count,
    maximum_visible_depth: value.maximum_visible_depth,
    class_family_counts: classFamilyCounts,
    view_id_state_counts: viewIdStateCounts,
    role_counts: roleCounts,
    relation_flags: relationFlags
  });
}
