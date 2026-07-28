import { afterEach, describe, expect, test, vi } from "bun:test";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import {
	beginRpcGuidedGoal,
	clearRpcTransientModeState,
	enterRpcPlanMode,
	enterRpcVibeMode,
	exitRpcPlanMode,
	exitRpcVibeMode,
} from "../src/modes/rpc/rpc-work-modes";
import type { PlanModeState } from "../src/plan-mode/state";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
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

function createPlanSession() {
	const sessionManager = SessionManager.inMemory(".");
	const baseModel = { id: "base-model", provider: "test" } as unknown as Model;
	const planModel = { id: "plan-model", provider: "test" } as unknown as Model;
	let activeTools = ["read", "bash"];
	let activeModel = baseModel;
	let nextToolRestoreError: Error | undefined;
	let nextModelRestoreError: Error | undefined;
	let planModeState: PlanModeState | undefined;
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
		setPlanProposalHandler: () => {},
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
	} as unknown as AgentSession;
	return {
		session,
		sessionManager,
		activeTools: () => [...activeTools],
		activeModelId: () => activeModel.id,
		failNextToolRestore: (error: Error) => {
			nextToolRestoreError = error;
		},
		failNextModelRestore: (error: Error) => {
			nextModelRestoreError = error;
		},
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
