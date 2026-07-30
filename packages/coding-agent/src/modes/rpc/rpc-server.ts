import { once } from "node:events";
import { isRecord, readLines } from "@oh-my-pi/pi-utils";
import type { ExtensionUIContext } from "../../extensibility/extensions";
import type { MCPManager } from "../../mcp/manager";
import type { AgentSession } from "../../session/agent-session";
import type { EventBus } from "../../utils/event-bus";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, RpcFrameEncoder } from "./rpc-frame";
import { buildRpcSessionState, type RpcModeTransport, runRpcMode } from "./rpc-mode";
import type { RpcRuntimeDescriptor, RpcRuntimeHostCommand, RpcRuntimeHostResponse } from "./rpc-types";

export interface RpcServerSession {
	session: AgentSession;
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
	eventBus: EventBus;
	mcpManager?: MCPManager;
}

export interface RpcServerSessionRequest {
	runtimeId: string;
	cwd: string;
	kind: "create" | "resume" | "fork";
	sessionPath?: string;
	sourceSessionPath?: string;
}

export type RpcServerSessionFactory = (request: RpcServerSessionRequest) => Promise<RpcServerSession>;

export type RpcRuntimeRunner = (
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
	input?: ReadableStream<Uint8Array>,
	mcpManager?: MCPManager,
	transport?: RpcModeTransport,
) => Promise<void>;

export interface RpcServerOptions {
	createSession: RpcServerSessionFactory;
	input?: ReadableStream<Uint8Array>;
	disposeHost?: () => Promise<void>;
	/** Test/embedding writer; production defaults to the lossless stdout queue. */
	writeFrames?: (frames: Iterable<string>) => void;
	/** Test seam for exercising host routing without a live AgentSession. */
	runRuntime?: RpcRuntimeRunner;
}

type LiveRuntime = {
	runtimeId: string;
	session: AgentSession;
	writer: WritableStreamDefaultWriter<Uint8Array>;
	finished: Promise<void>;
	closed: boolean;
};

function hostError(
	id: string | undefined,
	command: string,
	error: string,
	code: string,
	runtimeId?: string,
): RpcRuntimeHostResponse {
	return { id, type: "response", command, success: false, error, code, ...(runtimeId ? { runtimeId } : {}) };
}

function isRuntimeHostCommand(frame: Record<string, unknown>): frame is RpcRuntimeHostCommand {
	return (
		frame.type === "runtime_create" ||
		frame.type === "runtime_resume" ||
		frame.type === "runtime_fork" ||
		frame.type === "runtime_close" ||
		frame.type === "runtime_list"
	);
}

function isRuntimeCreationCommand(
	frame: RpcRuntimeHostCommand,
): frame is Extract<RpcRuntimeHostCommand, { type: "runtime_create" | "runtime_resume" | "runtime_fork" }> {
	return frame.type === "runtime_create" || frame.type === "runtime_resume" || frame.type === "runtime_fork";
}

/**
 * One-process v3 RPC host. It owns the JSONL codec and stdout writer while
 * every live runtime receives a private stream into the existing RPC command
 * dispatcher. This preserves FIFO/cancellation semantics per runtime without
 * serializing independent AgentSessions.
 */
