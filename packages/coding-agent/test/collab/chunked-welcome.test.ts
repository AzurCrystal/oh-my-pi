/**
 * Contract: a large session snapshot is delivered as a small `welcome` frame
 * plus a train of `snapshot-chunk` frames, so the guest can clear its 30s
 * first-welcome timeout long before the full transcript arrives — the fix for
 * [#3144](https://github.com/can1357/oh-my-pi/issues/3144) where a multi-MB
 * single-frame welcome timed out on the default relay.
 *
 * The test drives the production `CollabHost` (real sealing, real envelopes)
 * through an in-process relay + fake WebSocket, mirroring the relay's
 * forwarding contract exactly; only the TUI context and the network transport
 * are stubbed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { importRoomKey } from "@oh-my-pi/pi-coding-agent/collab/crypto";
import { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { COLLAB_PROTO, type CollabFrame, parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { CollabSocket } from "@oh-my-pi/pi-coding-agent/collab/relay-client";
import {
	getRpcCollabGuestLifecycleDisposition,
	getRpcCollabStatus,
	joinRpcCollabSession,
	leaveRpcCollabSession,
	sendRpcCollabGuestPrompt,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-collab";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type {
	SessionTransitionOptions,
	SessionTransitionRunner,
	SessionTransitionRunOptions,
} from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

// In-memory transport: shared FakeWebSocket + InMemoryRelay harness (see
// ./helpers/in-memory-relay), mirroring the relay's forwarding contract.

// ── Host harness with a configurable transcript ────────────────────────────

interface SizedSnapshot {
	header: { type: "session"; id: string; timestamp: string; cwd: string };
	entries: SessionEntry[];
}

/**
 * Build a synthetic transcript whose total serialized size comfortably
 * exceeds the host's `SNAPSHOT_CHUNK_BYTES` (512 KB), forcing several
 * chunks. Each entry is ~16 KB of repeated text, so 96 entries → ~1.5 MB,
 * cleanly above three chunks without making the test slow.
 */
function makeLargeSnapshot(): SizedSnapshot {
	const body = "x".repeat(16 * 1024);
	const entries: SessionEntry[] = [];
	for (let i = 0; i < 96; i++) {
		entries.push({
			type: "message",
			id: `e${i}`,
			parentId: null,
			timestamp: "2026-06-20T00:00:00Z",
			message: { role: "user", content: body, timestamp: 0 },
		});
	}
	return {
		header: { type: "session", id: "sess-large", timestamp: "2026-06-20T00:00:00Z", cwd: "/tmp" },
		entries,
	};
}

let hostEventListener: ((event: AgentSessionEvent) => void) | undefined;
let hostStreaming = false;
let hostPromptObserver: (() => void) | undefined;

function makeHostContext(snapshot: SizedSnapshot): InteractiveModeContext {
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionId: () => snapshot.header.id,
			getCwd: () => snapshot.header.cwd,
			snapshotForReplication: () => snapshot,
			onEntryAppended: undefined,
		},
		session: {
			get isStreaming() {
				return hostStreaming;
			},
			queuedMessageCount: 0,
			sessionName: "large",
			model: undefined,
			thinkingLevel: undefined,
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				hostEventListener = listener;
				return () => {
					if (hostEventListener === listener) hostEventListener = undefined;
				};
			},
			emitNotice: () => {},
			promptCustomMessage: () => {
				hostPromptObserver?.();
				return Promise.resolve();
			},
			abort: () => Promise.resolve(),
		},
		eventBus: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		collabHost: undefined,
	};
	return ctx as unknown as InteractiveModeContext;
}

function makeFailingGuestContext(failure: Error): InteractiveModeContext {
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => null,
			switchSession: () => Promise.reject(failure),
		},
		session: {
			newSession: () => Promise.resolve(),
			messages: [],
		},
		statusContainer: { clear: () => {} },
		pendingMessagesContainer: { clear: () => {} },
		compactionQueuedMessages: [],
		streamingComponent: undefined,
		streamingMessage: undefined,
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		loadingAnimation: undefined,
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			resetActiveTime: () => {},
		},
		ui: { requestRender: () => {} },
		chatContainer: { clear: () => {} },
		resetObserverRegistry: () => {},
		renderInitialMessages: () => {},
		reloadTodos: () => Promise.resolve(),
		showStatus: () => {},
		updateEditorTopBorder: () => {},
		updateEditorBorderColor: () => {},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
	return ctx;
}

