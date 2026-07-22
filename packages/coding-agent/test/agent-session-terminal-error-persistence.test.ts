import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type } from "arktype";

/**
 * Contract (issue #6250): when a tool returns `isError: true` and the follow-up
 * provider turn ends with a non-retryable `stopReason: "error"` carrying zero
 * content blocks, the terminal error turn MUST be persisted to the session so a
 * durable record of why the run stopped survives — instead of being silently
 * dropped by the `isEmptyErrorTurn` persistence gate. The pre-fix flow only
 * surfaced this error "live (pinned)", which vanishes when the main UI
 * subscription is detached (e.g. while a subagent transcript is focused).
 */
describe("AgentSession terminal empty error persistence", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;
	let sessionManager: SessionManager | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-terminal-error-persist-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		authStorage.setRuntimeApiKey("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		if (sessionManager) {
			await sessionManager.close();
			sessionManager = undefined;
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	it("persists a non-retryable zero-content error turn after a failed tool result", async () => {
		const model = getBundledModel("openai", "gpt-5");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}

		const failingTool: AgentTool = {
			name: "eval",
			label: "Eval",
			description: "Mock eval tool that rejects invalid input",
			parameters: type({ "code?": "string" }),
			execute: async () => ({
				content: [{ type: "text" as const, text: "SyntaxError: Unexpected token '{'." }],
				isError: true,
			}),
		};

		// First turn calls the tool; the tool fails; the follow-up continuation
		// throws a generic (non-retryable) provider error with no content.
		const mock = createMockModel({
			provider: "openai",
			id: model.id,
			responses: [
				{ content: [{ type: "toolCall", id: "tc-0", name: "eval", arguments: { code: "import {" } }] },
				{ throw: "Provider rejected the request (400 invalid continuation)" },
			],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: { model, systemPrompt: ["Test"], tools: [failingTool], messages: [] },
			convertToLlm,
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([[failingTool.name, failingTool]]),
		});

		await session.prompt("run eval");
		await session.waitForIdle();
		await sessionManager.flush();

		// The continuation ended terminally with a zero-content error.
		const last = session.agent.state.messages.at(-1);
		expect(last?.role).toBe("assistant");
		expect((last as AssistantMessage).stopReason).toBe("error");
		expect((last as AssistantMessage).content).toHaveLength(0);

		// The terminal error turn is now durably recorded: a rebuild from
		// persisted entries (what a focus/unfocus rebuild reads) shows it,
		// preserving the provider errorMessage instead of losing it.
		const persistedErrorTurns = sessionManager
			.getEntries()
			.filter(entry => entry.type === "message" && entry.message.role === "assistant")
			.map(entry => entry.type === "message" && (entry.message as AssistantMessage))
			.filter((message): message is AssistantMessage => !!message && message.stopReason === "error");
		expect(persistedErrorTurns).toHaveLength(1);
		expect(persistedErrorTurns[0]?.errorMessage).toContain("invalid continuation");
	});
});