export async function runRpcServer(options: RpcServerOptions): Promise<void> {
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	const frameDecoder = new RpcFrameDecoder();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	const runtimes = new Map<string, LiveRuntime>();
	let stdoutQueue: Promise<void> = Promise.resolve();
	let nextRuntime = 0;

	const writeFrame = (frame: object): void => {
		const frames = frameEncoder.encodeFrames(frame);
		if (options.writeFrames) {
			try {
				options.writeFrames(frames);
			} catch {
				// A disconnected embedding host cannot receive more frames.
			}
			return;
		}
		stdoutQueue = stdoutQueue
			.then(async () => {
				for (const line of frames) {
					if (!process.stdout.write(line)) await once(process.stdout, "drain");
				}
			})
			.catch(() => {});
	};
	const writeRuntimeFrame = (runtimeId: string, frame: object): void => {
		writeFrame({ ...frame, runtimeId });
	};
	const runtimeDescriptor = (runtimeId: string, session: AgentSession): RpcRuntimeDescriptor => ({
		runtimeId,
		state: buildRpcSessionState(session),
	});
	const closeRuntime = async (runtime: LiveRuntime): Promise<void> => {
		if (runtime.closed) return runtime.finished;
		runtime.closed = true;
		try {
			await runtime.writer.close();
		} catch {
			// A runtime which already stopped owns its own stream cleanup.
		}
		await runtime.finished;
	};
	const createRuntime = async (
		command: Extract<RpcRuntimeHostCommand, { type: "runtime_create" | "runtime_resume" | "runtime_fork" }>,
	): Promise<RpcRuntimeDescriptor> => {
		if (typeof command.cwd !== "string" || command.cwd.trim().length === 0) {
			throw new Error("cwd must be a non-empty string");
		}
		if (command.type === "runtime_resume" && !command.sessionPath?.trim()) {
			throw new Error("sessionPath must be a non-empty string");
		}
		if (command.type === "runtime_fork" && !command.sourceSessionPath?.trim()) {
			throw new Error("sourceSessionPath must be a non-empty string");
		}
		const runtimeId = `runtime_${++nextRuntime}_${crypto.randomUUID()}`;
		const created = await options.createSession({
			runtimeId,
			cwd: command.cwd,
			kind: command.type === "runtime_create" ? "create" : command.type === "runtime_resume" ? "resume" : "fork",
			...(command.type === "runtime_resume" ? { sessionPath: command.sessionPath } : {}),
			...(command.type === "runtime_fork" ? { sourceSessionPath: command.sourceSessionPath } : {}),
		});
		const stream = new TransformStream<Uint8Array, Uint8Array>();
		const writer = stream.writable.getWriter();
		const runtime: LiveRuntime = {
			runtimeId,
			session: created.session,
			writer,
			closed: false,
			finished: Promise.resolve(),
		};
		runtime.finished = (options.runRuntime ?? runRpcMode)(
			created.session,
			created.setToolUIContext,
			created.eventBus,
			stream.readable,
			created.mcpManager,
			{
				writeFrame: frame => writeRuntimeFrame(runtimeId, frame),
				emitReady: false,
				exitOnEof: false,
				onStopped: () => {
					if (runtimes.get(runtimeId) === runtime) runtimes.delete(runtimeId);
					if (!runtime.closed) {
						runtime.closed = true;
						void writer.close().catch(() => {});
					}
				},
			},
		).finally(() => {
			if (runtimes.get(runtimeId) === runtime) runtimes.delete(runtimeId);
			frameEncoder.clearRuntime(runtimeId);
			writer.releaseLock();
		});
		runtimes.set(runtimeId, runtime);
		return runtimeDescriptor(runtimeId, created.session);
	};

	writeFrame({
		type: "ready",
		protocolVersion: 1,
		supportedProtocolVersions: [1, 2, 3],
		capabilities: { multiSession: true },
		maxFrameBytes: MAX_RPC_FRAME_BYTES,
		maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
	});

	const dispatch = async (frame: unknown): Promise<void> => {
		if (!isRecord(frame)) {
			writeFrame(hostError(undefined, "parse", "RPC frame must be an object with a string type", "invalid_request"));
			return;
		}
		const id = typeof frame.id === "string" ? frame.id : undefined;
		const command = typeof frame.type === "string" ? frame.type : undefined;
		if (command === undefined) {
			writeFrame(hostError(id, "parse", "RPC frame must be an object with a string type", "invalid_request"));
			return;
		}
		if (frame.type === "negotiate_protocol") {
			const protocolVersion = frame.protocolVersion;
			if (protocolVersion !== 1 && protocolVersion !== 2 && protocolVersion !== 3) {
				writeFrame(
					hostError(
						id,
						"negotiate_protocol",
						`Unsupported RPC protocol version: ${String(protocolVersion)}`,
						"unsupported_protocol",
					),
				);
				return;
			}
			frameEncoder.setProtocolVersion(protocolVersion);
			writeFrame({ id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion } });
			return;
		}
		if (isRuntimeHostCommand(frame)) {
			if (frame.type === "runtime_list") {
				const listed = Array.from(runtimes.values()).map(runtime =>
					runtimeDescriptor(runtime.runtimeId, runtime.session),
				);
				writeFrame({ id, type: "response", command: "runtime_list", success: true, data: { runtimes: listed } });
				return;
			}
			if (frame.type === "runtime_close") {
				if (typeof frame.runtimeId !== "string" || frame.runtimeId.length === 0) {
					writeFrame(hostError(id, "runtime_close", "runtimeId is required", "runtime_required"));
					return;
				}
				const runtime = runtimes.get(frame.runtimeId);
				if (!runtime) {
					writeFrame(
						hostError(id, "runtime_close", `Unknown runtime: ${frame.runtimeId}`, "unknown_runtime", frame.runtimeId),
					);
					return;
				}
				await closeRuntime(runtime);
				writeFrame({
					id,
					type: "response",
					command: "runtime_close",
					success: true,
					runtimeId: frame.runtimeId,
					data: { closed: true },
				});
				return;
			}
			if (isRuntimeCreationCommand(frame)) {
				try {
					const descriptor = await createRuntime(frame);
					writeFrame({ id, type: "response", command: frame.type, success: true, data: descriptor });
				} catch (error) {
					writeFrame(
						hostError(
							id,
							frame.type,
							error instanceof Error ? error.message : String(error),
							"runtime_create_failed",
						),
					);
				}
			}
			return;
		}
		const runtimeId = typeof frame.runtimeId === "string" ? frame.runtimeId : undefined;
		if (!runtimeId) {
			writeFrame(hostError(id, command, "runtimeId is required for runtime commands", "runtime_required"));
			return;
		}
		const runtime = runtimes.get(runtimeId);
		if (!runtime || runtime.closed) {
			writeFrame(hostError(id, command, `Unknown runtime: ${runtimeId}`, "unknown_runtime", runtimeId));
			return;
		}
		const { runtimeId: _runtimeId, ...runtimeCommand } = frame;
		void runtime.writer.write(encoder.encode(`${JSON.stringify(runtimeCommand)}\n`)).catch(error => {
			writeRuntimeFrame(
				runtimeId,
				hostError(id, command, error instanceof Error ? error.message : String(error), "runtime_closed"),
			);
		});
	};

	try {
		for await (const line of readLines(options.input ?? Bun.stdin.stream())) {
			const text = decoder.decode(line).trim();
			if (!text) continue;
			try {
				const decoded = frameDecoder.push(JSON.parse(text));
				if (decoded) await dispatch(decoded);
			} catch (error) {
				writeFrame(
					hostError(
						undefined,
						"parse",
						`Failed to parse command: ${error instanceof Error ? error.message : String(error)}`,
						"invalid_request",
					),
				);
			}
		}
	} finally {
		await Promise.allSettled(Array.from(runtimes.values(), closeRuntime));
		await options.disposeHost?.();
		await stdoutQueue;
	}
}
