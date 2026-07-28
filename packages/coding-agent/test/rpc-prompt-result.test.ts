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
		});

		expect(relay).toHaveBeenCalledTimes(1);
		expect(relay).toHaveBeenCalledWith();
		expect(output).toEqual([{ type: "prompt_result", id: "req_guest", agentInvoked: true }]);
		expect(response).toEqual({
			id: "req_guest",
			type: "response",
			command: "prompt",
			success: true,
			data: { agentInvoked: true },
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
	test("emits prompt_result when prompt resolves without invoking the agent or extension user message", async () => {
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
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
	});

	test("emits true prompt_result when an extension command schedules a user message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.markAgentMessageTask();
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: true }]);
	});

	test("emits true prompt_result when an extension command schedules a triggerTurn custom message", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.markAgentMessageTask();
			return Promise.resolve(false);
		});

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: true }]);
	});

	test("ignores extension user messages scheduled before the watched prompt", async () => {
		const output: object[] = [];
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		extensionUserMessages.markAgentMessageTask();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportLocalOnlyPromptResult({
			id: "req_1",
			prompt: trackedPrompt.prompt,
			output: frame => output.push(frame),
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
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

	test("emits one true prompt_result before a deferred extension sendUserMessage settles", async () => {
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
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
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
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(sentContent).toBe("start work");
		expect(output).toEqual([{ type: "prompt_result", id: "req_success", agentInvoked: true }]);

		deferredSend.resolve();
		await deferredSend.promise;
		await Promise.resolve();

		expect(output).toEqual([{ type: "prompt_result", id: "req_success", agentInvoked: true }]);
	});

	test("emits true prompt_result and reports extension sendUserMessage rejection", async () => {
		let extensionActions: ExtensionActions | undefined;
		const output: object[] = [];
		const reportedErrors: Error[] = [];
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
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
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
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await waitForPromptHandlers(trackedPrompt.prompt);

		expect(reportedErrors).toEqual([thrown]);
		expect(output).toEqual([{ type: "prompt_result", id: "req_rejected", agentInvoked: true }]);
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

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: true }]);
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

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: false }]);
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

		expect(output).toEqual([{ type: "prompt_result", id: "req_1", agentInvoked: true }]);
	});
});
