import { afterEach, describe, expect, test, vi } from "bun:test";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { TempDir } from "@oh-my-pi/pi-utils";
import { GoalRuntime, type GoalRuntimeHost } from "../src/goals/runtime";
import type { GoalModeState, GoalTokenUsage } from "../src/goals/state";
import * as rpcCollab from "../src/modes/rpc/rpc-collab";
import { runRpcSessionTransitionAtCommit } from "../src/modes/rpc/rpc-mode";
import {
	approveRpcPlanProposal,
	beginRpcGuidedGoal,
	clearRpcTransientModeState,
	createRpcGoal,
	enterRpcPlanMode,
	enterRpcVibeMode,
	exitRpcPlanMode,
	exitRpcVibeMode,
	pauseRpcGoal,
	type RpcTransientModeSuspension,
	readRpcPlanModeState,
	rejectRpcPlanProposal,
	submitRpcPlanReview,
} from "../src/modes/rpc/rpc-work-modes";
import type { PlanModeState } from "../src/plan-mode/state";
import type { AgentSession } from "../src/session/agent-session";
import type { SessionTransitionRunner } from "../src/session/agent-session-types";
import { SessionManager } from "../src/session/session-manager";
import type { PlanProposalHandler } from "../src/tools/resolve";
import { VibeSessionRegistry } from "../src/vibe/runtime";
import type { VibeModeState } from "../src/vibe/state";

const VIBE_EPHEMERAL_TOOL = "vibe_spawn";

function createVibeSession(
	sessionManager: SessionManager,
	initialState: VibeModeState | undefined,
): { session: AgentSession; activeTools: () => string[] } {
	let vibeModeState: VibeModeState | undefined = initialState;
	let activeTools = ["read", "bash"];
	const session = {
		sessionManager,
		asyncJobManager: undefined,
		isStreaming: false,
		getAgentId: () => "test-agent",
		getPlanModeState: () => undefined,
		setPlanModeState: () => {},
		getGoalModeState: () => undefined,
		setGoalModeState: () => {},
		getVibeModeState: () => vibeModeState,
		setVibeModeState: (state: VibeModeState | undefined) => {
			vibeModeState = state;
		},
		peekPlanProposalHandler: () => undefined,
		setPlanProposalHandler: () => {},
		getEnabledToolNames: () => [...activeTools],
		setActiveToolsByName: async (names: string[]) => {
			activeTools = [...names];
		},
		activateVibeTools: async (baseToolNames: string[]) => {
			activeTools = [...baseToolNames, VIBE_EPHEMERAL_TOOL];
		},
		deactivateVibeTools: async (nextToolNames: string[]) => {
			activeTools = [...nextToolNames];
		},
		removeVibeToolsPreservingActive: async () => {
			activeTools = activeTools.filter(name => name !== VIBE_EPHEMERAL_TOOL);
		},
	} as unknown as AgentSession;
	return { session, activeTools: () => [...activeTools] };
}

