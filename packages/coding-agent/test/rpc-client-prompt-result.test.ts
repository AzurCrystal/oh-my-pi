import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { RpcClient, type RpcPromptResultFrame, type RpcPromptSubmissionResult } from "@oh-my-pi/pi-coding-agent/modes";

const MOCK_AGENT = path.join(import.meta.dir, "fixtures", "mock-rpc-agent.ts");

describe("RpcClient prompt results", () => {
	test("reports asynchronous local-only completion and preserves immediate agentInvoked", async () => {
		using client = new RpcClient({
			cliPath: MOCK_AGENT,
			env: { MOCK_RPC_PROMPT_RESULTS: "1" },
		});
		await client.start();

		const completion = Promise.withResolvers<RpcPromptResultFrame>();
		const unsubscribe = client.onPromptResult(completion.resolve);
		try {
			const pending: RpcPromptSubmissionResult = await client.promptWithResult("local-only");
			expect(pending).toEqual({ requestId: "req_1" });
			const frame = await completion.promise;
			expect(frame).toEqual({ type: "prompt_result", id: pending.requestId, agentInvoked: false });

			const immediate = await client.promptWithResult("agent");
			expect(immediate).toEqual({ requestId: "req_2", agentInvoked: true });

			const immediateNoAgent = await client.promptWithResult("no-agent");
			expect(immediateNoAgent).toEqual({ requestId: "req_3", agentInvoked: false });
		} finally {
			unsubscribe();
		}
	}, 5_000);
});