const LOCAL_SESSION_FILE = "/tmp/local-session.jsonl";

interface TransactionalGuestHarness {
	ctx: InteractiveModeContext;
	activeSession: () => string;
	switchedPaths: string[];
	transitionOptions: (SessionTransitionRunOptions | undefined)[];
	switchOptions: (SessionTransitionOptions | undefined)[];
	leaseReleases: () => number;
	clears: { status: number; pending: number };
}

function makeTransactionalGuestContext(options: {
	cancelReplica?: boolean;
	reloadFailure?: Error;
	events?: string[];
	cancelLocalWithoutBypass?: boolean;
	restoreFailure?: { remaining: number; error: Error };
	replicaPostCommitFailure?: Error;
}): TransactionalGuestHarness {
	let activeSession = LOCAL_SESSION_FILE;
	const switchedPaths: string[] = [];
	const transitionOptions: (SessionTransitionRunOptions | undefined)[] = [];
	const switchOptions: (SessionTransitionOptions | undefined)[] = [];
	let leaseReleases = 0;
	const clears = { status: 0, pending: 0 };
	const runSessionTransition: SessionTransitionRunner = async (transition, runOptions) => {
		transitionOptions.push(runOptions);
		return (await transition({})).result;
	};
	const ctx = {
		settings: { get: () => "" },
		sessionManager: {
			getSessionFile: () => activeSession,
			getSessionName: () => "local",
			getCwd: () => "/tmp",
		},
		session: {
			switchSession: async (sessionPath: string, switchSessionOptions?: SessionTransitionOptions) => {
				switchedPaths.push(sessionPath);
				switchOptions.push(switchSessionOptions);
				const isReplica = sessionPath !== LOCAL_SESSION_FILE;
				options.events?.push(isReplica ? "replica committed" : "local restored");
				if (isReplica && options.cancelReplica) return false;
				if (!isReplica && options.cancelLocalWithoutBypass && !switchSessionOptions?.bypassBeforeSwitchHook) {
					return false;
				}
				if (!isReplica && options.restoreFailure && options.restoreFailure.remaining > 0) {
					options.restoreFailure.remaining--;
					throw options.restoreFailure.error;
				}
				activeSession = sessionPath;
				switchSessionOptions?.onCommitted?.();
				if (isReplica && options.replicaPostCommitFailure) throw options.replicaPostCommitFailure;
				return true;
			},
			newSession: async () => true,
			messages: [],
			agent: {
				state: { model: undefined },
				setModel: () => {},
				setThinkingLevel: () => {},
				setDisableReasoning: () => {},
			},
			getVibeModeState: () => undefined,
			emitNotice: () => {},
			acquireSessionTransition: () => ({
				run: runSessionTransition,
				release: () => {
					leaseReleases++;
				},
			}),
			runSessionTransition,
		},
		runSessionTransition,
		statusContainer: {
			clear: () => {
				clears.status++;
			},
		},
		pendingMessagesContainer: {
			clear: () => {
				clears.pending++;
			},
		},
		compactionQueuedMessages: [],
		pendingTools: new Map(),
		resetObserverRegistry: () => {},
		syncRunningSubagentBadge: () => {},
		chatContainer: { clear: () => {} },
		renderInitialMessages: () => {},
		reloadTodos: async () => {
			if (!options.reloadFailure) return;
			options.events?.push("postcommit apply failed");
			throw options.reloadFailure;
		},
		collabGuest: undefined,
	} as unknown as InteractiveModeContext;
	Object.assign(ctx.session, {
		sessionManager: ctx.sessionManager,
		settings: ctx.settings,
	});
	return {
		ctx,
		activeSession: () => activeSession,
		switchedPaths,
		transitionOptions,
		switchOptions,
		leaseReleases: () => leaseReleases,
		clears,
	};
}