function createPlanSession(options?: { cwd?: string; proposalPath?: string }) {
	const sessionManager = SessionManager.inMemory(options?.cwd ?? ".");
	const baseModel = { id: "base-model", provider: "test" } as unknown as Model;
	const planModel = { id: "plan-model", provider: "test" } as unknown as Model;
	let activeTools = ["read", "bash"];
	let activeModel = baseModel;
	let nextToolRestoreError: Error | undefined;
	let nextModelRestoreError: Error | undefined;
	let planModeState: PlanModeState | undefined;
	let planProposalHandler: PlanProposalHandler | undefined;
	const newSession = vi.fn(async () => true);
	let transitionRunner: SessionTransitionRunner = async transition => (await transition({})).result;
	const runSessionTransition: SessionTransitionRunner = (transition, transitionOptions) =>
		transitionRunner(transition, transitionOptions);
	const session = {
		sessionManager,
		isStreaming: false,
		settings: { get: (key: string) => key === "plan.enabled" },
		get model() {
			return activeModel;
		},
		waitForIdle: async () => {},
		subscribe: () => () => {},
		getPlanModeState: () => planModeState,
		setPlanModeState: (state: PlanModeState | undefined) => {
			planModeState = state;
		},
		getGoalModeState: () => undefined,
		setGoalModeState: () => {},
		getVibeModeState: () => undefined,
		setVibeModeState: () => {},
		peekPlanProposalHandler: () => planProposalHandler,
		setPlanProposalHandler: (handler: PlanProposalHandler | null) => {
			planProposalHandler = handler ?? undefined;
		},
		prompt: async () => {},
		followUp: async () => {},
		preparePlanForReview: async (title: string) => ({
			details: {
				planFilePath: options?.proposalPath ?? "local://PLAN.md",
				title,
				planExists: true,
			},
		}),
		getPlanReferencePath: () => undefined,
		hasBuiltInTool: (name: string) => name === "write",
		getEnabledToolNames: () => [...activeTools],
		setActiveToolsByName: async (names: string[]) => {
			const error = nextToolRestoreError;
			nextToolRestoreError = undefined;
			if (error) throw error;
			activeTools = [...names];
		},
		configuredThinkingLevel: () => undefined,
		resolveRoleModelWithThinking: () => ({
			model: planModel,
			thinkingLevel: undefined,
			explicitThinkingLevel: false,
		}),
		setModelTemporary: async (model: Model) => {
			const error = nextModelRestoreError;
			nextModelRestoreError = undefined;
			if (error) throw error;
			activeModel = model;
		},
		setThinkingLevel: () => {},
		newSession,
		runSessionTransition,
		markPlanInternalAbortPending: () => {},
		clearPlanInternalAbortPending: () => {},
		setPlanReferencePath: () => {},
		markPlanReferenceSent: () => {},
	} as unknown as AgentSession;
	return {
		session,
		sessionManager,
		newSession,
		activeTools: () => [...activeTools],
		activeModelId: () => activeModel.id,
		failNextToolRestore: (error: Error) => {
			nextToolRestoreError = error;
		},
		failNextModelRestore: (error: Error) => {
			nextModelRestoreError = error;
		},
		setTransitionRunner: (runner: SessionTransitionRunner) => {
			transitionRunner = runner;
		},
	};
}

function createWorkModeTransitionRunner(
	session: AgentSession,
	quiesce: () => Promise<void> = async () => {},
): SessionTransitionRunner {
	return async (transition, options = {}) => {
		let suspension: RpcTransientModeSuspension | undefined;
		return runRpcSessionTransitionAtCommit(
			transition,
			async () => {
				await quiesce();
				suspension = await clearRpcTransientModeState(session, { reversibleVibeSuspension: true });
			},
			async ({ committed }) => {
				if (committed) await suspension?.commit();
				else await suspension?.rollback();
			},
			options.honorPlanDefaultOnCommit === true,
			options.preserveCurrentSessionOnSuccess === true,
		);
	};
}

function createGuidedGoalSession(options: { streaming: boolean; goalEnabled?: boolean; submitError?: Error }) {
	const sessionManager = SessionManager.create(".", ".");
	let enabledTools = ["read"];
	const submit = vi.fn(async (_text: string, _options?: { synthetic?: boolean }) => {
		if (options.submitError) throw options.submitError;
	});
	const followUp = vi.fn(async (_text: string, _images?: unknown, _options?: { synthetic?: boolean }) => {});
	const setActiveToolsByName = vi.fn(async (names: string[]) => {
		enabledTools = [...names];
	});
	const session = {
		sessionManager,
		settings: {
			get: (key: string) => (key === "goal.enabled" ? (options.goalEnabled ?? true) : undefined),
		},
		getPlanModeState: () => undefined,
		getGoalModeState: () => undefined,
		getVibeModeState: () => undefined,
		getEnabledToolNames: () => [...enabledTools],
		setActiveToolsByName,
		subscribe: () => () => {},
		isStreaming: options.streaming,
		prompt: submit,
		followUp,
	} as unknown as AgentSession;
	return {
		session,
		submit,
		followUp,
		setActiveToolsByName,
		enabledTools: () => [...enabledTools],
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	VibeSessionRegistry.resetGlobalForTests();
});

