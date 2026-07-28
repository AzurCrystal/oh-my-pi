import { afterEach, describe, expect, test } from "bun:test";
import { agentPauseGate } from "@oh-my-pi/pi-agent-core";
import { installRpcRuntimeControl, pauseRpcAgents } from "../src/modes/rpc/rpc-runtime-control";
import type { AgentSession } from "../src/session/agent-session";

function fakeSession(): AgentSession {
	return {
		isDisposed: false,
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

afterEach(() => {
	agentPauseGate.resume();
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
