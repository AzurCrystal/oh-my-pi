import { describe, expect, test, vi } from "bun:test";
import {
	RpcExtensionUserMessageTracker,
	reportLocalOnlyPromptResult,
	routeRpcCollabGuestPrompt,
	watchAndReportLocalOnlyPromptResult,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import type { ExtensionActions } from "../src/extensibility/extensions/types";
import { RpcCollabGuestRoutingError } from "../src/modes/rpc/rpc-collab";
import { initializeExtensions } from "../src/modes/runtime-init";
import type { AgentSession } from "../src/session/agent-session";

async function waitForPromptHandlers(prompt: Promise<unknown>): Promise<void> {
	await prompt.catch(() => undefined);
	await Promise.resolve();
}

describe("routeRpcCollabGuestPrompt", () => {
	test("emits exactly one correlated true result and acknowledges accepted relay input", () => {
		const output: object[] = [];
		const relay = vi.fn(() => {});

		const response = routeRpcCollabGuestPrompt({
			id: "req_guest",
			relay,
			output: frame => output.push(frame),
			lifecycleDisposition: "future",
		});

		expect(relay).toHaveBeenCalledTimes(1);
		expect(relay).toHaveBeenCalledWith();
		expect(output).toEqual([
			{
				type: "prompt_result",
				id: "req_guest",
				agentInvoked: true,
				lifecycleDisposition: "future",
			},
		]);
		expect(response).toEqual({
			id: "req_guest",
			type: "response",
			command: "prompt",
			success: true,
			data: { agentInvoked: true, lifecycleDisposition: "future" },
		});
	});

	test("returns relay errors without emitting a terminal prompt outcome", () => {
		const output: object[] = [];
		const response = routeRpcCollabGuestPrompt({
			id: "req_guest",
			relay: () => {
				throw new RpcCollabGuestRoutingError("relay unavailable", "link_unavailable");
			},
			output: frame => output.push(frame),
			lifecycleDisposition: "future",
		});

		expect(output).toEqual([]);
		expect(response).toEqual({
			id: "req_guest",
			type: "response",
			command: "prompt",
			success: false,
			error: "relay unavailable",
			code: "link_unavailable",
		});
	});
});

describe("reportLocalOnlyPromptResult", () => {
	test("emits a terminal none disposition for a local-only prompt", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionAgentMessageTasks: trackedPrompt.agentMessageTasks,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([
			{
				type: "prompt_result",
				id: "req_1",
				agentInvoked: false,
				lifecycleDisposition: "none",
			},
		]);
	});

	test("waits for a tracked future extension task before emitting its outcome", async () => {
		const output: object[] = [];
		const deferredTask = Promise.withResolvers<void>();
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.trackAgentMessageTask(deferredTask.promise, "future");
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionAgentMessageTasks: trackedPrompt.agentMessageTasks,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);
		expect(output).toEqual([]);

		deferredTask.resolve();
		await deferredTask.promise;
		await Promise.resolve();

		expect(output).toEqual([
			{
				type: "prompt_result",
				id: "req_1",
				agentInvoked: true,
				lifecycleDisposition: "future",
			},
		]);
	});

	test("reports a tracked extension failure instead of emitting success", async () => {
		const output: object[] = [];
		const reported: Error[] = [];
		const thrown = new Error("pre-start failure");
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.trackAgentMessageTask(Promise.reject(thrown), "future");
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_failure",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => reported.push(error),
			extensionAgentMessageTasks: trackedPrompt.agentMessageTasks,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([]);
		expect(reported).toEqual([thrown]);
	});

	test("ignores extension tasks scheduled before the watched prompt", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		extensionUserMessages.trackAgentMessageTask(Promise.resolve(), "future");
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionAgentMessageTasks: trackedPrompt.agentMessageTasks,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([
			{
				type: "prompt_result",
				id: "req_1",
				agentInvoked: false,
				lifecycleDisposition: "none",
			},
		]);
	});

	test("marks triggerTurn extension custom messages as agent work", async () => {
		let extensionActions: ExtensionActions | undefined;
		let markCount = 0;
		let sentOptions: { triggerTurn?: boolean } | undefined;
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendCustomMessage: async (_message: unknown, options?: { triggerTurn?: boolean }) => {
				sentOptions = options;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			markAgentInvokingMessage: () => {
				markCount += 1;
			},
		});
		extensionActions?.sendMessage(
			{
				customType: "test",
				content: "context",
				display: true,
				details: "context",
				attribution: "user",
			},
			{ triggerTurn: true },
		);

		expect(markCount).toBe(1);
		expect(sentOptions).toEqual({ triggerTurn: true });
	});

	test("waits for a deferred extension sendUserMessage before emitting true", async () => {
		let extensionActions: ExtensionActions | undefined;
		let sentContent: unknown;
		const output: object[] = [];
		const deferredSend = Promise.withResolvers<void>();
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendUserMessage: (content: unknown) => {
				sentContent = content;
				return deferredSend.promise;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			trackAgentInvokingMessage: (task, disposition) => {
				extensionUserMessages.trackAgentMessageTask(task, disposition);
			},
		});

		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			if (!extensionActions) throw new Error("extensions not initialized");
			extensionActions.sendUserMessage("start work");
			return Promise.resolve(false);
		});
		reportLocalOnlyPromptResult({
			id: "req_success",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionAgentMessageTasks: trackedPrompt.agentMessageTasks,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(sentContent).toBe("start work");
		expect(output).toEqual([]);

		deferredSend.resolve();
		await deferredSend.promise;
		await Promise.resolve();

		expect(output).toEqual([
			{
				type: "prompt_result",
				id: "req_success",
				agentInvoked: true,
				lifecycleDisposition: "future",
			},
		]);
	});

	test("correlates extension sendUserMessage rejection instead of emitting success", async () => {
		let extensionActions: ExtensionActions | undefined;
		const output: object[] = [];
		const reportedErrors: Error[] = [];
		const correlatedErrors: Error[] = [];
		const thrown = new Error("missing model");
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			sendUserMessage: async () => {
				throw thrown;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				reportedErrors.push(error);
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			trackAgentInvokingMessage: (task, disposition) => {
				extensionUserMessages.trackAgentMessageTask(task, disposition);
			},
		});

		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			if (!extensionActions) throw new Error("extensions not initialized");
			extensionActions.sendUserMessage("start work");
			return Promise.resolve(false);
		});
		reportLocalOnlyPromptResult({
			id: "req_rejected",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				correlatedErrors.push(error);
			},
			extensionAgentMessageTasks: trackedPrompt.agentMessageTasks,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(reportedErrors).toEqual([thrown]);
		expect(correlatedErrors).toEqual([thrown]);
		expect(output).toEqual([]);
	});

	test("emits one correlated true result when prompt invokes the agent", async () => {
		const output: object[] = [];
		const prompt = Promise.resolve(true);

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([
			{
				type: "prompt_result",
				id: "req_1",
				agentInvoked: true,
				lifecycleDisposition: "future",
			},
		]);
	});

	test("reports prompt rejection without emitting output", async () => {
		const output: object[] = [];
		const thrown = new Error("boom");
		const prompt = Promise.reject(thrown);
		let reported: Error | undefined;

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt,
			output: frame => output.push(frame),
			onError: error => {
				reported = error;
			},
		});
		await waitForPromptHandlers(prompt);

		expect(reported).toBe(thrown);
		expect(output).toEqual([]);
	});
});

describe("watchAndReportLocalOnlyPromptResult", () => {
	test("reports builtin residual prompts that complete locally", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();

		const prompt = Promise.resolve(false);
		watchAndReportLocalOnlyPromptResult({
			id: "req_1",
			startPrompt: () => prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionUserMessageTracker: extensionUserMessages,
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([
			{
				type: "prompt_result",
				id: "req_1",
				agentInvoked: false,
				lifecycleDisposition: "none",
			},
		]);
	});

	test("reports builtin residual prompts that invoke the agent", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();

		const prompt = Promise.resolve(true);
		watchAndReportLocalOnlyPromptResult({
			id: "req_1",
			startPrompt: () => prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			extensionUserMessageTracker: extensionUserMessages,
		});
		await waitForPromptHandlers(prompt);

		expect(output).toEqual([
			{
				type: "prompt_result",
				id: "req_1",
				agentInvoked: true,
				lifecycleDisposition: "future",
			},
		]);
	});
});
