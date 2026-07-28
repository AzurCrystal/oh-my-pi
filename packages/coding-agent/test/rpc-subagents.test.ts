import { afterEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import * as rpcCollab from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-collab";
import {
	getRpcSessionTransitionGuestBlock,
	handleRpcSessionChange,
	isSameRpcSessionReload,
	type RpcSessionChangeCommand,
	type RpcSessionChangeResult,
	type RpcSessionChangeSession,
	runRpcSessionTransitionAtCommit,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents";
import type { RpcSubagentFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionTransitionOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import {
	type AgentProgress,
	type SubagentEventPayload,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const tempPaths: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const tempPath of tempPaths.splice(0)) {
		removeSyncWithRetries(tempPath);
	}
});

function createProgress(overrides: Partial<AgentProgress> = {}): AgentProgress {
	return {
		index: 0,
		id: "SubagentA",
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "Do work",
		assignment: "Implement work",
		description: "Worker",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function createRegistryWithSnapshot(): RpcSubagentRegistry {
	const eventBus = new EventBus();
	const registry = new RpcSubagentRegistry(eventBus, () => {});
	eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
		id: "SubagentA",
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "started",
		sessionFile: "/tmp/subagent.jsonl",
	} satisfies SubagentLifecyclePayload);
	expect(registry.getSubagents()).toHaveLength(1);
	return registry;
}

type SessionChangeStubOptions = {
	sessionFile?: string;
	newSession?: boolean;
	switchSession?: boolean;
	branch?: { selectedText: string; selectedImages: ImageContent[]; cancelled: boolean };
	fork?: boolean;
	/** Thrown after reversible preparation but before the session commits. */
	failBeforeCommit?: Error;
	/** Thrown after the session has crossed its irreversible commit boundary. */
	failAfterCommit?: Error;
};

function createSessionChangeSession(options: SessionChangeStubOptions): RpcSessionChangeSession {
	const transition = async (
		sessionOptions: SessionTransitionOptions | undefined,
		committed: boolean,
	): Promise<void> => {
		await sessionOptions?.beforeCommit?.();
		if (options.failBeforeCommit) throw options.failBeforeCommit;
		if (!committed) return;
		sessionOptions?.onCommitted?.();
		if (options.failAfterCommit) throw options.failAfterCommit;
	};
	return {
		sessionFile: options.sessionFile,
		newSession: async sessionOptions => {
			const changed = options.newSession ?? true;
			if (changed) await transition(sessionOptions, true);
			return changed;
		},
		switchSession: async (_sessionPath, sessionOptions) => {
			const changed = options.switchSession ?? true;
			if (changed) await transition(sessionOptions, true);
			return changed;
		},
		branch: async (_entryId, sessionOptions) => {
			const result = options.branch ?? { selectedText: "branched text", selectedImages: [], cancelled: false };
			if (!result.cancelled) await transition(sessionOptions, true);
			return result;
		},
		fork: async sessionOptions => {
			// A non-persisted fork can return false after reversible preparation,
			// but it never reports the irreversible commit callback.
			const changed = options.fork ?? true;
			await transition(sessionOptions, changed);
			return changed;
		},
	};
}

describe("RPC subagent registry", () => {
	test("blocks guest session changes without leaving the collaboration", () => {
		const session = {} as AgentSession;
		vi.spyOn(rpcCollab, "isRpcCollabGuest").mockReturnValue(true);
		const leave = vi.spyOn(rpcCollab, "leaveRpcCollabSession");

		expect(getRpcSessionTransitionGuestBlock(session)).toEqual({
			message:
				"Session changes are unavailable while joined as a collaboration guest. Run leave_collab_session first.",
			code: "operation_failed",
		});
		expect(leave).not.toHaveBeenCalled();
	});

	test("defaults subagent frame emission to off while tracking snapshots", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		expect(registry.getSubscriptionLevel()).toBe("off");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(0);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				sessionFile: "/tmp/subagent.jsonl",
			},
		]);
		registry.dispose();
	});

	test("emits progress frames after explicit progress subscription and snapshots tracked subagents", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		registry.setSubscriptionLevel("progress");
		const lifecycle: SubagentLifecyclePayload = {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			description: "Worker",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
			parentToolCallId: "toolu_parent",
		};
		const progressPayload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Do work",
			assignment: "Implement work",
			parentToolCallId: "toolu_parent",
			sessionFile: "/tmp/subagent.jsonl",
			progress: createProgress(),
		};

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, lifecycle);
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, progressPayload);

		expect(frames.map(frame => frame.type)).toEqual(["subagent_lifecycle", "subagent_progress"]);
		expect(registry.getSubagents()).toMatchObject([
			{
				id: "SubagentA",
				status: "running",
				task: "Do work",
				assignment: "Implement work",
				sessionFile: "/tmp/subagent.jsonl",
				parentToolCallId: "toolu_parent",
			},
		]);

		registry.dispose();
	});

	test("clears stale snapshots when the active RPC session changes", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile: "/tmp/subagent.jsonl",
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		registry.clear();

		expect(registry.getSubagents()).toHaveLength(0);
		registry.dispose();
	});

	test("preserves the registry for a logical same-session reload and clears a different switch", async () => {
		const currentSessionFile = path.resolve("current-session.jsonl");
		const logicalReloadPath =
			process.platform === "win32"
				? currentSessionFile.toUpperCase().replaceAll("\\", "/")
				: path.normalize(currentSessionFile);
		expect(isSameRpcSessionReload(currentSessionFile, logicalReloadPath)).toBe(true);

		const registry = createRegistryWithSnapshot();
		try {
			const reloadResult = await handleRpcSessionChange(
				createSessionChangeSession({ switchSession: true, sessionFile: currentSessionFile }),
				{ type: "switch_session", sessionPath: logicalReloadPath },
				registry,
			);
			expect(reloadResult).toEqual({ type: "switch_session", data: { cancelled: false } });
			expect(registry.getSubagents()).toMatchObject([{ id: "SubagentA" }]);

			const differentSessionFile = path.resolve("different-session.jsonl");
			expect(isSameRpcSessionReload(currentSessionFile, differentSessionFile)).toBe(false);
			await handleRpcSessionChange(
				createSessionChangeSession({ switchSession: true, sessionFile: currentSessionFile }),
				{ type: "switch_session", sessionPath: differentSessionFile },
				registry,
			);
			expect(registry.getSubagents()).toHaveLength(0);
		} finally {
			registry.dispose();
		}
	});

	test("clears stale snapshots after successful RPC session changes", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: true }),
				expected: { type: "new_session", data: { cancelled: false } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: true }),
				expected: { type: "switch_session", data: { cancelled: false } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({
					branch: { selectedText: "Branch text", selectedImages: [], cancelled: false },
				}),
				expected: { type: "branch", data: { text: "Branch text", cancelled: false } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toHaveLength(0);
				expect(() => registry.resolveSessionFile({ subagentId: "SubagentA" })).toThrow(
					/Unknown subagent or session file unavailable/,
				);
			} finally {
				registry.dispose();
			}
		}
	});

	test("keeps stale snapshots when RPC session changes are cancelled", async () => {
		const cases: Array<{
			command: RpcSessionChangeCommand;
			session: RpcSessionChangeSession;
			expected: RpcSessionChangeResult;
		}> = [
			{
				command: { type: "new_session", parentSession: "/tmp/parent.jsonl" },
				session: createSessionChangeSession({ newSession: false }),
				expected: { type: "new_session", data: { cancelled: true } },
			},
			{
				command: { type: "switch_session", sessionPath: "/tmp/next.jsonl" },
				session: createSessionChangeSession({ switchSession: false }),
				expected: { type: "switch_session", data: { cancelled: true } },
			},
			{
				command: { type: "branch", entryId: "entry-1" },
				session: createSessionChangeSession({ branch: { selectedText: "", selectedImages: [], cancelled: true } }),
				expected: { type: "branch", data: { text: "", cancelled: true } },
			},
		];

		for (const testCase of cases) {
			const registry = createRegistryWithSnapshot();
			try {
				const result = await handleRpcSessionChange(testCase.session, testCase.command, registry);

				expect(result).toEqual(testCase.expected);
				expect(registry.getSubagents()).toMatchObject([{ id: "SubagentA" }]);
				expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe("/tmp/subagent.jsonl");
			} finally {
				registry.dispose();
			}
		}
	});

	test("keeps RPC session-transition teardown atomic across cancellation and failure", async () => {
		type IdleHandle = { disposed: boolean };
		type TransitionRuntime = {
			prepare: () => Promise<void>;
			reconcile: (outcome: { committed: boolean; honorPlanDefault: boolean }) => Promise<void>;
		};

		const createRuntime = (options: { modeTeardownError?: Error; reconcileError?: Error } = {}) => {
			const idleHandles: IdleHandle[] = [{ disposed: false }];
			const state = {
				modeLive: true,
				attachmentsReleased: 0,
				prepared: 0,
				reconciled: 0,
				honorPlanDefault: false,
				suspensionCommitted: 0,
				suspensionRolledBack: 0,
			};
			return {
				state,
				liveIdleHandles: () => idleHandles.filter(handle => !handle.disposed).length,
				prepare: async () => {
					state.prepared++;
					// Reversible teardown that can still fail before the idle handle is released.
					if (options.modeTeardownError) throw options.modeTeardownError;
					state.modeLive = false;
					for (const handle of idleHandles) handle.disposed = true;
				},
				reconcile: async ({ committed, honorPlanDefault }: { committed: boolean; honorPlanDefault: boolean }) => {
					state.reconciled++;
					state.honorPlanDefault = honorPlanDefault;
					if (committed) {
						state.attachmentsReleased++;
						state.suspensionCommitted++;
					} else {
						state.suspensionRolledBack++;
					}
					state.modeLive = true;
					for (const handle of idleHandles) handle.disposed = true;
					idleHandles.push({ disposed: false });
					if (options.reconcileError) throw options.reconcileError;
				},
			};
		};

		const runTransition = (
			runtime: TransitionRuntime,
			session: RpcSessionChangeSession,
			command: RpcSessionChangeCommand,
		): Promise<RpcSessionChangeResult> =>
			runRpcSessionTransitionAtCommit(
				async transitionOptions => {
					const result = await handleRpcSessionChange(session, command, undefined, transitionOptions);
					return { result, committed: !result.data.cancelled, honorPlanDefault: false };
				},
				runtime.prepare,
				runtime.reconcile,
				command.type === "new_session",
			);

		// A hook that cancels the change never reaches teardown at all.
		const hookCancelled = createRuntime();
		const cancelledResult = await runTransition(hookCancelled, createSessionChangeSession({ newSession: false }), {
			type: "new_session",
		});
		expect(cancelledResult.data.cancelled).toBe(true);
		expect(hookCancelled.state).toMatchObject({ modeLive: true, prepared: 0, reconciled: 0, attachmentsReleased: 0 });
		expect(hookCancelled.liveIdleHandles()).toBe(1);

		// A fork that cannot materialize after reversible preparation keeps the
		// outgoing collaboration and voice attachments and restores its runtime.
		const abortedFork = createRuntime();
		const forkResult = await runTransition(abortedFork, createSessionChangeSession({ fork: false }), {
			type: "fork",
		});
		expect(forkResult.data.cancelled).toBe(true);
		expect(abortedFork.state).toMatchObject({
			modeLive: true,
			prepared: 1,
			reconciled: 1,
			attachmentsReleased: 0,
		});
		expect(abortedFork.liveIdleHandles()).toBe(1);

		// Reloading the current logical file succeeds, but RPC must roll its
		// reversible Vibe suspension back rather than terminate workers or release
		// session-owned attachments.
		const sameReload = createRuntime();
		const sameReloadResult = await runRpcSessionTransitionAtCommit(
			async transitionOptions => {
				const result = await handleRpcSessionChange(
					createSessionChangeSession({ switchSession: true }),
					{ type: "switch_session", sessionPath: "/tmp/current.jsonl" },
					undefined,
					transitionOptions,
				);
				return { result, committed: !result.data.cancelled, honorPlanDefault: false };
			},
			sameReload.prepare,
			sameReload.reconcile,
			false,
			true,
		);
		expect(sameReloadResult.data.cancelled).toBe(false);
		expect(sameReload.state).toMatchObject({
			modeLive: true,
			prepared: 1,
			reconciled: 1,
			attachmentsReleased: 0,
			suspensionCommitted: 0,
			suspensionRolledBack: 1,
		});
		expect(sameReload.liveIdleHandles()).toBe(1);

		// A failure before the switch can commit keeps outgoing attachments.
		const failedSwitch = createRuntime();
		await expect(
			runTransition(failedSwitch, createSessionChangeSession({ failBeforeCommit: new Error("flush failed") }), {
				type: "switch_session",
				sessionPath: "/tmp/target.jsonl",
			}),
		).rejects.toThrow("flush failed");
		expect(failedSwitch.state).toMatchObject({ modeLive: true, prepared: 1, reconciled: 1, attachmentsReleased: 0 });
		expect(failedSwitch.liveIdleHandles()).toBe(1);

		// A later failure remains committed even though the operation never returns.
		const failedAfterCommit = createRuntime();
		await expect(
			runTransition(
				failedAfterCommit,
				createSessionChangeSession({ failAfterCommit: new Error("post-commit hook failed") }),
				{ type: "new_session" },
			),
		).rejects.toThrow("post-commit hook failed");
		expect(failedAfterCommit.state).toMatchObject({
			modeLive: true,
			prepared: 1,
			reconciled: 1,
			attachmentsReleased: 1,
			honorPlanDefault: true,
		});
		expect(failedAfterCommit.liveIdleHandles()).toBe(1);

		// Teardown that fails halfway still reconciles, and leaves exactly one idle
		// handle instead of stacking a second one on top of the live one.
		const failedTeardown = createRuntime({ modeTeardownError: new Error("vibe teardown failed") });
		await expect(
			runTransition(failedTeardown, createSessionChangeSession({}), { type: "new_session" }),
		).rejects.toThrow("vibe teardown failed");
		expect(failedTeardown.state).toMatchObject({
			modeLive: true,
			prepared: 1,
			reconciled: 1,
			attachmentsReleased: 0,
		});
		expect(failedTeardown.liveIdleHandles()).toBe(1);

		const failedReconcile = createRuntime({ reconcileError: new Error("mode reconciliation failed") });
		await expect(
			runTransition(failedReconcile, createSessionChangeSession({}), { type: "new_session" }),
		).rejects.toThrow("mode reconciliation failed");
		expect(failedReconcile.state).toMatchObject({
			modeLive: true,
			prepared: 1,
			reconciled: 1,
			attachmentsReleased: 1,
		});
		expect(failedReconcile.liveIdleHandles()).toBe(1);

		// Only a committed transition releases the irreversible attachments.
		const committed = createRuntime();
		const committedResult = await runTransition(committed, createSessionChangeSession({}), {
			type: "new_session",
		});
		expect(committedResult.data.cancelled).toBe(false);
		expect(committed.state).toMatchObject({ modeLive: true, prepared: 1, reconciled: 1, attachmentsReleased: 1 });
		expect(committed.liveIdleHandles()).toBe(1);
	});

	test("prunes terminal lifecycle snapshots while retaining transcript selectors", () => {
		const eventBus = new EventBus();
		const registry = new RpcSubagentRegistry(eventBus, () => {});
		const sessionFile = "/tmp/subagent.jsonl";
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "started",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(1);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, {
			id: "SubagentA",
			index: 0,
			agent: "task",
			agentSource: "bundled",
			status: "completed",
			sessionFile,
		} satisfies SubagentLifecyclePayload);

		expect(registry.getSubagents()).toHaveLength(0);
		expect(registry.resolveSessionFile({ subagentId: "SubagentA" })).toBe(sessionFile);
		expect(registry.resolveSessionFile({ sessionFile })).toBe(sessionFile);
		registry.dispose();
	});

	test("gates raw subagent events behind the events subscription level", () => {
		const eventBus = new EventBus();
		const frames: RpcSubagentFrame[] = [];
		const registry = new RpcSubagentRegistry(eventBus, frame => frames.push(frame));
		const eventPayload: SubagentEventPayload = {
			id: "SubagentA",
			event: { type: "agent_start" },
		};

		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);
		expect(frames).toHaveLength(0);

		registry.setSubscriptionLevel("events");
		eventBus.emit(TASK_SUBAGENT_EVENT_CHANNEL, eventPayload);

		expect(frames).toHaveLength(1);
		expect(frames[0]).toEqual({ type: "subagent_event", payload: eventPayload });
		registry.dispose();
	});
});