describe("RPC guided goal", () => {
	test("activates the goal tool and reports direct versus queued kickoff delivery", async () => {
		const direct = createGuidedGoalSession({ streaming: false });
		expect(await beginRpcGuidedGoal(direct.session, "Ship the release")).toEqual({ queued: false });
		expect(direct.enabledTools()).toEqual(["read", "goal"]);
		expect(direct.submit).toHaveBeenCalledWith(expect.stringContaining("Ship the release"), { synthetic: true });
		expect(direct.followUp).not.toHaveBeenCalled();

		const queued = createGuidedGoalSession({ streaming: true });
		expect(await beginRpcGuidedGoal(queued.session)).toEqual({ queued: true });
		expect(queued.enabledTools()).toEqual(["read", "goal"]);
		expect(queued.submit).not.toHaveBeenCalled();
		expect(queued.followUp).toHaveBeenCalledWith(expect.any(String), undefined, { synthetic: true });

		const raced = createGuidedGoalSession({ streaming: false, submitError: new AgentBusyError() });
		expect(await beginRpcGuidedGoal(raced.session, "Handle the race")).toEqual({ queued: true });
		expect(raced.submit).toHaveBeenCalledTimes(1);
		expect(raced.followUp).toHaveBeenCalledWith(expect.stringContaining("Handle the race"), undefined, {
			synthetic: true,
		});

		const disabled = createGuidedGoalSession({ streaming: false, goalEnabled: false });
		await expect(beginRpcGuidedGoal(disabled.session)).rejects.toThrow(
			"Goal mode is disabled. Enable it in settings (goal.enabled).",
		);
		expect(disabled.setActiveToolsByName).not.toHaveBeenCalled();
	});

	test("serializes guided setup and rolls back failed kickoff tools", async () => {
		const concurrent = createGuidedGoalSession({ streaming: false });
		const pending = Promise.withResolvers<void>();
		concurrent.submit.mockImplementationOnce(() => pending.promise);
		const first = beginRpcGuidedGoal(concurrent.session, "First");
		await expect(beginRpcGuidedGoal(concurrent.session, "Second")).rejects.toThrow(
			"Goal setup is already in progress.",
		);
		pending.resolve();
		await expect(first).resolves.toEqual({ queued: false });

		const failed = createGuidedGoalSession({ streaming: false });
		failed.submit.mockRejectedValueOnce(new Error("kickoff failed")).mockResolvedValueOnce(undefined);
		await expect(beginRpcGuidedGoal(failed.session, "Retry me")).rejects.toThrow("kickoff failed");
		expect(failed.enabledTools()).toEqual(["read"]);
		await expect(beginRpcGuidedGoal(failed.session, "Retry me")).resolves.toEqual({ queued: false });
		expect(failed.enabledTools()).toEqual(["read", "goal"]);
	});

	test("restores an active goal when tool restoration fails during pause", async () => {
		const sessionManager = SessionManager.inMemory(".");
		let state: GoalModeState | undefined;
		let tools = ["read"];
		let failNextToolChange = false;
		const activeGoal = {
			id: "goal-1",
			objective: "Keep working",
			status: "active" as const,
			tokensUsed: 0,
			timeUsedSeconds: 0,
			createdAt: 1,
			updatedAt: 1,
		};
		const session = {
			sessionManager,
			settings: { get: (key: string) => key === "goal.enabled" },
			isStreaming: false,
			subscribe: () => () => {},
			prompt: async () => {},
			getPlanModeState: () => undefined,
			getGoalModeState: () => state,
			setGoalModeState: (next: GoalModeState | undefined) => {
				state = next;
			},
			getVibeModeState: () => undefined,
			getEnabledToolNames: () => [...tools],
			setActiveToolsByName: async (next: string[]) => {
				if (failNextToolChange) {
					failNextToolChange = false;
					throw new Error("tool restore failed");
				}
				tools = [...next];
			},
			goalRuntime: {
				createGoal: async () => ({ enabled: true, mode: "active", goal: activeGoal }),
				pauseGoal: async () => {
					state = { enabled: false, mode: "active", goal: { ...activeGoal, status: "paused" } };
					return state;
				},
				resumeGoal: async () => {
					state = { enabled: true, mode: "active", goal: activeGoal };
					return state;
				},
			},
		} as unknown as AgentSession;

		await createRpcGoal(session, activeGoal.objective);
		failNextToolChange = true;
		await expect(pauseRpcGoal(session)).rejects.toThrow("Failed to pause goal mode: tool restore failed");
		expect(state?.enabled).toBe(true);
		expect(state?.goal.status).toBe("active");
		expect(tools).toEqual(["read", "goal"]);

		await expect(pauseRpcGoal(session)).resolves.toMatchObject({ enabled: false });
		expect(tools).toEqual(["read"]);
	});
});

