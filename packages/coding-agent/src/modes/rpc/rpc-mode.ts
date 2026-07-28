/**
 * RPC mode: Headless operation with JSON stdin/stdout protocol.
 *
 * Used for embedding the agent in other applications.
 * Receives commands as JSON on stdin, outputs events and responses as JSON on stdout.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import { once } from "node:events";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import { configureCredentialRedaction, redactSensitiveInObject } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { isZodSchema, zodToWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { $env, isRecord, logger, readLines, Snowflake } from "@oh-my-pi/pi-utils";
import type { CollabUiRequest, CollabUiResponseValue } from "@oh-my-pi/pi-wire";
import { reset as resetCapabilities } from "../../capability";
import { onSettingChanged } from "../../config/settings";
import { isCredential, SETTINGS_SCHEMA, type SettingPath } from "../../config/settings-schema";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import { SECRET_KEY_PATTERN } from "../../eval/runtime-env";
import {
	type AutocompleteProviderFactory,
	type ExtensionAskDialogQuestion,
	type ExtensionAskDialogResult,
	type ExtensionProviderRequestObservation,
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	type ExtensionUISelectItem,
	type ExtensionWidgetOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import type { Goal } from "../../goals/state";
import type { MCPManager } from "../../mcp/manager";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { SessionTransitionOptions } from "../../session/agent-session-types";
import { HistoryStorage } from "../../session/history-storage";
import { SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import { resolveResumableSession } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { FileSessionStorage } from "../../session/session-storage";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands } from "../../slash-commands/available-commands";
import { discoverTitleSystemPromptFile, resolvePromptInput } from "../../system-prompt";
import { defaultLoadModeForToolName } from "../../tools/essential-tools";
import type { EventBus } from "../../utils/event-bus";
import type { VibeScopeSuspension } from "../../vibe/runtime";
import { buildSessionAutocompleteProvider } from "../completions";
import { loadAllExtensions } from "../components/extensions/state-manager";
import { shouldSkipHistory } from "../controllers/input-controller";
import { initializeExtensions } from "../runtime-init";
import { applySettingEffects } from "../setting-effects";
import {
	getAvailableThemesWithPaths,
	getThemeByName,
	setTheme as setActiveTheme,
	setThemeInstance,
	type Theme,
	theme,
} from "../theme/theme";
import { isRpcHostToolResult, isRpcHostToolUpdate, RpcHostToolBridge } from "./host-tools";
import { isRpcHostUriResult, RpcHostUriBridge } from "./host-uris";
import * as rpcAccounts from "./rpc-accounts";
import * as rpcAgentControl from "./rpc-agent-control";
import * as rpcAuthoring from "./rpc-authoring";
import * as rpcBtw from "./rpc-btw";
import * as rpcCollab from "./rpc-collab";
import * as rpcDiagnostics from "./rpc-diagnostics";
import { buildRpcKeybindings, readRpcPromptHistory } from "./rpc-editor-state";
import { MAX_RPC_FRAME_BYTES, MAX_RPC_REASSEMBLED_BYTES, RpcFrameEncoder } from "./rpc-frame";
import * as rpcIdle from "./rpc-idle";
import { claimRpcInput } from "./rpc-input";
import * as rpcMcp from "./rpc-mcp";
import { pageRpcMessages, RPC_MESSAGES_PAGE_BUSY_ERROR, RpcMessagesPageError } from "./rpc-messages";
import * as rpcModelRoles from "./rpc-model-roles";
import * as rpcRuntimeControl from "./rpc-runtime-control";
import { getRpcSessionTransitionGuestBlock } from "./rpc-session-guard";
import { buildRpcSessionView } from "./rpc-session-view";
import { buildRpcSettingsSnapshot, validateRpcSettingValue } from "./rpc-settings";
import { RpcSubagentRegistry, readRpcSubagentTranscript } from "./rpc-subagents";
import { buildRpcThemeSnapshot } from "./rpc-theme";
import type {
	RpcCommand,
	RpcExtensionUICancelFrame,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcHostToolCallRequest,
	RpcHostToolCancelRequest,
	RpcHostToolDefinition,
	RpcHostToolResult,
	RpcHostToolUpdate,
	RpcHostUriCancelRequest,
	RpcHostUriRequest,
	RpcHostUriResult,
	RpcJsonValue,
	RpcPlanDecisionResult,
	RpcPlanModeSnapshot,
	RpcProviderRequestObservationFrame,
	RpcResponse,
	RpcSessionState,
	RpcSubagentSubscriptionLevel,
	RpcWorkModeSnapshot,
} from "./rpc-types";
import * as rpcVoice from "./rpc-voice";
import * as rpcWorkModes from "./rpc-work-modes";
import { buildRpcRepoStatus, readRpcUsageReports } from "./rpc-workspace";

// Re-export types for consumers
export type * from "./rpc-types";
export { getRpcSessionTransitionGuestBlock };

export type PendingExtensionRequest = {
	resolve: (response: RpcExtensionUIResponse) => void;
	reject: (error: Error) => void;
};

/** Pending extension UI request map that can fail closed when the RPC client disconnects. */
export class RpcPendingExtensionRequests extends Map<string, PendingExtensionRequest> {
	#closedError: Error | undefined;

	override set(id: string, request: PendingExtensionRequest): this {
		if (this.#closedError) {
			request.reject(this.#closedError);
			return this;
		}
		return super.set(id, request);
	}

	/** Reject every active and future extension UI request. */
	rejectAll(message: string): void {
		if (!this.#closedError) this.#closedError = new Error(message);
		const requests = Array.from(this.values());
		this.clear();
		for (const request of requests) {
			request.reject(this.#closedError);
		}
	}
}

type RpcOutput = (
	obj:
		| RpcResponse
		| RpcExtensionUIRequest
		| RpcExtensionUICancelFrame
		| RpcHostToolCallRequest
		| RpcHostToolCancelRequest
		| RpcHostUriRequest
		| RpcHostUriCancelRequest
		| object,
) => void;

export type RpcSessionChangeCommand = Extract<
	RpcCommand,
	{ type: "new_session" } | { type: "switch_session" } | { type: "branch" } | { type: "fork" }
>;

export type RpcSessionChangeResult =
	| { type: "new_session"; data: { cancelled: boolean } }
	| { type: "switch_session"; data: { cancelled: boolean } }
	| { type: "branch"; data: { text: string; cancelled: boolean } }
	| { type: "fork"; data: { cancelled: boolean } };

export type RpcSessionChangeSession = Pick<AgentSession, "newSession" | "switchSession" | "branch" | "fork">;

/** What a session-change transition reports back to the RPC reconciliation cycle. */
export interface RpcSessionTransitionOutcome<T> {
	result: T;
	/** True once the runtime owns the incoming session, false for a cancelled transition. */
	committed: boolean;
	/** True when the incoming session may adopt the plan-on-startup default. */
	honorPlanDefault: boolean;
}

/**
 * Runs a cancellable session change surrounded by one RPC reconciliation cycle.
 *
 * `prepare` runs at the transition's commit point, while the outgoing session is
 * still live, and MUST stay reversible: it may only release runtime state that
 * `reconcile` can rebuild from whichever session ends up current. Teardown that
 * cannot be undone belongs in `reconcile`, which learns whether the transition
 * committed — a hook that cancels the change never reaches `prepare` at all.
 *
 * `reconcile` also runs when `prepare` itself fails, so it owns re-establishing
 * the runtime behaviors `prepare` may have already released.
 */
export async function runRpcSessionTransitionAtCommit<T>(
	transition: (options: SessionTransitionOptions) => Promise<RpcSessionTransitionOutcome<T>>,
	prepare: () => Promise<void>,
	reconcile: (outcome: { committed: boolean; honorPlanDefault: boolean }) => Promise<void>,
	honorPlanDefaultOnCommit = false,
): Promise<T> {
	let prepared = false;
	const beforeCommit = async (): Promise<void> => {
		if (prepared) return;
		prepared = true;
		await prepare();
	};
	let committed = false;
	let honorPlanDefault = false;
	const onCommitted = (): void => {
		committed = true;
		honorPlanDefault = honorPlanDefaultOnCommit;
	};
	try {
		const outcome = await transition({ beforeCommit, onCommitted });
		committed ||= outcome.committed;
		honorPlanDefault ||= outcome.honorPlanDefault;
		return outcome.result;
	} finally {
		if (prepared) await reconcile({ committed, honorPlanDefault });
	}
}

export type RpcSkillCommandSession = Pick<AgentSession, "promptCustomMessage" | "skills" | "skillsSettings">;
export type RpcSkillCommandResult = { agentInvoked: true };

export async function tryRunRpcSkillCommand(
	session: RpcSkillCommandSession,
	text: string,
	streamingBehavior: "steer" | "followUp" = "steer",
): Promise<RpcSkillCommandResult | false> {
	if (!session.skillsSettings?.enableSkillCommands) return false;
	const parsed = parseSkillInvocation(text);
	if (!parsed) return false;
	const skill = session.skills.find(candidate => candidate.name === parsed.name);
	if (!skill) return false;
	const built = await buildSkillPromptMessage(skill, parsed.args, "user");
	await session.promptCustomMessage(
		{
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: built.message,
			display: true,
			details: built.details,
			attribution: "user",
		},
		{ streamingBehavior },
	);
	return { agentInvoked: true };
}

export function reportLocalOnlyPromptResult(input: {
	id: string | undefined;
	prompt: Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	hasExtensionAgentMessageTask?: () => boolean;
	waitForExtensionAgentMessageTasks?: () => Promise<void>;
}): void {
	void input.prompt
		.then(async agentInvoked => {
			await input.waitForExtensionAgentMessageTasks?.();
			input.output({
				type: "prompt_result",
				id: input.id,
				agentInvoked: agentInvoked || (input.hasExtensionAgentMessageTask?.() ?? false),
			});
		})
		.catch(error => {
			input.onError(error instanceof Error ? error : new Error(String(error)));
		});
}

type RpcExtensionUserMessageScope = {
	hasAgentMessageTask: boolean;
	pendingAgentMessageTasks: Set<Promise<void>>;
};

/**
 * Tracks extension-originated messages while an RPC prompt is executing.
 * A slash command can resolve the outer prompt as local-only while also
 * scheduling agent work through pi.sendUserMessage() or pi.sendMessage()
 * with triggerTurn; the terminal result must include that nested agent work.
 */
export class RpcExtensionUserMessageTracker {
	#activePromptScopes = new Set<RpcExtensionUserMessageScope>();

	markAgentMessageTask(): void {
		for (const scope of this.#activePromptScopes) {
			scope.hasAgentMessageTask = true;
		}
	}

	trackAgentMessageTask(task: Promise<unknown>): void {
		for (const scope of this.#activePromptScopes) {
			this.#trackAgentMessageTaskForScope(scope, task);
		}
	}

	#trackAgentMessageTaskForScope(scope: RpcExtensionUserMessageScope, task: Promise<unknown>): void {
		const scopedTask = task.then(
			() => {
				scope.hasAgentMessageTask = true;
			},
			() => {},
		);
		scope.pendingAgentMessageTasks.add(scopedTask);
		void scopedTask.finally(() => {
			scope.pendingAgentMessageTasks.delete(scopedTask);
		});
	}

	async #waitForAgentMessageTasks(scope: RpcExtensionUserMessageScope): Promise<void> {
		while (scope.pendingAgentMessageTasks.size > 0) {
			await Promise.allSettled(Array.from(scope.pendingAgentMessageTasks));
		}
	}

	watchPrompt<T>(startPrompt: () => Promise<T>): {
		prompt: Promise<T>;
		hasAgentMessageTask: () => boolean;
		waitForAgentMessageTasks: () => Promise<void>;
	} {
		const scope: RpcExtensionUserMessageScope = {
			hasAgentMessageTask: false,
			pendingAgentMessageTasks: new Set(),
		};
		this.#activePromptScopes.add(scope);
		let prompt: Promise<T>;
		try {
			prompt = startPrompt();
		} catch (error) {
			this.#activePromptScopes.delete(scope);
			throw error;
		}
		return {
			prompt: prompt.finally(() => {
				this.#activePromptScopes.delete(scope);
			}),
			hasAgentMessageTask: () => scope.hasAgentMessageTask,
			waitForAgentMessageTasks: () => this.#waitForAgentMessageTasks(scope),
		};
	}
}

export function watchAndReportLocalOnlyPromptResult(input: {
	id: string | undefined;
	startPrompt: () => Promise<boolean>;
	output: (obj: object) => void;
	onError: (error: Error) => void;
	extensionUserMessageTracker: RpcExtensionUserMessageTracker;
}): void {
	const trackedPrompt = input.extensionUserMessageTracker.watchPrompt(input.startPrompt);
	reportLocalOnlyPromptResult({
		id: input.id,
		prompt: trackedPrompt.prompt,
		output: input.output,
		onError: input.onError,
		hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
	});
}

/**
 * Dependencies for {@link dispatchRpcInputFrame}. Provided by the RPC mode
 * entrypoint; broken out so tests can drive the input loop with stubs.
 */
export interface RpcInputFrameDeps {
	handleCommand: (command: RpcCommand) => Promise<RpcResponse>;
	output: RpcOutput;
	errorResponse: (id: string | undefined, command: string, message: string) => RpcResponse;
	trackBackgroundTask?: (task: Promise<void>) => void;
	pendingExtensionRequests: Map<string, PendingExtensionRequest>;
	onHostToolResult: (frame: RpcHostToolResult) => void;
	onHostToolUpdate: (frame: RpcHostToolUpdate) => void;
	onHostUriResult: (frame: RpcHostUriResult) => void;
}

/**
 * Structural guard for a well-formed extension UI response frame. Mirrors the
 * shape declared in {@link RpcExtensionUIResponse} — a truthy record with
 * `type === "extension_ui_response"` and a string `id`. Payload variants (value,
 * confirmed, cancelled) are validated at the read site.
 */
function isRpcExtensionUIResponse(value: unknown): value is RpcExtensionUIResponse {
	if (!isRecord(value)) return false;
	return value.type === "extension_ui_response" && typeof value.id === "string";
}

/** Dispatch side-channel frames that must overtake the serialized command queue. */
export function dispatchRpcControlFrame(parsed: unknown, deps: RpcInputFrameDeps): boolean {
	if (isRpcExtensionUIResponse(parsed)) {
		const pending = deps.pendingExtensionRequests.get(parsed.id);
		if (pending) pending.resolve(parsed);
		return true;
	}

	if (isRpcHostToolResult(parsed)) {
		deps.onHostToolResult(parsed);
		return true;
	}

	if (isRpcHostToolUpdate(parsed)) {
		deps.onHostToolUpdate(parsed);
		return true;
	}

	if (isRpcHostUriResult(parsed)) {
		deps.onHostUriResult(parsed);
		return true;
	}

	return false;
}

const BACKGROUND_RPC_COMMAND_TYPES: Partial<Record<RpcCommand["type"], true>> = {
	bash: true,
	python: true,
	start_live: true,
	start_stt: true,
	toggle_stt: true,
	start_collab_hosting: true,
	join_collab_session: true,
	ask_btw: true,
	compact: true,
	retry: true,
	handoff: true,
	approve_plan_proposal: true,
	reject_plan_proposal: true,
	begin_guided_goal: true,
	prompt_agent: true,
	generate_ttsr_rule: true,
	mcp_add_server: true,
	mcp_set_server_enabled: true,
	mcp_reload: true,
	mcp_reconnect_server: true,
	mcp_unauth_server: true,
	mcp_begin_reauth: true,
	mcp_complete_reauth: true,
	mcp_begin_smithery_login: true,
	mcp_complete_smithery_login: true,
	mcp_search_registry: true,
	mcp_deploy_registry_result: true,
};

/**
 * Dispatch a single parsed frame from the RPC input stream.
 *
 * Commands that await cancellable work are dispatched in the background so
 * the stdin reader can route their dedicated canceller through the serial
 * queue while work is still running. Response correlation is preserved via
 * each command's `id`; ordering across concurrent commands is not guaranteed
 * and clients MUST match on `id`.
 *
 * @returns `undefined` when the frame was routed to a side-channel handler
 *   (extension UI response, host tool/URI frames) or background-dispatched.
 *   Otherwise a promise that resolves once the response for the command has
 *   been emitted via `output`. Errors from `handleCommand` on serial commands
 *   propagate; the caller is expected to wrap them.
 */
export function dispatchRpcInputFrame(parsed: unknown, deps: RpcInputFrameDeps): Promise<void> | undefined {
	if (dispatchRpcControlFrame(parsed, deps)) return undefined;
	// Regular RPC command. The transport contract states each remaining frame
	// is an {@link RpcCommand}; handleCommand's exhaustive fallback reports
	// unknown discriminants at runtime, so we do not shape-check the union here.
	const command = parsed as RpcCommand;

	// Only work with an explicit cancellation path bypasses the serial queue.
	// Clients correlate concurrent responses via `command.id`.
	if (BACKGROUND_RPC_COMMAND_TYPES[command.type] === true) {
		const task = (async () => {
			try {
				deps.output(await deps.handleCommand(command));
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				deps.output(deps.errorResponse(command.id, command.type, message));
			}
		})();
		deps.trackBackgroundTask?.(task);
		return undefined;
	}

	return (async () => {
		deps.output(await deps.handleCommand(command));
	})();
}

/** Serializes ordered commands while allowing cancellable work and control frames to overtake the queue. */
export class RpcInputDispatcher {
	#tail: Promise<void> = Promise.resolve();
	#tasks = new Set<Promise<void>>();
	readonly #deps: RpcInputFrameDeps;
	readonly #afterSerialCommand: (() => Promise<void>) | undefined;

