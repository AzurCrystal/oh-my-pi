import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../../session/agent-session";
import type { SessionTreeNode } from "../../session/session-entries";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	isLoopDurationExpired,
	type LoopLimitConfig,
	type LoopLimitRuntime,
} from "../loop-limit";

const LOOP_RESUBMIT_DELAY_MS = 800;

export type RpcLoopAction = "prompt" | "compact" | "reset";

export interface RpcLoopLimit {
	kind: "iterations" | "duration";
	initial?: number;
	remaining?: number;
	durationMs?: number;
	deadlineMs?: number;
}

export interface RpcLoopState {
	enabled: boolean;
	state: "waiting" | "running" | "paused";
	action: RpcLoopAction | null;
	prompt: string | null;
	limit: RpcLoopLimit | null;
}

export interface RpcPauseState {
	paused: boolean;
	pausedAt: number | null;
}

export interface RpcPauseResult extends RpcPauseState {
	changed: boolean;
	heldMs: number | null;
}

/** A JSON-safe session-tree node whose id can be passed directly to `navigate_tree`. */
export interface RpcSessionTreeNode {
	id: string;
	parentId: string | null;
	type: string;
	timestamp: string;
	label: string | null;
	messageRole: string | null;
	children: RpcSessionTreeNode[];
}

export interface RpcSessionTreeSnapshot {
	leafId: string | null;
	tree: RpcSessionTreeNode[];
}

interface RpcLoopRuntime {
	enabled: boolean;
	action: RpcLoopAction;
	prompt: string | undefined;
	limit: LoopLimitRuntime | undefined;
	timer: NodeJS.Timeout | undefined;
	promptInFlight: boolean;
}

interface RpcRuntimeControl {
	loop: RpcLoopRuntime;
	disposed: boolean;
	ownsPause: boolean;
	unsubscribeSession: () => void;
	unsubscribePause: () => void;
}

const runtimes = new WeakMap<AgentSession, RpcRuntimeControl>();

function emptyLoopRuntime(): RpcLoopRuntime {
	return {
		enabled: false,
		action: "prompt",
		prompt: undefined,
		limit: undefined,
		timer: undefined,
		promptInFlight: false,
	};
}

function loopLimitSnapshot(limit: LoopLimitRuntime | undefined): RpcLoopLimit | null {
	if (!limit) return null;
	if (limit.kind === "iterations") {
		return { kind: "iterations", initial: limit.initial, remaining: limit.remaining };
	}
	return { kind: "duration", durationMs: limit.durationMs, deadlineMs: limit.deadlineMs };
}

function loopSnapshot(runtime: RpcRuntimeControl | undefined): RpcLoopState {
	const loop = runtime?.loop;
	if (!loop?.enabled) {
		return { enabled: false, state: "waiting", action: null, prompt: null, limit: null };
	}
	return {
		enabled: true,
		state: loop.prompt === undefined ? "paused" : "running",
		action: loop.action,
		prompt: loop.prompt ?? null,
		limit: loopLimitSnapshot(loop.limit),
	};
}

function pauseSnapshot(): RpcPauseState {
	return { paused: agentPauseGate.paused, pausedAt: agentPauseGate.pausedAt ?? null };
}

function isAutoSubmitBlocked(session: AgentSession): boolean {
	return session.isStreaming || session.isCompacting || session.hasPostPromptWork;
}

function clearLoopTimer(loop: RpcLoopRuntime): void {
	if (!loop.timer) return;
	clearTimeout(loop.timer);
	loop.timer = undefined;
}

function pauseLoop(runtime: RpcRuntimeControl): void {
	const { loop } = runtime;
	loop.prompt = undefined;
	loop.promptInFlight = false;
	clearLoopTimer(loop);
}

function disableLoop(runtime: RpcRuntimeControl): void {
	const { loop } = runtime;
	loop.enabled = false;
	loop.prompt = undefined;
	loop.limit = undefined;
	loop.promptInFlight = false;
	clearLoopTimer(loop);
}