describe("RPC plan proposal guest guard", () => {
	test("rejects execute before leaving plan mode or creating a session", async () => {
		const tempDir = TempDir.createSync("@pi-rpc-plan-guest-");
		try {
			await Bun.write(tempDir.join("PLAN.md"), "# Guest execution plan\n");
			const plan = createPlanSession({ cwd: tempDir.path(), proposalPath: tempDir.join("PLAN.md") });
			await enterRpcPlanMode(plan.session);
			await submitRpcPlanReview(plan.session, "Guest execution");
			const entriesBefore = plan.sessionManager.getEntries().length;
			vi.spyOn(rpcCollab, "isRpcCollabGuest").mockReturnValue(true);

			await expect(approveRpcPlanProposal(plan.session, undefined, "execute")).rejects.toThrow(
				"Run leave_collab_session first.",
			);

			expect(plan.newSession).not.toHaveBeenCalled();
			expect(plan.session.getPlanModeState()?.enabled).toBe(true);
			expect(plan.activeTools()).toEqual(["read", "bash", "write"]);
			expect(plan.sessionManager.getEntries()).toHaveLength(entriesBefore);
		} finally {
			await tempDir.remove();
		}
	});

	test("preserves a cancelled execute proposal and can retry it", async () => {
		const tempDir = TempDir.createSync("@pi-rpc-plan-cancel-");
		try {
			const planPath = tempDir.join("PLAN.md");
			await Bun.write(planPath, "# Retryable plan\n");
			const plan = createPlanSession({ cwd: tempDir.path(), proposalPath: planPath });
			await enterRpcPlanMode(plan.session);
			await submitRpcPlanReview(plan.session, "Retryable execution");
			const proposalHandler = plan.session.peekPlanProposalHandler();
			const entryCount = plan.sessionManager.getEntries().length;
			plan.newSession.mockResolvedValue(false);

			await expect(approveRpcPlanProposal(plan.session, undefined, "execute")).rejects.toThrow(
				"Plan execution session creation was cancelled.",
			);
			expect(plan.session.getPlanModeState()?.enabled).toBe(true);
			expect(plan.activeTools()).toEqual(["read", "bash", "write"]);
			expect(plan.activeModelId()).toBe("plan-model");
			expect(plan.session.peekPlanProposalHandler()).toBe(proposalHandler);
			expect(plan.sessionManager.getEntries()).toHaveLength(entryCount);

			await expect(approveRpcPlanProposal(plan.session, undefined, "execute")).rejects.toThrow(
				"Plan execution session creation was cancelled.",
			);
			expect(plan.newSession).toHaveBeenCalledTimes(2);
		} finally {
			await tempDir.remove();
		}
	});
});