// ── Shared host/relay ───────────────────────────────────────────────────────

const snapshot = makeLargeSnapshot();
let host: CollabHost;

beforeAll(async () => {
	installInMemoryRelay();
	host = new CollabHost(makeHostContext(snapshot));
	await host.start("ws://localhost:8788");
});

afterAll(async () => {
	uninstallInMemoryRelay();
	await host.stop("test done");
});

const guestCleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of guestCleanups.splice(0).reverse()) cleanup();
});

describe("collab chunked welcome (#3144)", () => {
	it("delivers a small welcome before chunking the transcript across multiple frames", async () => {
		const parsed = parseCollabLink(host.link);
		if ("error" in parsed) throw new Error(parsed.error);
		const writeToken = parsed.writeToken ? Buffer.from(parsed.writeToken).toString("base64url") : undefined;
		const key = await importRoomKey(parsed.key);
		const socket = new CollabSocket({ wsUrl: parsed.wsUrl, role: "guest", key });
		guestCleanups.push(() => socket.close());

		const frames: CollabFrame[] = [];
		const trainDone = Promise.withResolvers<void>();
		socket.onFrame = frame => {
			frames.push(frame);
			if (frame.t === "snapshot-chunk" && frame.final) trainDone.resolve();
		};
		socket.onOpen = () => socket.send({ t: "hello", proto: COLLAB_PROTO, name: "test", writeToken });
		socket.connect();
		await trainDone.promise;

		const welcomeIdx = frames.findIndex(f => f.t === "welcome");
		expect(welcomeIdx).toBeGreaterThanOrEqual(0);
		const welcome = frames[welcomeIdx];
		if (welcome?.t !== "welcome") throw new Error("expected welcome frame");

		expect(welcome.entryCount).toBe(snapshot.entries.length);
		expect(welcome.header.id).toBe(snapshot.header.id);
		// Critical fix: the welcome itself MUST NOT carry the transcript inline —
		// inline bytes were what spent the guest's 30s timeout in #3144.
		const welcomeBytes = JSON.stringify(welcome).length;
		const snapshotBytes = JSON.stringify(snapshot).length;
		expect(welcomeBytes).toBeLessThan(snapshotBytes / 10);

		// The chunk train starts immediately after the welcome and the host
		// queues every chunk synchronously, so no other directed frame may
		// interleave between them.
		const chunks: { entries: SessionEntry[]; final: boolean }[] = [];
		for (let i = welcomeIdx + 1; i < frames.length; i++) {
			const f = frames[i];
			if (f?.t !== "snapshot-chunk") {
				throw new Error(`unexpected ${f?.t ?? "missing"} between welcome and final chunk`);
			}
			chunks.push({ entries: f.entries, final: f.final });
			if (f.final) break;
		}
		// Three+ chunks proves we honor the 512 KB cap with the 1.5 MB transcript;
		// only the last carries `final: true`.
		expect(chunks.length).toBeGreaterThan(1);
		expect(chunks.at(-1)?.final).toBe(true);
		expect(chunks.slice(0, -1).every(c => !c.final)).toBe(true);

		const flattened: SessionEntry[] = [];
		for (const chunk of chunks) flattened.push(...chunk.entries);
		expect(flattened.length).toBe(snapshot.entries.length);
		expect(flattened.map(e => e.id)).toEqual(snapshot.entries.map(e => e.id));
	});

	it("rejects the pending join when snapshot resume fails", async () => {
		const failure = new Error("replica write failed during snapshot resume");
		const writeSpy = spyOn(Bun, "write").mockRejectedValue(failure);
		const guest = new CollabGuestLink(makeFailingGuestContext(failure));
		const joinAttempt = guest.join(host.link);
		try {
			await expect(
				Promise.race([
					joinAttempt,
					Bun.sleep(250).then(() => {
						throw new Error("join did not reject");
					}),
				]),
			).rejects.toThrow("replica write failed during snapshot resume");
		} finally {
			writeSpy.mockRestore();
			await guest.leave("test cleanup").catch(() => {});
		}
	});

	it("keeps the local session and mirror intact when the replica switch is cancelled", async () => {
		const harness = makeTransactionalGuestContext({ cancelReplica: true });
		const guest = new CollabGuestLink(harness.ctx);
		const localRef = guest.agentRegistry.register({
			id: "local-peer",
			displayName: "Local Peer",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/local-peer.jsonl",
			status: "idle",
		});

		await expect(guest.join(host.link)).rejects.toThrow("Collab replica session switch was cancelled");

		expect(harness.activeSession()).toBe(LOCAL_SESSION_FILE);
		expect(guest.agentRegistry.get("local-peer")).toBe(localRef);
		expect(harness.clears).toEqual({ status: 0, pending: 0 });

		await guest.leave("first cleanup");
		await guest.leave("second cleanup");
		expect(harness.switchedPaths).toHaveLength(1);
	});

	it("bypasses return-hook cancellation while restoring a failed postcommit join", async () => {
		const failure = new Error("postcommit apply failed");
		const events: string[] = [];
		const harness = makeTransactionalGuestContext({
			reloadFailure: failure,
			events,
			cancelLocalWithoutBypass: true,
		});
		const guest = new CollabGuestLink(harness.ctx);
		guest.agentRegistry.register({
			id: "local-peer",
			displayName: "Local Peer",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/local-peer.jsonl",
			status: "idle",
		});
		harness.ctx.collabGuest = guest;

		const startup = (async () => {
			try {
				await guest.join(host.link);
			} catch (error) {
				await guest.leave("join failed");
				throw error;
			}
		})();
		try {
			await expect(startup).rejects.toThrow(failure.message);
		} finally {
			events.push("lease released");
		}

		expect(events).toEqual(["replica committed", "postcommit apply failed", "local restored", "lease released"]);
		expect(harness.activeSession()).toBe(LOCAL_SESSION_FILE);
		expect(harness.switchOptions.map(options => options?.bypassBeforeSwitchHook)).toEqual([undefined, true]);
		expect(harness.ctx.collabGuest).toBeUndefined();
		expect(guest.agentRegistry.list()).toMatchObject([
			{
				id: "local-peer",
				displayName: "Local Peer",
				sessionFile: "/tmp/local-peer.jsonl",
				status: "idle",
			},
		]);

		await guest.leave("repeated cleanup");
		expect(harness.switchedPaths).toHaveLength(2);
		expect(harness.transitionOptions).toEqual([
			{ preserveCollabAttachmentOnCommit: true },
			{ preserveCollabAttachmentOnCommit: true },
		]);
	});

	it("derives guest lifecycle disposition from host events before forwarding commands", async () => {
		hostStreaming = false;
		const harness = makeTransactionalGuestContext({});
		const emitHostEvent = hostEventListener;
		if (!emitHostEvent) throw new Error("collab host event bridge is not installed");
		let dispositionAtForward: "current" | "future" | undefined;
		let forwardedStarts = 0;
		let observeEvent: ((event: AgentSessionEvent) => void) | undefined;
		await joinRpcCollabSession(harness.ctx.session, host.link, undefined, event => {
			dispositionAtForward = getRpcCollabGuestLifecycleDisposition(harness.ctx.session);
			if (event.type === "agent_start") forwardedStarts++;
			observeEvent?.(event);
		});
		try {
			expect(getRpcCollabGuestLifecycleDisposition(harness.ctx.session)).toBe("future");

			const startObserved = Promise.withResolvers<AgentSessionEvent>();
			observeEvent = startObserved.resolve;
			hostStreaming = true;
			emitHostEvent({ type: "agent_start" } as AgentSessionEvent);
			await startObserved.promise;
			expect(getRpcCollabGuestLifecycleDisposition(harness.ctx.session)).toBe("current");
			expect(dispositionAtForward).toBe("current");

			const promptObserved = Promise.withResolvers<void>();
			hostPromptObserver = promptObserved.resolve;
			sendRpcCollabGuestPrompt(harness.ctx.session, "guest follow-up");
			await promptObserved.promise;
			expect(getRpcCollabGuestLifecycleDisposition(harness.ctx.session)).toBe("current");

			const terminalEndObserved = Promise.withResolvers<AgentSessionEvent>();
			observeEvent = terminalEndObserved.resolve;
			hostStreaming = false;
			emitHostEvent({ type: "agent_end", messages: [], isTerminal: true } as AgentSessionEvent);
			await terminalEndObserved.promise;
			expect(getRpcCollabGuestLifecycleDisposition(harness.ctx.session)).toBe("future");
			expect(dispositionAtForward).toBe("future");
			expect(forwardedStarts).toBe(1);

			const continuationStartObserved = Promise.withResolvers<AgentSessionEvent>();
			observeEvent = continuationStartObserved.resolve;
			hostStreaming = true;
			emitHostEvent({ type: "agent_start" } as AgentSessionEvent);
			await continuationStartObserved.promise;

			const intermediateEndObserved = Promise.withResolvers<AgentSessionEvent>();
			observeEvent = intermediateEndObserved.resolve;
			hostStreaming = false;
			emitHostEvent({ type: "agent_end", messages: [], isTerminal: false } as AgentSessionEvent);
			await intermediateEndObserved.promise;
			expect(getRpcCollabGuestLifecycleDisposition(harness.ctx.session)).toBe("current");
			expect(dispositionAtForward).toBe("current");
			expect(forwardedStarts).toBe(2);
		} finally {
			hostPromptObserver = undefined;
			hostStreaming = false;
			await leaveRpcCollabSession(harness.ctx.session);
		}

		expect(getRpcCollabGuestLifecycleDisposition(harness.ctx.session)).toBeUndefined();
	});

	it("retains failed join ownership and its transition lease until leave can restore", async () => {
		const replicaFailure = new Error("replica postcommit apply failed");
		const restoreFailure = { remaining: 1, error: new Error("local storage unavailable") };
		const harness = makeTransactionalGuestContext({ replicaPostCommitFailure: replicaFailure, restoreFailure });

		try {
			await expect(joinRpcCollabSession(harness.ctx.session, host.link)).rejects.toThrow(
				"original local session could not be restored",
			);
			expect(harness.activeSession()).not.toBe(LOCAL_SESSION_FILE);
			expect((await getRpcCollabStatus(harness.ctx.session)).role).toBe("guest");
			expect(harness.leaseReleases()).toBe(0);

			await leaveRpcCollabSession(harness.ctx.session);

			expect(harness.activeSession()).toBe(LOCAL_SESSION_FILE);
			expect((await getRpcCollabStatus(harness.ctx.session)).role).toBe("none");
			expect(harness.leaseReleases()).toBe(1);
		} finally {
			await leaveRpcCollabSession(harness.ctx.session).catch(() => {});
		}
	});

	it("routes replica and return switches through the injected transition runner", async () => {
		const transitionOptions: (SessionTransitionRunOptions | undefined)[] = [];
		const switchedPaths: string[] = [];
		const runSessionTransition: SessionTransitionRunner = async (transition, options) => {
			transitionOptions.push(options);
			return (await transition({})).result;
		};
		const ctx = {
			settings: { get: () => "" },
			sessionManager: {
				getSessionFile: () => "/tmp/local-session.jsonl",
				getSessionName: () => "local",
				getCwd: () => "/tmp",
			},
			session: {
				switchSession: async (sessionPath: string) => {
					switchedPaths.push(sessionPath);
					return true;
				},
				newSession: async () => true,
				messages: [],
				agent: {
					state: { model: undefined },
					setModel: () => {},
					setThinkingLevel: () => {},
					setDisableReasoning: () => {},
				},
			},
			runSessionTransition,
			collabGuest: undefined,
		} as unknown as InteractiveModeContext;
		const guest = new CollabGuestLink(ctx);
		guestCleanups.push(() => void guest.leave("test cleanup"));

		await guest.join(host.link);
		expect(transitionOptions).toEqual([{ preserveCollabAttachmentOnCommit: true }]);
		expect(switchedPaths).toHaveLength(1);

		await guest.leave("done");
		expect(transitionOptions).toEqual([
			{ preserveCollabAttachmentOnCommit: true },
			{ preserveCollabAttachmentOnCommit: true },
		]);
		expect(switchedPaths.at(-1)).toBe("/tmp/local-session.jsonl");
	});
});
