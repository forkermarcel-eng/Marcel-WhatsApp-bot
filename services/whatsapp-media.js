const MEDIA = Object.freeze({ imageMessage: "image", videoMessage: "video", stickerMessage: "sticker",
  audioMessage: "audio", documentMessage: "document" });

// Importing this adapter never constructs, reconnects or pairs a WA socket.
export function createWhatsAppMediaAdapter({ ingress, loadBaileys = () => import("@whiskeysockets/baileys") }) {
  return Object.freeze({ async ingestMessage(message, { contactId, conversationReference, reuploadRequest, logger } = {}) {
    const { downloadMediaMessage, extractMessageContent } = await loadBaileys();
    const content = extractMessageContent(message?.message);
    const key = Object.keys(MEDIA).find(type => content?.[type]);
    if (!key) throw new TypeError("supported media message required");
    const media = content[key];
    const rawTime = message.messageTimestamp;
    const seconds = rawTime == null ? null : Number(rawTime?.toNumber?.() ?? rawTime);
    const context = { channel: "whatsapp", contactId, conversationReference,
      messageReference: message.key?.id, direction: message.key?.fromMe ? "outbound" : "inbound",
      timestamp: seconds == null ? null : new Date(seconds * 1000).toISOString(),
      caption: media.caption ?? null, filename: media.fileName ?? null,
      sourceType: "attachment", provenance: { kind: "channel_download", voiceNote: media.ptt === true } };
    let input;
    try {
      input = await downloadMediaMessage(message, "stream", {},
        reuploadRequest ? { reuploadRequest, logger } : undefined);
    } catch (error) {
      const status = error?.status ?? error?.output?.statusCode ?? error?.response?.status;
      if (![404,410].includes(status)) throw error;
      return ingress.unavailable({ context, mediaType: MEDIA[key], reason: "SOURCE_MEDIA_UNAVAILABLE" });
    }
    return ingress.ingest({ input, context, mediaType: MEDIA[key] });
  } });
}
