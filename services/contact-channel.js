// contact.id identifies a person. This field identifies only their WhatsApp route.
export function requireContactWhatsAppJid(contact) {
  const jid = contact?.whatsapp_jid;
  if (typeof jid !== "string" || !jid.trim()) {
    const error = new Error("Diesem Kontakt ist kein WhatsApp-Identifier zugeordnet.");
    error.statusCode = 409;
    error.code = "CONTACT_HAS_NO_WHATSAPP_IDENTIFIER";
    throw error;
  }
  return jid;
}
