import {
  createPgTinderUnboundInboxConversationSweepRepository,
  createTinderUnboundInboxConversationSweepService,
  TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_TYPES
} from "../services/tinder-unbound-inbox-conversation-sweep.js";

/*
V8 child projection runs inside the generic authenticated command-ACK
transaction.  A SUCCEEDED child ACK means STAGED only; the return receipt
route is deliberately separate and is the only next-slot authority.
*/
function inertPool() {
  return {
    async connect() {
      throw new Error("V8 ACK projection cannot open a nested transaction");
    },
    async query() {
      throw new Error("V8 ACK projection cannot query outside the ACK transaction");
    }
  };
}

export async function projectTinderUnboundInboxConversationSweepCommandAck(client, { command, ack } = {}) {
  if (!TINDER_UNBOUND_INBOX_CONVERSATION_SWEEP_COMMAND_TYPES.includes(command?.command_type)) return null;
  const repository = createPgTinderUnboundInboxConversationSweepRepository(inertPool());
  const service = createTinderUnboundInboxConversationSweepService(repository);
  return service.projectSweepChildAcknowledgement(client, { command, ack });
}