describe("RPC reversible work-mode transitions", () => {
	test("preserves pending proposal details and decisions across reversible transitions", async () => {
		const cases = [
			{ name: "same logical reload", preserveCurrent: true, decision: "approved" },
			{ name: "precommit failure", preserveCurrent: false, decision: "rejected" },
		] as const;

		for (const testCase of cases) {
			const tempDir = TempDir.createSync(`@pi-rpc-plan-${testCase.decision}-`);
			try {
				const planPath = tempDir.join("PLAN.md");
				const content = `# ${testCase.name}\n\nKeep this exact proposal.\n`;
				const title = `${testCase.name} proposal`;
				await Bun.write(planPath, content);
				const plan = createPlanSession({ cwd: tempDir.path(), proposalPath: planPath });
				plan.setTransitionRunner(createWorkModeTransitionRunner(plan.session));
				await enterRpcPlanMode(plan.session);
				await submitRpcPlanReview(plan.session, title);
				const proposalHandler = plan.session.peekPlanProposalHandler();

				const transition = plan.session.runSessionTransition(
					async transitionOptions => {
						await transitionOptions.beforeCommit?.();
						if (!testCase.preserveCurrent) throw new Error("transition failed before commit");
						return { result: true, committed: true, honorPlanDefault: false };
					},
					testCase.preserveCurrent ? { preserveCurrentSessionOnSuccess: true } : undefined,
				);

				if (testCase.preserveCurrent) await expect(transition).resolves.toBe(true);
				else await expect(transition).rejects.toThrow("transition failed before commit");

				expect((await readRpcPlanModeState(plan.session)).proposal).toEqual({
					planFilePath: planPath,
					title,
					content,
				});
				expect(plan.session.peekPlanProposalHandler()).toBe(proposalHandler);
				expect(plan.session.getPlanModeState()?.enabled).toBe(true);

				if (testCase.decision === "approved") {
					const result = await approveRpcPlanProposal(plan.session, undefined, "keep-context");
					expect(result).toMatchObject({ decision: "approved", planFilePath: planPath, title });
				} else {
					const result = await rejectRpcPlanProposal(plan.session);
					expect(result).toMatchObject({ decision: "rejected", planFilePath: planPath, title });
				}
			} finally {
				await tempDir.remove();
			}
		}
	});

	test("flushes active goal accounting before reversible transition teardown", async () => {
		const runCase = async (committed: boolean) => {
			const sessionManager = SessionManager.inMemory(".");
			let state: GoalModeState | undefined;
			let usage: GoalTokenUsage = { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 };
			let now = 1_000;
			let activeTools = ["read"];
			const host: GoalRuntimeHost = {
				getState: () => state,
				setState: next => {
					state = next;
				},
				getCurrentUsage: () => ({ ...usage }),
				emit: async () => {},
				persist: (mode, next) => {
					if (mode === "none") sessionManager.appendModeChange("none");
					else if (next) sessionManager.appendModeChange(mode, { goal: next.goal });
				},
				sendHiddenMessage: async () => {},
				now: () => now,
			};
			const goalRuntime = new GoalRuntime(host);
			const session = {
				sessionManager,
				goalRuntime,
				settings: { get: (key: string) => key === "goal.enabled" },
				isStreaming: false,
				model: undefined,
				subscribe: () => () => {},
				prompt: async () => {},
				getPlanModeState: () => undefined,
				setPlanModeState: () => {},
				getGoalModeState: () => state,
				setGoalModeState: (next: GoalModeState | undefined) => {
					state = next;
				},
				getVibeModeState: () => undefined,
				setVibeModeState: () => {},
				peekPlanProposalHandler: () => undefined,
				setPlanProposalHandler: () => {},
				getEnabledToolNames: () => [...activeTools],
				setActiveToolsByName: async (names: string[]) => {
					activeTools = [...names];
				},
				configuredThinkingLevel: () => undefined,
			} as unknown as AgentSession;
			const runner = createWorkModeTransitionRunner(session, () =>
				goalRuntime.onTaskAborted({ reason: "internal" }),
			);

			await createRpcGoal(session, "Finish transition accounting", 8);
			goalRuntime.onTurnStart("turn-1", usage);
			usage = { input: 16, output: 2, cacheRead: 100, cacheWrite: 1 };
			now += 2_500;

			await runner(async transitionOptions => {
				await transitionOptions.beforeCommit?.();
				if (committed) transitionOptions.onCommitted?.();
				return { result: committed, committed, honorPlanDefault: false };
			});

			expect(sessionManager.buildSessionContext()).toMatchObject({
				mode: "goal",
				modeData: {
					goal: {
						status: "budget-limited",
						tokensUsed: 9,
						timeUsedSeconds: 2,
					},
				},
			});
			if (committed) {
				expect(state).toBeUndefined();
				expect(activeTools).toEqual(["read"]);
			} else {
				expect(state).toMatchObject({
					enabled: true,
					goal: { status: "budget-limited", tokensUsed: 9, timeUsedSeconds: 2 },
				});
				expect(activeTools).toEqual(["read", "goal"]);
			}
		};

		await runCase(false);
		await runCase(true);
	});
});

