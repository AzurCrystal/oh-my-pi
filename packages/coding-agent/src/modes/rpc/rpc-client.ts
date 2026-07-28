/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { isPromise } from "node:util/types";
import type { AgentEvent, AgentMessage, AgentToolResult, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Model } from "@oh-my-pi/pi-ai";
import { isRecord, ptree, readJsonl } from "@oh-my-pi/pi-utils";
import type { FileSink } from "bun";
import type { PythonResult } from "../../eval/py/executor";
import type { BashResult } from "../../exec/bash-executor";
import type { AgentSessionEvent, RoleModelCycleResult, SessionStats } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { TodoPhase } from "../../tools/todo";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameDecoder, type RpcProtocolVersion } from "./rpc-frame";
import {
	RPC_MESSAGES_PAGE_BUSY_ERROR,
	RPC_MESSAGES_PAGE_STALE_ERROR,
	type RpcMessagesPage,
	type RpcMessagesPageOptions,
} from "./rpc-messages";
import type {
	MCPAddScope,
	MCPServerConfig,
	MentalModelDetail,
	MentalModelMode,
	RpcAdvisorConfig,
	RpcAdvisorConfigSnapshot,
	RpcAgentControlResult,
	RpcAgentDefinition,
	RpcAgentDefinitionDeleteResult,
	RpcAgentDefinitionDocument,
	RpcAuthoringScope,
	RpcAvailableCommandsUpdateFrame,
	RpcAvailableSlashCommand,
	RpcBackgroundAgent,
	RpcBtwAnswer,
	RpcBtwAskResult,
	RpcBtwBranchResult,
	RpcBtwOutputFrame,
	RpcCollabLinks,
	RpcCollabStatus,
	RpcCommand,
	RpcCompletionApplied,
	RpcCompletionItem,
	RpcCompletionResult,
	RpcControllableAgent,
	RpcDiagnosticArtifact,
	RpcExecOutputFrame,
	RpcExtension,
	RpcExtensionUICancelFrame,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcGenerateTitleResult,
	RpcGoalModeSnapshot,
	RpcGuidedGoalKickoffResult,
	RpcHandoffResult,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcHostUriSchemeDefinition,
	RpcIdleRecapFrame,
	RpcInspectorEndpoint,
	RpcKeybinding,
	RpcLiveStatus,
	RpcLoginProvider,
	RpcLoopAction,
	RpcLoopState,
	RpcMCPOAuthBegin,
	RpcMCPOAuthResult,
	RpcMCPRegistrySearchResult,
	RpcMCPReloadResult,
	RpcMCPServerResult,
	RpcMCPSmitheryLoginBegin,
	RpcMCPSmitheryLoginResult,
	RpcMcpAuthChallenge,
	RpcMcpAuthChallengeFrame,
	RpcMentalModel,
	RpcMentalModelBulkRefresh,
	RpcMentalModelDeleteResult,
	RpcMentalModelHistory,
	RpcMentalModelList,
	RpcMentalModelOperation,
	RpcMentalModelRefreshOperation,
	RpcMentalModelReloadResult,
	RpcMentalModelSeedResult,
	RpcModelRoleScope,
	RpcModelRolesSnapshot,
	RpcNavigateTreeOptions,
	RpcNavigateTreeResult,
	RpcPauseResult,
	RpcPauseState,
	RpcPlanDecisionResult,
	RpcPlanFinalizationStrategy,
	RpcPlanModeSnapshot,
	RpcPlanProposalSnapshot,
	RpcPromptHistoryEntry,
	RpcPromptResultFrame,
	RpcPromptSubmissionResult,
	RpcProviderRequestObservationFrame,
	RpcQueuedMessages,
	RpcRawSseSnapshot,
	RpcRawSseUpdateFrame,
	RpcRecentLogs,
	RpcRepoStatus,
	RpcResponse,
	RpcSessionListEntry,
	RpcSessionState,
	RpcSessionTreeSnapshot,
	RpcSessionView,
	RpcSettingsSnapshot,
	RpcSettingsUpdateFrame,
	RpcSpeechSettings,
	RpcSpeechStatus,
	RpcStartupWarnings,
	RpcSttStatus,
	RpcSubagentEventFrame,
	RpcSubagentLifecycleFrame,
	RpcSubagentMessagesResult,
	RpcSubagentProgressFrame,
	RpcSubagentSnapshot,
	RpcSubagentSubscriptionLevel,
	RpcSystemInfo,
	RpcThemeSnapshot,
	RpcTtsrGeneratedCandidate,
	RpcTtsrGenerationEventFrame,
	RpcTtsrRegistration,
	RpcTtsrRemoval,
	RpcTtsrRule,
	RpcTtsrRuleDraft,
	RpcVibeModeSnapshot,
	RpcVoiceEventFrame,
	RpcWorkModeSnapshot,
	SmitherySearchResult,
	UsageReport,
} from "./rpc-types";

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Session directory for the agent */
	sessionDir?: string;
	/** Additional CLI arguments */
	args?: string[];
	/** Custom tools owned by the embedding host and exposed over the RPC transport */
	customTools?: RpcClientCustomTool[];
}

export type ModelInfo = Pick<Model, "provider" | "id" | "contextWindow" | "reasoning" | "thinking">;

export type RpcEventListener = (event: AgentEvent) => void;
export type RpcSessionEventListener = (event: AgentSessionEvent) => void;
export type RpcSubagentLifecycleListener = (payload: RpcSubagentLifecycleFrame["payload"]) => void;
export type RpcSubagentProgressListener = (payload: RpcSubagentProgressFrame["payload"]) => void;
export type RpcSubagentEventListener = (payload: RpcSubagentEventFrame["payload"]) => void;
export type RpcAvailableCommandsUpdateListener = (commands: RpcAvailableSlashCommand[]) => void;
export type RpcExecOutputListener = (frame: RpcExecOutputFrame) => void;
export type RpcBtwOutputListener = (frame: RpcBtwOutputFrame) => void;
export type RpcIdleRecapListener = (frame: RpcIdleRecapFrame) => void;
export type RpcSettingsUpdateListener = (frame: RpcSettingsUpdateFrame) => void;
export type RpcPromptResultListener = (frame: RpcPromptResultFrame) => void;
export type RpcRawSseUpdateListener = (frame: RpcRawSseUpdateFrame) => void;
export type RpcMcpAuthChallengeListener = (frame: RpcMcpAuthChallengeFrame) => void;
export type RpcTtsrGenerationEventListener = (frame: RpcTtsrGenerationEventFrame) => void;
export type RpcVoiceEventListener = (frame: RpcVoiceEventFrame) => void;
export type RpcExtensionUIRequestListener = (request: RpcExtensionUIRequest) => void;
export type RpcExtensionUICancelListener = (frame: RpcExtensionUICancelFrame) => void;
export type RpcProviderRequestObservationListener = (frame: RpcProviderRequestObservationFrame) => void;

export interface RpcClientHostUriContext {
	signal: AbortSignal;
}

export interface RpcClientHostUriReadResult {
	content: string;
	contentType?: "text/markdown" | "application/json" | "text/plain";
	notes?: string[];
	immutable?: boolean;
}

export type RpcClientHostUriHandler = (
	request: RpcHostUriRequest,
	context: RpcClientHostUriContext,
) => string | RpcClientHostUriReadResult | void | Promise<string | RpcClientHostUriReadResult | void>;

export interface RpcClientToolContext<TDetails = unknown> {
	toolCallId: string;
	signal: AbortSignal;
	sendUpdate(partialResult: RpcClientToolResult<TDetails>): void;
}

export type RpcClientToolResult<TDetails = unknown> = AgentToolResult<TDetails> | string;

export interface RpcClientCustomTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
> extends Omit<RpcHostToolDefinition, "parameters"> {
	parameters: Record<string, unknown>;
	execute(
		params: TParams,
		context: RpcClientToolContext<TDetails>,
	): Promise<RpcClientToolResult<TDetails>> | RpcClientToolResult<TDetails>;
}

export function defineRpcClientTool<
	TParams extends Record<string, unknown> = Record<string, unknown>,
	TDetails = unknown,
>(tool: RpcClientCustomTool<TParams, TDetails>): RpcClientCustomTool<TParams, TDetails> {
	return tool;
}

const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

const sessionEventTypes = new Set<AgentSessionEvent["type"]>([
	...agentEventTypes,
	"auto_compaction_start",
	"auto_compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"retry_fallback_applied",
	"retry_fallback_succeeded",
	"ttsr_triggered",
	"todo_reminder",
	"todo_auto_clear",
	"irc_message",
	"notice",
	"thinking_level_changed",
	"goal_updated",
	"context_message_added",
]);

function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value)) return false;
	if (value.type !== "response") return false;
	if (typeof value.command !== "string") return false;
	if (typeof value.success !== "boolean") return false;
	if (value.id !== undefined && typeof value.id !== "string") return false;
	if (value.success === false) {
		return typeof value.error === "string";
	}
	return true;
}

function supportsRpcProtocolV2(value: Record<string, unknown>): boolean {
	return (
		value.type === "ready" &&
		Array.isArray(value.supportedProtocolVersions) &&
		value.supportedProtocolVersions.includes(2) &&
		value.maxFrameBytes === MAX_RPC_FRAME_BYTES &&
		value.maxReassembledFrameBytes === MAX_RPC_REASSEMBLED_BYTES
	);
}

function isAgentEvent(value: unknown): value is AgentEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return agentEventTypes.has(type as AgentEvent["type"]);
}

function isAgentSessionEvent(value: unknown): value is AgentSessionEvent {
	if (!isRecord(value)) return false;
	const type = value.type;
	if (typeof type !== "string") return false;
	return sessionEventTypes.has(type as AgentSessionEvent["type"]);
}

function isRpcSubagentLifecycleFrame(value: unknown): value is RpcSubagentLifecycleFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_lifecycle" && isRecord(value.payload);
}

function isRpcSubagentProgressFrame(value: unknown): value is RpcSubagentProgressFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_progress" && isRecord(value.payload);
}

function isRpcSubagentEventFrame(value: unknown): value is RpcSubagentEventFrame {
	if (!isRecord(value)) return false;
	return value.type === "subagent_event" && isRecord(value.payload);
}

function isRpcAvailableCommandsUpdateFrame(value: unknown): value is RpcAvailableCommandsUpdateFrame {
	if (!isRecord(value)) return false;
	return value.type === "available_commands_update" && Array.isArray(value.commands);
}

function isRpcExecOutputFrame(value: unknown): value is RpcExecOutputFrame {
	return isRecord(value) && value.type === "exec_output" && typeof value.chunk === "string";
}

