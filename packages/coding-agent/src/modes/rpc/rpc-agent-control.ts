import type { MCPManager } from "../../mcp/manager";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import type { AgentSession } from "../../session/agent-session";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { TanCommandController } from "../controllers/tan-command-controller";

export type RpcControllableAgentStatus = "running" | "idle" | "parked" | "aborted";

/** Session scans are shared so repeated listings neither duplicate nor restore released agents. */
const persistedSubagentRegistrations = new Map<string, Promise<void>>();

export interface RpcControllableAgent {
	id: string;
	displayName: string;
	parentId: string | null;
	status: RpcControllableAgentStatus;
	sessionFile: string | null;
	createdAt: string;
	lastActivity: string;
	activity: string | null;
	live: boolean;
}

export interface RpcAgentControlResult {
	id: string;
}

export interface RpcBackgroundAgent {
	dispatched: true;
}

function toRpcControllableAgent(ref: AgentRef): RpcControllableAgent {
	return {
		id: ref.id,
		displayName: ref.displayName,
		parentId: ref.parentId ?? null,
		status: ref.status,
		sessionFile: ref.sessionFile,
		createdAt: new Date(ref.createdAt).toISOString(),
		lastActivity: new Date(ref.lastActivity).toISOString(),
		activity: ref.activity ?? null,
		live: ref.session !== null,
	};
}

function requireControllableAgent(agentId: string): AgentRef {
	const ref = AgentRegistry.global().get(agentId);
	if (!ref || ref.id === MAIN_AGENT_ID || ref.kind !== "sub") {
		throw new Error(`Unknown controllable agent: ${agentId}`);
	}
	return ref;
}

/** Lists task subagents from the process-global AgentRegistry used by the Agent Hub. */
export async function listRpcControllableAgents(session: AgentSession): Promise<RpcControllableAgent[]> {
	const sessionFile = session.sessionManager.getSessionFile();
	if (sessionFile) {
		let registration = persistedSubagentRegistrations.get(sessionFile);
		if (!registration) {
			registration = registerPersistedSubagents(AgentRegistry.global(), sessionFile);
			persistedSubagentRegistrations.set(sessionFile, registration);
		}
		await registration;
	}
	return AgentRegistry.global()
		.list()
		.filter(ref => ref.id !== MAIN_AGENT_ID && ref.kind === "sub")
		.map(toRpcControllableAgent);
}

/** Revives a parked task subagent through the same lifecycle manager as the Agent Hub. */
export async function reviveRpcAgent(_session: AgentSession, agentId: string): Promise<RpcControllableAgent> {
	const ref = requireControllableAgent(agentId);
	if (ref.status !== "parked") {
		throw new Error(`Agent "${agentId}" is ${ref.status}; only parked agents can be revived.`);
	}
	await AgentLifecycleManager.global().ensureLive(agentId);
	return toRpcControllableAgent(requireControllableAgent(agentId));
}

/** Aborts a running task subagent, then releases it from the shared lifecycle registry. */
export async function killRpcAgent(_session: AgentSession, agentId: string): Promise<RpcAgentControlResult> {
	const ref = requireControllableAgent(agentId);
	if (ref.status !== "running" || !ref.session) {
		throw new Error(`Agent "${agentId}" is ${ref.status}; only running agents can be killed.`);
	}
	await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
	await AgentLifecycleManager.global().release(agentId, ref);
	return { id: agentId };
}

/** Sends a steering prompt directly to a live subagent session, matching focused hub submission. */
export async function promptRpcAgent(
	_session: AgentSession,
	agentId: string,
	text: string,
): Promise<RpcControllableAgent> {
	const ref = requireControllableAgent(agentId);
	if (!ref.session) {
		throw new Error(`Agent "${agentId}" is parked; revive it before sending a prompt.`);
	}
	if (!text.trim()) {
		throw new Error("Agent prompt must not be empty.");
	}
	await ref.session.prompt(text, { streamingBehavior: "steer" });
	return toRpcControllableAgent(requireControllableAgent(agentId));
}

/** Runs the canonical `/tan` workflow without requiring a terminal renderer. */
export async function spawnRpcBackgroundAgent(
	session: AgentSession,
	work: string,
	mcpManager?: MCPManager,
): Promise<RpcBackgroundAgent> {
	if (!work.trim()) throw new Error("Background agent work must not be empty.");

	let failure: string | undefined;
	const controller = new TanCommandController({
		session,
		sessionManager: session.sessionManager,
		settings: session.settings,
		mcpManager,
		showStatus: () => {},
		showError: message => {
			failure = message;
		},
		rebuildChatFromMessages: () => {},
	});
	await controller.start(work);
	if (failure) throw new Error(failure);
	return { dispatched: true };
}
