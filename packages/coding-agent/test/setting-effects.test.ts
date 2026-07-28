import { describe, expect, it, vi } from "bun:test";
import { applySettingEffects } from "@oh-my-pi/pi-coding-agent/modes/setting-effects";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function makeFakeSession() {
	const methods = {
		setAdvisorEnabled: vi.fn(),
		setSteeringMode: vi.fn(),
		setFollowUpMode: vi.fn(),
		setInterruptMode: vi.fn(),
		setThinkingLevel: vi.fn(),
		refreshBaseSystemPrompt: vi.fn(async () => {}),
		applyMemoryBackend: vi.fn(async () => {}),
	};
	const session = {
		...methods,
		agent: {
			hideThinkingSummary: false,
			temperature: undefined as number | undefined,
			topP: undefined as number | undefined,
			topK: undefined as number | undefined,
			minP: undefined as number | undefined,
			presencePenalty: undefined as number | undefined,
			repetitionPenalty: undefined as number | undefined,
		},
		settings: {},
	};

	return {
		session,
		methods,
		apply: (path: string, value: unknown) => applySettingEffects(session as unknown as AgentSession, path, value),
	};
}

describe("applySettingEffects", () => {
	it("forwards synchronous session effects", async () => {
		const { apply, methods } = makeFakeSession();

		await apply("steeringMode", "all");

		expect(methods.setSteeringMode).toHaveBeenCalledTimes(1);
		expect(methods.setSteeringMode).toHaveBeenCalledWith("all");
	});

	it("normalizes negative sampling values to the unset sentinel", async () => {
		const { apply, session } = makeFakeSession();

		await apply("temperature", 0.7);
		expect(session.agent.temperature).toBe(0.7);

		await apply("temperature", -1);
		expect(session.agent.temperature).toBeUndefined();
	});

	it("rejects when an asynchronous effect fails", async () => {
		const { apply, methods } = makeFakeSession();
		methods.applyMemoryBackend.mockRejectedValue(new Error("backend unavailable"));

		await expect(apply("memory.backend", "mnemopi")).rejects.toThrow("backend unavailable");
	});

	it("resolves effect-free paths without calling session methods", async () => {
		const { apply, methods } = makeFakeSession();

		await expect(apply("compaction.enabled", true)).resolves.toBeUndefined();
		for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled();
	});
});