function reportLoopFailure(runtime: RpcRuntimeControl, error: unknown): void {
	if (runtime.disposed) return;
	pauseLoop(runtime);
	logger.error("RPC loop iteration failed", { error: error instanceof Error ? error.message : String(error) });
}

function scheduleLoopTask(runtime: RpcRuntimeControl, task: () => Promise<void>): void {
	const { loop } = runtime;
	if (runtime.disposed || !loop.enabled || loop.prompt === undefined || loop.timer) return;
	loop.timer = setTimeout(() => {
		loop.timer = undefined;
		void task().catch(error => reportLoopFailure(runtime, error));
	}, LOOP_RESUBMIT_DELAY_MS);
}

async function submitLoopPromptWhenReady(session: AgentSession, runtime: RpcRuntimeControl): Promise<void> {
	const { loop } = runtime;
	const prompt = loop.prompt;
	if (runtime.disposed || session.isDisposed || !loop.enabled || prompt === undefined) return;
	if (isLoopDurationExpired(loop.limit)) {
		disableLoop(runtime);
		return;
	}
	if (isAutoSubmitBlocked(session)) {
		scheduleLoopTask(runtime, () => submitLoopPromptWhenReady(session, runtime));
		return;
	}

	loop.promptInFlight = true;
	try {
		await session.prompt(prompt);
	} catch (error) {
		loop.promptInFlight = false;
		throw error;
	}
}

async function runLoopIteration(session: AgentSession, runtime: RpcRuntimeControl): Promise<void> {
	const { loop } = runtime;
	if (runtime.disposed || session.isDisposed || !loop.enabled || loop.prompt === undefined) return;
	if (isAutoSubmitBlocked(session)) {
		scheduleLoopTask(runtime, () => runLoopIteration(session, runtime));
		return;
	}
	if (loop.action === "reset" && session.getVibeModeState()?.enabled) {
		disableLoop(runtime);
		return;
	}
	if (!consumeLoopLimitIteration(loop.limit)) {
		disableLoop(runtime);
		return;
	}

	if (loop.action === "compact") {
		await session.compact();
	} else if (loop.action === "reset") {
		await session.newSession();
	}
	await submitLoopPromptWhenReady(session, runtime);
}

function runtimeFor(session: AgentSession): RpcRuntimeControl {
	const existing = runtimes.get(session);
	if (existing) return existing;

	const runtime: RpcRuntimeControl = {
		loop: emptyLoopRuntime(),
		disposed: false,
		ownsPause: false,
		unsubscribeSession: () => {},
		unsubscribePause: () => {},
	};
	runtime.unsubscribeSession = session.subscribe(event => {
		if (event.type !== "agent_end" || event.isTerminal === false || !runtime.loop.promptInFlight) return;
		runtime.loop.promptInFlight = false;
		scheduleLoopTask(runtime, () => runLoopIteration(session, runtime));
	});
	runtime.unsubscribePause = agentPauseGate.onChange(paused => {
		if (!paused) runtime.ownsPause = false;
	});
	runtimes.set(session, runtime);
	return runtime;
}

function loopLimit(count: number | undefined, durationMs: number | undefined): LoopLimitRuntime | undefined {
	if (count !== undefined && durationMs !== undefined) {
		throw new Error("Provide either count or durationMs, not both.");
	}
	if (count !== undefined) {
		if (!Number.isSafeInteger(count) || count <= 0) throw new Error("Loop count must be a positive integer.");
		const config: LoopLimitConfig = { kind: "iterations", iterations: count };
		return createLoopLimitRuntime(config);
	}
	if (durationMs !== undefined) {
		if (!Number.isSafeInteger(durationMs) || durationMs <= 0) {
			throw new Error("Loop duration must be a positive integer number of milliseconds.");
		}
		const config: LoopLimitConfig = { kind: "duration", durationMs };
		return createLoopLimitRuntime(config);
	}
	return undefined;
}

/** Installs event listeners and returns the teardown required when the RPC session ends. */
export function installRpcRuntimeControl(session: AgentSession): () => void {
	runtimeFor(session);
	return () => disposeRpcRuntimeControl(session);
}

