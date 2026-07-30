import { expect, test } from "bun:test";
import { isRecord, readLines } from "@oh-my-pi/pi-utils";
import { type RpcRuntimeRunner, type RpcServerSessionFactory, runRpcServer } from "../src/modes/rpc/rpc-server";
import type { AgentSession } from "../src/session/agent-session";

const encoder = new TextEncoder();

type Frame = Record<string, unknown>;

function isFrame(value: unknown): value is Frame {
	return isRecord(value);
}


function requireFrame(value: unknown, message: string): Frame {
	if (!isFrame(value)) throw new Error(message);
	return value;
}
function frameData(frame: Frame): Frame {
	if (!isFrame(frame.data)) throw new Error("Expected a response data object");
	return frame.data;
}

function frameString(frame: Frame, field: string): string {
	const value = frame[field];
	if (typeof value !== "string") throw new Error(`Expected ${field} to be a string`);
	return value;
}

function createSession(runtimeId: string, cwd: string): AgentSession {
	return {
		model: undefined,
		thinkingLevel: undefined,
		isStreaming: false,
		isCompacting: false,
		isRetrying: false,
		isBashRunning: false,
		isAborting: false,
		isGeneratingHandoff: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		sessionFile: `${cwd}/${runtimeId}.jsonl`,
		sessionId: runtimeId,
		sessionName: runtimeId,
		autoCompactionEnabled: false,
		messages: [],
		queuedMessageCount: 0,
		getTodoPhases: () => [],
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		settings: {
			get: (path: string) => {
				if (path === "snapcompact.systemPrompt") return "none";
				if (path === "snapcompact.toolResults") return false;
				return undefined;
			},
		},
		getContextBreakdown: () => ({
			contextWindow: 0,
			anchored: false,
			usedTokens: 0,
			systemPromptTokens: 0,
			systemToolsTokens: 0,
			systemContextTokens: 0,
			skillsTokens: 0,
			messagesTokens: 0,
		}),
		getAsyncJobSnapshot: () => null,
		getContextUsage: () => undefined,
		configWarnings: [],
		skillWarnings: [],
	} as unknown as AgentSession;
}

function createHostHarness() {
	const stream = new TransformStream<Uint8Array, Uint8Array>();
	const writer = stream.writable.getWriter();
	const frames: Frame[] = [];
	const promptCompletion = Promise.withResolvers<void>();
	const seenPrompts = new Set<string>();
	const factoryRequests: Array<{ runtimeId: string; cwd: string; kind: string }> = [];
	const factory: RpcServerSessionFactory = async request => {
		factoryRequests.push({ runtimeId: request.runtimeId, cwd: request.cwd, kind: request.kind });
		return {
			session: createSession(request.runtimeId, request.cwd),
			eventBus: {} as never,
		};
	};
	const runner: RpcRuntimeRunner = async (session, _setUi, _eventBus, input, _mcpManager, transport) => {
		for await (const line of readLines(input!)) {
			const decoded: unknown = JSON.parse(new TextDecoder().decode(line));
			if (!isFrame(decoded)) throw new Error("Expected an RPC command frame");
			if (decoded.type === "prompt") {
				seenPrompts.add(session.sessionId);
				transport?.writeFrame?.({ type: "agent_start", sessionId: session.sessionId });
				transport?.writeFrame?.({ type: "response", command: "prompt", success: true, id: decoded.id });
				void promptCompletion.promise.then(() => {
					transport?.writeFrame?.({ type: "message_end", sessionId: session.sessionId });
				});
				continue;
			}
			if (decoded.type === "abort") {
				transport?.writeFrame?.({ type: "abort_observed", sessionId: session.sessionId });
				transport?.writeFrame?.({ type: "response", command: "abort", success: true, id: decoded.id });
				continue;
			}
			if (decoded.type === "extension_ui_response") {
				transport?.writeFrame?.({ type: "callback_observed", sessionId: session.sessionId, id: decoded.id });
				continue;
			}
			if (decoded.type === "get_state") {
				transport?.writeFrame?.({ type: "response", command: "get_state", success: true, id: decoded.id });
			}
		}
	};
	const server = runRpcServer({
		createSession: factory,
		input: stream.readable,
		runRuntime: runner,
		writeFrames: encodedFrames => {
			for (const line of encodedFrames) {
				const decoded: unknown = JSON.parse(line);
				if (!isFrame(decoded)) throw new Error("Expected a response frame");
				frames.push(decoded);
			}
		},
	});
	const send = async (frame: Frame) => {
		await writer.write(encoder.encode(`${JSON.stringify(frame)}\n`));
	};
	const close = async () => {
		await writer.close();
	};
	const waitFor = async (predicate: () => boolean): Promise<void> => {
		for (let attempt = 0; attempt < 100; attempt++) {
			if (predicate()) return;
			await Bun.sleep(1);
		}
		throw new Error("Timed out waiting for RPC host frame");
	};
	return { close, factoryRequests, frames, promptCompletion, seenPrompts, send, server, waitFor };
}

function createdRuntimeIds(frames: Frame[]): string[] {
	return frames
		.filter(frame => frame.command === "runtime_create" && frame.success === true)
		.map(frame => frameString(frameData(frame), "runtimeId"));
}

