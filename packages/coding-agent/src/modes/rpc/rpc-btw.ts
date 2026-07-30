import type { AgentSession } from "../../session/agent-session";
import { BtwController, type BtwControllerRenderer } from "../controllers/btw-controller";

export interface RpcBtwAnswer {
	question: string;
	answer: string;
}

export interface RpcBtwAskResult {
	question: string;
	answer: string | null;
	cancelled: boolean;
}

export interface RpcBtwCancelResult {
	cancelled: boolean;
}

export interface RpcBtwBranchResult {
	branched: boolean;
	cancelled: boolean;
	sessionFile: string | null;
}

interface PendingBtwRequest {
	question: string;
	onTextDelta: (delta: string) => void;
	resolve: (result: RpcBtwAskResult) => void;
	reject: (error: Error) => void;
}

interface BtwBridge {
	next: PendingBtwRequest | undefined;
	active: PendingBtwRequest | undefined;
	branchResult: { cancelled: boolean; sessionFile: string | undefined } | undefined;
}

interface RpcBtwRuntime {
	controller: BtwController;
	bridge: BtwBridge;
}

const runtimes = new WeakMap<AgentSession, RpcBtwRuntime>();

function takeBranchResult(bridge: BtwBridge): BtwBridge["branchResult"] {
	const result = bridge.branchResult;
	bridge.branchResult = undefined;
	return result;
}

function takePending(bridge: BtwBridge): PendingBtwRequest | undefined {
	const pending = bridge.active ?? bridge.next;
	if (bridge.active === pending) bridge.active = undefined;
	if (bridge.next === pending) bridge.next = undefined;
	return pending;
}

function failPending(bridge: BtwBridge, message: string): void {
	const pending = bridge.next ?? bridge.active;
	if (bridge.next === pending) bridge.next = undefined;
	if (bridge.active === pending) bridge.active = undefined;
	pending?.reject(new Error(message));
}

function cancelPending(bridge: BtwBridge): void {
	const pending = bridge.active;
	bridge.active = undefined;
	if (!pending) return;
	pending.resolve({ question: pending.question, answer: null, cancelled: true });
}

function createRuntime(session: AgentSession): RpcBtwRuntime {
	const bridge: BtwBridge = { next: undefined, active: undefined, branchResult: undefined };
	const renderer: BtwControllerRenderer = {
		open: () => {
			bridge.active = bridge.next;
			bridge.next = undefined;
		},
		appendText: delta => {
			bridge.active?.onTextDelta(delta);
		},
		complete: answer => {
			const pending = takePending(bridge);
			if (!pending) return;
			pending.resolve({ question: pending.question, answer, cancelled: false });
		},
		abort: () => cancelPending(bridge),
		error: message => failPending(bridge, message),
		close: () => cancelPending(bridge),
	};
	const controller = new BtwController(
		{
			session,
			sessionManager: session.sessionManager,
			showStatus: message => failPending(bridge, message),
			showError: message => failPending(bridge, message),
			handleBtwBranch: async (question, assistantMessage) => {
				bridge.branchResult = await session.runSessionTransition(async transitionOptions => {
					const result = await session.branchFromBtw(question, assistantMessage, transitionOptions);
					return {
						result,
						committed: !result.cancelled,
						honorPlanDefault: false,
					};
				});
			},
		},
		renderer,
	);
	return { controller, bridge };
}

function getRuntime(session: AgentSession): RpcBtwRuntime {
	let runtime = runtimes.get(session);
	if (!runtime) {
		runtime = createRuntime(session);
		runtimes.set(session, runtime);
	}
	return runtime;
}

/** Runs the canonical `/btw` side turn and resolves after its final answer. */
export async function askRpcBtw(
	session: AgentSession,
	question: string,
	onTextDelta: (delta: string) => void,
): Promise<RpcBtwAskResult> {
	const runtime = getRuntime(session);
	const { promise, resolve, reject } = Promise.withResolvers<RpcBtwAskResult>();
	runtime.bridge.next = { question: question.trim(), onTextDelta, resolve, reject };
	try {
		await runtime.controller.start(question);
	} catch (error) {
		if (runtime.bridge.next) runtime.bridge.next = undefined;
		reject(error instanceof Error ? error : new Error(String(error)));
	}
	return promise;
}

/** Returns the last completed, non-empty side answer retained by the controller. */
export async function getRpcLastBtwAnswer(session: AgentSession): Promise<RpcBtwAnswer | null> {
	return getRuntime(session).controller.getLastAnswer() ?? null;
}

/** Cancels only an in-flight side question; a completed answer remains available. */
export async function cancelRpcBtw(session: AgentSession): Promise<RpcBtwCancelResult> {
	const runtime = getRuntime(session);
	if (!runtime.bridge.active) return { cancelled: false };
	return { cancelled: runtime.controller.handleEscape() };
}

/** Promotes the retained side answer through AgentSession.branchFromBtw. */
export async function branchRpcBtw(session: AgentSession): Promise<RpcBtwBranchResult> {
	const runtime = getRuntime(session);
	runtime.bridge.branchResult = undefined;
	if (!(await runtime.controller.handleBranch())) {
		throw new Error("No branchable /btw answer is available for the current session leaf.");
	}
	const result = takeBranchResult(runtime.bridge);
	if (!result) throw new Error("The /btw branch did not return a result.");
	if (!result.cancelled) runtime.controller.dispose();
	return {
		branched: !result.cancelled,
		cancelled: result.cancelled,
		sessionFile: result.sessionFile ?? null,
	};
}