	constructor(options: { deps: RpcInputFrameDeps; afterSerialCommand?: () => Promise<void> }) {
		this.#deps = options.deps;
		this.#afterSerialCommand = options.afterSerialCommand;
	}

	/** Accept a parsed input frame without blocking the stdin reader. */
	dispatch(parsed: unknown): void {
		try {
			if (dispatchRpcControlFrame(parsed, this.#deps)) return;

			const command = parsed as RpcCommand;
			if (BACKGROUND_RPC_COMMAND_TYPES[command.type] === true) {
				dispatchRpcInputFrame(command, this.#deps);
				return;
			}

			const task = this.#tail.then(
				() => this.#dispatchSerialCommand(command),
				() => this.#dispatchSerialCommand(command),
			);
			this.#tail = task.catch(() => {});
			this.#tasks.add(task);
			void task.finally(() => {
				this.#tasks.delete(task);
			});
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			const id = isRecord(parsed) && typeof parsed.id === "string" ? parsed.id : undefined;
			this.#deps.output(this.#deps.errorResponse(id, "parse", `Failed to parse command: ${message}`));
		}
	}

	/** Await every accepted serial command, including commands queued before EOF. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	async #dispatchSerialCommand(command: RpcCommand): Promise<void> {
		try {
			const awaited = dispatchRpcInputFrame(command, this.#deps);
			if (awaited) await awaited;
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : String(err);
			this.#deps.output(this.#deps.errorResponse(command.id, command.type, message));
		} finally {
			await this.#afterSerialCommand?.();
		}
	}
}

/**
 * Coordinates deferred shutdown with in-flight background input tasks.
 *
 * `pi.shutdown()` from an extension only *requests* shutdown; the process must
 * not exit while any background-dispatched command still owes the client a
 * response frame. The coordinator tracks those tasks, re-checks the shutdown
 * request whenever one settles, and drains every tracked task before invoking
 * `performShutdown`.
 * The shutdown sequence is latched so concurrent triggers (input loop and
 * settling tasks) run it exactly once.
 */
export class RpcShutdownCoordinator {
	#tasks = new Set<Promise<void>>();
	#shutdown: Promise<void> | undefined;
	readonly #isShutdownRequested: () => boolean;
	readonly #performShutdown: () => Promise<void>;

	constructor(options: { isShutdownRequested: () => boolean; performShutdown: () => Promise<void> }) {
		this.#isShutdownRequested = options.isShutdownRequested;
		this.#performShutdown = options.performShutdown;
	}

	/**
	 * Track a background input task. When it settles it is untracked and the
	 * shutdown request is re-checked, so a deferred shutdown fires even when
	 * no further client frames arrive.
	 */
	track(task: Promise<void>): void {
		this.#tasks.add(task);
		void task.finally(() => {
			this.#tasks.delete(task);
			// Fire-and-forget: performShutdown ends the process. Rejections are
			// not expected — hook errors are caught inside extensionRunner.emit,
			// and background tasks catch their own dispatch errors.
			void this.checkShutdownRequested();
		});
	}

	/** Await every tracked task, including tasks tracked while draining. */
	async drain(): Promise<void> {
		while (this.#tasks.size > 0) {
			await Promise.allSettled(Array.from(this.#tasks));
		}
	}

	/**
	 * If shutdown was requested, drain background tasks (so every owed
	 * response frame is written) before running the shutdown sequence.
	 */
	checkShutdownRequested(): Promise<void> {
		if (!this.#shutdown) {
			if (!this.#isShutdownRequested()) return Promise.resolve();
			this.#shutdown = this.drain().then(() => this.#performShutdown());
		}
		return this.#shutdown;
	}
}

export type RpcSubagentResetRegistry = Pick<RpcSubagentRegistry, "clear">;

export async function handleRpcSessionChange(
	session: RpcSessionChangeSession,
	command: RpcSessionChangeCommand,
	subagentRegistry?: RpcSubagentResetRegistry,
	transitionOptions?: SessionTransitionOptions,
): Promise<RpcSessionChangeResult> {
	switch (command.type) {
		case "new_session": {
			const options = command.parentSession
				? { parentSession: command.parentSession, ...transitionOptions }
				: transitionOptions;
			const cancelled = !(await session.newSession(options));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "new_session", data: { cancelled } };
		}

		case "switch_session": {
			const cancelled = !(await session.switchSession(command.sessionPath, transitionOptions));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "switch_session", data: { cancelled } };
		}

		case "branch": {
			const result = await session.branch(command.entryId, transitionOptions);
			if (!result.cancelled) subagentRegistry?.clear();
			return { type: "branch", data: { text: result.selectedText, cancelled: result.cancelled } };
		}

		case "fork": {
			const cancelled = !(await session.fork(transitionOptions));
			if (!cancelled) subagentRegistry?.clear();
			return { type: "fork", data: { cancelled } };
		}
	}
	throw new Error("Unsupported RPC session change command");
}

function readRpcPersistedGoal(modeData: unknown): Goal | undefined {
	if (!isRecord(modeData) || !isRecord(modeData.goal)) return undefined;
	const value = modeData.goal;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status as Goal["status"],
		tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

function normalizeHostToolDefinitions(tools: RpcHostToolDefinition[]): RpcHostToolDefinition[] {
	return tools.map((tool, index) => {
		const name = typeof tool.name === "string" ? tool.name.trim() : "";
		if (!name) {
			throw new Error(`Host tool at index ${index} must provide a non-empty name`);
		}
		const description = typeof tool.description === "string" ? tool.description.trim() : "";
		if (!description) {
			throw new Error(`Host tool "${name}" must provide a non-empty description`);
		}
		if (!tool.parameters || typeof tool.parameters !== "object" || Array.isArray(tool.parameters)) {
			throw new Error(`Host tool "${name}" must provide a JSON Schema object`);
		}
		const label = typeof tool.label === "string" && tool.label.trim() ? tool.label.trim() : name;
		return {
			name,
			label,
			description,
			parameters: tool.parameters,
			hidden: tool.hidden === true,
			loadMode: defaultLoadModeForToolName(name, tool.loadMode),
		};
	});
}

function parseValueDialogResponse(response: RpcExtensionUIResponse): string | undefined {
	if ("value" in response) return response.value;
	return undefined;
}

function shouldEmitRpcTitles(): boolean {
	const raw = $env.PI_RPC_EMIT_TITLE;
	if (!raw) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function isSubagentSubscriptionLevel(value: unknown): value is RpcSubagentSubscriptionLevel {
	return value === "off" || value === "progress" || value === "events";
}

const RPC_REDACTED_CREDENTIAL = "[credential_redacted]";
const RPC_URL_REDACTION_ORIGIN = "https://rpc-redaction.invalid";
const RPC_SECRET_FIELD_NAMES: Record<string, true> = {
	authorization: true,
	"proxy-authorization": true,
	cookie: true,
	"set-cookie": true,
	sig: true,
	signature: true,
};

function isRpcSecretFieldName(name: string): boolean {
	return SECRET_KEY_PATTERN.test(name) || RPC_SECRET_FIELD_NAMES[name.toLowerCase()] === true;
}

export function redactRpcUrlSecrets(value: string): string {
	const shape = URL.canParse(value)
		? "absolute"
		: value.startsWith("//")
			? "scheme-relative"
			: value.startsWith("?")
				? "query"
				: value.startsWith("/") || value.startsWith("./") || value.startsWith("../")
					? "path"
					: !/\s/.test(value) && URL.canParse(value, RPC_URL_REDACTION_ORIGIN)
						? "rootless"
						: undefined;
	if (!shape) return value;

	let parsed: URL;
	try {
		parsed = new URL(value, RPC_URL_REDACTION_ORIGIN);
	} catch {
		return value;
	}

	let changed = false;
	if (parsed.username) {
		parsed.username = RPC_REDACTED_CREDENTIAL;
		changed = true;
	}
	if (parsed.password) {
		parsed.password = RPC_REDACTED_CREDENTIAL;
		changed = true;
	}

	const query = [...parsed.searchParams.entries()];
	if (query.some(([name]) => isRpcSecretFieldName(name))) {
		parsed.search = "";
		for (const [name, nested] of query) {
			parsed.searchParams.append(name, isRpcSecretFieldName(name) ? RPC_REDACTED_CREDENTIAL : nested);
		}
		changed = true;
	}
	if (!changed) return value;

	const serialized =
		shape === "absolute"
			? parsed.toString()
			: shape === "scheme-relative"
				? parsed.href.slice(parsed.protocol.length)
				: shape === "query"
					? `${parsed.search}${parsed.hash}`
					: shape === "rootless"
						? `${parsed.pathname.slice(1)}${parsed.search}${parsed.hash}`
						: `${parsed.pathname}${parsed.search}${parsed.hash}`;
	return serialized.replaceAll(encodeURIComponent(RPC_REDACTED_CREDENTIAL), RPC_REDACTED_CREDENTIAL);
}

/**
 * Provider observations cross a process boundary, so apply every existing
 * credential scrubber plus exact masking for credential settings and headers.
 */
function redactRpcProviderValue(session: AgentSession, value: RpcJsonValue): RpcJsonValue {
	const restoreCredentialRedaction = session.settings.get("secrets.enabled");
	let redacted: RpcJsonValue;
	configureCredentialRedaction(true);
	try {
		redacted = redactSensitiveInObject(value).result as RpcJsonValue;
	} finally {
		configureCredentialRedaction(restoreCredentialRedaction);
	}

	const configuredCredentials: string[] = [];
	for (const candidate of Object.keys(SETTINGS_SCHEMA)) {
		const settingPath = candidate as SettingPath;
		if (!isCredential(settingPath)) continue;
		const settingValue: unknown = session.settings.get(settingPath);
		if (typeof settingValue === "string" && settingValue.length > 0) configuredCredentials.push(settingValue);
	}
	const obfuscator = session.obfuscator;

	const visit = (candidate: RpcJsonValue): RpcJsonValue => {
		if (typeof candidate === "string") {
			let text = redactRpcUrlSecrets(candidate);
			for (const credential of configuredCredentials) {
				text = text.replaceAll(credential, RPC_REDACTED_CREDENTIAL);
			}
			return obfuscator?.hasSecrets() ? obfuscator.obfuscate(text) : text;
		}
		if (Array.isArray(candidate)) return candidate.map(visit);
		if (candidate === null || typeof candidate !== "object") return candidate;
		const result: { [key: string]: RpcJsonValue } = {};
		for (const [key, nested] of Object.entries(candidate)) {
			result[key] = isRpcSecretFieldName(key) ? RPC_REDACTED_CREDENTIAL : visit(nested);
		}
		return result;
	};
	return visit(redacted);
}

function buildRpcProviderObservationFrame(
	session: AgentSession,
	observation: ExtensionProviderRequestObservation,
): RpcProviderRequestObservationFrame {
	if (observation.type === "context") {
		return {
			type: "provider_request_observation",
			stage: "context",
			requestId: observation.requestId,
			messages: redactRpcProviderValue(session, observation.messages),
			...(observation.serializationError ? { serializationError: observation.serializationError } : {}),
		};
	}
	return {
		type: "provider_request_observation",
		stage: "before_provider_request",
		requestId: observation.requestId,
		payload: redactRpcProviderValue(session, observation.payload),
		...(observation.serializationError ? { serializationError: observation.serializationError } : {}),
	};
}

export function requestRpcEditor(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	title: string,
	prefill?: string,
	dialogOptions?: ExtensionUIDialogOptions,
	editorOptions?: { promptStyle?: boolean },
): Promise<string | undefined> {
	return requestRpcDialog(
		pendingRequests,
		output,
		dialogOptions,
		undefined,
		{
			method: "editor",
			title,
			prefill,
			promptStyle: editorOptions?.promptStyle,
			timeout: dialogOptions?.timeout,
		},
		parseValueDialogResponse,
	);
}

/** Sends an RPC extension dialog and cancels the remote presentation on abort or timeout. */
export function requestRpcDialog<T>(
	pendingRequests: Map<string, PendingExtensionRequest>,
	output: RpcOutput,
	opts: ExtensionUIDialogOptions | undefined,
	defaultValue: T,
	request: Record<string, unknown>,
	parseResponse: (response: RpcExtensionUIResponse) => T,
): Promise<T> {
	if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

	const id = Snowflake.next() as string;
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	let timeoutNotified = false;
	let timeoutId: NodeJS.Timeout | undefined;

	const cleanup = () => {
		clearTimeout(timeoutId);
		opts?.signal?.removeEventListener("abort", onAbort);
		pendingRequests.delete(id);
	};
	const finish = (value: T) => {
		if (settled) return;
		settled = true;
		cleanup();
		resolve(value);
	};
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		cleanup();
		reject(error);
	};
	const notifyTimeout = () => {
		if (timeoutNotified) return;
		timeoutNotified = true;
		opts?.onTimeout?.();
	};
	const cancel = (timedOut: boolean) => {
		if (settled) return;
		try {
			output({
				type: "extension_ui_cancel",
				targetId: id,
				...(timedOut ? { timedOut: true } : {}),
			} satisfies RpcExtensionUICancelFrame);
		} finally {
			finish(defaultValue);
			if (timedOut) notifyTimeout();
		}
	};
	const onAbort = () => cancel(false);

	opts?.signal?.addEventListener("abort", onAbort, { once: true });
	if (opts?.timeout !== undefined) {
		timeoutId = setTimeout(() => cancel(true), opts.timeout);
	}

	pendingRequests.set(id, {
		resolve: response => {
			if (settled) return;
			if ("cancelled" in response && response.cancelled) {
				finish(defaultValue);
				if (response.timedOut) notifyTimeout();
				return;
			}
			try {
				finish(parseResponse(response));
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		},
		reject: fail,
	});
	if (!settled) output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
	return promise;
}
/**
 * Run in RPC mode.
 * Listens for JSON commands on stdin, outputs events and responses on stdout.
 */
export async function runRpcMode(
	session: AgentSession,
	setToolUIContext?: (uiContext: ExtensionUIContext, hasUI: boolean) => void,
	eventBus?: EventBus,
	input: ReadableStream<Uint8Array> = claimRpcInput(),
	mcpManager?: MCPManager,
): Promise<never> {
	// Signal to RPC clients that the server is ready to accept commands
	// Suppress terminal notifications: they write \x07 (BEL) or OSC sequences directly to
	// process.stdout with no newline, which the reader merges with the next JSON line and
	// breaks JSON.parse. In RPC mode stdout is the JSON protocol channel — nothing else
	// may write there.
	process.env.PI_NOTIFICATIONS = "off";

	const frameEncoder = new RpcFrameEncoder();
	// Ordered stdout writer honoring backpressure: chunked v2 frames are produced
	// lazily by the encoder and written one physical line at a time, so a near-limit
	// logical frame never materializes its full base64 transport in memory.
	let stdoutQueue: Promise<void> = Promise.resolve();
	const writeFrames = (frames: Iterable<string>) => {
		stdoutQueue = stdoutQueue
			.then(async () => {
				for (const line of frames) {
					if (!process.stdout.write(line)) await once(process.stdout, "drain");
				}
			})
			// stdout gone (host exited) — nothing left to deliver; keep the queue alive.
			.catch(() => {});
	};
	writeFrames(
		frameEncoder.encodeFrames({
			type: "ready",
			protocolVersion: 1,
			supportedProtocolVersions: [1, 2],
			maxFrameBytes: MAX_RPC_FRAME_BYTES,
			maxReassembledFrameBytes: MAX_RPC_REASSEMBLED_BYTES,
		}),
	);
	const output = (obj: RpcResponse | RpcExtensionUIRequest | object) => {
		writeFrames(frameEncoder.encodeFrames(obj));
		if (isRecord(obj) && obj.type === "response" && obj.command === "negotiate_protocol" && obj.success === true)
			frameEncoder.setProtocolVersion(2);
	};
	const emitRpcTitles = shouldEmitRpcTitles();

	const success = <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		data?: object | null,
	): RpcResponse => {
		if (data === undefined) {
			return { id, type: "response", command, success: true } as RpcResponse;
		}
		return { id, type: "response", command, success: true, data } as RpcResponse;
	};

	const error = (id: string | undefined, command: string, message: string, code?: string): RpcResponse => {
		return { id, type: "response", command, success: false, error: message, ...(code ? { code } : {}) };
	};
	const moduleErrorCode = (command: RpcCommand["type"], message: string): string => {
		if (message.startsWith("Unknown controllable agent:")) return "unknown_agent";
		if (
			(command === "revive_agent" || command === "kill_agent" || command === "prompt_agent") &&
			(message.includes("only parked agents") ||
				message.includes("only running agents") ||
				message.includes("revive it before sending"))
		) {
			return "invalid_agent_state";
		}
		if (message.includes("already exists")) return "already_exists";
		if (message.includes("not an OMFG-authored rule")) return "not_writable";
		if (
			message.includes("is disabled") ||
			message.includes("are disabled") ||
			message.includes("backend is not active") ||
			message.includes("TTSR is not active")
		) {
			return "capability_unavailable";
		}
		if (
			message.startsWith("Exit ") ||
			message.includes("current goal before starting") ||
			message.includes("Resume or clear the current goal")
		) {
			return "mode_conflict";
		}
		if (
			message.startsWith("No active") ||
			message.startsWith("No paused") ||
			message.startsWith("No plan proposal") ||
			message.includes("is not active") ||
			message.includes("is not awaiting") ||
			message.includes("is not ready for review") ||
			message.includes("already complete")
		) {
			return "invalid_state";
		}
		if (
			message.includes("required") ||
			message.includes("must not be empty") ||
			message.includes("must be a positive integer") ||
			message.startsWith("Invalid agent name:") ||
			message.includes("does not match")
		) {
			return "invalid_request";
		}
		if (command === "build_ttsr_rule" || command === "register_ttsr_rule") return "invalid_rule";
		if (command === "set_agent_definition") return "invalid_agent_definition";
		return "operation_failed";
	};

	const moduleCommand = async <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		operation: () => Promise<object | null>,
	): Promise<RpcResponse> => {
		try {
			return success(id, command, await operation());
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return error(id, command, message, moduleErrorCode(command, message));
		}
	};
	const mcpManagerCommand = async <T extends RpcCommand["type"]>(
		id: string | undefined,
		command: T,
		operation: (manager: MCPManager) => Promise<object | null>,
	): Promise<RpcResponse> => {
		if (!mcpManager) {
			return error(id, command, "MCP manager is unavailable in this RPC session", "mcp_unavailable");
		}
		return moduleCommand(id, command, () => operation(mcpManager));
	};

	const extensionUserMessageTracker = new RpcExtensionUserMessageTracker();

	const pendingExtensionRequests = new RpcPendingExtensionRequests();
	const hostToolBridge = new RpcHostToolBridge(output);
	const hostUriBridge = new RpcHostUriBridge(output);
	const subagentRegistry = eventBus ? new RpcSubagentRegistry(eventBus, output) : undefined;

	// Mid-flight MCP re-authentication. Without an installed handler the manager
	// only logs and the tool call fails outright, so an RPC client could never
	// recover a server whose token expired during a call. The handler blocks the
	// call until the client answers `resolve_mcp_auth_challenge`.
	const mcpAuthController = rpcDiagnostics.buildRpcMcpAuthHandler(challenge => {
		output({ type: "mcp_auth_challenge", challenge });
	});
	mcpManager?.setAuthHandler(mcpAuthController.handler);

	// Raw SSE snapshots are only forwarded between subscribe/unsubscribe so an
	// idle client is not billed for every provider event.
	let unsubscribeRawSse: (() => void) | undefined;
	// Provider inputs are large and sensitive; no runner observer exists until a
	// client explicitly subscribes.
	let unsubscribeProviderRequestObservations: (() => void) | undefined;

	const emitVoiceEvent: rpcVoice.RpcVoiceEventSink = event => {
		output({ type: "voice_event", event });
	};

	// A live microphone or audio stream must not outlive the process; both
	// teardown paths release it before the session is disposed.
	const releaseVoice = async (): Promise<void> => {
		try {
			await rpcVoice.disposeRpcVoice(session);
		} catch (voiceError) {
			logger.error("RPC voice teardown failed", { error: String(voiceError) });
		}
	};

	const emitIdleRecap: rpcIdle.RpcIdleRecapSink = recap => {
		output({ type: "idle_recap", recap });
	};
	let disposeRuntimeControl = rpcRuntimeControl.installRpcRuntimeControl(session);
	let idleBehavior = rpcIdle.installRpcIdleBehavior(session, eventBus, emitIdleRecap);

	/** Releases the runtime-control and idle handles the current session owns. */
	const disposeRpcRuntimeBehaviors = (): void => {
		disposeRuntimeControl();
		idleBehavior.dispose();
	};

	/**
	 * Rebinds both runtime behaviors to the current session. Releasing first keeps
	 * exactly one idle handle alive: unlike runtime control, idle behavior is not
	 * idempotent, and a teardown that failed halfway may still hold a live handle.
	 */
	const installRpcRuntimeBehaviors = (): void => {
		disposeRpcRuntimeBehaviors();
		disposeRuntimeControl = rpcRuntimeControl.installRpcRuntimeControl(session);
		idleBehavior = rpcIdle.installRpcIdleBehavior(session, eventBus, emitIdleRecap);
	};

	// Shutdown request flag (wrapped in object to allow mutation with const)
	const shutdownState = { requested: false };

	let publishedEditorText = "";
	const autocompleteProviderFactories: AutocompleteProviderFactory[] = [];
	const buildRpcAutocompleteProvider = () => {
		let provider = buildSessionAutocompleteProvider(session);
		for (const factory of autocompleteProviderFactories) {
			try {
				const wrapped = factory(provider);
				if (
					wrapped &&
					typeof wrapped.getSuggestions === "function" &&
					typeof wrapped.applyCompletion === "function"
				) {
					provider = wrapped;
				} else {
					logger.warn("Extension autocomplete provider factory returned an invalid provider; skipping it");
				}
			} catch (factoryError) {
				logger.warn("Extension autocomplete provider factory threw; skipping it", {
					error: String(factoryError),
				});
			}
		}
		return provider;
	};

	/**
	 * Extension UI context that uses the RPC protocol.
	 */
	class RpcExtensionUIContext implements ExtensionUIContext {
		constructor(
			private pendingRequests: Map<string, PendingExtensionRequest>,
			private output: RpcOutput,
		) {}

		select(
			title: string,
			options: ExtensionUISelectItem[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{
					method: "select",
					title,
					options: options.map(getExtensionUISelectOptionLabel),
					timeout: dialogOptions?.timeout,
				},
				parseValueDialogResponse,
			);
		}

		confirm(title: string, message: string, dialogOptions?: ExtensionUIDialogOptions): Promise<boolean> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				false,
				{ method: "confirm", title, message, timeout: dialogOptions?.timeout },
				response => ("confirmed" in response ? response.confirmed : false),
			);
		}

		input(
			title: string,
			placeholder?: string,
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<string | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{ method: "input", title, placeholder, timeout: dialogOptions?.timeout },
				parseValueDialogResponse,
			);
		}

		askDialog(
			questions: ExtensionAskDialogQuestion[],
			dialogOptions?: ExtensionUIDialogOptions,
		): Promise<ExtensionAskDialogResult | undefined> {
			return requestRpcDialog(
				this.pendingRequests,
				this.output,
				dialogOptions,
				undefined,
				{ method: "askDialog", questions, timeout: dialogOptions?.timeout },
				response => ("result" in response ? response.result : undefined),
			);
		}

		onTerminalInput(): () => void {
			// Raw terminal input not supported in RPC mode
			return () => {};
		}

		notify(message: string, type?: "info" | "warning" | "error"): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "notify",
				message,
				notifyType: type,
			} as RpcExtensionUIRequest);
		}

