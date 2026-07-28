import { afterEach, describe, expect, test, vi } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import * as rpcCollab from "../src/modes/rpc/rpc-collab";
import {
	enableRpcLoop,
	installRpcRuntimeControl,
	pauseRpcAgents,
	readRpcLoopState,
} from "../src/modes/rpc/rpc-runtime-control";
import type { AgentSession } from "../src/session/agent-session";

function fakeSession(): AgentSession {
	return {
		isDisposed: false,
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

afterEach(() => {
	agentPauseGate.resume();
	vi.restoreAllMocks();
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