describe("RPC vibe mode", () => {
	test("persists none when exiting so reconciliation does not re-enter vibe", async () => {
		const sessionManager = SessionManager.create(".", ".");
		sessionManager.appendModeChange("vibe");
		vi.spyOn(VibeSessionRegistry.global(), "killAll").mockResolvedValue(0);

		await exitRpcVibeMode(createVibeSession(sessionManager, { enabled: true }).session);

		expect(sessionManager.buildSessionContext().mode).toBe("none");
	});
});

describe("RPC transient mode state", () => {
	test("returns plan tools and model while the transcript keeps owning plan mode", async () => {
		const plan = createPlanSession();

		await enterRpcPlanMode(plan.session);
		expect(plan.activeTools()).toEqual(["read", "bash", "write"]);
		expect(plan.activeModelId()).toBe("plan-model");
		const entriesAfterEntry = plan.sessionManager.getEntries().length;

		await clearRpcTransientModeState(plan.session);

		expect(plan.activeTools()).toEqual(["read", "bash"]);
		expect(plan.activeModelId()).toBe("base-model");
		expect(plan.session.getPlanModeState()).toBeUndefined();
		// Nothing was persisted, so a cancelled or failed transition rehydrates the
		// very same mode from the session's own entries.
		expect(plan.sessionManager.buildSessionContext().mode).toBe("plan");
		expect(plan.sessionManager.getEntries()).toHaveLength(entriesAfterEntry);

		// Re-entry snapshots the true pre-plan state, so a later exit cannot strand
		// the plan tool set or the plan model on the session.
		await enterRpcPlanMode(plan.session);
		expect(plan.activeTools()).toEqual(["read", "bash", "write"]);
		await exitRpcPlanMode(plan.session);
		expect(plan.activeTools()).toEqual(["read", "bash"]);
		expect(plan.activeModelId()).toBe("base-model");
	});

	test("suspends vibe workers instead of killing them and keeps the recorded mode", async () => {
		const sessionManager = SessionManager.inMemory(".");
		const vibe = createVibeSession(sessionManager, undefined);
		const registry = VibeSessionRegistry.global();
		const killAll = vi.spyOn(registry, "killAll").mockResolvedValue(0);
		const commit = vi.fn(async () => {});
		const rollback = vi.fn(async () => {});
		const suspendScope = vi
			.spyOn(registry, "suspendScopeReversibly")
			.mockResolvedValue({ count: 0, commit, rollback });

		await enterRpcVibeMode(vibe.session);
		expect(vibe.activeTools()).toEqual(["read", VIBE_EPHEMERAL_TOOL]);
		const entriesAfterEntry = sessionManager.getEntries().length;

		await clearRpcTransientModeState(vibe.session);

		expect(suspendScope).toHaveBeenCalledTimes(1);
		expect(killAll).not.toHaveBeenCalled();
		expect(commit).toHaveBeenCalledTimes(1);
		expect(rollback).not.toHaveBeenCalled();
		expect(vibe.session.getVibeModeState()).toBeUndefined();
		expect(vibe.activeTools()).toEqual(["read", "bash"]);
		expect(sessionManager.buildSessionContext().mode).toBe("vibe");
		expect(sessionManager.getEntries()).toHaveLength(entriesAfterEntry);
	});

	test("retains plan snapshots when tool or model restoration fails and retries from the original base", async () => {
		for (const target of ["tools", "model"] as const) {
			const plan = createPlanSession();
			await enterRpcPlanMode(plan.session);
			const failure = new Error(`${target} restore failed`);
			if (target === "tools") plan.failNextToolRestore(failure);
			else plan.failNextModelRestore(failure);

			await expect(clearRpcTransientModeState(plan.session)).rejects.toBe(failure);
			expect(plan.session.getPlanModeState()?.enabled).toBe(true);
			expect(plan.activeModelId()).toBe("plan-model");

			await clearRpcTransientModeState(plan.session);
			expect(plan.session.getPlanModeState()).toBeUndefined();
			expect(plan.activeTools()).toEqual(["read", "bash"]);
			expect(plan.activeModelId()).toBe("base-model");
		}
	});
});
