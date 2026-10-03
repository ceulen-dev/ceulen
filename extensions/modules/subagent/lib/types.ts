// ponytail: pi-ai / pi-agent-core types, derived from pi-coding-agent's public
// surface — the bundle's single-peer contract (pi-coding-agent + pi-tui only)
// forbids direct imports, and type derivation is the established ceulen
// pattern (classifier module derives ClassifierModel the same way).

import type { MessageEndEvent, ModelRegistry } from "@earendil-works/pi-coding-agent";

/** pi-ai `Model` via the registry facade's return type. Non-generic: the
 *  union instantiation accepts everything `Model<any>` accepted here
 *  (provider/id reads, createAgentSession's model param). */
export type Model = ReturnType<ModelRegistry["getAvailable"]>[number];

/** pi-agent-core `AgentMessage` via the session's message_end event payload. */
export type AgentMessage = MessageEndEvent["message"];

/** pi-ai `Message` alias — the module only reads role + content parts and
 *  (on assistant messages) usage/stopReason/model, all carried by AgentMessage. */
export type Message = AgentMessage;