function isRpcBtwOutputFrame(value: unknown): value is RpcBtwOutputFrame {
	return isRecord(value) && value.type === "btw_output" && typeof value.chunk === "string";
}

function isRpcIdleRecapFrame(value: unknown): value is RpcIdleRecapFrame {
	return isRecord(value) && value.type === "idle_recap" && typeof value.recap === "string";
}

function isRpcPromptResultFrame(value: unknown): value is RpcPromptResultFrame {
	return (
		isRecord(value) &&
		value.type === "prompt_result" &&
		(value.id === undefined || typeof value.id === "string") &&
		typeof value.agentInvoked === "boolean"
	);
}

function isRpcSettingsUpdateFrame(value: unknown): value is RpcSettingsUpdateFrame {
	return isRecord(value) && value.type === "settings_update" && typeof value.path === "string";
}

function isRpcRawSseUpdateFrame(value: unknown): value is RpcRawSseUpdateFrame {
	return isRecord(value) && value.type === "raw_sse_update" && isRecord(value.snapshot);
}

function isRpcMcpAuthChallengeFrame(value: unknown): value is RpcMcpAuthChallengeFrame {
	return isRecord(value) && value.type === "mcp_auth_challenge" && isRecord(value.challenge);
}

function isRpcVoiceEventFrame(value: unknown): value is RpcVoiceEventFrame {
	return isRecord(value) && value.type === "voice_event" && isRecord(value.event);
}

function isRpcTtsrGenerationEventFrame(value: unknown): value is RpcTtsrGenerationEventFrame {
	return isRecord(value) && value.type === "ttsr_generation_event" && isRecord(value.event);
}

function isRpcHostToolCallRequest(value: unknown): value is RpcHostToolCallRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_tool_call" &&
		typeof value.id === "string" &&
		typeof value.toolCallId === "string" &&
		typeof value.toolName === "string" &&
		isRecord(value.arguments)
	);
}

function isRpcHostToolCancelRequest(value: unknown): value is RpcHostToolCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_tool_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

function isRpcHostUriRequest(value: unknown): value is RpcHostUriRequest {
	if (!isRecord(value)) return false;
	return (
		value.type === "host_uri_request" &&
		typeof value.id === "string" &&
		(value.operation === "read" || value.operation === "write") &&
		typeof value.url === "string" &&
		(value.content === undefined || typeof value.content === "string")
	);
}

function isRpcHostUriCancelRequest(value: unknown): value is RpcHostUriCancelRequest {
	if (!isRecord(value)) return false;
	return value.type === "host_uri_cancel" && typeof value.id === "string" && typeof value.targetId === "string";
}

function isRpcExtensionUiCancelFrame(value: unknown): value is RpcExtensionUICancelFrame {
	if (!isRecord(value)) return false;
	return (
		value.type === "extension_ui_cancel" &&
		typeof value.targetId === "string" &&
		(value.timedOut === undefined || typeof value.timedOut === "boolean")
	);
}

function isRpcProviderRequestObservationFrame(value: unknown): value is RpcProviderRequestObservationFrame {
	if (!isRecord(value)) return false;
	return (
		value.type === "provider_request_observation" &&
		(value.stage === "context" || value.stage === "before_provider_request") &&
		typeof value.requestId === "number"
	);
}
function isRpcExtensionUiRequest(value: unknown): value is RpcExtensionUIRequest {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_request" && typeof value.id === "string" && typeof value.method === "string";
}

function normalizeToolResult<TDetails>(result: RpcClientToolResult<TDetails>): AgentToolResult<TDetails> {
	if (typeof result === "string") {
		return {
			content: [{ type: "text", text: result }],
		};
	}
	return result;
}

/** Failed RPC command; `code` mirrors the server's machine-readable error code when present. */
export class RpcCommandError extends Error {
	constructor(
		message: string,
		readonly command: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "RpcCommandError";
	}
}