describe("readRpcSubagentTranscript", () => {
	test("returns complete JSONL entries and byte cursor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "session.jsonl");
		const headerLine = `${JSON.stringify({ type: "session", id: "s1", timestamp: "2026-06-09T00:00:00.000Z", cwd: dir })}\n`;
		const messageLine = `${JSON.stringify({
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: "2026-06-09T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "hello" }] },
		})}\n`;
		await Bun.write(sessionFile, `${headerLine}${messageLine}{"type":"message"`);

		const result = await readRpcSubagentTranscript(sessionFile);

		expect(result.entries).toHaveLength(2);
		expect(result.messages).toHaveLength(1);
		expect(result.nextByte).toBe(Buffer.byteLength(`${headerLine}${messageLine}`, "utf8"));
		expect(result.reset).toBe(false);
	});

	test("returns empty cursor result for missing transcript files", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-rpc-subagent-transcript-missing-"));
		tempPaths.push(dir);
		const sessionFile = path.join(dir, "missing.jsonl");

		const result = await readRpcSubagentTranscript(sessionFile, 42);

		expect(result).toEqual({
			sessionFile,
			fromByte: 42,
			nextByte: 42,
			reset: false,
			entries: [],
			messages: [],
		});
	});
});

describe("RpcClient subagent frames", () => {
	test("dispatches subagent frames and session-specific events", async () => {
		const scriptPath = path.join(os.tmpdir(), `omp-rpc-subagent-client-${Date.now()}.js`);
		tempPaths.push(scriptPath);
		await Bun.write(
			scriptPath,
			`
let buffer = "";
function write(frame) {
	process.stdout.write(JSON.stringify(frame) + "\\n");
}
const progress = {
	index: 0,
	id: "SubagentA",
	agent: "task",
	agentSource: "bundled",
	status: "running",
	task: "Do work",
	assignment: "Implement work",
	recentTools: [],
	recentOutput: [],
	toolCount: 0,
	tokens: 0,
	cost: 0,
	durationMs: 0
};
write({ type: "ready" });
process.stdin.on("data", chunk => {
	buffer += chunk.toString("utf8");
	let index = buffer.indexOf("\\n");
	while (index !== -1) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (line) handle(JSON.parse(line));
		index = buffer.indexOf("\\n");
	}
});
function handle(frame) {
	if (frame.type === "set_subagent_subscription") {
		write({ id: frame.id, type: "response", command: "set_subagent_subscription", success: true, data: { level: frame.level } });
		return;
	}
	if (frame.type === "get_subagents") {
		write({ id: frame.id, type: "response", command: "get_subagents", success: true, data: { subagents: [{ id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "running", lastUpdate: 1 }] } });
		return;
	}
	if (frame.type === "get_subagent_messages") {
		write({ id: frame.id, type: "response", command: "get_subagent_messages", success: true, data: { sessionFile: frame.sessionFile || "/tmp/subagent.jsonl", fromByte: frame.fromByte || 0, nextByte: 0, reset: false, entries: [], messages: [] } });
		return;
	}
	if (frame.type === "prompt") {
		write({ id: frame.id, type: "response", command: "prompt", success: true });
		write({ type: "notice", level: "info", message: "subagent test" });
		write({ type: "subagent_lifecycle", payload: { id: "SubagentA", index: 0, agent: "task", agentSource: "bundled", status: "started", sessionFile: "/tmp/subagent.jsonl" } });
		write({ type: "subagent_progress", payload: { index: 0, agent: "task", agentSource: "bundled", task: "Do work", assignment: "Implement work", sessionFile: "/tmp/subagent.jsonl", progress } });
		write({ type: "subagent_event", payload: { id: "SubagentA", event: { type: "agent_start" } } });
		write({ type: "agent_end", messages: [] });
	}
}
`,
		);

		using client = new RpcClient({ cliPath: scriptPath });
		const lifecycleIds: string[] = [];
		const progressTasks: string[] = [];
		const rawEventTypes: string[] = [];
		const sessionEventTypes: string[] = [];
		client.onSubagentLifecycle(payload => lifecycleIds.push(payload.id));
		client.onSubagentProgress(payload => progressTasks.push(payload.task));
		client.onSubagentEvent(payload => rawEventTypes.push(payload.event.type));
		client.onSessionEvent(event => sessionEventTypes.push(event.type));

		await client.start();
		await expect(client.setSubagentSubscription("events")).resolves.toBe("events");
		await client.promptAndWait("Trigger subagent frames");
		expect(await client.getSubagents()).toHaveLength(1);
		expect(await client.getSubagentMessages({ sessionFile: "/tmp/subagent.jsonl" })).toMatchObject({
			sessionFile: "/tmp/subagent.jsonl",
		});

		expect(lifecycleIds).toEqual(["SubagentA"]);
		expect(progressTasks).toEqual(["Do work"]);
		expect(rawEventTypes).toEqual(["agent_start"]);
		expect(sessionEventTypes).toContain("notice");
	});
});
