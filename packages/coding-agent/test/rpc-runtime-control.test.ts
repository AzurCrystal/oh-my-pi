import { afterEach, describe, expect, test, vi } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import * as rpcCollab from "../src/modes/rpc/rpc-collab";
import { feedRpcIdleEvent, installRpcIdleBehavior, type RpcIdleBehaviorSuspension } from "../src/modes/rpc/rpc-idle";
import { runRpcSessionTransitionAtCommit } from "../src/modes/rpc/rpc-mode";
import {
	enableRpcLoop,
	installRpcRuntimeControl,
	pauseRpcAgents,
	type RpcRuntimeControlSuspension,
	readRpcLoopState,
	suspendRpcRuntimeControl,
} from "../src/modes/rpc/rpc-runtime-control";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";
import type { SessionTransitionRunner, SessionTransitionRunOptions } from "../src/session/agent-session-types";
import { SessionManager } from "../src/session/session-manager";

function fakeSession(): AgentSession {
	return {
		isDisposed: false,
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 10; index++) await Promise.resolve();
}

afterEach(() => {
	agentPauseGate.resume();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("RPC runtime loop guest guard", () => {
	test("rejects reset before installing the loop or submitting its first prompt", async () => {
		const subscribe = vi.fn(() => () => {});
		const prompt = vi.fn(async () => {});
		const newSession = vi.fn(async () => true);
		const session = {
			isDisposed: false,
			isStreaming: false,
			isCompacting: false,
			hasPostPromptWork: false,
			subscribe,
			prompt,
			newSession,
			settings: { get: () => "prompt" },
			getVibeModeState: () => undefined,
		} as unknown as AgentSession;
		vi.spyOn(rpcCollab, "isRpcCollabGuest").mockReturnValue(true);

		await expect(enableRpcLoop(session, "repeat", "reset")).rejects.toThrow("Run leave_collab_session first.");

		expect(await readRpcLoopState(session)).toEqual({
			enabled: false,
			state: "waiting",
			action: null,
			prompt: null,
			limit: null,
		});
		expect(subscribe).not.toHaveBeenCalled();
		expect(prompt).not.toHaveBeenCalled();
		expect(newSession).not.toHaveBeenCalled();
	});

	test("does not consume a cancelled reset and continues exactly once after a committed reset", async () => {
		vi.useFakeTimers();
		let listener: ((event: AgentSessionEvent) => void) | undefined;
		let createSession = false;
		let transitionOptions: SessionTransitionRunOptions | undefined;
		const prompt = vi.fn(async () => {});
		const newSession = vi.fn(async () => createSession);
		const runSessionTransition: SessionTransitionRunner = async (transition, options) => {
			transitionOptions = options;
			return (await transition({})).result;
		};
		const session = {
			isDisposed: false,
			isStreaming: false,
			isCompacting: false,
			hasPostPromptWork: false,
			subscribe: (next: (event: AgentSessionEvent) => void) => {
				listener = next;
				return () => {};
			},
			prompt,
			newSession,
			runSessionTransition,
			settings: { get: () => "prompt" },
			getVibeModeState: () => undefined,
		} as unknown as AgentSession;

		await enableRpcLoop(session, "repeat", "reset", 2);
		expect(prompt).toHaveBeenCalledTimes(1);
		listener?.({ type: "agent_end", messages: [], isTerminal: true });
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(newSession).toHaveBeenCalledTimes(1);
		expect(prompt).toHaveBeenCalledTimes(1);
		expect(await readRpcLoopState(session)).toMatchObject({
			enabled: true,
			state: "paused",
			limit: { remaining: 2 },
		});
		expect(transitionOptions).toEqual({ preserveLoopConfiguration: true });

		await enableRpcLoop(session, "repeat", "reset", 2);
		createSession = true;
		listener?.({ type: "agent_end", messages: [], isTerminal: true });
		vi.advanceTimersByTime(800);
		await flushMicrotasks();

		expect(newSession).toHaveBeenCalledTimes(2);
		expect(prompt).toHaveBeenCalledTimes(3);
		expect(await readRpcLoopState(session)).toMatchObject({
			enabled: true,
			state: "running",
			limit: { remaining: 1 },
		});
	});
});

describe("RPC runtime transition suspension", () => {
	test("same-session reload restores loop, idle timers, and owned pause exactly once", async () => {
		vi.useFakeTimers();
		let listener: ((event: AgentSessionEvent) => void) | undefined;
		let transitionRunner: SessionTransitionRunner = async transition => (await transition({})).result;
		const prompt = vi.fn(async () => {});
		const runSessionTransition: SessionTransitionRunner = (transition, options) =>
			transitionRunner(transition, options);
		const runEphemeralTurn = vi.fn(async () => ({ replyText: "One idle recap" }));
		const recap = vi.fn();
		const session = {
			isDisposed: false,
			isStreaming: false,
			isCompacting: false,
			hasPostPromptWork: false,
			sessionManager: SessionManager.inMemory("."),
			model: { id: "test-model" },
			messages: [{}],
			subscribe: (next: (event: AgentSessionEvent) => void) => {
				listener = next;
				return () => {};
			},
			prompt,
			runEphemeralTurn,
			runIdleCompaction: async () => {},
			getContextUsage: () => ({ tokens: 0 }),
			getGoalModeState: () => undefined,
			getTodoPhases: () => [],
			settings: {
				get: () => "prompt",
				getGroup: (group: string) =>
					group === "compaction"
						? { idleEnabled: false, idleThresholdTokens: 0, idleTimeoutSeconds: 60 }
						: { enabled: true, idleSeconds: 1 },
			},
			runSessionTransition,
		} as unknown as AgentSession;
		const disposeRuntime = installRpcRuntimeControl(session);
		const idleBehavior = installRpcIdleBehavior(session, undefined, recap);
		transitionRunner = async (transition, options = {}) => {
			let runtimeSuspension: RpcRuntimeControlSuspension | undefined;
			let idleSuspension: RpcIdleBehaviorSuspension | undefined;
			return runRpcSessionTransitionAtCommit(
				transition,
				async () => {
					runtimeSuspension = suspendRpcRuntimeControl(session);
					idleSuspension = idleBehavior.suspend();
				},
				async ({ committed }) => {
					if (committed) {
						runtimeSuspension?.commit(options.preserveLoopConfiguration === true);
						idleSuspension?.commit();
					} else {
						runtimeSuspension?.rollback();
						idleSuspension?.rollback();
					}
				},
				options.honorPlanDefaultOnCommit === true,
				options.preserveCurrentSessionOnSuccess === true,
			);
		};

		await enableRpcLoop(session, "repeat this", "prompt", 3);
		await flushMicrotasks();
		expect(await pauseRpcAgents(session)).toMatchObject({ paused: true, changed: true });
		listener?.({ type: "agent_end", messages: [], isTerminal: true });
		feedRpcIdleEvent(idleBehavior, { type: "agent_end", messages: [], isTerminal: true });

		await session.runSessionTransition(
			async transitionOptions => {
				await transitionOptions.beforeCommit?.();
				return { result: true, committed: true, honorPlanDefault: false };
			},
			{ preserveCurrentSessionOnSuccess: true },
		);

		expect(await readRpcLoopState(session)).toEqual({
			enabled: true,
			state: "running",
			action: "prompt",
			prompt: "repeat this",
			limit: { kind: "iterations", initial: 3, remaining: 3 },
		});
		expect(agentPauseGate.paused).toBe(true);

		vi.advanceTimersByTime(800);
		await flushMicrotasks();
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(await readRpcLoopState(session)).toMatchObject({
			action: "prompt",
			prompt: "repeat this",
			limit: { remaining: 2 },
		});

		vi.advanceTimersByTime(2_200);
		await flushMicrotasks();
		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(recap).toHaveBeenCalledWith("One idle recap");
		expect(prompt).toHaveBeenCalledTimes(2);
		expect(agentPauseGate.paused).toBe(true);

		idleBehavior.dispose();
		disposeRuntime();
		expect(agentPauseGate.paused).toBe(false);
	});
});

describe("RPC runtime pause control", () => {
	test("releases its pause after repeated idempotent pause requests", async () => {
		const session = fakeSession();
		const dispose = installRpcRuntimeControl(session);

		expect((await pauseRpcAgents(session)).changed).toBe(true);
		expect((await pauseRpcAgents(session)).changed).toBe(false);
		dispose();

		expect(agentPauseGate.paused).toBe(false);
	});

	test("does not release a pause acquired by another owner", async () => {
		agentPauseGate.pause();
		const session = fakeSession();
		const dispose = installRpcRuntimeControl(session);

		expect((await pauseRpcAgents(session)).changed).toBe(false);
		dispose();

		expect(agentPauseGate.paused).toBe(true);
	});
});
