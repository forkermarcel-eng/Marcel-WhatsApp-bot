// Channel adapters supply this contract; no Appium/Baileys imports belong here.
function text(value, name, max = 2048) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max || /\u0000/.test(value)) {
    throw new TypeError(`${name} is invalid`);
  }
  return value || null;
}

export function normalizeAttachmentContext(input = {}) {
  const channel = text(input.channel, "channel", 64);
  if (!channel || !/^[a-z][a-z0-9_-]*$/.test(channel)) throw new TypeError("channel is required");
  const contactId = input.contactId == null ? null : Number(input.contactId);
  if (contactId !== null && (!Number.isSafeInteger(contactId) || contactId <= 0)) {
    throw new TypeError("contactId is invalid");
  }
  const direction = input.direction ?? null;
  if (![null, "inbound", "outbound"].includes(direction)) throw new TypeError("direction is invalid");
  const timestamp = input.timestamp == null ? null : new Date(input.timestamp);
  if (timestamp && Number.isNaN(timestamp.getTime())) throw new TypeError("timestamp is invalid");
  const sourceType = input.sourceType ?? "attachment";
  if (!["attachment", "profile", "avatar", "match"].includes(sourceType)) throw new TypeError("sourceType is invalid");
  if (sourceType !== "attachment" && direction !== null) throw new TypeError("profile/avatar media is not a message");
  const role = input.role ?? null;
  if (![null,"profile_primary","profile_photo","conversation_avatar","match_avatar"].includes(role)) throw new TypeError("media role invalid");
  const ordinal = input.ordinal ?? null;
  if (ordinal !== null && (!Number.isSafeInteger(ordinal) || ordinal < 0)) throw new TypeError("ordinal is invalid");
  const provenance = input.provenance ?? {};
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) throw new TypeError("provenance is invalid");
  const serialized = JSON.stringify(provenance);
  if (serialized.length > 16384) throw new TypeError("provenance exceeds limit");
  return Object.freeze({
    channel, contactId, sourceType, direction, ordinal, role,
    timestamp: timestamp?.toISOString() ?? null,
    messageReference: text(input.messageReference, "messageReference"),
    conversationReference: text(input.conversationReference, "conversationReference"),
    profileReference: text(input.profileReference, "profileReference"),
    matchReference: text(input.matchReference, "matchReference"),
    filename: text(input.filename, "filename", 255),
    caption: text(input.caption, "caption", 16000),
    provenance: Object.freeze(JSON.parse(serialized))
  });
}

export function attachmentOwners(context) {
  const value = normalizeAttachmentContext(context);
  const candidates = [
    ["contact", value.contactId == null ? null : String(value.contactId), "contacts", value.role || "gallery"],
    ["message", value.messageReference, value.channel, "attachment"],
    ["conversation", value.conversationReference, value.channel, value.role || value.sourceType],
    ["profile", value.profileReference, value.channel, value.role || "profile_media"],
    ["match", value.matchReference, value.channel, value.role || value.sourceType]
  ];
  const result = candidates.filter(([, ref]) => ref !== null).map(([type, ref, channel, role]) => ({
    ownerChannel: channel, ownerType: type, ownerReference: ref,
    relationshipType: role, ordinal: value.ordinal, context: value
  }));
  if (!result.length) throw new TypeError("an attachment requires an owner reference");
  return result;
}
