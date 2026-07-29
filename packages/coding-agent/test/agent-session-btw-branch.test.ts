import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { Snowflake } from "@oh-my-pi/pi-utils";

class FailingBtwBranchStorage extends MemorySessionStorage {
	nextSyncWriteError: Error | undefined;

	override writeTextSync(filePath: string, content: string): void {
		const error = this.nextSyncWriteError;
		if (error) {
			this.nextSyncWriteError = undefined;
			throw error;
		}
		super.writeTextSync(filePath, content);
	}
}

function createBtwAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Check the failure mode first.", thinkingSignature: "sig" },
			{ type: "redactedThinking", data: "encrypted-side-channel-thinking" },
			{ type: "text", text: "The fix is to branch the side answer." },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 3,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		providerPayload: { type: "openaiResponsesHistory", items: [{ id: "side-channel" }] },
	};
}

function expectSanitizedBtwAssistant(message: AssistantMessage): void {
	expect(message.providerPayload).toBeUndefined();
	expect(message.content).toEqual([
		{ type: "thinking", thinking: "Check the failure mode first." },
		{ type: "text", text: "The fix is to branch the side answer." },
	]);
}

describe("AgentSession.branchFromBtw", () => {
	let tempDir: string;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-btw-branch-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		await fs.promises
			.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
			.catch(() => undefined);
		vi.restoreAllMocks();
	});

	async function createSession(options?: {
		persisted?: boolean;
		extensionRunner?: ExtensionRunner;
		handler?: MockHandler;
		storage?: MemorySessionStorage;
	}) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ handler: options?.handler ?? (() => ({ content: ["unused"] })) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager =
			options?.persisted === false
				? SessionManager.inMemory()
				: SessionManager.create(tempDir, tempDir, options?.storage);
		const settings = Settings.isolated({ "compaction.enabled": false });
		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			extensionRunner: options?.extensionRunner,
		});
		return session;
	}

	it("creates a persisted branch with the /btw user input and complete assistant message", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() - 2 });
		activeSession.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "seed response" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 1,
		});
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;
		expect(originalFile).toBeDefined();
		const originalRaw = fs.readFileSync(originalFile!, "utf8");
		const assistantMessage = createBtwAssistant();

		const onCommitted = vi.fn();
		const result = await activeSession.branchFromBtw("why did this fail?", assistantMessage, { onCommitted });

		expect(result.cancelled).toBe(false);
		expect(onCommitted).toHaveBeenCalledTimes(1);
		expect(result.sessionFile).toBe(activeSession.sessionFile);
		expect(result.sessionFile).toBeDefined();
		expect(result.sessionFile).not.toBe(originalFile);
		expect(fs.readFileSync(originalFile!, "utf8")).toBe(originalRaw);
		const messages = activeSession.messages;
		expect(messages.at(-2)).toMatchObject({ role: "user", content: [{ type: "text", text: "why did this fail?" }] });
		const promoted = messages.at(-1);
		expect(promoted?.role).toBe("assistant");
		if (promoted?.role !== "assistant") throw new Error("Expected promoted assistant message");
		expectSanitizedBtwAssistant(promoted);
	});

	it("honors session_before_branch cancellation without creating a branch", async () => {
		const emit = vi.fn(async () => ({ cancel: true }));
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit,
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const originalFile = activeSession.sessionFile;

		const result = await activeSession.branchFromBtw("question", createBtwAssistant());

		expect(result).toEqual({ cancelled: true, sessionFile: originalFile });
		expect(activeSession.sessionFile).toBe(originalFile);
		expect(emit).toHaveBeenCalledWith({
			type: "session_before_branch",
			entryId: activeSession.sessionManager.getLeafId(),
		});
	});

	it("syncs promoted /btw messages into live context even when hooks skip conversation restore", async () => {
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async () => ({ skipConversationRestore: true })),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		activeSession.agent.replaceMessages(activeSession.sessionManager.buildSessionContext().messages);
		await activeSession.sessionManager.flush();
		const assistantMessage = createBtwAssistant();

		const result = await activeSession.branchFromBtw("question", assistantMessage);

		expect(result.cancelled).toBe(false);
		const messages = activeSession.messages;
		expect(messages.at(-2)).toMatchObject({ role: "user", content: [{ type: "text", text: "question" }] });
		const promoted = messages.at(-1);
		expect(promoted?.role).toBe("assistant");
		if (promoted?.role !== "assistant") throw new Error("Expected promoted assistant message");
		expectSanitizedBtwAssistant(promoted);
	});

	it("aborts an in-flight main stream before switching to the /btw branch", async () => {
		const providerStarted = Promise.withResolvers<void>();
		const activeSession = await createSession({
			handler: () => {
				providerStarted.resolve();
				return { content: ["main response should not move"], delayMs: 60_000 };
			},
		});
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();

		const promptPromise = activeSession.prompt("main prompt");
		await providerStarted.promise;
		expect(activeSession.isStreaming).toBe(true);
		await activeSession.followUp("queued follow-up should not move");
		expect(activeSession.queuedMessageCount).toBe(1);

		const assistantMessage = createBtwAssistant();
		const result = await activeSession.branchFromBtw("question", assistantMessage);
		await promptPromise;

		expect(result.cancelled).toBe(false);
		const messages = activeSession.messages;
		expect(messages.at(-2)).toMatchObject({ role: "user", content: [{ type: "text", text: "question" }] });
		const promoted = messages.at(-1);
		expect(promoted?.role).toBe("assistant");
		if (promoted?.role !== "assistant") throw new Error("Expected promoted assistant message");
		expectSanitizedBtwAssistant(promoted);
		expect(messages).not.toContainEqual(
			expect.objectContaining({
				role: "assistant",
				content: [{ type: "text", text: "main response should not move" }],
			}),
		);
		expect(activeSession.queuedMessageCount).toBe(0);
		expect(messages).not.toContainEqual(
			expect.objectContaining({
				role: "user",
				content: [{ type: "text", text: "queued follow-up should not move" }],
			}),
		);
	});

	it("refuses to branch /btw while user bash work is still running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();

		const bashPromise = activeSession.executeBash('bun -e "await Bun.sleep(60_000)"', () => undefined, {
			useUserShell: false,
		});
		while (!activeSession.isBashRunning) await Bun.sleep(1);

		await expect(activeSession.branchFromBtw("question", createBtwAssistant())).rejects.toThrow(
			"Cannot branch /btw while session maintenance or user work is still running",
		);

		activeSession.abortBash();
		await bashPromise.catch(() => undefined);
	});

	it("refuses to branch /btw while user Python work is still running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const abortController = new AbortController();
		const execution = Promise.withResolvers<void>().promise;
		activeSession.trackEvalExecution(execution, abortController).catch(() => undefined);
		expect(activeSession.isEvalRunning).toBe(true);

		await expect(activeSession.branchFromBtw("question", createBtwAssistant())).rejects.toThrow(
			"Cannot branch /btw while session maintenance or user work is still running",
		);

		abortController.abort();
	});

	it("refuses to branch /btw while context maintenance is running", async () => {
		const activeSession = await createSession();
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		const sessionWithMaintenance = activeSession as AgentSession & { _maintenanceForTest?: boolean };
		Object.defineProperty(sessionWithMaintenance, "isCompacting", {
			get: () => sessionWithMaintenance._maintenanceForTest === true,
		});
		sessionWithMaintenance._maintenanceForTest = true;

		await expect(activeSession.branchFromBtw("question", createBtwAssistant())).rejects.toThrow(
			"Cannot branch /btw while session maintenance or user work is still running",
		);
	});

	it("cancels post-prompt work after branch hooks before switching sessions", async () => {
		const hookRelease = Promise.withResolvers<void>();
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_branch"),
			emit: vi.fn(async () => {
				await hookRelease.promise;
				return undefined;
			}),
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });
		await activeSession.sessionManager.flush();
		activeSession.queueDeferredMessage({
			role: "custom",
			customType: "test-hidden-message",
			content: "hidden",
			display: false,
			timestamp: Date.now(),
		});
		expect(activeSession.hasPostPromptWork).toBe(true);

		const branchPromise = activeSession.branchFromBtw("question", createBtwAssistant());
		await Promise.resolve();
		expect(activeSession.hasPostPromptWork).toBe(true);

		hookRelease.resolve();
		const result = await branchPromise;

		expect(result.cancelled).toBe(false);
		expect(activeSession.hasPostPromptWork).toBe(false);
	});

	it("keeps an active provider turn and its queues live when branch persistence fails", async () => {
		const storage = new FailingBtwBranchStorage();
		const providerStarted = Promise.withResolvers<void>();
		const providerRelease = Promise.withResolvers<{ content: ["main response survived"] }>();
		let providerSignal: AbortSignal | undefined;
		const activeSession = await createSession({
			storage,
			handler: (_context, options) => {
				providerSignal = options?.signal;
				providerStarted.resolve();
				return Promise.race([
					providerRelease.promise,
					new Promise<never>((_resolve, reject) => {
						options?.signal?.addEventListener("abort", () => reject(new Error("provider aborted")), {
							once: true,
						});
					}),
				]);
			},
		});
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
		await activeSession.sessionManager.flush();

		const sourceTurnPersisted = Promise.withResolvers<void>();
		const previousOnEntryAppended = activeSession.sessionManager.onEntryAppended;
		activeSession.sessionManager.onEntryAppended = entry => {
			previousOnEntryAppended?.(entry);
			if (entry.type !== "message" || entry.message.role !== "user") return;
			activeSession.sessionManager.onEntryAppended = previousOnEntryAppended;
			sourceTurnPersisted.resolve();
		};
		const promptPromise = activeSession.prompt("main prompt");
		await Promise.all([providerStarted.promise, sourceTurnPersisted.promise]);
		await activeSession.followUp("queued source follow-up");
		const sourceSessionFile = activeSession.sessionFile;
		const sourceSessionId = activeSession.sessionId;
		const sourceHeader = structuredClone(activeSession.sessionManager.getHeader());
		const sourceEntries = structuredClone(activeSession.sessionManager.getEntries());
		const sourceLeafId = activeSession.sessionManager.getLeafId();
		const sourceMessages = [...activeSession.messages];
		const sourceSteering = [...activeSession.agent.peekSteeringQueue()];
		const sourceFollowUp = [...activeSession.agent.peekFollowUpQueue()];
		const onCommitted = vi.fn();
		const writeFailure = new Error("btw branch write failed");
		storage.nextSyncWriteError = writeFailure;

		await expect(
			activeSession.branchFromBtw("promote side answer", createBtwAssistant(), { onCommitted }),
		).rejects.toBe(writeFailure);

		expect(providerSignal?.aborted).toBe(false);
		expect(activeSession.isStreaming).toBe(true);
		expect(activeSession.sessionFile).toBe(sourceSessionFile);
		expect(activeSession.sessionId).toBe(sourceSessionId);
		expect(activeSession.sessionManager.getHeader()).toEqual(sourceHeader);
		expect(activeSession.sessionManager.getEntries()).toEqual(sourceEntries);
		expect(activeSession.sessionManager.getLeafId()).toBe(sourceLeafId);
		expect(activeSession.messages).toEqual(sourceMessages);
		expect(activeSession.agent.peekSteeringQueue()).toEqual(sourceSteering);
		expect(activeSession.agent.peekFollowUpQueue()).toEqual(sourceFollowUp);
		expect(onCommitted).not.toHaveBeenCalled();

		providerRelease.resolve({ content: ["main response survived"] });
		await promptPromise;
		await activeSession.waitForIdle();
		expect(JSON.stringify(activeSession.messages)).toContain("main response survived");
	});

	it("keeps pending post-prompt work live when branch persistence fails", async () => {
		const storage = new FailingBtwBranchStorage();
		const activeSession = await createSession({ storage });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: 1 });
		await activeSession.sessionManager.flush();

		const taskRelease = Promise.withResolvers<void>();
		let taskSignal: AbortSignal | undefined;
		let taskCompleted = false;
		activeSession.trackPostPromptTaskForTests(signal => {
			taskSignal = signal;
			return Promise.race([
				taskRelease.promise,
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("post-prompt task aborted")), { once: true });
				}),
			]).then(() => {
				taskCompleted = true;
			});
		});
		expect(activeSession.hasPostPromptWork).toBe(true);

		const sourceSessionFile = activeSession.sessionFile;
		const sourceHeader = structuredClone(activeSession.sessionManager.getHeader());
		const sourceEntries = structuredClone(activeSession.sessionManager.getEntries());
		const sourceLeafId = activeSession.sessionManager.getLeafId();
		const sourceMessages = [...activeSession.messages];
		const onCommitted = vi.fn();
		const writeFailure = new Error("post-prompt branch write failed");
		storage.nextSyncWriteError = writeFailure;

		await expect(
			activeSession.branchFromBtw("promote side answer", createBtwAssistant(), { onCommitted }),
		).rejects.toBe(writeFailure);

		expect(taskSignal?.aborted).toBe(false);
		expect(taskCompleted).toBe(false);
		expect(activeSession.hasPostPromptWork).toBe(true);
		expect(activeSession.sessionFile).toBe(sourceSessionFile);
		expect(activeSession.sessionManager.getHeader()).toEqual(sourceHeader);
		expect(activeSession.sessionManager.getEntries()).toEqual(sourceEntries);
		expect(activeSession.sessionManager.getLeafId()).toBe(sourceLeafId);
		expect(activeSession.messages).toEqual(sourceMessages);
		expect(onCommitted).not.toHaveBeenCalled();

		taskRelease.resolve();
		await activeSession.waitForIdle();
		expect(taskCompleted).toBe(true);
	});

	it("bypasses only session_before_switch when explicitly restoring a committed snapshot", async () => {
		const emit = vi.fn(async (event: { type: string }) =>
			event.type === "session_before_switch" ? { cancel: true } : undefined,
		);
		const extensionRunner = {
			hasHandlers: vi.fn((eventType: string) => eventType === "session_before_switch"),
			emit,
		} as unknown as ExtensionRunner;
		const activeSession = await createSession({ extensionRunner });
		activeSession.sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await activeSession.sessionManager.ensureOnDisk();
		const sourceSessionFile = activeSession.sessionFile;

		const targetManager = SessionManager.create(tempDir, tempDir);
		targetManager.appendMessage({ role: "user", content: "committed target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		const targetSessionFile = targetManager.getSessionFile();
		await targetManager.close();
		if (!targetSessionFile) throw new Error("Expected persisted target session");

		expect(await activeSession.switchSession(targetSessionFile)).toBe(false);
		expect(activeSession.sessionFile).toBe(sourceSessionFile);

		const beforeCommit = vi.fn(async () => undefined);
		const onCommitted = vi.fn();
		expect(
			await activeSession.switchSession(targetSessionFile, {
				bypassBeforeSwitchHook: true,
				beforeCommit,
				onCommitted,
			}),
		).toBe(true);

		expect(activeSession.sessionFile).toBe(targetSessionFile);
		expect(beforeCommit).toHaveBeenCalledTimes(1);
		expect(onCommitted).toHaveBeenCalledTimes(1);
		expect(emit.mock.calls.filter(([event]) => event.type === "session_before_switch")).toHaveLength(1);
	});

	it("throws for in-memory sessions", async () => {
		const activeSession = await createSession({ persisted: false });
		activeSession.sessionManager.appendMessage({ role: "user", content: "seed", timestamp: Date.now() });

		await expect(activeSession.branchFromBtw("question", createBtwAssistant())).rejects.toThrow(
			"Cannot branch /btw: session is not persisted",
		);
	});
});