test("rpc-server runs distinct cwd runtimes concurrently and correlates every event", async () => {
	const host = createHostHarness();
	await host.send({ id: "create-a", type: "runtime_create", cwd: "/worktree/a" });
	await host.send({ id: "create-b", type: "runtime_create", cwd: "/worktree/b" });
	await host.waitFor(() => createdRuntimeIds(host.frames).length === 2);
	const [runtimeA, runtimeB] = createdRuntimeIds(host.frames);

	expect(runtimeA).not.toBe(runtimeB);
	expect(host.factoryRequests).toEqual([
		{ runtimeId: runtimeA, cwd: "/worktree/a", kind: "create" },
		{ runtimeId: runtimeB, cwd: "/worktree/b", kind: "create" },
	]);

	await host.send({ id: "prompt-a", type: "prompt", runtimeId: runtimeA, message: "a" });
	await host.send({ id: "prompt-b", type: "prompt", runtimeId: runtimeB, message: "b" });
	await host.waitFor(() => host.seenPrompts.size === 2);
	expect(host.frames.filter(frame => frame.type === "agent_start").map(frame => frame.runtimeId)).toEqual(
		expect.arrayContaining([runtimeA, runtimeB]),
	);

	host.promptCompletion.resolve();
	await host.waitFor(() => host.frames.filter(frame => frame.type === "message_end").length === 2);
	expect(host.frames.filter(frame => frame.type === "message_end").map(frame => frame.runtimeId)).toEqual(
		expect.arrayContaining([runtimeA, runtimeB]),
	);

	await host.close();
	await host.server;
});

test("rpc-server creates, resumes, forks, and lists independent live runtimes", async () => {
	const host = createHostHarness();
	expect(host.frames[0]).toEqual(
		expect.objectContaining({
			type: "ready",
			supportedProtocolVersions: [1, 2, 3],
			capabilities: { multiSession: true },
		}),
	);
	await host.send({ id: "create", type: "runtime_create", cwd: "/worktree/create" });
	await host.send({ id: "resume", type: "runtime_resume", cwd: "/worktree/resume", sessionPath: "/sessions/resume.jsonl" });
	await host.send({
		id: "fork",
		type: "runtime_fork",
		cwd: "/worktree/fork",
		sourceSessionPath: "/sessions/source.jsonl",
	});
	await host.waitFor(
		() =>
			host.frames.filter(
				frame =>
					frame.success === true &&
					typeof frame.command === "string" &&
					["runtime_create", "runtime_resume", "runtime_fork"].includes(frame.command),
			).length === 3,
	);
	await host.send({ id: "list", type: "runtime_list" });
	await host.waitFor(() => host.frames.some(frame => frame.id === "list"));

	expect(host.factoryRequests.map(request => request.kind)).toEqual(["create", "resume", "fork"]);
	const listed = host.frames.find(frame => frame.id === "list");
	if (!listed) throw new Error("Expected a runtime list response");
	const runtimes = frameData(listed).runtimes;
	if (!Array.isArray(runtimes)) throw new Error("Expected runtime list data");
	expect(runtimes.map(runtime => frameString(requireFrame(runtime, "Expected a runtime descriptor"), "runtimeId"))).toEqual(
		host.factoryRequests.map(request => request.runtimeId),
	);

	await host.close();
	await host.server;
});

test("rpc-server rejects absent and unknown runtime handles with correlated errors", async () => {
	const host = createHostHarness();
	await host.send({ id: "absent", type: "get_state" });
	await host.send({ id: "unknown", type: "get_state", runtimeId: "not-a-runtime" });
	await host.waitFor(() => host.frames.some(frame => frame.id === "unknown"));

	expect(host.frames.filter(frame => frame.type === "response" && frame.success === false)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: "absent", command: "get_state", code: "runtime_required" }),
			expect.objectContaining({
				id: "unknown",
				command: "get_state",
				code: "unknown_runtime",
				runtimeId: "not-a-runtime",
			}),
		]),
	);

	await host.close();
	await host.server;
});

test("rpc-server isolates abort, close, and callback responses by runtimeId", async () => {
	const host = createHostHarness();
	await host.send({ id: "create-a", type: "runtime_create", cwd: "/worktree/a" });
	await host.send({ id: "create-b", type: "runtime_create", cwd: "/worktree/b" });
	await host.waitFor(() => createdRuntimeIds(host.frames).length === 2);
	const [runtimeA, runtimeB] = createdRuntimeIds(host.frames);

	await host.send({ id: "abort-a", type: "abort", runtimeId: runtimeA });
	await host.send({ type: "extension_ui_response", runtimeId: runtimeB, id: "shared-callback", value: "continue" });
	await host.waitFor(
		() =>
			host.frames.some(frame => frame.type === "abort_observed") &&
			host.frames.some(frame => frame.type === "callback_observed"),
	);
	expect(host.frames.find(frame => frame.type === "abort_observed")?.runtimeId).toBe(runtimeA);
	expect(host.frames.filter(frame => frame.type === "callback_observed")).toEqual([
		expect.objectContaining({ runtimeId: runtimeB, sessionId: runtimeB, id: "shared-callback" }),
	]);

	await host.send({ id: "close-a", type: "runtime_close", runtimeId: runtimeA });
	await host.waitFor(() => host.frames.some(frame => frame.command === "runtime_close" && frame.success === true));
	await host.send({ id: "state-b", type: "get_state", runtimeId: runtimeB });
	await host.waitFor(() => host.frames.some(frame => frame.id === "state-b" && frame.runtimeId === runtimeB));

	await host.close();
	await host.server;
});