/** True when a high-level `getMessages()` drain should discard partial pages and fall back to `get_messages`. */
function isPageFallbackError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (error instanceof RpcCommandError && (error.code === "session_busy" || error.code === "stale_cursor"))
		return true;
	return error.message === RPC_MESSAGES_PAGE_BUSY_ERROR || error.message === RPC_MESSAGES_PAGE_STALE_ERROR;
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	#process: ptree.ChildProcess | null = null;
	#reaping: Promise<void> | null = null;
	#eventListeners: RpcEventListener[] = [];
	#sessionEventListeners: RpcSessionEventListener[] = [];
	#subagentLifecycleListeners = new Set<RpcSubagentLifecycleListener>();
	#subagentProgressListeners = new Set<RpcSubagentProgressListener>();
	#subagentEventListeners = new Set<RpcSubagentEventListener>();
	#availableCommandsUpdateListeners = new Set<RpcAvailableCommandsUpdateListener>();
	#execOutputListeners = new Set<RpcExecOutputListener>();
	#btwOutputListeners = new Set<RpcBtwOutputListener>();
	#idleRecapListeners = new Set<RpcIdleRecapListener>();
	#promptResultListeners = new Set<RpcPromptResultListener>();
	#settingsUpdateListeners = new Set<RpcSettingsUpdateListener>();
	#rawSseUpdateListeners = new Set<RpcRawSseUpdateListener>();
	#mcpAuthChallengeListeners = new Set<RpcMcpAuthChallengeListener>();
	#ttsrGenerationEventListeners = new Set<RpcTtsrGenerationEventListener>();
	#voiceEventListeners = new Set<RpcVoiceEventListener>();
	#pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	#customTools: RpcClientCustomTool[] = [];
	#pendingHostToolCalls = new Map<string, { controller: AbortController }>();
	#pendingHostUriRequests = new Map<string, { controller: AbortController }>();
	#hostUriHandler: RpcClientHostUriHandler | undefined;
	#requestId = 0;
	#protocolVersion: RpcProtocolVersion = 1;
	#extensionUiListeners = new Set<RpcExtensionUIRequestListener>();
	#extensionUiCancelListeners = new Set<RpcExtensionUICancelListener>();
	#providerRequestObservationListeners = new Set<RpcProviderRequestObservationListener>();
	#abortController = new AbortController();

	constructor(private options: RpcClientOptions = {}) {
		this.#customTools = [...(options.customTools ?? [])];
	}

	/**
	 * Start the RPC agent process.
	 *
	 * Safe to call again after {@link stop} on the same instance: a fresh
	 * {@link AbortController} is minted for each start, and any failure after
	 * the child spawn kills the child and clears internal state so callers may
	 * retry without leaking processes.
	 */
	async start(): Promise<void> {
		await this.#reaping;
		if (this.#process) {
			throw new Error("Client already started");
		}

		// Mint a fresh controller so a previous stop()'s abort does not
		// short-circuit the new stdout reader (issue #4079).
		this.#abortController = new AbortController();
		this.#protocolVersion = 1;

		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.sessionDir) {
			args.push("--session-dir", this.options.sessionDir);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const child = ptree.spawn(["bun", cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...Bun.env, ...this.options.env },
			stdin: "pipe",
		});
		this.#process = child;

		// Wait for the "ready" signal or process exit
		const { promise: readyPromise, resolve: readyResolve, reject: readyReject } = Promise.withResolvers<void>();
		let readySettled = false;
		let protocolV2Supported = false;
		let protocolV2Enabled = false;
		const frameDecoder = new RpcFrameDecoder();

		const reapAfterOutputFailure = async (error: Error) => {
			if (this.#process !== child) return;

			this.#process = null;
			this.#abortController.abort(error);
			const pendingRequests = Array.from(this.#pendingRequests.values());
			this.#pendingRequests.clear();
			for (const pendingCall of this.#pendingHostToolCalls.values()) pendingCall.controller.abort(error);
			this.#pendingHostToolCalls.clear();
			for (const pendingRequest of this.#pendingHostUriRequests.values()) pendingRequest.controller.abort(error);
			this.#pendingHostUriRequests.clear();

			try {
				child.kill();
			} catch {
				// The process may already have exited.
			}
			await this.#waitForExit(child);
			for (const request of pendingRequests) request.reject(error);
		};

		// Process lines in background, intercepting the ready signal.
		const lines = readJsonl(child.stdout, this.#abortController.signal);
		void (async () => {
			for await (const line of lines) {
				if (!readySettled && isRecord(line) && line.type === "ready") {
					protocolV2Supported = supportsRpcProtocolV2(line);
					readySettled = true;
					readyResolve();
					continue;
				}
				if (isRecord(line) && line.type === "rpc_chunk" && !protocolV2Enabled)
					throw new Error("RPC chunk received before protocol negotiation");
				const decoded = frameDecoder.push(line);
				if (decoded) this.#handleLine(decoded);
			}
			// A closed stdout is terminal even if the child remains alive. Startup
			// failures are reaped by the readyPromise catch below; established
			// workers are reaped here so pending requests cannot hang indefinitely.
			if (!readySettled) {
				readySettled = true;
				readyReject(new Error(`Agent output stream ended before ready. Stderr: ${child.peekStderr()}`));
				return;
			}
			const exitResult = await Promise.race([
				child.exited.then(
					exitCode => ({ exitCode }),
					cause => ({ cause }),
				),
				Bun.sleep(100).then(() => null),
			]);
			const error =
				exitResult === null
					? new Error(`Agent output stream ended unexpectedly. Stderr: ${child.peekStderr()}`)
					: "exitCode" in exitResult
						? new Error(`Agent process exited with code ${exitResult.exitCode}. Stderr: ${child.peekStderr()}`)
						: new Error(`Agent output stream ended. Stderr: ${child.peekStderr()}`, {
								cause: exitResult.cause,
							});
			await reapAfterOutputFailure(error);
		})().catch(async (cause: unknown) => {
			const error = cause instanceof Error ? cause : new Error(String(cause));
			if (!readySettled) {
				readySettled = true;
				readyReject(error);
				return;
			}
			await reapAfterOutputFailure(new Error(`Agent output reader failed: ${error.message}`, { cause: error }));
		});

		// Also race against process exit (in case stdout closes before we read it)
		void child.exited.then(
			(exitCode: number) => {
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent process exited with code ${exitCode}. Stderr: ${child.peekStderr()}`));
			},
			(err: Error) => {
				// Killed or reaped without an exit code (e.g. stop() during
				// startup); surface it instead of leaking an unhandled rejection.
				if (readySettled) return;
				readySettled = true;
				readyReject(new Error(`Agent process exited before ready. Stderr: ${child.peekStderr()}`, { cause: err }));
			},
		);

		// Timeout to prevent hanging forever
		const readyTimeout = this.#startTimeout(30000, () => {
			if (readySettled) return;
			readySettled = true;
			readyReject(new Error(`Timeout waiting for agent to become ready. Stderr: ${child.peekStderr()}`));
		});

		try {
			await readyPromise;
			if (protocolV2Supported) {
				protocolV2Enabled = true;
				const response = await this.#send({ type: "negotiate_protocol", protocolVersion: 2 });
				if (
					!response.success ||
					response.command !== "negotiate_protocol" ||
					!isRecord(response.data) ||
					response.data.protocolVersion !== 2
				)
					throw new Error("RPC protocol v2 negotiation failed");
				this.#protocolVersion = 2;
			}
			if (this.#customTools.length > 0) {
				await this.setCustomTools(this.#customTools);
			}
		} catch (cause) {
			// Startup failed after spawning the child. Reap it before returning
			// so a retry cannot inherit a live worker or its session lock.
			const error = cause instanceof Error ? cause : new Error(String(cause));
			await reapAfterOutputFailure(error);
			throw cause;
		} finally {
			clearTimeout(readyTimeout);
		}
	}

	/**
	 * Stop the RPC agent process.
	 */
	stop(): Promise<void> {
		if (!this.#process) return this.#reaping ?? Promise.resolve();

		const error = new Error("Client stopped");
		const child = this.#process;
		child.kill();
		this.#abortController.abort(error);
		this.#process = null;
		for (const request of this.#pendingRequests.values()) request.reject(error);
		this.#pendingRequests.clear();
		for (const pendingCall of this.#pendingHostToolCalls.values()) {
			pendingCall.controller.abort(error);
		}
		this.#pendingHostToolCalls.clear();
		for (const pendingRequest of this.#pendingHostUriRequests.values()) {
			pendingRequest.controller.abort(error);
		}
		this.#pendingHostUriRequests.clear();
		return this.#waitForExit(child);
	}

	/**
	 * Stop the RPC agent process and clean up resources.
	 */
	[Symbol.dispose](): void {
		void this.stop();
	}

	#waitForExit(child: ptree.ChildProcess): Promise<void> {
		const reaping = child.exited.then(
			() => {},
			() => {},
		);
		this.#reaping = reaping;
		void reaping.then(() => {
			if (this.#reaping === reaping) this.#reaping = null;
		});
		return reaping;
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.#eventListeners.push(listener);
		return () => {
			const index = this.#eventListeners.indexOf(listener);
			if (index !== -1) {
				this.#eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to all top-level session events, including non-core session state events.
	 */
	onSessionEvent(listener: RpcSessionEventListener): () => void {
		this.#sessionEventListeners.push(listener);
		return () => {
			const index = this.#sessionEventListeners.indexOf(listener);
			if (index !== -1) {
				this.#sessionEventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to subagent lifecycle frames after setSubagentSubscription("progress" | "events").
	 */
	onSubagentLifecycle(listener: RpcSubagentLifecycleListener): () => void {
		this.#subagentLifecycleListeners.add(listener);
		return () => this.#subagentLifecycleListeners.delete(listener);
	}

	/**
	 * Subscribe to aggregated subagent progress frames after setSubagentSubscription("progress" | "events").
	 */
	onSubagentProgress(listener: RpcSubagentProgressListener): () => void {
		this.#subagentProgressListeners.add(listener);
		return () => this.#subagentProgressListeners.delete(listener);
	}

	/**
	 * Subscribe to raw subagent session events. Call setSubagentSubscription(\"events\") to enable them server-side.
	 */
	onSubagentEvent(listener: RpcSubagentEventListener): () => void {
		this.#subagentEventListeners.add(listener);
		return () => this.#subagentEventListeners.delete(listener);
	}

	/**
	 * Subscribe to slash-command availability updates emitted by the RPC server.
	 */
	onAvailableCommandsUpdate(listener: RpcAvailableCommandsUpdateListener): () => void {
		this.#availableCommandsUpdateListeners.add(listener);
		return () => this.#availableCommandsUpdateListeners.delete(listener);
	}

	/**
	 * Subscribe to incremental bash and Python execution output emitted by the RPC server.
	 */
	onExecOutput(listener: RpcExecOutputListener): () => void {
		this.#execOutputListeners.add(listener);
		return () => this.#execOutputListeners.delete(listener);
	}

	/** Subscribe to incremental text from `/btw` side turns. */
	onBtwOutput(listener: RpcBtwOutputListener): () => void {
		this.#btwOutputListeners.add(listener);
		return () => this.#btwOutputListeners.delete(listener);
	}

	/** Subscribe to recaps produced after the configured RPC idle period. */
	onIdleRecap(listener: RpcIdleRecapListener): () => void {
		this.#idleRecapListeners.add(listener);
		return () => this.#idleRecapListeners.delete(listener);
	}

	/** Subscribe to asynchronous completion of prompts handled without an agent turn. */
	onPromptResult(listener: RpcPromptResultListener): () => void {
		this.#promptResultListeners.add(listener);
		return () => this.#promptResultListeners.delete(listener);
	}

	/**
	 * Subscribe to effective setting changes emitted by the RPC server.
	 */
	onSettingsUpdate(listener: RpcSettingsUpdateListener): () => void {
		this.#settingsUpdateListeners.add(listener);
		return () => this.#settingsUpdateListeners.delete(listener);
	}

	/**
	 * Subscribe to raw SSE snapshots. Call {@link subscribeRawSse} to make the server emit them.
	 */
	onRawSseUpdate(listener: RpcRawSseUpdateListener): () => void {
		this.#rawSseUpdateListeners.add(listener);
		return () => this.#rawSseUpdateListeners.delete(listener);
	}

	/**
	 * Subscribe to mid-flight MCP re-authentication challenges. The blocked tool call
	 * only resumes once {@link resolveMcpAuthChallenge} answers the challenge id.
	 */
	onMcpAuthChallenge(listener: RpcMcpAuthChallengeListener): () => void {
		this.#mcpAuthChallengeListeners.add(listener);
		return () => this.#mcpAuthChallengeListeners.delete(listener);
	}

	/** Subscribe to streaming `/omfg` rule-generation drafts. */
	onTtsrGenerationEvent(listener: RpcTtsrGenerationEventListener): () => void {
		this.#ttsrGenerationEventListeners.add(listener);
		return () => this.#ttsrGenerationEventListeners.delete(listener);
	}

	/**
	 * Subscribe to live-session and speech-to-text activity emitted by the RPC server.
	 */
	onVoiceEvent(listener: RpcVoiceEventListener): () => void {
		this.#voiceEventListeners.add(listener);
		return () => this.#voiceEventListeners.delete(listener);
	}

	/** Subscribe to extension UI requests, including rich ask dialogs and OAuth prompts. */
	onExtensionUiRequest(listener: RpcExtensionUIRequestListener): () => void {
		this.#extensionUiListeners.add(listener);
		return () => this.#extensionUiListeners.delete(listener);
	}

	/** Subscribe to server-side cancellation of pending extension UI dialogs. */
	onExtensionUiCancel(listener: RpcExtensionUICancelListener): () => void {
		this.#extensionUiCancelListeners.add(listener);
		return () => this.#extensionUiCancelListeners.delete(listener);
	}

	/** Observe redacted provider inputs after {@link subscribeProviderRequestObservations}. */
	onProviderRequestObservation(listener: RpcProviderRequestObservationListener): () => void {
		this.#providerRequestObservationListeners.add(listener);
		return () => this.#providerRequestObservationListeners.delete(listener);
	}

	/** Answer a request received through {@link onExtensionUiRequest}. */
	respondToExtensionUi(response: RpcExtensionUIResponse): void {
		this.#writeFrame(response);
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.#process?.peekStderr() ?? "";
	}

	#startTimeout(timeoutMs: number, onTimeout: () => void): NodeJS.Timeout {
		const timer = setTimeout(onTimeout, timeoutMs);
		timer.unref();
		return timer;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.promptWithResult(message, images);
	}

	/**
	 * Send a prompt and retain any outcome known when the server acknowledges it.
	 * An omitted `agentInvoked` means the prompt is still resolving asynchronously.
	 */
	async promptWithResult(message: string, images?: ImageContent[]): Promise<RpcPromptSubmissionResult> {
		const response = await this.#send({ type: "prompt", message, images });
		return this.#getData<RpcPromptSubmissionResult | undefined>(response) ?? {};
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.#send({ type: "abort" });
	}

	/** Ask an ephemeral side question without adding it to the main transcript. */
	async askBtw(question: string): Promise<RpcBtwAskResult> {
		const response = await this.#send({ type: "ask_btw", question }, 600_000);
		return this.#getData(response);
	}

	/** Return the last completed, non-empty `/btw` answer. */
	async getLastBtwAnswer(): Promise<RpcBtwAnswer | null> {
		const response = await this.#send({ type: "get_last_btw_answer" });
		return this.#getData<{ answer: RpcBtwAnswer | null }>(response).answer;
	}

	/** Cancel an in-flight `/btw` side turn. */
	async cancelBtw(): Promise<boolean> {
		const response = await this.#send({ type: "cancel_btw" });
		return this.#getData<{ cancelled: boolean }>(response).cancelled;
	}

	/** Branch the retained `/btw` answer into the main session. */
	async branchBtw(): Promise<RpcBtwBranchResult> {
		const response = await this.#send({ type: "branch_btw" }, 600_000);
		return this.#getData(response);
	}

	/**
	 * Abort current operation and immediately start a new turn with the given message.
	 */
	async abortAndPrompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.#send({ type: "abort_and_prompt", message, images });
	}

	/** Get completions for the current editor state. */
	async complete(lines: string[], cursor: { line: number; column: number }): Promise<RpcCompletionResult> {
		const response = await this.#send({ type: "complete", lines, cursor });
		return this.#getData(response);
	}

	/** Apply a completion previously returned by {@link complete}. */
	async applyCompletion(
		lines: string[],
		cursor: { line: number; column: number },
		item: RpcCompletionItem,
	): Promise<RpcCompletionApplied> {
		const response = await this.#send({ type: "apply_completion", lines, cursor, item });
		return this.#getData(response);
	}

	/**
	 * Publish the host editor's current draft for synchronous extension reads.
	 * Publish again after each host-local edit that extensions should observe.
	 */
	async publishEditorText(text: string): Promise<void> {
		await this.#send({ type: "publish_editor_text", text });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "new_session", parentSession });
		return this.#getData(response);
	}

	/** Fork the active session with its complete transcript and artifacts. */
	async fork(): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "fork" });
		return this.#getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.#send({ type: "get_state" });
		return this.#getData(response);
	}

	/** Replace the session todo phases. */
	async setTodos(phases: TodoPhase[]): Promise<TodoPhase[]> {
		const response = await this.#send({ type: "set_todos", phases });
		return this.#getData<{ todoPhases: TodoPhase[] }>(response).todoPhases;
	}

	/** Replace the host-owned URI schemes exposed to the RPC session. */
	async setHostUriSchemes(schemes: RpcHostUriSchemeDefinition[]): Promise<string[]> {
		const response = await this.#send({ type: "set_host_uri_schemes", schemes });
		return this.#getData<{ schemes: string[] }>(response).schemes;
	}

	/**
	 * Register the handler that satisfies requests for schemes announced through
	 * {@link setHostUriSchemes}. Replacing or disposing it affects future requests.
	 */
	registerHostUriHandler(handler: RpcClientHostUriHandler): () => void {
		this.#hostUriHandler = handler;
		return () => {
			if (this.#hostUriHandler === handler) this.#hostUriHandler = undefined;
		};
	}

	/** Start redacted provider context/request observation. Servers default to off. */
	async subscribeProviderRequestObservations(): Promise<void> {
		const response = await this.#send({ type: "subscribe_provider_request_observations" });
		this.#getData(response);
	}

	/** Stop provider context/request observation and release the server observer. */
	async unsubscribeProviderRequestObservations(): Promise<void> {
		const response = await this.#send({ type: "unsubscribe_provider_request_observations" });
		this.#getData(response);
	}

	/**
	 * Configure subagent frames emitted by the RPC server. Servers default to "off".
	 * "progress" emits lifecycle/progress frames; "events" additionally emits raw subagent session events.
	 */
	async setSubagentSubscription(level: RpcSubagentSubscriptionLevel): Promise<RpcSubagentSubscriptionLevel> {
		const response = await this.#send({ type: "set_subagent_subscription", level });
		return this.#getData<{ level: RpcSubagentSubscriptionLevel }>(response).level;
	}

	/**
	 * Return the RPC server's current subagent snapshot.
	 */
	async getSubagents(): Promise<RpcSubagentSnapshot[]> {
		const response = await this.#send({ type: "get_subagents" });
		return this.#getData<{ subagents: RpcSubagentSnapshot[] }>(response).subagents;
	}

	/**
	 * Read persisted transcript entries for a tracked subagent session.
	 */
	async getSubagentMessages(selector: {
		subagentId?: string;
		sessionFile?: string;
		fromByte?: number;
	}): Promise<RpcSubagentMessagesResult> {
		const response = await this.#send({
			type: "get_subagent_messages",
			subagentId: selector.subagentId,
			sessionFile: selector.sessionFile,
			fromByte: selector.fromByte,
		});
		return this.#getData<RpcSubagentMessagesResult>(response);
	}

	/** List task subagents that can be controlled through the shared agent registry. */
	async getControllableAgents(): Promise<RpcControllableAgent[]> {
		const response = await this.#send({ type: "get_controllable_agents" });
		return this.#getData(response);
	}

	/** Revive a parked task subagent. */
	async reviveAgent(agentId: string): Promise<RpcControllableAgent> {
		const response = await this.#send({ type: "revive_agent", agentId });
		return this.#getData(response);
	}

	/** Abort and release a running task subagent. */
	async killAgent(agentId: string): Promise<RpcAgentControlResult> {
		const response = await this.#send({ type: "kill_agent", agentId });
		return this.#getData(response);
	}

	/** Send a steering prompt to a live task subagent. */
	async promptAgent(agentId: string, text: string): Promise<RpcControllableAgent> {
		const response = await this.#send({ type: "prompt_agent", agentId, text }, 600_000);
		return this.#getData(response);
	}

	/** Dispatch the canonical background `/tan` workflow. */
	async spawnBackgroundAgent(work: string): Promise<RpcBackgroundAgent> {
		const response = await this.#send({ type: "spawn_background_agent", work });
		return this.#getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.#send({ type: "set_model", provider, modelId });
		return this.#getData(response);
	}

	/** Select a model for this session without updating persisted model settings. */
	async setModelTemporary(
		provider: string,
		modelId: string,
		options?: { thinkingLevel?: ConfiguredThinkingLevel; ephemeral?: boolean },
	): Promise<Model> {
		const response = await this.#send({
			type: "set_model_temporary",
			provider,
			modelId,
			...(options?.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
			...(options?.ephemeral !== undefined ? { ephemeral: options.ephemeral } : {}),
		});
		return this.#getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(direction?: "forward" | "backward"): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel | undefined;
		isScoped: boolean;
	} | null> {
		const response = await this.#send({ type: "cycle_model", direction });
		return this.#getData(response);
	}

	/** Cycle through the configured model roles in the supplied order. */
	async cycleRoleModels(
		roleOrder: string[],
		direction?: "forward" | "backward",
	): Promise<RoleModelCycleResult | null> {
		const response = await this.#send({ type: "cycle_role_models", roleOrder, direction });
		return this.#getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.#send({ type: "get_available_models" });
		return this.#getData<{ models: ModelInfo[] }>(response).models;
	}

	/** Read effective model roles with their settings-layer provenance. */
	async getModelRoles(): Promise<RpcModelRolesSnapshot> {
		const response = await this.#send({ type: "get_model_roles" });
		return this.#getData(response);
	}

	/** Persist one model role in the global or project settings layer. */
	async setModelRole(role: string, model: string, scope: RpcModelRoleScope): Promise<RpcModelRolesSnapshot> {
		const response = await this.#send({ type: "set_model_role", role, model, scope });
		return this.#getData(response);
	}

	/** Clear one model role from the global or project settings layer. */
	async clearModelRole(role: string, scope: RpcModelRoleScope): Promise<RpcModelRolesSnapshot> {
		const response = await this.#send({ type: "clear_model_role", role, scope });
		return this.#getData(response);
	}

	/**
	 * Get list of available slash commands.
	 */
	async getAvailableCommands(): Promise<RpcAvailableSlashCommand[]> {
		const response = await this.#send({ type: "get_available_commands" });
		return this.#getData<{ commands: RpcAvailableSlashCommand[] }>(response).commands;
	}

	/**
	 * Get the complete settings schema and effective values.
	 */
	async getSettings(): Promise<RpcSettingsSnapshot> {
		const response = await this.#send({ type: "get_settings" });
		return this.#getData(response);
	}

	/**
	 * Set a setting value.
	 */
	async setSetting(path: string, value: unknown): Promise<{ path: string; value: unknown; configured: boolean }> {
		const response = await this.#send({ type: "set_setting", path, value });
		return this.#getData(response);
	}

	/**
	 * Get loaded extensions without their raw configuration.
	 */
	async getExtensions(options?: { cwd?: string }): Promise<RpcExtension[]> {
		const response = await this.#send({
			type: "get_extensions",
			...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
		});
		return this.#getData<{ extensions: RpcExtension[] }>(response).extensions;
	}

	/** Get the active theme's resolved colors, symbols, and contrast metadata. */
	async getTheme(): Promise<RpcThemeSnapshot> {
		const response = await this.#send({ type: "get_theme" });
		return this.#getData(response);
	}

	/** Get the effective terminal keybindings and their descriptions. */
	async getKeybindings(): Promise<RpcKeybinding[]> {
		const response = await this.#send({ type: "get_keybindings" });
		return this.#getData<{ keybindings: RpcKeybinding[] }>(response).keybindings;
	}

	/** Get repository status for a working directory. PR lookup is opt-in. */
	async getRepoStatus(options?: { cwd?: string; includePr?: boolean }): Promise<RpcRepoStatus> {
		const response = await this.#send({
			type: "get_repo_status",
			...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
			...(options?.includePr !== undefined ? { includePr: options.includePr } : {}),
		});
		return this.#getData(response);
	}

	/** Get provider usage reports for the active session. */
	async getUsageReports(): Promise<UsageReport[]> {
		const response = await this.#send({ type: "get_usage_reports" });
		return this.#getData<{ reports: UsageReport[] }>(response).reports;
	}

	/** Get session-owned presentation state used by status surfaces. */
	async getSessionView(): Promise<RpcSessionView> {
		const response = await this.#send({ type: "get_session_view" });
		return this.#getData(response);
	}

	/** Enter plan mode. */
	async enterPlanMode(
		planFilePath?: string,
		workflow: "parallel" | "iterative" = "parallel",
	): Promise<RpcPlanModeSnapshot> {
		const response = await this.#send({ type: "enter_plan_mode", planFilePath, workflow });
		return this.#getData(response);
	}

	/** Pause plan mode while preserving the persisted paused state. */
	async pausePlanMode(): Promise<RpcPlanModeSnapshot> {
		const response = await this.#send({ type: "pause_plan_mode" });
		return this.#getData(response);
	}

	/** Resume a paused plan mode. */
	async resumePlanMode(): Promise<RpcPlanModeSnapshot> {
		const response = await this.#send({ type: "resume_plan_mode" });
		return this.#getData(response);
	}

	/** Exit plan mode. */
	async exitPlanMode(): Promise<RpcPlanModeSnapshot> {
		const response = await this.#send({ type: "exit_plan_mode" });
		return this.#getData(response);
	}

	/** Read plan-mode state. */
	async getPlanModeState(): Promise<RpcPlanModeSnapshot> {
		const response = await this.#send({ type: "get_plan_mode_state" });
		return this.#getData(response);
	}

	/** Prepare the current plan for host review. */
	async submitPlanReview(title = ""): Promise<RpcPlanProposalSnapshot> {
		const response = await this.#send({ type: "submit_plan_review", title });
		return this.#getData(response);
	}

	/** Approve and begin executing the pending plan proposal. */
	async approvePlanProposal(options?: {
		editedContent?: string;
		strategy?: RpcPlanFinalizationStrategy;
		executionModel?: { provider: string; modelId: string };
		thinkingLevel?: ConfiguredThinkingLevel;
	}): Promise<RpcPlanDecisionResult> {
		const response = await this.#send({ type: "approve_plan_proposal", ...options }, 600_000);
		return this.#getData(response);
	}

	/** Reject the pending plan proposal, optionally prompting for refinement. */
	async rejectPlanProposal(feedback = ""): Promise<RpcPlanDecisionResult> {
		const response = await this.#send({ type: "reject_plan_proposal", feedback }, 600_000);
		return this.#getData(response);
	}

	/** Create and activate a goal. */
	async createGoal(objective: string, tokenBudget?: number): Promise<RpcGoalModeSnapshot> {
		const response = await this.#send({ type: "create_goal", objective, tokenBudget });
		return this.#getData(response);
	}

	/** Pause the active goal. */
	async pauseGoal(): Promise<RpcGoalModeSnapshot> {
		const response = await this.#send({ type: "pause_goal" });
		return this.#getData(response);
	}

	/** Resume the paused goal. */
	async resumeGoal(): Promise<RpcGoalModeSnapshot> {
		const response = await this.#send({ type: "resume_goal" });
		return this.#getData(response);
	}

	/** Replace the active goal. */
	async switchGoal(objective: string, tokenBudget?: number): Promise<RpcGoalModeSnapshot> {
		const response = await this.#send({ type: "switch_goal", objective, tokenBudget });
		return this.#getData(response);
	}

	/** Clear the current goal. */
	async clearGoal(): Promise<RpcGoalModeSnapshot> {
		const response = await this.#send({ type: "clear_goal" });
		return this.#getData(response);
	}

	/** Set or clear the active goal's token budget. */
	async setGoalBudget(tokenBudget: number | null): Promise<RpcGoalModeSnapshot> {
		const response = await this.#send({ type: "set_goal_budget", tokenBudget });
		return this.#getData(response);
	}

	/** Read goal-mode state. */
	async getGoalState(): Promise<RpcGoalModeSnapshot> {
		const response = await this.#send({ type: "get_goal_state" });
		return this.#getData(response);
	}

	/** Start the guided goal-definition flow. */
	async beginGuidedGoal(initialObjective?: string): Promise<RpcGuidedGoalKickoffResult> {
		const response = await this.#send({ type: "begin_guided_goal", initialObjective }, 600_000);
		return this.#getData(response);
	}

	/** Enter vibe mode. */
	async enterVibeMode(): Promise<RpcVibeModeSnapshot> {
		const response = await this.#send({ type: "enter_vibe_mode" });
		return this.#getData(response);
	}

	/** Exit vibe mode. */
	async exitVibeMode(): Promise<RpcVibeModeSnapshot> {
		const response = await this.#send({ type: "exit_vibe_mode" });
		return this.#getData(response);
	}

	/** Read vibe-mode state. */
	async getVibeModeState(): Promise<RpcVibeModeSnapshot> {
		const response = await this.#send({ type: "get_vibe_mode_state" });
		return this.#getData(response);
	}

	/** Read the combined plan, goal, guided-goal, and vibe state. */
	async getWorkModeState(): Promise<RpcWorkModeSnapshot> {
		const response = await this.#send({ type: "get_work_mode_state" });
		return this.#getData(response);
	}

	/** Enable automatic loop resubmission. */
	async enableLoop(
		prompt: string,
		options?: { action?: RpcLoopAction; count?: number; durationMs?: number },
	): Promise<RpcLoopState> {
		const response = await this.#send({ type: "enable_loop", prompt, ...options });
		return this.#getData(response);
	}

	/** Disable automatic loop resubmission. */
	async disableLoop(): Promise<RpcLoopState> {
		const response = await this.#send({ type: "disable_loop" });
		return this.#getData(response);
	}

	/** Read automatic loop state. */
	async getLoopState(): Promise<RpcLoopState> {
		const response = await this.#send({ type: "get_loop_state" });
		return this.#getData(response);
	}

	/** Cancel the active loop iteration and pause future repeats. */
	async cancelLoopIteration(): Promise<RpcLoopState> {
		const response = await this.#send({ type: "cancel_loop_iteration" });
		return this.#getData(response);
	}

	/** Pause process-wide agent execution. */
	async pauseAgents(): Promise<RpcPauseResult> {
		const response = await this.#send({ type: "pause_agents" });
		return this.#getData(response);
	}

	/** Resume process-wide agent execution. */
	async resumeAgents(): Promise<RpcPauseResult> {
		const response = await this.#send({ type: "resume_agents" });
		return this.#getData(response);
	}

	/** Read process-wide pause state. */
	async getPauseState(): Promise<RpcPauseState> {
		const response = await this.#send({ type: "get_pause_state" });
		return this.#getData(response);
	}

	/** Read the session tree; returned node ids are valid navigateTree targets. */
	async getSessionTree(): Promise<RpcSessionTreeSnapshot> {
		const response = await this.#send({ type: "get_session_tree" });
		return this.#getData(response);
	}

	/** Read one project or user advisor configuration. */
	async getAdvisorConfig(scope: RpcAuthoringScope): Promise<RpcAdvisorConfigSnapshot> {
		const response = await this.#send({ type: "get_advisor_config", scope });
		return this.#getData(response);
	}

	/** Save one advisor configuration and apply the merged roster. */
	async setAdvisorConfig(
		scope: RpcAuthoringScope,
		instructions: string | null,
		advisors: RpcAdvisorConfig[],
	): Promise<RpcAdvisorConfigSnapshot> {
		const response = await this.#send({ type: "set_advisor_config", scope, instructions, advisors });
		return this.#getData(response);
	}

	/** Build and validate a TTSR rule without persisting it. */
	async buildTtsrRule(
		name: string,
		description: string,
		conditions: string[],
		scopes: string[],
		body: string,
	): Promise<RpcTtsrRuleDraft> {
		const response = await this.#send({ type: "build_ttsr_rule", name, description, conditions, scopes, body });
		return this.#getData(response);
	}

	/** Generate an `/omfg` TTSR rule candidate, optionally amending a previous draft. */
	async generateTtsrRule(
		complaint: string,
		options?: { feedback?: string; previousRule?: string },
	): Promise<RpcTtsrGeneratedCandidate> {
		const response = await this.#send({ type: "generate_ttsr_rule", complaint, ...options }, 600_000);
		return this.#getData(response);
	}

	/** Persist and install a TTSR rule. */
	async registerTtsrRule(
		scope: RpcAuthoringScope,
		name: string,
		description: string,
		conditions: string[],
		scopes: string[],
		body: string,
		overwrite: boolean,
	): Promise<RpcTtsrRegistration> {
		const response = await this.#send({
			type: "register_ttsr_rule",
			scope,
			name,
			description,
			conditions,
			scopes,
			body,
			overwrite,
		});
		return this.#getData(response);
	}

	/** List TTSR rules compiled into the live session. */
	async getTtsrRules(): Promise<RpcTtsrRule[]> {
		const response = await this.#send({ type: "get_ttsr_rules" });
		return this.#getData(response);
	}

	/** Remove a live TTSR rule and optionally its persisted OMFG file. */
	async removeTtsrRule(name: string, deletePersisted: boolean): Promise<RpcTtsrRemoval> {
		const response = await this.#send({ type: "remove_ttsr_rule", name, deletePersisted });
		return this.#getData(response);
	}

	/** List effective task-agent definitions. */
	async getAgentDefinitions(): Promise<RpcAgentDefinition[]> {
		const response = await this.#send({ type: "get_agent_definitions" });
		return this.#getData(response);
	}

	/** Read an effective or scope-specific task-agent definition. */
	async getAgentDefinition(name: string, scope: RpcAuthoringScope | null): Promise<RpcAgentDefinitionDocument | null> {
		const response = await this.#send({ type: "get_agent_definition", name, scope });
		return this.#getData(response);
	}

	/** Create or replace a project or user task-agent definition. */
	async setAgentDefinition(
		scope: RpcAuthoringScope,
		name: string,
		content: string,
		overwrite: boolean,
	): Promise<RpcAgentDefinitionDocument> {
		const response = await this.#send({ type: "set_agent_definition", scope, name, content, overwrite });
		return this.#getData(response);
	}

	/** Delete a project or user task-agent definition. */
	async deleteAgentDefinition(scope: RpcAuthoringScope, name: string): Promise<RpcAgentDefinitionDeleteResult> {
		const response = await this.#send({ type: "delete_agent_definition", scope, name });
		return this.#getData(response);
	}

	/** List mental models on the active Hindsight bank. */
	async getMentalModels(detail: MentalModelDetail): Promise<RpcMentalModelList> {
		const response = await this.#send({ type: "get_mental_models", detail });
		return this.#getData(response);
	}

	/** Read one mental model. */
	async getMentalModel(mentalModelId: string, detail: MentalModelDetail): Promise<RpcMentalModel | null> {
		const response = await this.#send({ type: "get_mental_model", mentalModelId, detail });
		return this.#getData(response);
	}

	/** Create one mental model. */
	async createMentalModel(
		name: string,
		sourceQuery: string,
		mentalModelId: string | null,
		tags: string[] | null,
		maxTokens: number | null,
		mode: MentalModelMode | null,
		refreshAfterConsolidation: boolean | null,
	): Promise<RpcMentalModelOperation> {
		const response = await this.#send({
			type: "create_mental_model",
			name,
			sourceQuery,
			mentalModelId,
			tags,
			maxTokens,
			mode,
			refreshAfterConsolidation,
		});
		return this.#getData(response);
	}

	/** Queue a refresh for one mental model. */
	async refreshMentalModel(mentalModelId: string): Promise<RpcMentalModelRefreshOperation> {
		const response = await this.#send({ type: "refresh_mental_model", mentalModelId });
		return this.#getData(response);
	}

	/** Queue refreshes for all mental models configured for automatic refresh. */
	async refreshAutoMentalModels(): Promise<RpcMentalModelBulkRefresh> {
		const response = await this.#send({ type: "refresh_auto_mental_models" });
		return this.#getData(response);
	}

	/** Read one mental model and its content history. */
	async getMentalModelHistory(mentalModelId: string): Promise<RpcMentalModelHistory | null> {
		const response = await this.#send({ type: "get_mental_model_history", mentalModelId });
		return this.#getData(response);
	}

	/** Seed built-in mental models for the active bank scope. */
	async seedMentalModels(): Promise<RpcMentalModelSeedResult> {
		const response = await this.#send({ type: "seed_mental_models" });
		return this.#getData(response);
	}

	/** Delete one mental model and refresh the live prompt cache. */
	async deleteMentalModel(mentalModelId: string): Promise<RpcMentalModelDeleteResult> {
		const response = await this.#send({ type: "delete_mental_model", mentalModelId });
		return this.#getData(response);
	}

	/** Reload the active bank's mental-model prompt block. */
	async reloadMentalModels(): Promise<RpcMentalModelReloadResult> {
		const response = await this.#send({ type: "reload_mental_models" });
		return this.#getData(response);
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.#send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.#send({ type: "cycle_thinking_level" });
		return this.#getData(response);
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.#send({ type: "set_follow_up_mode", mode });
	}

	/** Set whether new prompts interrupt immediately or wait for the active turn. */
	async setInterruptMode(mode: "immediate" | "wait"): Promise<void> {
		await this.#send({ type: "set_interrupt_mode", mode });
	}

	/** Read user-restorable steering and follow-up messages, including images. */
	async getQueuedMessages(): Promise<RpcQueuedMessages> {
		const response = await this.#send({ type: "get_queued_messages" });
		return this.#getData(response);
	}

	/** Remove and return the most recently queued user message. */
	async popQueuedMessage(): Promise<RpcQueuedMessages["steering"][number] | null> {
		const response = await this.#send({ type: "pop_queued_message" });
		return this.#getData<{ message: RpcQueuedMessages["steering"][number] | null }>(response).message;
	}

	/** Clear all user-restorable steering and follow-up messages. */
	async clearQueue(): Promise<RpcQueuedMessages> {
		const response = await this.#send({ type: "clear_queue" });
		return this.#getData(response);
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.#send({ type: "compact", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.#send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.#send({ type: "abort_retry" });
	}

	/** Retry the most recent failed assistant turn. */
	async retry(): Promise<boolean> {
		const response = await this.#send({ type: "retry" });
		return this.#getData<{ retried: boolean }>(response).retried;
	}

	/**
	 * Execute a bash command.
	 */
	async bash(
		command: string,
		options?: { excludeFromContext?: boolean; useUserShell?: boolean; followCwd?: boolean },
	): Promise<BashResult> {
		const response = await this.#send({
			type: "bash",
			command,
			...(options?.excludeFromContext !== undefined ? { excludeFromContext: options.excludeFromContext } : {}),
			...(options?.useUserShell !== undefined ? { useUserShell: options.useUserShell } : {}),
			...(options?.followCwd !== undefined ? { followCwd: options.followCwd } : {}),
		});
		return this.#getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.#send({ type: "abort_bash" });
	}

	/**
	 * Execute Python code.
	 */
	async python(code: string, options?: { excludeFromContext?: boolean }): Promise<PythonResult> {
		const response = await this.#send({
			type: "python",
			code,
			...(options?.excludeFromContext !== undefined ? { excludeFromContext: options.excludeFromContext } : {}),
		});
		return this.#getData(response);
	}

	/**
	 * Abort running Python code.
	 */
	async abortPython(): Promise<void> {
		await this.#send({ type: "abort_python" });
	}

	/**
	 * List persisted sessions.
	 */
	async getSessions(opts?: {
		scope?: "cwd" | "all";
		query?: string;
		limit?: number;
		cwd?: string;
	}): Promise<{ sessions: RpcSessionListEntry[]; total: number }> {
		const response = await this.#send({
			type: "get_sessions",
			...(opts?.scope !== undefined ? { scope: opts.scope } : {}),
			...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
			...(opts?.query !== undefined ? { query: opts.query } : {}),
			...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
		});
		return this.#getData(response);
	}

	/**
	 * Delete a persisted inactive session.
	 */
	async deleteSession(sessionPath: string): Promise<void> {
		await this.#send({ type: "delete_session", sessionPath });
	}

	/** Read project-scoped prompt history unless another cwd is supplied. */
	async getPromptHistory(options?: {
		cwd?: string;
		query?: string;
		limit?: number;
	}): Promise<RpcPromptHistoryEntry[]> {
		const response = await this.#send({
			type: "get_prompt_history",
			...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
			...(options?.query !== undefined ? { query: options.query } : {}),
			...(options?.limit !== undefined ? { limit: options.limit } : {}),
		});
		return this.#getData<{ entries: RpcPromptHistoryEntry[] }>(response).entries;
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<SessionStats> {
		const response = await this.#send({ type: "get_session_stats" });
		return this.#getData(response);
	}

	/**
	 * Hand off session context to a new session.
	 */
	async handoff(customInstructions?: string): Promise<RpcHandoffResult | null> {
		const response = await this.#send({ type: "handoff", customInstructions });
		return this.#getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.#send({ type: "export_html", outputPath });
		return this.#getData(response);
	}

	/**
	 * Switch sessions by absolute path, session-id prefix, filename prefix, or partial title.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionReference: string): Promise<{ cancelled: boolean }> {
		const response = await this.#send({ type: "switch_session", sessionPath: sessionReference });
		return this.#getData(response);
	}

	/**
	 * Branch from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async branch(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.#send({ type: "branch", entryId });
		return this.#getData(response);
	}

	/** Navigate within the active session tree without creating a new session file. */
	async navigateTree(targetId: string, options: RpcNavigateTreeOptions = {}): Promise<RpcNavigateTreeResult> {
		const response = await this.#send({ type: "navigate_tree", targetId, ...options });
		return this.#getData(response);
	}

	/** Resume the agent after a committed ask-tool re-answer tree navigation. */
	async resumeAfterAskReanswer(): Promise<void> {
		await this.#send({ type: "resume_after_ask_reanswer" });
	}

	/** Set the active session's user-visible name. */
	async setSessionName(name: string): Promise<void> {
		await this.#send({ type: "set_session_name", name });
	}

	/** Generate and apply an automatic title for the active session. */
	async generateTitle(text: string): Promise<RpcGenerateTitleResult> {
		const response = await this.#send({ type: "generate_title", text });
		return this.#getData(response);
	}

	/**
	 * Get messages available for branching.
	 */
	async getBranchMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.#send({ type: "get_branch_messages" });
		return this.#getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.#send({ type: "get_last_assistant_text" });
		return this.#getData<{ text: string | null }>(response).text;
	}

	/**
	 * Get one stable, byte-bounded message page.
	 */
	async getMessagesPage(options: RpcMessagesPageOptions = {}): Promise<RpcMessagesPage> {
		const response = await this.#send({ type: "get_messages_page", ...options });
		return this.#getData<RpcMessagesPage>(response);
	}

	/** Get all messages, draining stable pages when protocol v2 is available. */
	async getMessages(): Promise<AgentMessage[]> {
		if (this.#protocolVersion === 2) {
			try {
				const messages: AgentMessage[] = [];
				const seenCursors = new Set<string>();
				let totalMessages: number | undefined;
				let cursor: string | undefined;
				do {
					const page = await this.getMessagesPage({ cursor, limit: 256 });
					if (
						!Number.isSafeInteger(page.totalMessages) ||
						page.totalMessages < 0 ||
						(totalMessages !== undefined && page.totalMessages !== totalMessages)
					)
						throw new Error("RPC message pagination returned an inconsistent total");
					totalMessages = page.totalMessages;
					messages.push(...page.messages);
					cursor = page.nextCursor;
					if (cursor && seenCursors.has(cursor)) throw new Error("RPC message pagination repeated a cursor");
					if (cursor) seenCursors.add(cursor);
				} while (cursor);
				if (messages.length !== totalMessages)
					throw new Error("RPC message pagination ended before the advertised total");
				return messages;
			} catch (error) {
				if (!isPageFallbackError(error)) throw error;
			}
		}
		const response = await this.#send({ type: "get_messages" });
		return this.#getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/** Get OAuth providers and their redacted per-account credential metadata. */
	async getLoginProviders(): Promise<RpcLoginProvider[]> {
		const response = await this.#send({ type: "get_login_providers" });
		return this.#getData<{ providers: RpcLoginProvider[] }>(response).providers;
	}

	/**
	 * Trigger OAuth login for the given provider.
	 * Providers may emit an `input` extension_ui_request before any auth URL
	 * (for endpoint/domain setup) or after it (for pasted-code completion).
	 * Pass `onManualCodeInput` to answer either form, or handle the generic
	 * request through {@link onExtensionUiRequest}.
	 * Resolves when login completes or rejects on failure.
	 *
	 * @param onOpenUrl Called when the server emits the auth URL. The host must
	 *   open `url` in a browser. When the flow's callback server hosts a
	 *   `/launch` redirect, `launchUrl` is a short loopback URL that 302s to
	 *   `url` — hosts SHOULD surface it as the truncation-safe copy target so
	 *   terminal viewport clipping cannot corrupt trailing OAuth query
	 *   parameters (e.g. `code_challenge_method=S256`).
	 */
	async login(
		providerId: string,
		options?: {
			onOpenUrl?: (url: string, instructions?: string, launchUrl?: string) => void;
			onManualCodeInput?: (prompt: { title: string; placeholder?: string }) => string | Promise<string>;
		},
	): Promise<{ providerId: string }> {
		const { onManualCodeInput, onOpenUrl } = options ?? {};
		const listener =
			onOpenUrl || onManualCodeInput
				? (req: RpcExtensionUIRequest) => {
						if (req.method === "open_url") {
							onOpenUrl?.(req.url, req.instructions, req.launchUrl);
							return;
						}
						if (req.method !== "input" || !onManualCodeInput) return;
						void Promise.resolve(onManualCodeInput({ title: req.title, placeholder: req.placeholder }))
							.then(value => {
								this.#writeFrame({
									type: "extension_ui_response",
									id: req.id,
									value,
								});
							})
							.catch(() => {
								this.#writeFrame({
									type: "extension_ui_response",
									id: req.id,
									cancelled: true,
								});
							});
					}
				: undefined;
		if (listener) this.#extensionUiListeners.add(listener);
		try {
			const response = await this.#send({ type: "login", providerId }, 600_000);
			return this.#getData<{ providerId: string }>(response);
		} finally {
			if (listener) this.#extensionUiListeners.delete(listener);
		}
	}

	/** Legacy per-account logout name. A credential id is required; sibling accounts are preserved. */
	async logout(
		providerId: string,
		credentialId: number,
	): Promise<{ providerId: string; credentialId: number; removed: boolean }> {
		const response = await this.#send({ type: "logout", providerId, credentialId });
		return this.#getData(response);
	}

	/** Remove exactly one stored OAuth account. */
	async removeLoginAccount(
		providerId: string,
		credentialId: number,
	): Promise<{ providerId: string; credentialId: number; removed: boolean }> {
		const response = await this.#send({ type: "remove_login_account", providerId, credentialId });
		return this.#getData(response);
	}

	/** Destructively remove every stored credential for one provider. */
	async removeProviderCredentials(providerId: string): Promise<{ providerId: string }> {
		const response = await this.#send({ type: "remove_provider_credentials", providerId });
		return this.#getData(response);
	}

	// =========================================================================
	// MCP
	// =========================================================================

	/** Add a configured MCP server and connect it to the live manager. */
	async addMcpServer(name: string, config: MCPServerConfig, scope: MCPAddScope): Promise<RpcMCPServerResult> {
		const response = await this.#send({ type: "mcp_add_server", name, config, scope }, 120_000);
		return this.#getData(response);
	}

	/** Remove a configured MCP server and its live tools. */
	async removeMcpServer(name: string, scope: MCPAddScope): Promise<RpcMCPServerResult> {
		const response = await this.#send({ type: "mcp_remove_server", name, scope });
		return this.#getData(response);
	}

	/** Enable or disable an MCP server in persistence and the live manager. */
	async setMcpServerEnabled(name: string, enabled: boolean): Promise<RpcMCPServerResult> {
		const response = await this.#send({ type: "mcp_set_server_enabled", name, enabled }, 120_000);
		return this.#getData(response);
	}

	/** Rediscover every MCP server and refresh live tools. */
	async reloadMcp(): Promise<RpcMCPReloadResult> {
		const response = await this.#send({ type: "mcp_reload" }, 120_000);
		return this.#getData(response);
	}

	/** Reconnect one MCP server and replace its live tools. */
	async reconnectMcpServer(name: string): Promise<RpcMCPServerResult> {
		const response = await this.#send({ type: "mcp_reconnect_server", name }, 120_000);
		return this.#getData(response);
	}

	/** Remove managed OAuth credentials and reload one MCP server. */
	async unauthMcpServer(name: string): Promise<RpcMCPServerResult> {
		const response = await this.#send({ type: "mcp_unauth_server", name }, 120_000);
		return this.#getData(response);
	}

	/** Begin proactive MCP OAuth and return the URL for the host to open. */
	async beginMcpReauth(name: string): Promise<RpcMCPOAuthBegin> {
		const response = await this.#send({ type: "mcp_begin_reauth", name }, 120_000);
		return this.#getData(response);
	}

	/** Submit an OAuth completion or await the callback for a pending MCP flow. */
	async completeMcpReauth(flowId: string, completion?: string): Promise<RpcMCPOAuthResult> {
		const response = await this.#send({ type: "mcp_complete_reauth", flowId, completion }, 600_000);
		return this.#getData(response);
	}

	/** Cancel a pending proactive MCP OAuth flow. */
	async cancelMcpReauth(flowId: string): Promise<void> {
		const response = await this.#send({ type: "mcp_cancel_reauth", flowId });
		this.#getData(response);
	}

	/** Begin Smithery authorization and return the client-facing login details. */
	async beginMcpSmitheryLogin(): Promise<RpcMCPSmitheryLoginBegin> {
		const response = await this.#send({ type: "mcp_begin_smithery_login" }, 120_000);
		return this.#getData(response);
	}

	/** Poll Smithery authorization or complete it with a supplied API key. */
	async completeMcpSmitheryLogin(sessionId: string, apiKey?: string): Promise<RpcMCPSmitheryLoginResult> {
		const response = await this.#send({ type: "mcp_complete_smithery_login", sessionId, apiKey }, 120_000);
		return this.#getData(response);
	}

	/** Remove the cached Smithery credential. */
	async logoutMcpSmithery(): Promise<{ removed: boolean }> {
		const response = await this.#send({ type: "mcp_logout_smithery" });
		return this.#getData(response);
	}

	/** Search the Smithery MCP registry. */
	async searchMcpRegistry(query: string, limit?: number, semantic?: boolean): Promise<RpcMCPRegistrySearchResult> {
		const response = await this.#send({ type: "mcp_search_registry", query, limit, semantic }, 120_000);
		return this.#getData(response);
	}

	/** Configure and deploy one Smithery result into the live MCP manager. */
	async deployMcpRegistryResult(
		result: SmitherySearchResult,
		scope: MCPAddScope,
		name: string | undefined,
		values: Record<string, string>,
	): Promise<RpcMCPServerResult> {
		const response = await this.#send({ type: "mcp_deploy_registry_result", result, scope, values, name }, 120_000);
		return this.#getData(response);
	}

	// =========================================================================
	// Diagnostics
	// =========================================================================

	/** Start CPU profiling. Fails when a profile is already running. */
	async startCpuProfile(): Promise<void> {
		const response = await this.#send({ type: "start_cpu_profile" });
		this.#getData(response);
	}

	/** Stop CPU profiling and write a report bundle. */
	async stopCpuProfile(): Promise<RpcDiagnosticArtifact> {
		const response = await this.#send({ type: "stop_cpu_profile" }, 300_000);
		return this.#getData(response);
	}

	/** Write a report bundle containing a heap snapshot. */
	async createHeapProfile(): Promise<RpcDiagnosticArtifact> {
		const response = await this.#send({ type: "create_heap_profile" }, 300_000);
		return this.#getData(response);
	}

	/** Write a support bundle with the session transcript, settings, and raw SSE log. */
	async createSupportBundle(): Promise<RpcDiagnosticArtifact> {
		const response = await this.#send({ type: "create_support_bundle" }, 300_000);
		return this.#getData(response);
	}

	/** Write a report bundle containing the native work profile. */
	async createWorkProfile(): Promise<RpcDiagnosticArtifact> {
		const response = await this.#send({ type: "create_work_profile" }, 300_000);
		return this.#getData(response);
	}

	/** Read the tail of the debug log, optionally including rotated days. */
	async getRecentLogs(options?: { maxLines?: number; olderDays?: number }): Promise<RpcRecentLogs> {
		const response = await this.#send({
			type: "get_recent_logs",
			...(options?.maxLines !== undefined ? { maxLines: options.maxLines } : {}),
			...(options?.olderDays !== undefined ? { olderDays: options.olderDays } : {}),
		});
		return this.#getData(response);
	}

	/** Read the current raw SSE debug buffer. */
	async getRawSse(): Promise<RpcRawSseSnapshot> {
		const response = await this.#send({ type: "get_raw_sse" });
		return this.#getData(response);
	}

	/** Start pushing `raw_sse_update` frames; observe them with {@link onRawSseUpdate}. */
	async subscribeRawSse(): Promise<void> {
		const response = await this.#send({ type: "subscribe_raw_sse" });
		this.#getData(response);
	}

	/** Stop pushing `raw_sse_update` frames. */
	async unsubscribeRawSse(): Promise<void> {
		const response = await this.#send({ type: "unsubscribe_raw_sse" });
		this.#getData(response);
	}

	/** Start (or return) the remote V8 inspector endpoint. */
	async startInspector(): Promise<RpcInspectorEndpoint> {
		const response = await this.#send({ type: "start_inspector" });
		return this.#getData(response);
	}

	/** Read host OS, CPU, memory, and runtime versions. */
	async getSystemInfo(): Promise<RpcSystemInfo> {
		const response = await this.#send({ type: "get_system_info" });
		return this.#getData(response);
	}

	/** Read config and skill warnings collected during startup. */
	async getStartupWarnings(): Promise<RpcStartupWarnings> {
		const response = await this.#send({ type: "get_startup_warnings" });
		return this.#getData(response);
	}

	/** Read the artifacts directory belonging to the active session. */
	async getArtifactsDirectory(): Promise<RpcDiagnosticArtifact> {
		const response = await this.#send({ type: "get_artifacts_directory" });
		return this.#getData(response);
	}

	/** Remove artifact directories older than `daysOld` (default 30). */
	async clearArtifactCache(daysOld?: number): Promise<{ removed: number }> {
		const response = await this.#send({
			type: "clear_artifact_cache",
			...(daysOld !== undefined ? { daysOld } : {}),
		});
		return this.#getData(response);
	}

	/** List MCP auth challenges still waiting for an answer. */
	async getMcpAuthChallenges(): Promise<RpcMcpAuthChallenge[]> {
		const response = await this.#send({ type: "get_mcp_auth_challenges" });
		return this.#getData<{ challenges: RpcMcpAuthChallenge[] }>(response).challenges;
	}

	/**
	 * Answer a pending MCP auth challenge. Omit `config` to fail the blocked call.
	 * Resolves `false` when the challenge id is unknown or already answered.
	 */
	async resolveMcpAuthChallenge(challengeId: string, config?: MCPServerConfig): Promise<boolean> {
		const response = await this.#send({
			type: "resolve_mcp_auth_challenge",
			challengeId,
			...(config !== undefined ? { config } : {}),
		});
		return this.#getData<{ resolved: boolean }>(response).resolved;
	}

	// =========================================================================
	// Voice
	// =========================================================================

	/** Start the realtime voice session; observe activity with {@link onVoiceEvent}. */
	async startLive(options?: { voice?: string }): Promise<RpcLiveStatus> {
		const response = await this.#send({
			type: "start_live",
			...(options?.voice !== undefined ? { voice: options.voice } : {}),
		});
		return this.#getData(response);
	}

	/** Stop the realtime voice session and drain its transport. */
	async stopLive(): Promise<RpcLiveStatus> {
		const response = await this.#send({ type: "stop_live" });
		return this.#getData(response);
	}

	/** Read realtime voice phase, levels, transcript, and terminal error. */
	async getLiveStatus(): Promise<RpcLiveStatus> {
		const response = await this.#send({ type: "get_live_status" });
		return this.#getData(response);
	}

	/** Toggle the microphone while keeping the realtime session connected. */
	async toggleLiveMute(): Promise<RpcLiveStatus> {
		const response = await this.#send({ type: "toggle_live_mute" });
		return this.#getData(response);
	}

	/** Start microphone transcription; observe transcripts with {@link onVoiceEvent}. */
	async startStt(): Promise<RpcSttStatus> {
		const response = await this.#send({ type: "start_stt" });
		return this.#getData(response);
	}

	/** Stop recording and wait for the final transcript. */
	async stopStt(): Promise<RpcSttStatus> {
		const response = await this.#send({ type: "stop_stt" });
		return this.#getData(response);
	}

	/** Push-to-talk toggle matching the interactive shortcut. */
	async toggleStt(): Promise<RpcSttStatus> {
		const response = await this.#send({ type: "toggle_stt" });
		return this.#getData(response);
	}

	/** Read microphone/transcription state. */
	async getSttStatus(): Promise<RpcSttStatus> {
		const response = await this.#send({ type: "get_stt_status" });
		return this.#getData(response);
	}

	/** Speak explicit text through the harness speakers. */
	async speakText(text: string): Promise<RpcSpeechStatus> {
		const response = await this.#send({ type: "speak_text", text });
		return this.#getData(response);
	}

	/** Stop playback, synthesis, and pending speech rewrites. */
	async clearSpeech(): Promise<RpcSpeechStatus> {
		const response = await this.#send({ type: "clear_speech" });
		return this.#getData(response);
	}

	/** Lower speech playback volume while the user is speaking. */
	async duckSpeech(): Promise<RpcSpeechStatus> {
		const response = await this.#send({ type: "duck_speech" });
		return this.#getData(response);
	}

	/** Restore speech playback volume. */
	async unduckSpeech(): Promise<RpcSpeechStatus> {
		const response = await this.#send({ type: "unduck_speech" });
		return this.#getData(response);
	}

	/** Read effective speech settings and playback activity. */
	async getSpeechStatus(): Promise<RpcSpeechStatus> {
		const response = await this.#send({ type: "get_speech_status" });
		return this.#getData(response);
	}

	/** Persist the speech settings controlling automatic and explicit vocalization. */
	async setSpeechSettings(patch: RpcSpeechSettings): Promise<RpcSpeechStatus> {
		const response = await this.#send({
			type: "set_speech_settings",
			...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
			...(patch.mode !== undefined ? { mode: patch.mode } : {}),
		});
		return this.#getData(response);
	}

	// =========================================================================
	// Collaboration
	// =========================================================================

	/** Share the active session through the configured collaboration relay. */
	async startCollabHosting(relayUrl?: string): Promise<RpcCollabLinks> {
		const response = await this.#send({
			type: "start_collab_hosting",
			...(relayUrl !== undefined ? { relayUrl } : {}),
		});
		return this.#getData(response);
	}

	/** Stop sharing the active session. */
	async stopCollabHosting(): Promise<void> {
		const response = await this.#send({ type: "stop_collab_hosting" });
		this.#getData(response);
	}

	/** Read the collaboration role, links, and participants. */
	async getCollabStatus(): Promise<RpcCollabStatus> {
		const response = await this.#send({ type: "get_collab_status" });
		return this.#getData(response);
	}

	/**
	 * Join a shared session. The host's events arrive through {@link onSessionEvent}
	 * and its dialogs through the extension-UI channel, exactly as for a hosting client.
	 */
	async joinCollabSession(link: string): Promise<RpcCollabStatus> {
		const response = await this.#send({ type: "join_collab_session", link }, 120_000);
		return this.#getData(response);
	}

	/** Leave a guest session, or stop hosting when called by the host. */
	async leaveCollabSession(): Promise<void> {
		const response = await this.#send({ type: "leave_collab_session" });
		this.#getData(response);
	}

	/**
	 * Replace the host-owned custom tools exposed to the RPC session.
	 * Changes take effect before the next model call.
	 */
	async setCustomTools(tools: RpcClientCustomTool[]): Promise<string[]> {
		this.#customTools = [...tools];
		if (!this.#process) {
			return this.#customTools.map(tool => tool.name);
		}
		const definitions: RpcHostToolDefinition[] = this.#customTools.map(tool => ({
			name: tool.name,
			label: tool.label,
			description: tool.description,
			parameters: tool.parameters,
			hidden: tool.hidden,
			loadMode: tool.loadMode,
		}));
		const response = await this.#send({ type: "set_host_tools", tools: definitions });
		return this.#getData<{ toolNames: string[] }>(response).toolNames;
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_end event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve();
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<AgentEvent[]> {
		const { promise, resolve, reject } = Promise.withResolvers<AgentEvent[]>();
		const events: AgentEvent[] = [];
		let settled = false;
		const unsubscribe = this.onEvent(event => {
			events.push(event);
			if (event.type === "agent_end") {
				settled = true;
				unsubscribe();
				clearTimeout(timeoutId);
				resolve(events);
			}
		});

		const timeoutId = this.#startTimeout(timeout, () => {
			if (settled) return;
			settled = true;
			unsubscribe();
			reject(new Error(`Timeout collecting events. Stderr: ${this.#process?.peekStderr() ?? ""}`));
		});
		return promise;
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<AgentEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	#handleLine(data: unknown): void {
		// Check if it's a response to a pending request
		if (isRpcResponse(data)) {
			const id = data.id;
			if (id && this.#pendingRequests.has(id)) {
				const pending = this.#pendingRequests.get(id)!;
				this.#pendingRequests.delete(id);
				pending.resolve(data);
				return;
			}
		}

		if (isRpcHostToolCallRequest(data)) {
			void this.#handleHostToolCall(data);
			return;
		}

		if (isRpcHostUriRequest(data)) {
			void this.#handleHostUriRequest(data);
			return;
		}

		if (isRpcExtensionUiRequest(data)) {
			for (const listener of this.#extensionUiListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcExtensionUiCancelFrame(data)) {
			for (const listener of this.#extensionUiCancelListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcHostToolCancelRequest(data)) {
			this.#pendingHostToolCalls.get(data.targetId)?.controller.abort();
			return;
		}

		if (isRpcHostUriCancelRequest(data)) {
			this.#pendingHostUriRequests.get(data.targetId)?.controller.abort();
			return;
		}

		if (isRpcSubagentLifecycleFrame(data)) {
			for (const listener of this.#subagentLifecycleListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentProgressFrame(data)) {
			for (const listener of this.#subagentProgressListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcSubagentEventFrame(data)) {
			for (const listener of this.#subagentEventListeners) {
				listener(data.payload);
			}
			return;
		}

		if (isRpcAvailableCommandsUpdateFrame(data)) {
			for (const listener of this.#availableCommandsUpdateListeners) {
				listener(data.commands);
			}
			return;
		}

		if (isRpcExecOutputFrame(data)) {
			for (const listener of this.#execOutputListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcBtwOutputFrame(data)) {
			for (const listener of this.#btwOutputListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcIdleRecapFrame(data)) {
			for (const listener of this.#idleRecapListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcSettingsUpdateFrame(data)) {
			for (const listener of this.#settingsUpdateListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcRawSseUpdateFrame(data)) {
			for (const listener of this.#rawSseUpdateListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcMcpAuthChallengeFrame(data)) {
			for (const listener of this.#mcpAuthChallengeListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcVoiceEventFrame(data)) {
			for (const listener of this.#voiceEventListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcTtsrGenerationEventFrame(data)) {
			for (const listener of this.#ttsrGenerationEventListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcProviderRequestObservationFrame(data)) {
			for (const listener of this.#providerRequestObservationListeners) {
				listener(data);
			}
			return;
		}

		if (isRpcPromptResultFrame(data)) {
			for (const listener of this.#promptResultListeners) {
				listener(data);
			}
			return;
		}

		if (!isAgentSessionEvent(data)) return;

		for (const listener of this.#sessionEventListeners) {
			listener(data);
		}

		if (!isAgentEvent(data)) return;

		for (const listener of this.#eventListeners) {
			listener(data);
		}
	}

	#send(command: RpcCommandBody, timeoutMs = 30_000): Promise<RpcResponse> {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}

		const id = `req_${++this.#requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;
		const { promise, resolve, reject } = Promise.withResolvers<RpcResponse>();
		let settled = false;
		const timeoutId = this.#startTimeout(timeoutMs, () => {
			if (settled) return;
			this.#pendingRequests.delete(id);
			settled = true;
			reject(
				new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.#process?.peekStderr() ?? ""}`),
			);
		});

		this.#pendingRequests.set(id, {
			resolve: response => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				resolve(response);
			},
			reject: error => {
				if (settled) return;
				settled = true;
				clearTimeout(timeoutId);
				reject(error);
			},
		});

		this.#writeFrame(fullCommand, err => {
			this.#pendingRequests.delete(id);
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			reject(err);
		});
		return promise;
	}

	async #handleHostToolCall(request: RpcHostToolCallRequest): Promise<void> {
		const tool = this.#customTools.find(candidate => candidate.name === request.toolName);
		if (!tool) {
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: `Host tool "${request.toolName}" is not registered` }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
			return;
		}

		const controller = new AbortController();
		this.#pendingHostToolCalls.set(request.id, { controller });

		const sendUpdate = (partialResult: RpcClientToolResult<unknown>): void => {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_update",
				id: request.id,
				partialResult: normalizeToolResult(partialResult),
			} satisfies RpcHostToolUpdate);
		};

		try {
			const result = await tool.execute(request.arguments, {
				toolCallId: request.toolCallId,
				signal: controller.signal,
				sendUpdate,
			});
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: normalizeToolResult(result),
			} satisfies RpcHostToolResult);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_tool_result",
				id: request.id,
				result: {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: {},
				},
				isError: true,
			} satisfies RpcHostToolResult);
		} finally {
			this.#pendingHostToolCalls.delete(request.id);
		}
	}

	async #handleHostUriRequest(request: RpcHostUriRequest): Promise<void> {
		const handler = this.#hostUriHandler;
		if (!handler) {
			this.#writeFrame({
				type: "host_uri_result",
				id: request.id,
				isError: true,
				error: "No host URI handler is registered",
			} satisfies RpcHostUriResult);
			return;
		}

		const controller = new AbortController();
		this.#pendingHostUriRequests.set(request.id, { controller });
		try {
			const result = await handler(request, { signal: controller.signal });
			if (controller.signal.aborted) return;
			if (request.operation === "write") {
				this.#writeFrame({ type: "host_uri_result", id: request.id } satisfies RpcHostUriResult);
				return;
			}
			if (typeof result === "string") {
				this.#writeFrame({ type: "host_uri_result", id: request.id, content: result } satisfies RpcHostUriResult);
				return;
			}
			if (!isRecord(result) || typeof result.content !== "string") {
				throw new Error("Host URI read handlers must return a string or an object with string content");
			}
			if (
				result.contentType !== undefined &&
				result.contentType !== "text/markdown" &&
				result.contentType !== "application/json" &&
				result.contentType !== "text/plain"
			) {
				throw new Error(`Unsupported host URI content type: ${String(result.contentType)}`);
			}
			if (
				result.notes !== undefined &&
				(!Array.isArray(result.notes) || !result.notes.every(note => typeof note === "string"))
			) {
				throw new Error("Host URI result notes must be an array of strings");
			}
			if (result.immutable !== undefined && typeof result.immutable !== "boolean") {
				throw new Error("Host URI result immutable must be a boolean");
			}
			this.#writeFrame({
				type: "host_uri_result",
				id: request.id,
				content: result.content,
				...(result.contentType === undefined ? {} : { contentType: result.contentType }),
				...(result.notes === undefined ? {} : { notes: result.notes }),
				...(result.immutable === undefined ? {} : { immutable: result.immutable }),
			} satisfies RpcHostUriResult);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.#writeFrame({
				type: "host_uri_result",
				id: request.id,
				isError: true,
				error: error instanceof Error ? error.message : String(error),
			} satisfies RpcHostUriResult);
		} finally {
			this.#pendingHostUriRequests.delete(request.id);
		}
	}

	#writeFrame(
		frame: RpcCommand | RpcExtensionUIResponse | RpcHostToolResult | RpcHostToolUpdate | RpcHostUriResult,
		onError?: (error: Error) => void,
	): void {
		if (!this.#process?.stdin) {
			throw new Error("Client not started");
		}
		const stdin = this.#process.stdin as FileSink;
		stdin.write(`${JSON.stringify(frame)}\n`);
		const flushResult = stdin.flush();
		if (isPromise(flushResult)) {
			flushResult.catch((err: Error) => {
				onError?.(err);
			});
		}
	}

	#getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new RpcCommandError(errorResponse.error, errorResponse.command, errorResponse.code);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}
