import type { AgentSession } from "../../session/agent-session";
import * as rpcCollab from "./rpc-collab";

export interface RpcSessionTransitionGuestBlock {
	message: string;
	code: "operation_failed";
}

const GUEST_SESSION_TRANSITION_MESSAGE =
	"Session changes are unavailable while joined as a collaboration guest. Run leave_collab_session first.";

/** Returns the protocol error for a session transition attempted by a collaboration guest. */
export function getRpcSessionTransitionGuestBlock(session: AgentSession): RpcSessionTransitionGuestBlock | undefined {
	if (!rpcCollab.isRpcCollabGuest(session)) return undefined;
	return { message: GUEST_SESSION_TRANSITION_MESSAGE, code: "operation_failed" };
}

/** Rejects indirect RPC paths before they mutate a collaboration guest replica. */
export function assertRpcSessionTransitionAllowed(session: AgentSession): void {
	const block = getRpcSessionTransitionGuestBlock(session);
	if (block) throw new Error(block.message);
}
