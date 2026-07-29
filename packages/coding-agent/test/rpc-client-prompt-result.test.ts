import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	RPC_TOMBSTONE_LIMIT,
	type RpcAsyncCommandSubmissionResult,
	RpcClient,
	RpcCommandError,
	type RpcPromptErrorResponse,
	type RpcPromptResultFrame,
	type RpcPromptSubmissionResult,
} from "@oh-my-pi/pi-coding-agent/modes";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

describe("RpcClient prompt results", () => {
	test("correlates terminal true and false frames while preserving immediate acknowledgements", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_PROMPT_RESULTS: "1" },
		});
		await client.start();

		const completions: RpcPromptResultFrame[] = [];
		const allCompletions = Promise.withResolvers<void>();
		const unsubscribe = client.onPromptResult(frame => {
			completions.push(frame);
			if (completions.length === 3) allCompletions.resolve();
		});
		try {
			const pending: RpcPromptSubmissionResult = await client.promptWithResult("local-only");
			expect(pending).toEqual({ requestId: "req_1" });

			const immediate = await client.promptWithResult("agent");
			expect(immediate).toEqual({ requestId: "req_2", agentInvoked: true });

			const immediateNoAgent = await client.promptWithResult("no-agent");
			expect(immediateNoAgent).toEqual({ requestId: "req_3", agentInvoked: false });
			await allCompletions.promise;
			expect(completions).toEqual([
				{ type: "prompt_result", id: "req_1", agentInvoked: false, lifecycleDisposition: "none" },
				{ type: "prompt_result", id: "req_2", agentInvoked: true, lifecycleDisposition: "future" },
				{ type: "prompt_result", id: "req_3", agentInvoked: false, lifecycleDisposition: "none" },
			]);
		} finally {
			unsubscribe();
		}
	}, 5_000);

	test("reports a same-id late prompt failure exactly once", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_PROMPT_RESULTS: "1" },
		});
		await client.start();

		const errors: RpcPromptErrorResponse[] = [];
		const lateError = Promise.withResolvers<void>();
		const unsubscribe = client.onPromptError(error => {
			errors.push(error);
			lateError.resolve();
		});
		try {
			const acknowledgement = await client.promptWithResult("late-error");
			expect(acknowledgement).toEqual({ requestId: "req_1" });
			await lateError.promise;
			expect(errors).toEqual([
				{
					id: acknowledgement.requestId,
					type: "response",
					command: "prompt",
					success: false,
					error: "Prompt scheduling failed",
					code: "prompt_scheduling_failed",
				},
			]);
		} finally {
			unsubscribe();
		}
	}, 5_000);

	test("reports a correlated late abort-and-prompt failure exactly once", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LIFECYCLE: "1" },
		});
		await client.start();

		const errors: RpcPromptErrorResponse[] = [];
		const lateError = Promise.withResolvers<void>();
		const unsubscribe = client.onPromptError(error => {
			errors.push(error);
			lateError.resolve();
		});
		try {
			const acknowledgement: RpcAsyncCommandSubmissionResult = await client.abortAndPromptWithResult("replace");
			await lateError.promise;
			await Promise.resolve();
			expect(errors).toEqual([
				{
					id: acknowledgement.requestId,
					type: "response",
					command: "abort_and_prompt",
					success: false,
					error: "Replacement scheduling failed",
					code: "prompt_scheduling_failed",
				},
			]);
		} finally {
			unsubscribe();
		}
	}, 5_000);

	test("completes a local-only abort-and-prompt reservation from its same-id outcome", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LIFECYCLE: "1" },
		});
		await client.start();

		const outcome = Promise.withResolvers<RpcPromptResultFrame>();
		const unsubscribe = client.onPromptResult(frame => outcome.resolve(frame));
		try {
			const acknowledgement = await client.abortAndPromptWithResult("local-only");
			await client.waitForIdle();
			expect(await outcome.promise).toEqual({
				type: "prompt_result",
				id: acknowledgement.requestId,
				agentInvoked: false,
				lifecycleDisposition: "none",
			});
		} finally {
			unsubscribe();
		}
	}, 5_000);

	test("keeps an immediate abort-and-prompt rejection on the matched request path", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LIFECYCLE: "1" },
		});
		await client.start();

		const errors: RpcPromptErrorResponse[] = [];
		const unsubscribe = client.onPromptError(error => errors.push(error));
		try {
			let rejection: unknown;
			try {
				await client.abortAndPromptWithResult("immediate-reject");
			} catch (error) {
				rejection = error;
			}
			expect(rejection).toBeInstanceOf(RpcCommandError);
			expect(errors).toEqual([]);
			await client.waitForIdle();
		} finally {
			unsubscribe();
		}
	}, 5_000);

	test("returns local-only promptAndWait immediately and treats a bare idle wait as complete", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LIFECYCLE: "1" },
		});
		await client.start();

		await client.waitForIdle();
		expect(await client.promptAndWait("local-only")).toEqual([]);
		await client.waitForIdle();
	}, 5_000);

	test("keeps queued promptAndWait correlated across the previous run's terminal gap", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LIFECYCLE: "1" },
		});
		await client.start();

		let invokedResults = 0;
		const firstInvoked = Promise.withResolvers<void>();
		const secondInvoked = Promise.withResolvers<void>();
		const unsubscribe = client.onPromptResult(frame => {
			if (!frame.agentInvoked) return;
			invokedResults++;
			if (invokedResults === 1) firstInvoked.resolve();
			if (invokedResults === 2) secondInvoked.resolve();
		});
		try {
			await client.promptWithResult("active-A");
			await firstInvoked.promise;

			const queued = client.promptAndWait("queued-B", undefined, 2_000, "followUp");
			let queuedSettled = false;
			void queued.then(
				() => {
					queuedSettled = true;
				},
				() => {
					queuedSettled = true;
				},
			);
			await secondInvoked.promise;

			await client.getState();
			expect(queuedSettled).toBe(false);

			await client.getSettings();
			const events = await queued;
			expect(events.map(event => event.type)).toEqual(["agent_end", "agent_start", "agent_end"]);
		} finally {
			unsubscribe();
		}
	}, 5_000);

	test("waits for delayed extension work and surfaces a correlated pre-start failure", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LIFECYCLE: "1" },
		});
		await client.start();

		const delayed = client.promptAndWait("extension-delayed", undefined, 2_000);
		let delayedSettled = false;
		void delayed.finally(() => {
			delayedSettled = true;
		});
		await Promise.resolve();
		expect(delayedSettled).toBe(false);
		await client.getState();
		expect((await delayed).map(event => event.type)).toEqual(["agent_start", "agent_end"]);

		const failing = client.promptAndWait("extension-prestart-error", undefined, 2_000);
		await client.getState();
		await expect(failing).rejects.toMatchObject({
			command: "prompt",
			code: "prompt_scheduling_failed",
		});
		await client.waitForIdle();
	}, 5_000);

	test("merges guest follow-up into the active remote lifecycle reservation", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LIFECYCLE: "1" },
		});
		await client.start();

		await client.promptWithResult("active-guest");
		await client.followUp("guest-current");
		const idle = client.waitForIdle(2_000);
		await client.getState();
		await idle;
	}, 5_000);

	test("applies a duplicated current disposition only once per prompt request", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LIFECYCLE: "1" },
		});
		await client.start();

		const activeRunStarted = Promise.withResolvers<void>();
		const unsubscribe = client.onPromptResult(frame => {
			if (frame.lifecycleDisposition === "future") activeRunStarted.resolve();
		});
		try {
			await client.promptWithResult("active-guest");
			await activeRunStarted.promise;
			await client.promptWithResult("duplicate-current");

			const idle = client.waitForIdle(2_000);
			let idleSettled = false;
			void idle.then(
				() => {
					idleSettled = true;
				},
				() => {
					idleSettled = true;
				},
			);
			await client.getSettings();
			expect(idleSettled).toBe(false);

			await client.getState();
			await idle;
		} finally {
			unsubscribe();
		}
	}, 5_000);

	test("rejects only promptAndWait when an old runtime omits prompt_result capability", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_OLD_RUNTIME: "1" },
		});
		await client.start();

		await client.getState();
		await client.prompt("legacy fire-and-forget");
		await client.waitForIdle();
		await expect(client.promptAndWait("unsupported")).rejects.toMatchObject({
			command: "prompt",
			code: "capability_unavailable",
		});
	}, 5_000);

	test("bounds prompt-error tombstones while suppressing retained duplicate frames", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_TOMBSTONES: "1" },
		});
		await client.start();

		const errors: RpcPromptErrorResponse[] = [];
		const unsubscribe = client.onPromptError(error => errors.push(error));
		try {
			for (let index = 0; index <= RPC_TOMBSTONE_LIMIT; index++) {
				await client.promptWithResult(`late-${index}`);
			}
			await client.getSettings();
			expect(errors).toHaveLength(RPC_TOMBSTONE_LIMIT + 1);

			await client.getState();
			expect(errors).toHaveLength(RPC_TOMBSTONE_LIMIT + 2);
			expect(errors.at(-1)?.id).toBe("req_1");
		} finally {
			unsubscribe();
		}
	}, 10_000);

	test("ignores non-terminal agent_end while waiting for the correlated run", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_LIFECYCLE: "1" },
		});
		await client.start();

		const invoked = Promise.withResolvers<void>();
		const intermediateEnd = Promise.withResolvers<void>();
		const unsubscribeResult = client.onPromptResult(frame => {
			if (frame.agentInvoked) invoked.resolve();
		});
		const unsubscribeEvent = client.onEvent(event => {
			if (event.type === "agent_end" && "isTerminal" in event && event.isTerminal === false) {
				intermediateEnd.resolve();
			}
		});
		try {
			const waiting = client.promptAndWait("continuing", undefined, 2_000);
			let settled = false;
			void waiting.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await invoked.promise;

			await client.getState();
			await intermediateEnd.promise;
			expect(settled).toBe(false);

			await client.getSettings();
			const events = await waiting;
			expect(events.map(event => event.type)).toEqual(["agent_start", "agent_end", "agent_start", "agent_end"]);
		} finally {
			unsubscribeResult();
			unsubscribeEvent();
		}
	}, 5_000);
});