/** Stops the loop, removes listeners, and releases a global pause initiated by this RPC session. */
export function disposeRpcRuntimeControl(session: AgentSession): void {
	const runtime = runtimes.get(session);
	if (!runtime) return;
	runtimes.delete(session);
	runtime.disposed = true;
	disableLoop(runtime);
	runtime.unsubscribeSession();
	runtime.unsubscribePause();
	if (runtime.ownsPause && agentPauseGate.paused) agentPauseGate.resume();
}

/** Enables a headless `/loop`; the initial prompt is submitted immediately when the session is idle. */
export async function enableRpcLoop(
	session: AgentSession,
	prompt: string,
	action: RpcLoopAction | undefined = undefined,
	count: number | undefined = undefined,
	durationMs: number | undefined = undefined,
): Promise<RpcLoopState> {
	if (session.isDisposed) throw new Error("Cannot enable loop on a disposed session.");
	if (!prompt.trim()) throw new Error("Loop prompt must not be empty.");
	const runtime = runtimeFor(session);
	disableLoop(runtime);
	runtime.loop.enabled = true;
	runtime.loop.action = action ?? session.settings.get("loop.mode");
	runtime.loop.prompt = prompt;
	runtime.loop.limit = loopLimit(count, durationMs);
	void submitLoopPromptWhenReady(session, runtime).catch(error => reportLoopFailure(runtime, error));
	return loopSnapshot(runtime);
}

/** Disables a headless loop and prevents any pending repeat from running. */
export async function disableRpcLoop(session: AgentSession): Promise<RpcLoopState> {
	const runtime = runtimes.get(session);
	if (runtime) disableLoop(runtime);
	return loopSnapshot(runtime);
}

/** Reads the loop state for this session without creating a runtime. */
export async function readRpcLoopState(session: AgentSession): Promise<RpcLoopState> {
	return loopSnapshot(runtimes.get(session));
}

/** Mirrors Esc during `/loop`: pause future repeats and abort only the active prompt turn. */
export async function cancelRpcLoopIteration(session: AgentSession): Promise<RpcLoopState> {
	const runtime = runtimes.get(session);
	if (!runtime) return loopSnapshot(undefined);
	pauseLoop(runtime);
	if (session.isStreaming) await session.abort();
	return loopSnapshot(runtime);
}

/** Engages the same process-wide gate as `/pause`. */
export async function pauseRpcAgents(session: AgentSession): Promise<RpcPauseResult> {
	if (session.isDisposed) throw new Error("Cannot pause agents from a disposed session.");
	const runtime = runtimeFor(session);
	const changed = agentPauseGate.pause();
	runtime.ownsPause = changed;
	return { ...pauseSnapshot(), changed, heldMs: null };
}

/** Releases the process-wide pause gate without aborting any parked work. */
export async function resumeRpcAgents(session: AgentSession): Promise<RpcPauseResult> {
	const runtime = runtimes.get(session);
	const heldMs = agentPauseGate.resume();
	if (runtime) runtime.ownsPause = false;
	return { ...pauseSnapshot(), changed: heldMs !== undefined, heldMs: heldMs ?? null };
}

/** Reads the process-wide pause gate state. */
export async function readRpcPauseState(_session: AgentSession): Promise<RpcPauseState> {
	return pauseSnapshot();
}

function treeNodeSnapshot(node: SessionTreeNode): RpcSessionTreeNode {
	const { entry } = node;
	return {
		id: entry.id,
		parentId: entry.parentId,
		type: entry.type,
		timestamp: entry.timestamp,
		label: node.label ?? null,
		messageRole: entry.type === "message" ? entry.message.role : null,
		children: node.children.map(treeNodeSnapshot),
	};
}

/** Returns the complete branch structure and its active leaf; every returned node id is a `navigate_tree` target. */
export async function readRpcSessionTree(session: AgentSession): Promise<RpcSessionTreeSnapshot> {
	return {
		leafId: session.sessionManager.getLeafId(),
		tree: session.sessionManager.getTree().map(treeNodeSnapshot),
	};
}
