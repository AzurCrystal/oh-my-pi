import { afterEach, describe, expect, test, vi } from "bun:test";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { beginRpcGuidedGoal, exitRpcVibeMode } from "../src/modes/rpc/rpc-work-modes";
import type { AgentSession } from "../src/session/agent-session";
import { SessionManager } from "../src/session/session-manager";
import { VibeSessionRegistry } from "../src/vibe/runtime";
import type { VibeModeState } from "../src/vibe/state";

function createVibeSession(sessionManager: SessionManager): AgentSession {
	let vibeModeState: VibeModeState | undefined = { enabled: true };
	return {
		sessionManager,
		getAgentId: () => "test-agent",
		getVibeModeState: () => vibeModeState,
		deactivateVibeTools: async () => {},
		setVibeModeState: (state: VibeModeState | undefined) => {
			vibeModeState = state;
		},
		getEnabledToolNames: () => [],
	} as unknown as AgentSession;
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

		await exitRpcVibeMode(createVibeSession(sessionManager));

		expect(sessionManager.buildSessionContext().mode).toBe("none");
	});
});