		setStatus(key: string, text: string | undefined): void {
			// Fire and forget - no response needed
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setStatus",
				statusKey: key,
				statusText: text,
			} as RpcExtensionUIRequest);
		}

		setWorkingMessage(message?: string): void {
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setWorkingMessage",
				message,
			} satisfies RpcExtensionUIRequest);
		}

		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			// Only support string arrays in RPC mode - factory functions are ignored
			if (content === undefined || Array.isArray(content)) {
				this.output({
					type: "extension_ui_request",
					id: Snowflake.next() as string,
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				} as RpcExtensionUIRequest);
			}
			// Component factories are not supported in RPC mode - would need TUI access
		}

		setFooter(_factory: unknown): void {
			// Custom footer not supported in RPC mode - requires TUI access
		}

		setHeader(_factory: unknown): void {
			// Custom header not supported in RPC mode - requires TUI access
		}

		setTitle(title: string): void {
			// Title updates are low-value noise for most RPC hosts; opt in via PI_RPC_EMIT_TITLE=1.
			if (!emitRpcTitles) return;
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "setTitle",
				title,
			} as RpcExtensionUIRequest);
		}

		async custom(): Promise<never> {
			// Custom UI not supported in RPC mode
			return undefined as never;
		}

		pasteToEditor(text: string): void {
			// Paste handling not supported in RPC mode - falls back to setEditorText
			this.setEditorText(text);
		}

		setEditorText(text: string): void {
			publishedEditorText = text;
			// Fire and forget - host can implement editor control
			this.output({
				type: "extension_ui_request",
				id: Snowflake.next() as string,
				method: "set_editor_text",
				text,
			} as RpcExtensionUIRequest);
		}

		/**
		 * Synchronous snapshot contract: returns the latest host-published draft
		 * (or server-issued setEditorText value). Host-local edits remain invisible
		 * until the next publish_editor_text command.
		 */
		getEditorText(): string {
			return publishedEditorText;
		}

		async editor(
			title: string,
			prefill?: string,
			dialogOptions?: ExtensionUIDialogOptions,
			editorOptions?: { promptStyle?: boolean },
		): Promise<string | undefined> {
			return requestRpcEditor(this.pendingRequests, this.output, title, prefill, dialogOptions, editorOptions);
		}

		addAutocompleteProvider(factory: AutocompleteProviderFactory): void {
			autocompleteProviderFactories.push(factory);
		}

		get theme(): Theme {
			return theme;
		}

		getAllThemes(): Promise<{ name: string; path: string | undefined }[]> {
			return getAvailableThemesWithPaths();
		}

		getTheme(name: string): Promise<Theme | undefined> {
			return getThemeByName(name);
		}

		setTheme(themeOrName: string | Theme): Promise<{ success: boolean; error?: string }> {
			if (typeof themeOrName !== "string") {
				setThemeInstance(themeOrName);
				return Promise.resolve({ success: true });
			}
			return setActiveTheme(themeOrName, false);
		}

		getToolsExpanded() {
			// Tool expansion not supported in RPC mode - no TUI
			return false;
		}

		setToolsExpanded(_expanded: boolean) {
			// Tool expansion not supported in RPC mode - no TUI
		}

		setEditorComponent(): void {
			// Custom editor components not supported in RPC mode
		}
	}

	// Wire up UI context for tool execution (ask tool, etc.) and extensions.
	// A single shared instance routes all responses received on stdin to the
	// correct waiting promise regardless of which code path created the request.
	const rpcUiContext = new RpcExtensionUIContext(pendingExtensionRequests, output);
	setToolUIContext?.(rpcUiContext, true);

	// A joined collab session replicates the remote host's events into our
	// AgentSession; push them down the same stdout path a hosting client sees so
	// guest and host clients stream identically.
	const forwardCollabSessionEvent = (event: AgentSessionEvent): void => {
		output(event);
	};

	// A remote host's select/editor ask arrives over the relay. Reuse the RPC
	// extension-UI channel rather than inventing a second dialog protocol.
	const requestCollabUi = async (request: CollabUiRequest, signal: AbortSignal): Promise<CollabUiResponseValue> => {
		if (request.kind === "editor") {
			return await requestRpcEditor(pendingExtensionRequests, output, request.title, request.prefill, {
				signal,
			});
		}
		return await rpcUiContext.select(request.title, request.options, {
			signal,
			initialIndex: request.initialIndex,
			selectionMarker: request.selectionMarker,
			checkedIndices: request.checkedIndices,
			markableCount: request.markableCount,
			helpText: request.helpText,
		});
	};

	// Installed before extension init: an extension that writes a setting while loading
	// would otherwise change it before anyone is listening, leaving the client stale.
	const unsubscribeSettings = onSettingChanged((path, value) => {
		output({ type: "settings_update", path, value: isCredential(path) ? null : (value ?? null) });
	});

	// Install forwarding before extension initialization: extensions can emit
	// session events while their initialization hooks run.
	session.subscribe(event => {
		output(event);
		// The TUI drives the vocalizer from its event controller; RPC has none, so
		// speech would never happen without this. Never let it throw into the event path.
		try {
			rpcVoice.vocalizeRpcSessionEvent(session, event);
		} catch (voiceError) {
			logger.error("RPC voice vocalization failed", { error: String(voiceError) });
		}
		try {
			rpcIdle.feedRpcIdleEvent(idleBehavior, event);
		} catch (idleError) {
			logger.error("RPC idle behavior failed", { error: String(idleError) });
		}
	});

	// Set up extensions with RPC-based UI context
	await initializeExtensions(session, {
		reportSendError: (action, err) => {
			output(error(undefined, action, err.message));
		},
		reportRuntimeError: err => {
			output({ type: "extension_error", extensionPath: err.extensionPath, event: err.event, error: err.error });
		},
		onShutdown: () => {
			shutdownState.requested = true;
		},
		trackAgentInvokingMessage: task => {
			extensionUserMessageTracker.trackAgentMessageTask(task);
		},
		uiContext: rpcUiContext,
	});

	const getAvailableCommands = async () => buildAvailableSlashCommands(session);
	const emitAvailableCommandsUpdate = async () => {
		output({ type: "available_commands_update", commands: await getAvailableCommands() });
	};
	const reloadPluginState = async () => {
		const cwd = session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		resetCapabilities();
		await session.refreshSkills();
		session.setSlashCommands(await loadSlashCommands({ cwd }));
		await emitAvailableCommandsUpdate();
	};
	const executeRpcBuiltinSlashCommand = (message: string) =>
		executeAcpBuiltinSlashCommand(message, {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			cwd: session.sessionManager.getCwd(),
			output: text => output({ type: "command_output", text }),
			refreshCommands: emitAvailableCommandsUpdate,
			reloadPlugins: reloadPluginState,
			notifyTitleChanged: async () => {
				output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
			},
			notifyConfigChanged: async () => {
				output({ type: "config_update", model: session.model, thinkingLevel: session.thinkingLevel });
			},
		});
	const reconcileRpcCwd = async (previousCwd: string, targetCwd: string): Promise<void> => {
		if (path.resolve(previousCwd) === path.resolve(targetCwd)) return;
		const moveResult = await executeRpcBuiltinSlashCommand(`/move ${targetCwd}`);
		if (moveResult === false || "prompt" in moveResult) {
			throw new Error("The /move builtin could not reconcile the session working directory.");
		}
		if (path.resolve(session.sessionManager.getCwd()) !== path.resolve(targetCwd)) {
			throw new Error(`Failed to move the session to ${targetCwd}.`);
		}
		const titlePromptSource = discoverTitleSystemPromptFile(targetCwd);
		session.setTitleSystemPrompt(await resolvePromptInput(titlePromptSource, "title system prompt"));
	};
	const resolveRpcSessionReference = async (reference: string): Promise<string | undefined> => {
		const normalized = reference.trim();
		if (!normalized) return undefined;
		if (path.isAbsolute(normalized)) return normalized;
		const resumable = await resolveResumableSession(
			normalized,
			session.sessionManager.getCwd(),
			session.sessionManager.getSessionDir(),
			{ allowGlobalFallback: true },
		);
		if (resumable) return resumable.session.path;
		const query = normalized.toLowerCase();
		const localTitle = (
			await SessionManager.list(session.sessionManager.getCwd(), session.sessionManager.getSessionDir())
		).find(item => item.title?.toLowerCase().includes(query));
		if (localTitle) return localTitle.path;
		return (await SessionManager.listAll()).find(item => item.title?.toLowerCase().includes(query))?.path;
	};
	session.subscribeCommandMetadataChanged(() => {
		void emitAvailableCommandsUpdate();
	});
	await emitAvailableCommandsUpdate();

	const recordPromptHistory = (text: string): void => {
		if (shouldSkipHistory(text)) return;
		try {
			void HistoryStorage.open()
				.add(text, session.sessionManager.getCwd(), session.sessionId)
				.catch(historyError => logger.error("HistoryStorage add failed", { error: String(historyError) }));
		} catch (historyError) {
			logger.warn("History storage unavailable", { error: String(historyError) });
		}
	};

	const generateAndApplyTitle = async (text: string): Promise<{ title: string | null; applied: boolean }> => {
		const title = await session.generateTitle(text);
		if (!title) return { title, applied: false };
		const applied = await session.setSessionName(title, "auto");
		if (applied) {
			output({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId });
		}
		return { title, applied };
	};

	const resolveRpcModel = async (provider: string, modelId: string): Promise<Model | undefined> => {
		let model = session
			.getAvailableModels()
			.find(candidate => candidate.provider === provider && candidate.id === modelId);
		if (model) return model;
		await session.modelRegistry.awaitBackgroundRefresh();
		model = session
			.getAvailableModels()
			.find(candidate => candidate.provider === provider && candidate.id === modelId);
		return model;
	};

	const routeCollabGuestCommand = (
		requestId: string | undefined,
		commandName: "prompt" | "steer" | "follow_up" | "abort" | "abort_and_prompt",
		route: () => void,
	): RpcResponse => {
		try {
			route();
			return success(requestId, commandName);
		} catch (routeError) {
			const message = routeError instanceof Error ? routeError.message : String(routeError);
			const code = routeError instanceof rpcCollab.RpcCollabGuestRoutingError ? routeError.code : "operation_failed";
			return error(requestId, commandName, message, code);
		}
	};

	const isRpcPlanPaused = (): boolean => session.sessionManager.buildSessionContext().mode === "plan_paused";
	const withRpcPlanPauseState = (snapshot: rpcWorkModes.RpcPlanModeSnapshot): RpcPlanModeSnapshot => ({
		...snapshot,
		paused: isRpcPlanPaused(),
	});
	const readRpcPlanModeSnapshot = async (): Promise<RpcPlanModeSnapshot> =>
		withRpcPlanPauseState(await rpcWorkModes.readRpcPlanModeState(session));
	const buildRpcWorkModeSnapshot = async (): Promise<RpcWorkModeSnapshot> => {
		const snapshot = await rpcWorkModes.buildRpcWorkModeSnapshot(session);
		return { ...snapshot, plan: withRpcPlanPauseState(snapshot.plan) };
	};
	const withRpcPlanDecisionState = (decision: rpcWorkModes.RpcPlanDecisionResult): RpcPlanDecisionResult => ({
		...decision,
		state: withRpcPlanPauseState(decision.state),
	});
	const pauseRpcPlanMode = async (): Promise<RpcPlanModeSnapshot> => {
		const current = await readRpcPlanModeSnapshot();
		if (current.paused) return current;
		if (!current.enabled) throw new Error("Plan mode is not active.");
		await rpcWorkModes.exitRpcPlanMode(session);
		session.sessionManager.appendModeChange("plan_paused");
		return readRpcPlanModeSnapshot();
	};
	const resumeRpcPlanMode = async (): Promise<RpcPlanModeSnapshot> => {
		const current = await readRpcPlanModeSnapshot();
		if (current.enabled) return current;
		if (!current.paused) throw new Error("Plan mode is not paused.");
		return withRpcPlanPauseState(await rpcWorkModes.enterRpcPlanMode(session));
	};
	const exitRpcPlanMode = async (): Promise<RpcPlanModeSnapshot> => {
		if (isRpcPlanPaused()) {
			session.sessionManager.appendModeChange("none");
			return readRpcPlanModeSnapshot();
		}
		return withRpcPlanPauseState(await rpcWorkModes.exitRpcPlanMode(session));
	};

	const reconcileRpcWorkModes = async (honorPlanDefault: boolean): Promise<void> => {
		const sessionContext = session.sessionManager.buildSessionContext();
		// Always hydrate from a clean base: whatever transient runtime the previous
		// session left behind hands its tools and model back before the recorded
		// mode below re-enters and takes its own snapshot.
		await rpcWorkModes.clearRpcTransientModeState(session);

		if (sessionContext.mode === "goal" || sessionContext.mode === "goal_paused") {
			if (!session.settings.get("goal.enabled")) {
				session.goalRuntime.clearAccounting();
				session.sessionManager.appendModeChange("none");
				return;
			}
			const goal = readRpcPersistedGoal(sessionContext.modeData);
			if (!goal) {
				session.goalRuntime.clearAccounting();
				session.sessionManager.appendModeChange("none");
				return;
			}
			session.setGoalModeState({
				enabled: false,
				mode: "active",
				goal: { ...goal, status: "paused" },
			});
			await rpcWorkModes.resumeRpcGoal(session);
			if (sessionContext.mode === "goal_paused") await rpcWorkModes.pauseRpcGoal(session);
			return;
		}

		session.goalRuntime.clearAccounting();
		if (sessionContext.mode === "vibe") {
			await rpcWorkModes.enterRpcVibeMode(session);
			return;
		}

		if (sessionContext.mode === "plan_paused") {
			if (!session.settings.get("plan.enabled")) session.sessionManager.appendModeChange("none");
			return;
		}

		if (sessionContext.mode === "plan") {
			if (!session.settings.get("plan.enabled")) {
				session.sessionManager.appendModeChange("none");
				return;
			}
			const planFilePath =
				isRecord(sessionContext.modeData) && typeof sessionContext.modeData.planFilePath === "string"
					? sessionContext.modeData.planFilePath
					: undefined;
			await rpcWorkModes.enterRpcPlanMode(session, planFilePath);
			return;
		}

		const isFreshSession =
			sessionContext.messages.length === 0 &&
			!session.sessionManager.getEntries().some(entry => entry.type === "mode_change");
		if (
			honorPlanDefault &&
			isFreshSession &&
			session.settings.get("plan.defaultOnStartup") &&
			session.settings.get("plan.enabled")
		) {
			await rpcWorkModes.enterRpcPlanMode(session);
		}
	};

	/** Releases the collaboration relay and captured audio the current session owns. */
	const releaseRpcSessionAttachments = async (): Promise<void> => {
		try {
			await rpcCollab.disposeRpcCollab(session);
		} catch (collabError) {
			logger.error("RPC collaboration teardown failed", { error: String(collabError) });
		}
		await releaseVoice();
	};

	const runReconciledRpcSessionTransition = async <T>(
		transition: (options: SessionTransitionOptions) => Promise<RpcSessionTransitionOutcome<T>>,
		honorPlanDefaultOnCommit = false,
	): Promise<T> => {
		const previousCwd = session.sessionManager.getCwd();
		let workModeSuspension: VibeScopeSuspension | undefined;
		return runRpcSessionTransitionAtCommit(
			transition,
			async () => {
				// Restoring tools/model and detaching process-local vibe records are
				// reversible until the session operation reports its commit boundary.
				workModeSuspension = await rpcWorkModes.clearRpcTransientModeState(session, {
					reversibleVibeSuspension: true,
				});
				disposeRpcRuntimeBehaviors();
			},
			async ({ committed, honorPlanDefault }) => {
				try {
					if (workModeSuspension) {
						if (committed) await workModeSuspension.commit();
						else await workModeSuspension.rollback();
						workModeSuspension = undefined;
					}
					// A relay the client hosts and a live microphone belong to the
					// conversation that owned them: only a committed transition releases
					// them, so a failed one leaves the still-current session operational.
					if (committed) await releaseRpcSessionAttachments();
					try {
						await reconcileRpcCwd(previousCwd, session.sessionManager.getCwd());
					} finally {
						await reconcileRpcWorkModes(honorPlanDefault);
					}
				} finally {
					installRpcRuntimeBehaviors();
				}
			},
			honorPlanDefaultOnCommit,
		);
	};

	await reconcileRpcWorkModes(true);

	// Handle a single command
	const handleCommand = async (command: RpcCommand): Promise<RpcResponse> => {
		const id = command.id;

		switch (command.type) {
			case "negotiate_protocol": {
				if (command.protocolVersion !== 2)
					return error(id, "negotiate_protocol", `Unsupported RPC protocol version: ${command.protocolVersion}`);
				return success(id, "negotiate_protocol", { protocolVersion: 2 });
			}

			// =================================================================
			// Prompting
			// =================================================================

			case "prompt": {
				if (rpcCollab.isRpcCollabGuest(session)) {
					return routeCollabGuestCommand(id, "prompt", () =>
						rpcCollab.sendRpcCollabGuestPrompt(session, command.message, command.images),
					);
				}
				const resolvedPrompt = (agentInvoked: boolean): RpcResponse => {
					output({ type: "prompt_result", id, agentInvoked });
					return success(id, "prompt", { agentInvoked });
				};
				let message = command.message.trim();
				let images = command.images ? [...command.images] : undefined;
				let inputAgentInvoked: Promise<boolean> | undefined;
				const runner = session.extensionRunner;
				if (runner?.hasHandlers("input")) {
					const trackedInput = extensionUserMessageTracker.watchPrompt(() =>
						runner.emitInput(message, images, "rpc"),
					);
					const inputResult = await trackedInput.prompt;
					inputAgentInvoked = trackedInput
						.waitForAgentMessageTasks()
						.then(() => trackedInput.hasAgentMessageTask());
					if (inputResult?.handled) {
						return resolvedPrompt(await inputAgentInvoked);
					}
					if (inputResult?.text !== undefined) message = inputResult.text.trim();
					if (inputResult?.images !== undefined) images = inputResult.images;
				}
				if (!message && !images?.length) {
					return resolvedPrompt(inputAgentInvoked ? await inputAgentInvoked : false);
				}

				recordPromptHistory(message);
				const skillResult = await tryRunRpcSkillCommand(session, message, command.streamingBehavior);
				if (skillResult) {
					return resolvedPrompt(skillResult.agentInvoked);
				}
				const builtinResult = await executeRpcBuiltinSlashCommand(message);
				if (builtinResult !== false) {
					if ("prompt" in builtinResult) {
						watchAndReportLocalOnlyPromptResult({
							id,
							startPrompt: async () =>
								(await session.prompt(builtinResult.prompt, { images })) ||
								(inputAgentInvoked ? await inputAgentInvoked : false),
							output,
							onError: promptError => output(error(id, "prompt", promptError.message)),
							extensionUserMessageTracker,
						});
						return success(id, "prompt");
					}
					return resolvedPrompt(inputAgentInvoked ? await inputAgentInvoked : false);
				}

				// Don't await - events will stream
				// Extension commands are executed immediately, file prompt templates are expanded
				// If streaming and streamingBehavior specified, queues via steer/followUp
				watchAndReportLocalOnlyPromptResult({
					id,
					startPrompt: async () =>
						(await session.prompt(message, {
							images,
							streamingBehavior: command.streamingBehavior,
						})) || (inputAgentInvoked ? await inputAgentInvoked : false),
					output,
					onError: promptError => output(error(id, "prompt", promptError.message)),
					extensionUserMessageTracker,
				});
				return success(id, "prompt");
			}

			case "steer": {
				if (rpcCollab.isRpcCollabGuest(session)) {
					return routeCollabGuestCommand(id, "steer", () =>
						rpcCollab.sendRpcCollabGuestPrompt(session, command.message, command.images),
					);
				}
				await session.steer(command.message, command.images);
				return success(id, "steer");
			}

			case "follow_up": {
				if (rpcCollab.isRpcCollabGuest(session)) {
					return routeCollabGuestCommand(id, "follow_up", () =>
						rpcCollab.sendRpcCollabGuestPrompt(session, command.message, command.images),
					);
				}
				await session.followUp(command.message, command.images);
				return success(id, "follow_up");
			}

			case "abort": {
				if (rpcCollab.isRpcCollabGuest(session)) {
					return routeCollabGuestCommand(id, "abort", () => rpcCollab.sendRpcCollabGuestAbort(session));
				}
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				return success(id, "abort");
			}

			case "abort_and_prompt": {
				if (rpcCollab.isRpcCollabGuest(session)) {
					return routeCollabGuestCommand(id, "abort_and_prompt", () => {
						rpcCollab.sendRpcCollabGuestAbort(session);
						rpcCollab.sendRpcCollabGuestPrompt(session, command.message, command.images);
					});
				}
				await session.abort({ reason: USER_INTERRUPT_LABEL });
				session
					.prompt(command.message, { images: command.images })
					.catch(e => output(error(id, "abort_and_prompt", e.message)));
				return success(id, "abort_and_prompt");
			}

			case "ask_btw":
				return moduleCommand(id, "ask_btw", () =>
					rpcBtw.askRpcBtw(session, command.question, chunk =>
						output({ type: "btw_output", id: command.id, chunk }),
					),
				);

			case "get_last_btw_answer":
				return moduleCommand(id, "get_last_btw_answer", async () => ({
					answer: await rpcBtw.getRpcLastBtwAnswer(session),
				}));

			case "cancel_btw":
				return moduleCommand(id, "cancel_btw", () => rpcBtw.cancelRpcBtw(session));

			case "branch_btw": {
				const guestBlock = getRpcSessionTransitionGuestBlock(session);
				if (guestBlock) {
					return error(id, "branch_btw", guestBlock.message, guestBlock.code);
				}
				return moduleCommand(id, "branch_btw", () => rpcBtw.branchRpcBtw(session));
			}

			case "complete": {
				const provider = buildRpcAutocompleteProvider();
				const result = await provider.getSuggestions(command.lines, command.cursor.line, command.cursor.column);
				return success(
					id,
					"complete",
					result
						? {
								items: result.items.map(item => ({
									value: item.value,
									label: item.label,
									...(typeof item.description === "string" ? { description: item.description } : {}),
								})),
								prefix: result.prefix,
							}
						: { items: [], prefix: "" },
				);
			}

			case "apply_completion": {
				try {
					const provider = buildRpcAutocompleteProvider();
					const suggestions = await provider.getSuggestions(
						command.lines,
						command.cursor.line,
						command.cursor.column,
					);
					if (!suggestions) throw new Error("Completion is no longer available");
					const selected = suggestions.items.find(
						candidate =>
							candidate.value === command.item.value &&
							candidate.label === command.item.label &&
							candidate.description === command.item.description,
					);
					if (!selected) throw new Error("Selected completion is no longer available");
					const applied = provider.applyCompletion(
						command.lines,
						command.cursor.line,
						command.cursor.column,
						selected,
						suggestions.prefix,
					);
					return success(id, "apply_completion", {
						lines: applied.lines,
						cursor: { line: applied.cursorLine, column: applied.cursorCol },
					});
				} catch (err) {
					return error(
						id,
						"apply_completion",
						err instanceof Error ? err.message : String(err),
						"stale_completion",
					);
				}
			}

			case "publish_editor_text": {
				if (typeof command.text !== "string") {
					return error(id, "publish_editor_text", "Editor text must be a string", "invalid_request");
				}
				publishedEditorText = command.text;
				return success(id, "publish_editor_text");
			}

			case "new_session":
			case "switch_session":
			case "branch":
			case "fork": {
				const guestBlock = getRpcSessionTransitionGuestBlock(session);
				if (guestBlock) {
					return error(id, command.type, guestBlock.message, guestBlock.code);
				}
				let resolvedCommand: RpcSessionChangeCommand = command;
				if (command.type === "switch_session") {
					const sessionPath = await resolveRpcSessionReference(command.sessionPath);
					if (!sessionPath) {
						return error(id, "switch_session", `Session "${command.sessionPath}" not found`, "unknown_session");
					}
					resolvedCommand = { ...command, sessionPath };
				}
				const result = await runReconciledRpcSessionTransition(async transitionOptions => {
					const changed = await handleRpcSessionChange(
						session,
						resolvedCommand,
						subagentRegistry,
						transitionOptions,
					);
					return {
						result: changed,
						committed: !changed.data.cancelled,
						honorPlanDefault: command.type === "new_session" && !changed.data.cancelled,
					};
				}, command.type === "new_session");
				if (!result.data.cancelled) await emitAvailableCommandsUpdate();
				return success(id, result.type, result.data);
			}

			// =================================================================
			// State
			// =================================================================

			case "get_state": {
				const state: RpcSessionState = {
					model: session.model,
					thinkingLevel: session.thinkingLevel,
					isStreaming: session.isStreaming,
					isCompacting: session.isCompacting,
					isRetrying: session.isRetrying,
					isBashRunning: session.isBashRunning,
					isAborting: session.isAborting,
					isGeneratingHandoff: session.isGeneratingHandoff,
					steeringMode: session.steeringMode,
					followUpMode: session.followUpMode,
					interruptMode: session.interruptMode,
					sessionFile: session.sessionFile,
					sessionId: session.sessionId,
					sessionName: session.sessionName,
					autoCompactionEnabled: session.autoCompactionEnabled,
					messageCount: session.messages.length,
					queuedMessageCount: session.queuedMessageCount,
					todoPhases: session.getTodoPhases(),
					systemPrompt: session.systemPrompt,
					dumpTools: session.agent.state.tools.map(tool => ({
						name: tool.name,
						description: tool.description,
						parameters: isZodSchema(tool.parameters) ? zodToWireSchema(tool.parameters) : tool.parameters,
						examples: tool.examples,
					})),
					contextUsage: session.getContextUsage(),
					configWarnings: [...session.configWarnings],
					skillWarnings: session.skillWarnings.map(warning => ({
						skillPath: warning.skillPath,
						message: warning.message,
					})),
				};
				return success(id, "get_state", state);
			}

			case "get_available_commands": {
				return success(id, "get_available_commands", { commands: await getAvailableCommands() });
			}

			case "get_settings": {
				return success(id, "get_settings", await buildRpcSettingsSnapshot(session.settings));
			}

			case "set_setting": {
				const validated = validateRpcSettingValue(command.path, command.value);
				if (!validated.ok) return error(id, "set_setting", validated.error, validated.code);
				const path = command.path as SettingPath;
				session.settings.set(path, validated.value as never);
				await session.settings.flush();
				try {
					await applySettingEffects(session, command.path, validated.value, mcpManager);
				} catch (err) {
					return error(
						id,
						"set_setting",
						`Setting saved but effect failed: ${err instanceof Error ? err.message : String(err)}`,
						"effect_failed",
					);
				}
				return success(id, "set_setting", {
					path: command.path,
					value: isCredential(path) ? null : validated.value,
					configured: session.settings.isConfigured(path),
				});
			}

			case "get_extensions": {
				const disabledIds = session.settings.get("disabledExtensions") ?? [];
				const extensions = await loadAllExtensions(command.cwd ?? session.sessionManager.getCwd(), disabledIds);
				return success(id, "get_extensions", {
					extensions: extensions.map(({ raw: _raw, ...rest }) => rest),
				});
			}

			case "get_repo_status": {
				return success(
					id,
					"get_repo_status",
					await buildRpcRepoStatus(command.cwd ?? session.sessionManager.getCwd(), {
						includePr: command.includePr ?? false,
					}),
				);
			}

			case "get_usage_reports": {
				return success(id, "get_usage_reports", { reports: await readRpcUsageReports(session) });
			}

			case "set_todos": {
				session.setTodoPhases(command.phases);
				return success(id, "set_todos", { todoPhases: session.getTodoPhases() });
			}

			case "set_host_tools": {
				const tools = normalizeHostToolDefinitions(command.tools);
				const rpcTools = hostToolBridge.setTools(tools);
				await session.refreshRpcHostTools(rpcTools);
				return success(id, "set_host_tools", { toolNames: tools.map(tool => tool.name) });
			}

			case "set_host_uri_schemes": {
				try {
					const schemes = hostUriBridge.setSchemes(command.schemes);
					return success(id, "set_host_uri_schemes", { schemes });
				} catch (err) {
					return error(id, "set_host_uri_schemes", err instanceof Error ? err.message : String(err));
				}
			}

			case "subscribe_provider_request_observations": {
				const runner = session.extensionRunner;
				if (!runner) {
					return error(
						id,
						"subscribe_provider_request_observations",
						"Extension runner is unavailable",
						"extensions_unavailable",
					);
				}
				unsubscribeProviderRequestObservations?.();
				unsubscribeProviderRequestObservations = runner.onProviderRequestObservation(observation => {
					output(buildRpcProviderObservationFrame(session, observation));
				});
				return success(id, "subscribe_provider_request_observations", { subscribed: true });
			}

			case "unsubscribe_provider_request_observations": {
				unsubscribeProviderRequestObservations?.();
				unsubscribeProviderRequestObservations = undefined;
				return success(id, "unsubscribe_provider_request_observations", { subscribed: false });
			}

			case "set_subagent_subscription": {
				if (!subagentRegistry) {
					return error(id, "set_subagent_subscription", "Subagent event bus is unavailable");
				}
				if (!isSubagentSubscriptionLevel(command.level)) {
					return error(
						id,
						"set_subagent_subscription",
						`Invalid subagent subscription level: ${String(command.level)}`,
					);
				}
				subagentRegistry.setSubscriptionLevel(command.level);
				return success(id, "set_subagent_subscription", { level: subagentRegistry.getSubscriptionLevel() });
			}

			case "get_subagents": {
				if (!subagentRegistry) {
					return error(id, "get_subagents", "Subagent event bus is unavailable");
				}
				return success(id, "get_subagents", { subagents: subagentRegistry.getSubagents() });
			}

			case "get_subagent_messages": {
				if (!subagentRegistry) {
					return error(id, "get_subagent_messages", "Subagent event bus is unavailable");
				}
				try {
					if (command.fromByte !== undefined && !Number.isFinite(command.fromByte)) {
						return error(id, "get_subagent_messages", "fromByte must be a finite number");
					}
					const sessionFile = subagentRegistry.resolveSessionFile(command);
					const transcript = await readRpcSubagentTranscript(sessionFile, command.fromByte);
					return success(id, "get_subagent_messages", transcript);
				} catch (err) {
					return error(id, "get_subagent_messages", err instanceof Error ? err.message : String(err));
				}
			}

			// =================================================================
			// Work modes
			// =================================================================

			case "enter_plan_mode":
				return moduleCommand(id, "enter_plan_mode", async () =>
					withRpcPlanPauseState(
						await rpcWorkModes.enterRpcPlanMode(session, command.planFilePath, command.workflow),
					),
				);

			case "pause_plan_mode":
				return moduleCommand(id, "pause_plan_mode", pauseRpcPlanMode);

			case "resume_plan_mode":
				return moduleCommand(id, "resume_plan_mode", resumeRpcPlanMode);

			case "exit_plan_mode":
				return moduleCommand(id, "exit_plan_mode", exitRpcPlanMode);

			case "get_plan_mode_state":
				return moduleCommand(id, "get_plan_mode_state", readRpcPlanModeSnapshot);

			case "submit_plan_review":
				return moduleCommand(id, "submit_plan_review", () =>
					rpcWorkModes.submitRpcPlanReview(session, command.title),
				);

			case "approve_plan_proposal": {
				let executionModel: Model | undefined;
				if (command.executionModel) {
					executionModel = await resolveRpcModel(command.executionModel.provider, command.executionModel.modelId);
					if (!executionModel) {
						return error(
							id,
							"approve_plan_proposal",
							`Model not found: ${command.executionModel.provider}/${command.executionModel.modelId}`,
							"model_not_found",
						);
					}
				}
				return moduleCommand(id, "approve_plan_proposal", async () =>
					withRpcPlanDecisionState(
						await rpcWorkModes.approveRpcPlanProposal(
							session,
							command.editedContent,
							command.strategy,
							executionModel,
							command.thinkingLevel,
						),
					),
				);
			}

			case "reject_plan_proposal":
				return moduleCommand(id, "reject_plan_proposal", async () =>
					withRpcPlanDecisionState(await rpcWorkModes.rejectRpcPlanProposal(session, command.feedback)),
				);

			case "create_goal":
				return moduleCommand(id, "create_goal", () =>
					rpcWorkModes.createRpcGoal(session, command.objective, command.tokenBudget),
				);

			case "pause_goal":
				return moduleCommand(id, "pause_goal", () => rpcWorkModes.pauseRpcGoal(session));

			case "resume_goal":
				return moduleCommand(id, "resume_goal", () => rpcWorkModes.resumeRpcGoal(session));

			case "switch_goal":
				return moduleCommand(id, "switch_goal", () =>
					rpcWorkModes.switchRpcGoal(session, command.objective, command.tokenBudget),
				);

			case "clear_goal":
				return moduleCommand(id, "clear_goal", () => rpcWorkModes.clearRpcGoal(session));

			case "set_goal_budget":
				return moduleCommand(id, "set_goal_budget", () =>
					rpcWorkModes.setRpcGoalBudget(session, command.tokenBudget),
				);

			case "get_goal_state":
				return moduleCommand(id, "get_goal_state", () => rpcWorkModes.readRpcGoalState(session));

			case "begin_guided_goal":
				return moduleCommand(id, "begin_guided_goal", () =>
					rpcWorkModes.beginRpcGuidedGoal(session, command.initialObjective),
				);

			case "enter_vibe_mode":
				return moduleCommand(id, "enter_vibe_mode", () => rpcWorkModes.enterRpcVibeMode(session));

			case "exit_vibe_mode":
				return moduleCommand(id, "exit_vibe_mode", () => rpcWorkModes.exitRpcVibeMode(session));

			case "get_vibe_mode_state":
				return moduleCommand(id, "get_vibe_mode_state", () => rpcWorkModes.readRpcVibeModeState(session));

			case "get_work_mode_state":
				return moduleCommand(id, "get_work_mode_state", buildRpcWorkModeSnapshot);

			// =================================================================
			// Runtime control
			// =================================================================

			case "enable_loop":
				return moduleCommand(id, "enable_loop", () =>
					rpcRuntimeControl.enableRpcLoop(
						session,
						command.prompt,
						command.action,
						command.count,
						command.durationMs,
					),
				);

			case "disable_loop":
				return moduleCommand(id, "disable_loop", () => rpcRuntimeControl.disableRpcLoop(session));

			case "get_loop_state":
				return moduleCommand(id, "get_loop_state", () => rpcRuntimeControl.readRpcLoopState(session));

			case "cancel_loop_iteration":
				return moduleCommand(id, "cancel_loop_iteration", () => rpcRuntimeControl.cancelRpcLoopIteration(session));

			case "pause_agents":
				return moduleCommand(id, "pause_agents", () => rpcRuntimeControl.pauseRpcAgents(session));

			case "resume_agents":
				return moduleCommand(id, "resume_agents", () => rpcRuntimeControl.resumeRpcAgents(session));

			case "get_pause_state":
				return moduleCommand(id, "get_pause_state", () => rpcRuntimeControl.readRpcPauseState(session));

			case "get_session_tree":
				return moduleCommand(id, "get_session_tree", () => rpcRuntimeControl.readRpcSessionTree(session));

			// =================================================================
			// Agent control
			// =================================================================

			case "get_controllable_agents":
				return moduleCommand(id, "get_controllable_agents", () =>
					rpcAgentControl.listRpcControllableAgents(session),
				);

			case "revive_agent":
				return moduleCommand(id, "revive_agent", () => rpcAgentControl.reviveRpcAgent(session, command.agentId));

			case "kill_agent":
				return moduleCommand(id, "kill_agent", () => rpcAgentControl.killRpcAgent(session, command.agentId));

			case "prompt_agent":
				return moduleCommand(id, "prompt_agent", () =>
					rpcAgentControl.promptRpcAgent(session, command.agentId, command.text),
				);

			case "spawn_background_agent":
				return moduleCommand(id, "spawn_background_agent", () =>
					rpcAgentControl.spawnRpcBackgroundAgent(session, command.work, mcpManager),
				);

			// =================================================================
			// Authoring
			// =================================================================

			case "get_advisor_config":
				return moduleCommand(id, "get_advisor_config", () =>
					rpcAuthoring.readRpcAdvisorConfig(session, command.scope),
				);

			case "set_advisor_config":
				return moduleCommand(id, "set_advisor_config", () =>
					rpcAuthoring.writeRpcAdvisorConfig(session, command.scope, command.instructions, command.advisors),
				);

			case "generate_ttsr_rule":
				return moduleCommand(id, "generate_ttsr_rule", () =>
					rpcAuthoring.generateRpcTtsrRule(
						session,
						command.complaint,
						command.feedback,
						command.previousRule,
						event => output({ type: "ttsr_generation_event", id, event }),
					),
				);

			case "build_ttsr_rule":
				return moduleCommand(id, "build_ttsr_rule", () =>
					rpcAuthoring.buildRpcTtsrRule(
						session,
						command.name,
						command.description,
						command.conditions,
						command.scopes,
						command.body,
					),
				);

			case "register_ttsr_rule":
				return moduleCommand(id, "register_ttsr_rule", () =>
					rpcAuthoring.registerRpcTtsrRule(
						session,
						command.scope,
						command.name,
						command.description,
						command.conditions,
						command.scopes,
						command.body,
						command.overwrite,
					),
				);

			case "get_ttsr_rules":
				return moduleCommand(id, "get_ttsr_rules", () => rpcAuthoring.listRpcTtsrRules(session));

			case "remove_ttsr_rule":
				return moduleCommand(id, "remove_ttsr_rule", () =>
					rpcAuthoring.removeRpcTtsrRule(session, command.name, command.deletePersisted),
				);

			case "get_agent_definitions":
				return moduleCommand(id, "get_agent_definitions", () => rpcAuthoring.listRpcAgentDefinitions(session));

			case "get_agent_definition":
				return moduleCommand(id, "get_agent_definition", () =>
					rpcAuthoring.readRpcAgentDefinition(session, command.name, command.scope),
				);

			case "set_agent_definition":
				return moduleCommand(id, "set_agent_definition", () =>
					rpcAuthoring.writeRpcAgentDefinition(
						session,
						command.scope,
						command.name,
						command.content,
						command.overwrite,
					),
				);

			case "delete_agent_definition":
				return moduleCommand(id, "delete_agent_definition", () =>
					rpcAuthoring.deleteRpcAgentDefinition(session, command.scope, command.name),
				);

			case "get_mental_models":
				return moduleCommand(id, "get_mental_models", () =>
					rpcAuthoring.listRpcMentalModels(session, command.detail),
				);

			case "get_mental_model":
				return moduleCommand(id, "get_mental_model", () =>
					rpcAuthoring.readRpcMentalModel(session, command.mentalModelId, command.detail),
				);

			case "create_mental_model":
				return moduleCommand(id, "create_mental_model", () =>
					rpcAuthoring.createRpcMentalModel(
						session,
						command.name,
						command.sourceQuery,
						command.mentalModelId,
						command.tags,
						command.maxTokens,
						command.mode,
						command.refreshAfterConsolidation,
					),
				);

			case "refresh_mental_model":
				return moduleCommand(id, "refresh_mental_model", () =>
					rpcAuthoring.refreshRpcMentalModel(session, command.mentalModelId),
				);

			case "refresh_auto_mental_models":
				return moduleCommand(id, "refresh_auto_mental_models", () =>
					rpcAuthoring.refreshRpcAutoMentalModels(session),
				);

			case "get_mental_model_history":
				return moduleCommand(id, "get_mental_model_history", () =>
					rpcAuthoring.readRpcMentalModelHistory(session, command.mentalModelId),
				);

			case "seed_mental_models":
				return moduleCommand(id, "seed_mental_models", () => rpcAuthoring.seedRpcMentalModels(session));

			case "delete_mental_model":
				return moduleCommand(id, "delete_mental_model", () =>
					rpcAuthoring.deleteRpcMentalModel(session, command.mentalModelId),
				);

			case "reload_mental_models":
				return moduleCommand(id, "reload_mental_models", () => rpcAuthoring.reloadRpcMentalModels(session));

			// =================================================================
			// Presentation
			// =================================================================

			case "get_theme": {
				return success(id, "get_theme", await buildRpcThemeSnapshot());
			}

			case "get_keybindings": {
				return success(id, "get_keybindings", { keybindings: await buildRpcKeybindings() });
			}

			case "get_session_view": {
				return success(id, "get_session_view", buildRpcSessionView(session));
			}

			// =================================================================
			// Model
			// =================================================================

			case "set_model":
			case "set_model_temporary": {
				const model = await resolveRpcModel(command.provider, command.modelId);
				if (!model) {
					return error(id, command.type, `Model not found: ${command.provider}/${command.modelId}`);
				}
				if (command.type === "set_model_temporary") {
					await session.setModelTemporary(model, command.thinkingLevel, { ephemeral: command.ephemeral });
				} else {
					await session.setModel(model);
				}
				return success(id, command.type, model);
			}

			case "cycle_model": {
				const result = await session.cycleModel(command.direction);
				if (!result) {
					return success(id, "cycle_model", null);
				}
				return success(id, "cycle_model", result);
			}

			case "cycle_role_models": {
				const result = await session.cycleRoleModels(command.roleOrder, command.direction);
				return success(id, "cycle_role_models", result ?? null);
			}

			case "get_available_models": {
				await session.modelRegistry.awaitBackgroundRefresh();
				const models = session.getAvailableModels();
				return success(id, "get_available_models", { models });
			}

			case "get_model_roles":
				return moduleCommand(id, "get_model_roles", () => rpcModelRoles.readRpcModelRoles(session));

			case "set_model_role":
				return moduleCommand(id, "set_model_role", () =>
					rpcModelRoles.setRpcModelRole(session, command.role, command.model, command.scope),
				);

			case "clear_model_role":
				return moduleCommand(id, "clear_model_role", () =>
					rpcModelRoles.clearRpcModelRole(session, command.role, command.scope),
				);

			// =================================================================
			// Thinking
			// =================================================================

			case "set_thinking_level": {
				session.setThinkingLevel(command.level);
				return success(id, "set_thinking_level");
			}

			case "cycle_thinking_level": {
				const level = session.cycleThinkingLevel();
				if (!level) {
					return success(id, "cycle_thinking_level", null);
				}
				return success(id, "cycle_thinking_level", { level });
			}

			// =================================================================
			// Queue Modes
			// =================================================================

			case "set_steering_mode": {
				session.setSteeringMode(command.mode);
				return success(id, "set_steering_mode");
			}

			case "set_follow_up_mode": {
				session.setFollowUpMode(command.mode);
				return success(id, "set_follow_up_mode");
			}

			case "set_interrupt_mode": {
				session.setInterruptMode(command.mode);
				return success(id, "set_interrupt_mode");
			}

			case "get_queued_messages": {
				return success(id, "get_queued_messages", session.getRestorableQueuedMessages());
			}

			case "pop_queued_message": {
				return success(id, "pop_queued_message", { message: session.popLastQueuedMessage() ?? null });
			}

			case "clear_queue": {
				return success(id, "clear_queue", session.clearQueue());
			}

			// =================================================================
			// Compaction
			// =================================================================

			case "compact": {
				const result = await session.compact(command.customInstructions);
				return success(id, "compact", result);
			}

			case "set_auto_compaction": {
				session.setAutoCompactionEnabled(command.enabled);
				return success(id, "set_auto_compaction");
			}

			// =================================================================
			// Retry
			// =================================================================

			case "retry": {
				return success(id, "retry", { retried: await session.retry() });
			}

			case "set_auto_retry": {
				session.setAutoRetryEnabled(command.enabled);
				return success(id, "set_auto_retry");
			}

			case "abort_retry": {
				session.abortRetry();
				return success(id, "abort_retry");
			}

			// =================================================================
			// Bash
			// =================================================================

			case "bash": {
				const result = await session.executeBash(
					command.command,
					chunk => output({ type: "exec_output", source: "bash", id: command.id, chunk }),
					{
						excludeFromContext: command.excludeFromContext,
						useUserShell: command.useUserShell ?? true,
					},
				);
				if (
					command.followCwd &&
					!result.cancelled &&
					result.exitCode === 0 &&
					result.workingDir &&
					path.isAbsolute(result.workingDir)
				) {
					await reconcileRpcCwd(session.sessionManager.getCwd(), result.workingDir);
				}
				return success(id, "bash", result);
			}

			case "abort_bash": {
				session.abortBash();
				return success(id, "abort_bash");
			}

			case "python": {
				const result = await session.executePython(
					command.code,
					chunk => output({ type: "exec_output", source: "python", id: command.id, chunk }),
					{ excludeFromContext: command.excludeFromContext },
				);
				return success(id, "python", result);
			}

			case "abort_python": {
				session.abortEval();
				return success(id, "abort_python");
			}

			// =================================================================
			// Session
			// =================================================================

			case "get_session_stats": {
				const stats = session.getSessionStats();
				return success(id, "get_session_stats", stats);
			}

			case "get_sessions": {
				const currentCwd = session.sessionManager.getCwd();
				const cwd = command.cwd ?? currentCwd;
				const sessionDir =
					command.cwd === undefined || path.resolve(cwd) === path.resolve(currentCwd)
						? session.sessionManager.getSessionDir()
						: undefined;
				let sessions =
					command.scope === "all" ? await SessionManager.listAll() : await SessionManager.list(cwd, sessionDir);
				const query = command.query?.trim().toLowerCase();
				if (query) {
					sessions = sessions.filter(item =>
						`${item.title ?? ""}\n${item.firstMessage}\n${item.cwd}\n${item.id}\n${item.allMessagesText}`
							.toLowerCase()
							.includes(query),
					);
				}
				sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
				const total = sessions.length;
				const limit = Math.max(1, Math.min(1000, command.limit ?? 100));
				return success(id, "get_sessions", {
					sessions: sessions.slice(0, limit).map(item => ({
						path: item.path,
						id: item.id,
						cwd: item.cwd,
						title: item.title,
						parentSessionPath: item.parentSessionPath,
						created: item.created.toISOString(),
						modified: item.modified.toISOString(),
						messageCount: item.messageCount,
						size: item.size,
						firstMessage: item.firstMessage,
						status: item.status,
					})),
					total,
				});
			}

			case "delete_session": {
				const target = path.resolve(command.sessionPath);
				const activeSessionFile = session.sessionManager.getSessionFile();
				const active = activeSessionFile !== undefined && target === path.resolve(activeSessionFile);
				if (active) {
					const guestBlock = getRpcSessionTransitionGuestBlock(session);
					if (guestBlock) {
						return error(id, "delete_session", guestBlock.message, guestBlock.code);
					}
					try {
						if (session.isCompacting) {
							session.abortCompaction();
							while (session.isCompacting) await Bun.sleep(10);
						}
						const deleted = await runReconciledRpcSessionTransition(async transitionOptions => {
							const created = await session.newSession({ drop: true, ...transitionOptions });
							if (created) subagentRegistry?.clear();
							return { result: created, committed: created, honorPlanDefault: created };
						}, true);
						if (!deleted) {
							return error(id, "delete_session", "Session deletion was cancelled", "cancelled");
						}
						await emitAvailableCommandsUpdate();
						return success(id, "delete_session", { sessionPath: command.sessionPath });
					} catch (err) {
						return error(id, "delete_session", err instanceof Error ? err.message : String(err));
					}
				}
				// `deleteSessionWithArtifacts` unlinks the file and recursively removes the
				// sibling artifacts directory derived from its name, so an arbitrary path is a
				// destructive primitive. Only accept a path the session listing actually owns.
				const known = (await SessionManager.listAll()).some(item => path.resolve(item.path) === target);
				if (!known) {
					return error(
						id,
						"delete_session",
						`Not a known session file: ${command.sessionPath}`,
						"unknown_session",
					);
				}
				try {
					await new FileSessionStorage().deleteSessionWithArtifacts(command.sessionPath);
					return success(id, "delete_session", { sessionPath: command.sessionPath });
				} catch (err) {
					return error(id, "delete_session", err instanceof Error ? err.message : String(err));
				}
			}

			case "get_prompt_history": {
				return success(id, "get_prompt_history", {
					entries: await readRpcPromptHistory({
						cwd: command.cwd ?? session.sessionManager.getCwd(),
						query: command.query,
						limit: command.limit,
					}),
				});
			}

			case "navigate_tree": {
				const result = await session.navigateTree(command.targetId, {
					summarize: command.summarize,
					customInstructions: command.customInstructions,
					allowAskReopen: command.allowAskReopen,
					reanswerAskResult: command.reanswerAskResult,
				});
				return success(id, "navigate_tree", {
					...(result.editorText === undefined ? {} : { editorText: result.editorText }),
					cancelled: result.cancelled,
					...(result.aborted === undefined ? {} : { aborted: result.aborted }),
					...(result.reopenAsk === undefined ? {} : { reopenAsk: result.reopenAsk }),
					...(result.askReanswerCommitted === undefined
						? {}
						: { askReanswerCommitted: result.askReanswerCommitted }),
				});
			}

			case "resume_after_ask_reanswer": {
				session.resumeAfterAskReanswer();
				return success(id, "resume_after_ask_reanswer");
			}

			case "export_html": {
				const path = await session.exportToHtml(command.outputPath);
				return success(id, "export_html", { path });
			}

			case "get_branch_messages": {
				const messages = session.getUserMessagesForBranching();
				return success(id, "get_branch_messages", { messages });
			}

			case "get_last_assistant_text": {
				const text = session.getLastAssistantText();
				return success(id, "get_last_assistant_text", { text });
			}

			case "set_session_name": {
				const name = command.name.trim();
				if (!name) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				const applied = await session.setSessionName(name, "user");
				if (!applied) {
					return error(id, "set_session_name", "Session name cannot be empty");
				}
				return success(id, "set_session_name");
			}

			case "generate_title": {
				return success(id, "generate_title", await generateAndApplyTitle(command.text));
			}

			case "handoff": {
				// Resetting the agent mid-stream lets the live turn keep emitting into a
				// session that handoff has already torn down. Refuse while a prompt is in
				// flight (mirrors the TUI /handoff guard).
				if (session.isStreaming) {
					return error(id, "handoff", "Cannot hand off while a response is in progress");
				}
				const result = await session.handoff(command.customInstructions);
				return success(id, "handoff", result ? { savedPath: result.savedPath } : null);
			}

			// =================================================================
			// Messages
			// =================================================================

			case "get_messages": {
				return success(id, "get_messages", { messages: session.messages });
			}

			case "get_messages_page": {
				if (session.isStreaming || session.isCompacting)
					return error(id, "get_messages_page", RPC_MESSAGES_PAGE_BUSY_ERROR, "session_busy");
				const messages = session.messages;
				try {
					return success(
						id,
						"get_messages_page",
						pageRpcMessages(
							messages,
							{
								sessionId: session.sessionId,
								leafId: session.sessionManager.getLeafId(),
								messageCount: messages.length,
							},
							{ cursor: command.cursor, limit: command.limit },
						),
					);
				} catch (pageError) {
					return error(
						id,
						"get_messages_page",
						pageError instanceof Error ? pageError.message : String(pageError),
						pageError instanceof RpcMessagesPageError ? pageError.code : undefined,
					);
				}
			}

			// =================================================================
			// Login
			// =================================================================

			case "get_login_providers":
				return moduleCommand(id, "get_login_providers", () => rpcAccounts.readRpcLoginProviders(session));

			case "login": {
				const knownProvider = getOAuthProviders().find(p => p.id === command.providerId);
				if (!knownProvider) {
					return error(id, "login", `Unknown OAuth provider: ${command.providerId}`);
				}
				const uiCtx = new RpcExtensionUIContext(pendingExtensionRequests, output);
				try {
					await session.modelRegistry.authStorage.login(command.providerId, {
						onAuth: info => {
							output({
								type: "extension_ui_request",
								id: Snowflake.next() as string,
								method: "open_url",
								url: info.url,
								launchUrl: info.launchUrl,
								instructions: info.instructions,
							} as RpcExtensionUIRequest);
						},
						onProgress: message => {
							uiCtx.notify(message, "info");
						},
						onPrompt: async prompt => {
							return (await uiCtx.input(prompt.message, prompt.placeholder, { timeout: 600_000 })) ?? "";
						},
					});
					// Provider-scoped online refresh so the just-persisted credential
					// re-runs discovery instead of reusing a fresh authoritative cache
					// row (#5780).
					await session.modelRegistry.refreshProvider(command.providerId, "online");
					return success(id, "login", { providerId: command.providerId });
				} catch (err: unknown) {
					return error(id, "login", err instanceof Error ? err.message : String(err));
				}
			}

			case "logout":
			case "remove_login_account": {
				if (!Number.isSafeInteger(command.credentialId) || command.credentialId < 1) {
					const message =
						command.type === "logout"
							? "logout now requires a positive credentialId; use remove_provider_credentials to remove every account"
							: "credentialId must be a positive integer";
					return error(id, command.type, message, "credential_id_required");
				}
				return moduleCommand(id, command.type, () =>
					rpcAccounts.removeRpcLoginAccount(session, command.providerId, command.credentialId),
				);
			}

			case "remove_provider_credentials":
				return moduleCommand(id, "remove_provider_credentials", () =>
					rpcAccounts.removeRpcProviderCredentials(session, command.providerId),
				);

			// =================================================================
			// MCP
			// =================================================================

			case "mcp_add_server":
				return mcpManagerCommand(id, "mcp_add_server", manager =>
					rpcMcp.addRpcMCPServer(session, manager, command.name, command.config, command.scope),
				);

			case "mcp_remove_server":
				return mcpManagerCommand(id, "mcp_remove_server", manager =>
					rpcMcp.removeRpcMCPServer(session, manager, command.name, command.scope),
				);

			case "mcp_set_server_enabled":
				return mcpManagerCommand(id, "mcp_set_server_enabled", manager =>
					rpcMcp.setRpcMCPServerEnabled(session, manager, command.name, command.enabled),
				);

			case "mcp_reload":
				return mcpManagerCommand(id, "mcp_reload", manager => rpcMcp.reloadRpcMCP(session, manager));

			case "mcp_reconnect_server":
				return mcpManagerCommand(id, "mcp_reconnect_server", manager =>
					rpcMcp.reconnectRpcMCPServer(session, manager, command.name),
				);

			case "mcp_unauth_server":
				return mcpManagerCommand(id, "mcp_unauth_server", manager =>
					rpcMcp.unauthRpcMCPServer(session, manager, command.name),
				);

			case "mcp_begin_reauth":
				return mcpManagerCommand(id, "mcp_begin_reauth", manager =>
					rpcMcp.beginRpcMCPReauth(session, manager, command.name),
				);

			case "mcp_complete_reauth":
				return mcpManagerCommand(id, "mcp_complete_reauth", manager =>
					rpcMcp.completeRpcMCPReauth(session, manager, command.flowId, command.completion),
				);

			case "mcp_cancel_reauth": {
				if (!mcpManager) {
					return error(
						id,
						"mcp_cancel_reauth",
						"MCP manager is unavailable in this RPC session",
						"mcp_unavailable",
					);
				}
				try {
					await rpcMcp.cancelRpcMCPReauth(session, command.flowId);
					return success(id, "mcp_cancel_reauth");
				} catch (err) {
					return error(id, "mcp_cancel_reauth", err instanceof Error ? err.message : String(err));
				}
			}

			case "mcp_begin_smithery_login":
				return mcpManagerCommand(id, "mcp_begin_smithery_login", () => rpcMcp.beginRpcMCPSmitheryLogin());

			case "mcp_complete_smithery_login":
				return mcpManagerCommand(id, "mcp_complete_smithery_login", () =>
					rpcMcp.completeRpcMCPSmitheryLogin(command.sessionId, command.apiKey),
				);

			case "mcp_logout_smithery":
				return mcpManagerCommand(id, "mcp_logout_smithery", () => rpcMcp.logoutRpcMCPSmithery());

			case "mcp_search_registry":
				return mcpManagerCommand(id, "mcp_search_registry", () =>
					rpcMcp.searchRpcMCPRegistry(command.query, command.limit, command.semantic),
				);

			case "mcp_deploy_registry_result":
				return mcpManagerCommand(id, "mcp_deploy_registry_result", manager =>
					rpcMcp.deployRpcMCPRegistryResult(
						session,
						manager,
						command.result,
						command.scope,
						command.name,
						command.values,
					),
				);

			// =================================================================
			// Diagnostics
			// =================================================================

			case "start_cpu_profile":
				return moduleCommand(id, "start_cpu_profile", async () => {
					await rpcDiagnostics.startRpcCpuProfile(session);
					return null;
				});

			case "stop_cpu_profile":
				return moduleCommand(id, "stop_cpu_profile", () => rpcDiagnostics.stopRpcCpuProfile(session));

			case "create_heap_profile":
				return moduleCommand(id, "create_heap_profile", () => rpcDiagnostics.createRpcHeapProfile(session));

			case "create_support_bundle":
				return moduleCommand(id, "create_support_bundle", () => rpcDiagnostics.createRpcSupportBundle(session));

			case "create_work_profile":
				return moduleCommand(id, "create_work_profile", () => rpcDiagnostics.createRpcWorkProfile(session));

			case "get_recent_logs":
				return moduleCommand(id, "get_recent_logs", () =>
					rpcDiagnostics.readRpcRecentLogs(session, command.maxLines, command.olderDays),
				);

			case "get_raw_sse":
				return moduleCommand(id, "get_raw_sse", () => rpcDiagnostics.readRpcRawSseSnapshot(session));

			case "subscribe_raw_sse": {
				unsubscribeRawSse ??= rpcDiagnostics.subscribeRpcRawSse(session, snapshot => {
					output({ type: "raw_sse_update", snapshot });
				});
				return success(id, "subscribe_raw_sse", { subscribed: true });
			}

			case "unsubscribe_raw_sse": {
				unsubscribeRawSse?.();
				unsubscribeRawSse = undefined;
				return success(id, "unsubscribe_raw_sse", { subscribed: false });
			}

			case "start_inspector":
				return moduleCommand(id, "start_inspector", () => rpcDiagnostics.startRpcInspector(session));

			case "get_system_info":
				return moduleCommand(id, "get_system_info", () => rpcDiagnostics.readRpcSystemInfo(session));

			case "get_startup_warnings":
				return moduleCommand(id, "get_startup_warnings", () => rpcDiagnostics.readRpcStartupWarnings(session));

			case "get_artifacts_directory":
				return moduleCommand(id, "get_artifacts_directory", () => rpcDiagnostics.getRpcArtifactsDirectory(session));

			case "clear_artifact_cache":
				return moduleCommand(id, "clear_artifact_cache", () =>
					rpcDiagnostics.clearRpcArtifactCache(session, command.daysOld),
				);

			case "get_mcp_auth_challenges":
				return moduleCommand(id, "get_mcp_auth_challenges", async () => ({
					challenges: rpcDiagnostics.readPendingRpcMcpAuthChallenges(mcpAuthController),
				}));

			case "resolve_mcp_auth_challenge":
				return moduleCommand(id, "resolve_mcp_auth_challenge", async () => ({
					resolved: rpcDiagnostics.resolveRpcMcpAuthChallenge(
						mcpAuthController,
						command.challengeId,
						command.config,
					),
				}));

			// =================================================================
			// Voice
			// =================================================================

			case "start_live":
				return moduleCommand(id, "start_live", () =>
					rpcVoice.startRpcLive(session, emitVoiceEvent, { voice: command.voice }),
				);

			case "stop_live":
				return moduleCommand(id, "stop_live", () => rpcVoice.stopRpcLive(session));

			case "get_live_status":
				return moduleCommand(id, "get_live_status", () => rpcVoice.getRpcLiveStatus(session));

			case "toggle_live_mute":
				return moduleCommand(id, "toggle_live_mute", () => rpcVoice.toggleRpcLiveMute(session));

			case "start_stt":
				return moduleCommand(id, "start_stt", () => rpcVoice.startRpcStt(session, emitVoiceEvent));

			case "stop_stt":
				return moduleCommand(id, "stop_stt", () => rpcVoice.stopRpcStt(session));

			case "toggle_stt":
				return moduleCommand(id, "toggle_stt", () => rpcVoice.toggleRpcStt(session, emitVoiceEvent));

			case "get_stt_status":
				return moduleCommand(id, "get_stt_status", () => rpcVoice.getRpcSttStatus(session));

			case "speak_text":
				return moduleCommand(id, "speak_text", () => rpcVoice.speakRpcText(session, command.text));

			case "clear_speech":
				return moduleCommand(id, "clear_speech", () => rpcVoice.clearRpcSpeech(session));

			case "duck_speech":
				return moduleCommand(id, "duck_speech", () => rpcVoice.duckRpcSpeech(session));

			case "unduck_speech":
				return moduleCommand(id, "unduck_speech", () => rpcVoice.unduckRpcSpeech(session));

			case "get_speech_status":
				return moduleCommand(id, "get_speech_status", () => rpcVoice.getRpcSpeechStatus(session));

			case "set_speech_settings":
				return moduleCommand(id, "set_speech_settings", () =>
					rpcVoice.applyRpcSpeechSettings(session, { enabled: command.enabled, mode: command.mode }),
				);

			// =================================================================
			// Collaboration
			// =================================================================

			case "start_collab_hosting":
				return moduleCommand(id, "start_collab_hosting", () =>
					rpcCollab.startRpcCollabHosting(session, command.relayUrl, eventBus),
				);

			case "stop_collab_hosting":
				return moduleCommand(id, "stop_collab_hosting", async () => {
					await rpcCollab.stopRpcCollabHosting(session);
					return null;
				});

			case "get_collab_status":
				return moduleCommand(id, "get_collab_status", () => rpcCollab.getRpcCollabStatus(session));

			case "join_collab_session":
				return moduleCommand(id, "join_collab_session", () =>
					rpcCollab.joinRpcCollabSession(
						session,
						command.link,
						eventBus,
						forwardCollabSessionEvent,
						requestCollabUi,
					),
				);

			case "leave_collab_session":
				return moduleCommand(id, "leave_collab_session", async () => {
					await rpcCollab.leaveRpcCollabSession(session);
					return null;
				});
		}
		const exhaustive: never = command;
		const unhandled = exhaustive as { type?: string; id?: string };
		return error(unhandled.id, unhandled.type ?? "unknown", `Unknown command: ${unhandled.type}`);
	};

	// Deferred shutdown (pi.shutdown() from an extension) must not kill the
	// process while a background-dispatched command still owes the client its
	// response frame. The coordinator drains tracked tasks before exiting and
	// re-checks the request as each task settles.
	const shutdownCoordinator = new RpcShutdownCoordinator({
		isShutdownRequested: () => shutdownState.requested,
		performShutdown: async () => {
			// Route through the idempotent session.dispose() so the browser
			// reaper (releaseTabsForOwner) and other bounded teardown run before
			// the process exits. dispose() also emits `session_shutdown`, so we
			// must NOT emit it separately here or the event fires twice. Skipping
			// dispose left OMP-owned Chromium alive after RPC shutdown (#5643).
			unsubscribeSettings();
			unsubscribeRawSse?.();
			unsubscribeProviderRequestObservations?.();
			disposeRpcRuntimeBehaviors();
			rpcWorkModes.disposeRpcWorkModes(session);
			await releaseRpcSessionAttachments();
			await session.dispose();
			// See the EOF path: queued frames must reach stdout before the process dies.
			await stdoutQueue;
			process.exit(0);
		},
	});

	const dispatchFrameDeps: RpcInputFrameDeps = {
		handleCommand,
		output,
		errorResponse: error,
		trackBackgroundTask: task => shutdownCoordinator.track(task),
		pendingExtensionRequests,
		onHostToolResult: frame => hostToolBridge.handleResult(frame),
		onHostToolUpdate: frame => hostToolBridge.handleUpdate(frame),
		onHostUriResult: frame => hostUriBridge.handleResult(frame),
	};

	const inputDispatcher = new RpcInputDispatcher({
		deps: dispatchFrameDeps,
		afterSerialCommand: () => shutdownCoordinator.checkShutdownRequested(),
	});

	// Keep the stdin reader moving: side-channel frames dispatch immediately,
	// ordered commands serialize through inputDispatcher, and explicitly
	// cancellable work runs in the background so its canceller can overtake it.
	// Frames are read line-by-line and parsed here (not via readJsonl)
	// so a single malformed line is reported and the loop keeps running instead of
	// throwing out of the generator and killing the whole process (issue #5194).
	const decoder = new TextDecoder();
	for await (const line of readLines(input ?? Bun.stdin.stream())) {
		const text = decoder.decode(line).trim();
		if (!text) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			output(error(undefined, "parse", `Failed to parse command: ${message}`));
			continue;
		}
		inputDispatcher.dispatch(parsed);
	}

	// stdin closed — RPC client is gone. Fail pending side-channel requests
	// first so active/queued commands can settle, then drain accepted work.
	pendingExtensionRequests.rejectAll("RPC client disconnected before extension UI response completed");
	hostToolBridge.close("RPC client disconnected before host tool execution completed");
	hostUriBridge.clear("RPC client disconnected before host URI request completed");
	await inputDispatcher.drain();
	await shutdownCoordinator.drain();
	subagentRegistry?.dispose();
	unsubscribeSettings();
	unsubscribeRawSse?.();
	unsubscribeProviderRequestObservations?.();
	disposeRpcRuntimeBehaviors();
	rpcWorkModes.disposeRpcWorkModes(session);
	await releaseRpcSessionAttachments();
	// Dispose the main session before exiting so the browser reaper and other
	// bounded teardown run on the stdin-EOF path too (#5643). Idempotent: a
	// prior pi.shutdown() through the coordinator makes this await settle
	// immediately.
	await session.dispose();
	// Frames handed to `writeFrames` are only queued; exiting without awaiting the
	// queue drops already-produced responses and `exec_output` chunks mid-flight.
	await stdoutQueue;
	process.exit(0);
}
