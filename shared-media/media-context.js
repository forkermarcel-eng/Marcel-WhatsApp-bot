// Read-side only: ordered messages and profile media share asset references,
// not storage paths, native channel SDK objects or automatically inferred facts.
import { mediaDeliveryUrl } from "./delivery.js";

export function createMediaContextReader({ listAttachments }) {
  if (typeof listAttachments !== "function") throw new TypeError("attachment reader required");
  return Object.freeze({ async read({ contactId, channel, conversationReference=null, profileReference=null, messages, profileLimit = 4 }) {
    if (!Number.isSafeInteger(contactId) || contactId < 1) throw new TypeError("contactId required");
    if (!Array.isArray(messages) || messages.length > 200) throw new TypeError("bounded message window required");
    if(!conversationReference&&!profileReference)throw new TypeError("conversation or profile reference required");
    if(!conversationReference&&messages.length)throw new TypeError("message context requires conversation reference");
    if (!Number.isInteger(profileLimit) || profileLimit < 0 || profileLimit > 20) throw new TypeError("profileLimit invalid");
    const refs = messages.map(m => m.messageReference);
    if (refs.some(r => typeof r !== "string" || !r) || new Set(refs).size !== refs.length) {
      throw new TypeError("unique message references required");
    }
    const attachments = await listAttachments({ contactId, channel, conversationReference, profileReference, messageReferences: refs, profileLimit });
    const scoped = attachments.filter(item => item.context?.contactId === contactId
      && item.context.channel === channel && ((conversationReference&&item.context.conversationReference === conversationReference)
        ||(profileReference&&item.context.sourceType==="profile"&&item.context.profileReference===profileReference)));
    const owner = { ownerChannel: "contacts", ownerType: "contact", ownerReference: String(contactId) };
    const project = item => {
      const available = item.asset.availability === "AVAILABLE";
      const analysis = Object.values(item.asset.metadata?.analyses || {});
      const derivatives = ["display", "thumbnail"].flatMap(variant => {
        const derivative = item.asset.metadata?.derivatives?.[variant];
        if (!available || !derivative?.storageKey) return [];
        return [{ variant, mimeType: derivative.mimeType, width: derivative.width,
          height: derivative.height, mediaReference: mediaDeliveryUrl(item.asset.assetId, owner, variant) }];
      });
      return { assetId: item.asset.assetId, mediaType: item.asset.mediaType,
      mimeType: item.asset.mimeType, availability: item.asset.availability,
      sourceType: item.context.sourceType, role: item.context.role ?? null,
      profileReference: item.context.profileReference ?? null,
      conversationReference: item.context.conversationReference ?? null,
      messageReference: item.context.messageReference ?? null,
      mediaReference: available && item.asset.storageKey ? mediaDeliveryUrl(item.asset.assetId, owner) : null,
      derivatives,
      caption: item.context.caption, direction: item.context.direction,
      timestamp: item.context.timestamp, ordinal: item.context.ordinal,
      analysisStatus: analysis.length ? "RESULTS_AVAILABLE" : "NOT_ANALYZED",
      analysis };
    };
    return {
      contactId, channel, conversationReference,...(profileReference?{profileReference}:{}),
      messages: messages.map(message => ({ ...message, attachments: scoped
        .filter(item => item.context.sourceType === "attachment" && item.context.messageReference === message.messageReference)
        .sort((a,b) => (a.context.ordinal ?? 0) - (b.context.ordinal ?? 0)).map(project) })),
      profileMedia: scoped.filter(item => item.context.sourceType === "profile").slice(0,profileLimit).map(project)
    };
  } });
}
