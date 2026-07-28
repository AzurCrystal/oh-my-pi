import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient, type RpcPromptResultFrame, type RpcPromptSubmissionResult } from "@oh-my-pi/pi-coding-agent/modes";

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
				{ type: "prompt_result", id: "req_1", agentInvoked: false },
				{ type: "prompt_result", id: "req_2", agentInvoked: true },
				{ type: "prompt_result", id: "req_3", agentInvoked: false },
			]);
		} finally {
			unsubscribe();
		}
	}, 5_000);
});
