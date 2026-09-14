import {
  inspectTinderUnboundInboxConversationSweepRetainedSchemaForV9,
  inspectTinderUnboundInboxConversationSweepRetainedSchemaForV10,
  inspectTinderUnboundInboxConversationSweepSchema,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE
} from "./tinder-unbound-inbox-conversation-sweep-schema.js";
import {
  inspectTinderLocalConversationAttestationRetainedSchemaForV9,
  inspectTinderLocalConversationAttestationRetainedSchemaForV10,
  TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE
} from "./tinder-local-conversation-attestation-schema.js";
import {
  inspectTinderVerifiedChatReturnSchema,
  TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE
} from "./tinder-verified-chat-return-schema.js";
import {
  inspectTinderResumedForegroundChatReturnSchema,
  TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE
} from "./tinder-resumed-foreground-chat-return-schema.js";

/*
 * V8 runtime compatibility after the additive V9 command-vocabulary
 * successor.  Migration inspectors remain version-exact.  This narrow
 * runtime inspector exists only at V8 command-ACK/ingress boundaries, where
 * a V8 child must remain fail-closed unless either the exact V8 foundation or
 * the jointly canonical retained-V6, retained-V8, and V9 foundations are
 * present.
 */
export const TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE = Object.freeze({
  CANONICAL: "CANONICAL",
  INVALID: "INVALID"
});

export async function inspectTinderUnboundInboxConversationSweepRuntimeSchema(client, {
  inspectV8Schema = inspectTinderUnboundInboxConversationSweepSchema,
  inspectV8RetainedSchemaForV9 = inspectTinderUnboundInboxConversationSweepRetainedSchemaForV9,
  inspectV6RetainedSchemaForV9 = inspectTinderLocalConversationAttestationRetainedSchemaForV9,
  inspectV9Schema = inspectTinderVerifiedChatReturnSchema,
  inspectV8RetainedSchemaForV10 = inspectTinderUnboundInboxConversationSweepRetainedSchemaForV10,
  inspectV6RetainedSchemaForV10 = inspectTinderLocalConversationAttestationRetainedSchemaForV10,
  inspectV10Schema = inspectTinderResumedForegroundChatReturnSchema
} = {}) {
  const v8 = await inspectV8Schema(client);
  if (v8?.state === TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL) {
    return { state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.CANONICAL };
  }

  // Only the exact V8 INVALID successor shape can be reclassified through
  // V9.  UPGRADE_REQUIRED, trigger-repair, and unknown V8 states are not V9
  // evidence and must never cause a successor or retained-catalog read.
  if (v8?.state !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.INVALID) {
    return { state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.INVALID };
  }

  const v9 = await inspectV9Schema(client);
  // V10 is an optional successor while V8 is still deployed on older
  // catalog shapes.  An unavailable or malformed successor inspection is
  // never evidence for a fallback: collapse it to the same bounded INVALID
  // result used for any other unproven runtime foundation.  In particular,
  // do not leak a catalog/query failure through an ordinary V8 status path.
  let v10 = null;
  if (v9?.state !== TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL) {
    try {
      v10 = await inspectV10Schema(client);
    } catch {
      return { state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.INVALID };
    }
  }
  const v9Canonical = v9?.state === TINDER_VERIFIED_CHAT_RETURN_FOUNDATION_STATE.CANONICAL;
  const v10Canonical =
    v10?.state === TINDER_RESUMED_FOREGROUND_CHAT_RETURN_FOUNDATION_STATE.CANONICAL;
  if (!v9Canonical && !v10Canonical) {
    return { state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.INVALID };
  }

  const retainedV8 = v10Canonical
    ? await inspectV8RetainedSchemaForV10(client)
    : await inspectV8RetainedSchemaForV9(client);
  if (retainedV8?.state !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_FOUNDATION_STATE.CANONICAL) {
    return { state: TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.INVALID };
  }

  // V8 still queries V6's attestation permits for conflict exclusion. V9's
  // command-constraint proof and V8's retained catalog alone therefore do
  // not establish a safe runtime. Verify the unchanged V6 catalog and leave
  // the entire V8 child inert on any missing or drifted dependency.
  const retainedV6 = v10Canonical
    ? await inspectV6RetainedSchemaForV10(client)
    : await inspectV6RetainedSchemaForV9(client);
  return {
    state: retainedV6?.state === TINDER_LOCAL_CONVERSATION_ATTESTATION_FOUNDATION_STATE.CANONICAL
      ? TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.CANONICAL
      : TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.INVALID
  };
}

export async function assertTinderUnboundInboxConversationSweepRuntimeSchemaReady(client, options) {
  const inspection = await inspectTinderUnboundInboxConversationSweepRuntimeSchema(client, options);
  if (inspection.state !== TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_RUNTIME_FOUNDATION_STATE.CANONICAL) {
    throw new Error("Tinder unbound Inbox conversation sweep runtime schema is not ready.");
  }
  return inspection;
}
