/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { Effort, ImageContent, Model, ToolExample, UsageReport } from "@oh-my-pi/pi-ai";
import type { PythonResult } from "../../eval/py/executor";
import type { BashResult } from "../../exec/bash-executor";
import type {
	ContextUsage,
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
} from "../../extensibility/extensions/types";
import type { MentalModelDetail, MentalModelMode } from "../../hindsight";
import type { SmitherySearchResult } from "../../mcp/smithery-registry";
import type { MCPServerConfig } from "../../mcp/types";
import type {
	AgentSessionEvent,
	RestoredQueuedMessage,
	RoleModelCycleResult,
	SessionStats,
} from "../../session/agent-session";
import type { FileEntry } from "../../session/session-entries";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type {
	AgentProgress,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
} from "../../task";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { AskToolDetails, AskToolInput } from "../../tools/ask";
import type { TodoPhase } from "../../tools/todo";
import type { RpcCompletionApplied, RpcCompletionItem, RpcCompletionResult } from "../completions";
import type { Extension } from "../components/extensions/types";
import type { MCPAddScope } from "../controllers/mcp-command-controller";
import type { RpcLoginProvidersSnapshot } from "./rpc-accounts";
import type { RpcAgentControlResult, RpcBackgroundAgent, RpcControllableAgent } from "./rpc-agent-control";
import type {
	RpcAdvisorConfig,
	RpcAdvisorConfigSnapshot,
	RpcAgentDefinition,
	RpcAgentDefinitionDeleteResult,
	RpcAgentDefinitionDocument,
	RpcAuthoringScope,
	RpcMentalModel,
	RpcMentalModelBulkRefresh,
	RpcMentalModelDeleteResult,
	RpcMentalModelHistory,
	RpcMentalModelList,
	RpcMentalModelOperation,
	RpcMentalModelRefreshOperation,
	RpcMentalModelReloadResult,
	RpcMentalModelSeedResult,
	RpcTtsrGeneratedCandidate,
	RpcTtsrGenerationDelta,
	RpcTtsrRegistration,
	RpcTtsrRemoval,
	RpcTtsrRule,
	RpcTtsrRuleDraft,
} from "./rpc-authoring";
import type { RpcBtwAnswer, RpcBtwAskResult, RpcBtwBranchResult, RpcBtwCancelResult } from "./rpc-btw";
import type { RpcCollabLinks, RpcCollabStatus } from "./rpc-collab";
import type {
	RpcDiagnosticArtifact,
	RpcInspectorEndpoint,
	RpcMcpAuthChallenge,
	RpcRawSseSnapshot,
	RpcRecentLogs,
	RpcStartupWarnings,
	RpcSystemInfo,
} from "./rpc-diagnostics";
import type { RpcKeybinding, RpcPromptHistoryEntry } from "./rpc-editor-state";
import type {
	RpcMCPOAuthBegin,
	RpcMCPOAuthResult,
	RpcMCPRegistrySearchResult,
	RpcMCPReloadResult,
	RpcMCPServerResult,
	RpcMCPSmitheryLoginBegin,
	RpcMCPSmitheryLoginResult,
} from "./rpc-mcp";
import type { RpcMessagesPage } from "./rpc-messages";
import type { RpcModelRoleScope, RpcModelRolesSnapshot } from "./rpc-model-roles";
import type {
	RpcLoopAction,
	RpcLoopState,
	RpcPauseResult,
	RpcPauseState,
	RpcSessionTreeSnapshot,
} from "./rpc-runtime-control";
import type { RpcSessionView } from "./rpc-session-view";
import type { RpcSettingsSnapshot } from "./rpc-settings";
import type { RpcThemeSnapshot } from "./rpc-theme";
import type { RpcLiveStatus, RpcSpeechMode, RpcSpeechStatus, RpcSttStatus, RpcVoiceEvent } from "./rpc-voice";
import type {
	RpcGoalModeSnapshot,
	RpcGuidedGoalSnapshot,
	RpcPlanDecisionResult as RpcPlanDecisionResultBase,
	RpcPlanFinalizationStrategy,
	RpcPlanModeSnapshot as RpcPlanModeSnapshotBase,
	RpcPlanProposalSnapshot,
	RpcVibeModeSnapshot,
	RpcWorkModeSnapshot as RpcWorkModeSnapshotBase,
} from "./rpc-work-modes";
import type { RpcRepoStatus } from "./rpc-workspace";

export type { UsageReport } from "@oh-my-pi/pi-ai";
export type { MentalModelDetail, MentalModelMode } from "../../hindsight";
export type { SmitherySearchResult } from "../../mcp/smithery-registry";
export type { MCPServerConfig } from "../../mcp/types";
export type { RpcCompletionApplied, RpcCompletionItem, RpcCompletionResult } from "../completions";
export type { MCPAddScope } from "../controllers/mcp-command-controller";
export type { RpcLoginAccount, RpcLoginProvider, RpcLoginProvidersSnapshot } from "./rpc-accounts";
export type {
	RpcAgentControlResult,
	RpcBackgroundAgent,
	RpcControllableAgent,
	RpcControllableAgentStatus,
} from "./rpc-agent-control";
export type {
	RpcAdvisorConfig,
	RpcAdvisorConfigSnapshot,
	RpcAgentDefinition,
	RpcAgentDefinitionDeleteResult,
	RpcAgentDefinitionDocument,
	RpcAuthoringScope,
	RpcMentalModel,
	RpcMentalModelBulkRefresh,
	RpcMentalModelDeleteResult,
	RpcMentalModelHistory,
	RpcMentalModelList,
	RpcMentalModelOperation,
	RpcMentalModelRefreshOperation,
	RpcMentalModelReloadResult,
	RpcMentalModelSeedResult,
	RpcTtsrGeneratedCandidate,
	RpcTtsrGenerationDelta,
	RpcTtsrRegistration,
	RpcTtsrRemoval,
	RpcTtsrRule,
	RpcTtsrRuleDraft,
} from "./rpc-authoring";
export type { RpcBtwAnswer, RpcBtwAskResult, RpcBtwBranchResult, RpcBtwCancelResult } from "./rpc-btw";
export type { RpcCollabLinks, RpcCollabParticipant, RpcCollabStatus } from "./rpc-collab";
export type {
	RpcDiagnosticArtifact,
	RpcInspectorEndpoint,
	RpcMcpAuthChallenge,
	RpcRawSseRecord,
	RpcRawSseSnapshot,
	RpcRecentLogs,
	RpcStartupWarnings,
	RpcSystemInfo,
} from "./rpc-diagnostics";
export type { RpcKeybinding, RpcPromptHistoryEntry } from "./rpc-editor-state";
export type {
	RpcMCPOAuthBegin,
	RpcMCPOAuthResult,
	RpcMCPRegistrySearchResult,
	RpcMCPReloadResult,
	RpcMCPServerResult,
	RpcMCPSmitheryLoginBegin,
	RpcMCPSmitheryLoginResult,
} from "./rpc-mcp";
export type {
	RpcModelRole,
	RpcModelRoleProvenance,
	RpcModelRoleScope,
	RpcModelRolesSnapshot,
} from "./rpc-model-roles";
export type {
	RpcLoopAction,
	RpcLoopLimit,
	RpcLoopState,
	RpcPauseResult,
	RpcPauseState,
	RpcSessionTreeNode,
	RpcSessionTreeSnapshot,
} from "./rpc-runtime-control";
export type { RpcSessionView } from "./rpc-session-view";
export type { RpcSettingDescriptor, RpcSettingsSnapshot } from "./rpc-settings";
export type { RpcThemeSnapshot } from "./rpc-theme";
export type {
	RpcLiveLevelsEvent,
	RpcLivePhase,
	RpcLivePhaseEvent,
	RpcLiveStartOptions,
	RpcLiveStatus,
	RpcLiveTerminalEvent,
	RpcLiveTranscriptEvent,
	RpcSpeechMode,
	RpcSpeechSettings,
	RpcSpeechStatus,
	RpcSttNoticeEvent,
	RpcSttStateEvent,
	RpcSttStatus,
	RpcSttTranscriptEvent,
	RpcVoiceEvent,
} from "./rpc-voice";
export type {
	RpcGoalBudgetSnapshot,
	RpcGoalDescriptor,
	RpcGoalModeSnapshot,
	RpcGuidedGoalSnapshot,
	RpcPlanFinalizationStrategy,
	RpcPlanProposalSnapshot,
	RpcVibeModeSnapshot,
	RpcVibeWorkerSnapshot,
} from "./rpc-work-modes";

export interface RpcPlanModeSnapshot extends RpcPlanModeSnapshotBase {
	paused: boolean;
}

export type RpcPlanDecisionResult = Omit<RpcPlanDecisionResultBase, "state"> & {
	state: RpcPlanModeSnapshot;
};

export type RpcWorkModeSnapshot = Omit<RpcWorkModeSnapshotBase, "plan"> & {
	plan: RpcPlanModeSnapshot;
};
export type { RpcRepoStatus } from "./rpc-workspace";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

export type RpcCommand =
	// Protocol
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }

	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "ask_btw"; question: string }
	| { id?: string; type: "get_last_btw_answer" }
	| { id?: string; type: "cancel_btw" }
	| { id?: string; type: "branch_btw" }
	| { id?: string; type: "complete"; lines: string[]; cursor: { line: number; column: number } }
	| {
			id?: string;
			type: "apply_completion";
			lines: string[];
			cursor: { line: number; column: number };
			item: RpcCompletionItem;
	  }
	| { id?: string; type: "publish_editor_text"; text: string }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "get_settings" }
	| { id?: string; type: "set_setting"; path: string; value: unknown }
	| { id?: string; type: "get_extensions"; cwd?: string }
	| { id?: string; type: "get_repo_status"; cwd?: string; includePr?: boolean }
	| { id?: string; type: "get_usage_reports" }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "subscribe_provider_request_observations" }
	| { id?: string; type: "unsubscribe_provider_request_observations" }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }

	// Work modes
	| { id?: string; type: "enter_plan_mode"; planFilePath?: string; workflow?: "parallel" | "iterative" }
	| { id?: string; type: "pause_plan_mode" }
	| { id?: string; type: "resume_plan_mode" }
	| { id?: string; type: "exit_plan_mode" }
	| { id?: string; type: "get_plan_mode_state" }
	| { id?: string; type: "submit_plan_review"; title?: string }
	| {
			id?: string;
			type: "approve_plan_proposal";
			editedContent?: string;
			strategy?: RpcPlanFinalizationStrategy;
			executionModel?: { provider: string; modelId: string };
			thinkingLevel?: ConfiguredThinkingLevel;
	  }
	| { id?: string; type: "reject_plan_proposal"; feedback?: string }
	| { id?: string; type: "create_goal"; objective: string; tokenBudget?: number }
	| { id?: string; type: "pause_goal" }
	| { id?: string; type: "resume_goal" }
	| { id?: string; type: "switch_goal"; objective: string; tokenBudget?: number }
	| { id?: string; type: "clear_goal" }
	| { id?: string; type: "set_goal_budget"; tokenBudget: number | null }
	| { id?: string; type: "get_goal_state" }
	| { id?: string; type: "begin_guided_goal"; initialObjective: string }
	| { id?: string; type: "answer_guided_goal"; answer: string }
	| { id?: string; type: "accept_guided_goal"; objective: string }
	| { id?: string; type: "cancel_guided_goal" }
	| { id?: string; type: "get_guided_goal_state" }
	| { id?: string; type: "enter_vibe_mode" }
	| { id?: string; type: "exit_vibe_mode" }
	| { id?: string; type: "get_vibe_mode_state" }
	| { id?: string; type: "get_work_mode_state" }

	// Runtime control
	| {
			id?: string;
			type: "enable_loop";
			prompt: string;
			action?: RpcLoopAction;
			count?: number;
			durationMs?: number;
	  }
	| { id?: string; type: "disable_loop" }
	| { id?: string; type: "get_loop_state" }
	| { id?: string; type: "cancel_loop_iteration" }
	| { id?: string; type: "pause_agents" }
	| { id?: string; type: "resume_agents" }
	| { id?: string; type: "get_pause_state" }
	| { id?: string; type: "get_session_tree" }

	// Agent control
	| { id?: string; type: "get_controllable_agents" }
	| { id?: string; type: "revive_agent"; agentId: string }
	| { id?: string; type: "kill_agent"; agentId: string }
	| { id?: string; type: "prompt_agent"; agentId: string; text: string }
	| { id?: string; type: "spawn_background_agent"; work: string }

	// Authoring
	| { id?: string; type: "get_advisor_config"; scope: RpcAuthoringScope }
	| {
			id?: string;
			type: "set_advisor_config";
			scope: RpcAuthoringScope;
			instructions: string | null;
			advisors: RpcAdvisorConfig[];
	  }
	| {
			id?: string;
			type: "generate_ttsr_rule";
			complaint: string;
			feedback?: string;
			previousRule?: string;
	  }
	| {
			id?: string;
			type: "build_ttsr_rule";
			name: string;
			description: string;
			conditions: string[];
			scopes: string[];
			body: string;
	  }
	| {
			id?: string;
			type: "register_ttsr_rule";
			scope: RpcAuthoringScope;
			name: string;
			description: string;
			conditions: string[];
			scopes: string[];
			body: string;
			overwrite: boolean;
	  }
	| { id?: string; type: "get_ttsr_rules" }
	| { id?: string; type: "remove_ttsr_rule"; name: string; deletePersisted: boolean }
	| { id?: string; type: "get_agent_definitions" }
	| { id?: string; type: "get_agent_definition"; name: string; scope: RpcAuthoringScope | null }
	| {
			id?: string;
			type: "set_agent_definition";
			scope: RpcAuthoringScope;
			name: string;
			content: string;
			overwrite: boolean;
	  }
	| { id?: string; type: "delete_agent_definition"; scope: RpcAuthoringScope; name: string }
	| { id?: string; type: "get_mental_models"; detail: MentalModelDetail }
	| { id?: string; type: "get_mental_model"; mentalModelId: string; detail: MentalModelDetail }
	| {
			id?: string;
			type: "create_mental_model";
			name: string;
			sourceQuery: string;
			mentalModelId: string | null;
			tags: string[] | null;
			maxTokens: number | null;
			mode: MentalModelMode | null;
			refreshAfterConsolidation: boolean | null;
	  }
	| { id?: string; type: "refresh_mental_model"; mentalModelId: string }
	| { id?: string; type: "refresh_auto_mental_models" }
	| { id?: string; type: "get_mental_model_history"; mentalModelId: string }
	| { id?: string; type: "seed_mental_models" }
	| { id?: string; type: "delete_mental_model"; mentalModelId: string }
	| { id?: string; type: "reload_mental_models" }

	// Presentation
	| { id?: string; type: "get_theme" }
	| { id?: string; type: "get_keybindings" }
	| { id?: string; type: "get_session_view" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| {
			id?: string;
			type: "set_model_temporary";
			provider: string;
			modelId: string;
			thinkingLevel?: ConfiguredThinkingLevel;
			ephemeral?: boolean;
	  }
	| { id?: string; type: "cycle_model"; direction?: "forward" | "backward" }
	| { id?: string; type: "cycle_role_models"; roleOrder: string[]; direction?: "forward" | "backward" }
	| { id?: string; type: "get_available_models" }
	| { id?: string; type: "get_model_roles" }
	| { id?: string; type: "set_model_role"; role: string; model: string; scope: RpcModelRoleScope }
	| { id?: string; type: "clear_model_role"; role: string; scope: RpcModelRoleScope }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }
	| { id?: string; type: "get_queued_messages" }
	| { id?: string; type: "pop_queued_message" }
	| { id?: string; type: "clear_queue" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "retry" }
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| {
			id?: string;
			type: "bash";
			command: string;
			excludeFromContext?: boolean;
			useUserShell?: boolean;
			followCwd?: boolean;
	  }
	| { id?: string; type: "abort_bash" }
	| { id?: string; type: "python"; code: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_python" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	/** Absolute session path, session-id prefix, filename prefix, or partial title. */
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "get_sessions"; scope?: "cwd" | "all"; cwd?: string; query?: string; limit?: number }
	| { id?: string; type: "delete_session"; sessionPath: string }
	| { id?: string; type: "get_prompt_history"; cwd?: string; query?: string; limit?: number }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "fork" }
	| {
			id?: string;
			type: "navigate_tree";
			targetId: string;
			summarize?: boolean;
			customInstructions?: string;
			allowAskReopen?: boolean;
			reanswerAskResult?: AgentToolResult<AskToolDetails>;
	  }
	| { id?: string; type: "resume_after_ask_reanswer" }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "generate_title"; text: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "logout"; providerId: string; credentialId: number }
	| { id?: string; type: "remove_login_account"; providerId: string; credentialId: number }
	| { id?: string; type: "remove_provider_credentials"; providerId: string }

	// MCP
	| { id?: string; type: "mcp_add_server"; name: string; config: MCPServerConfig; scope: MCPAddScope }
	| { id?: string; type: "mcp_remove_server"; name: string; scope: MCPAddScope }
	| { id?: string; type: "mcp_set_server_enabled"; name: string; enabled: boolean }
	| { id?: string; type: "mcp_reload" }
	| { id?: string; type: "mcp_reconnect_server"; name: string }
	| { id?: string; type: "mcp_unauth_server"; name: string }
	| { id?: string; type: "mcp_begin_reauth"; name: string }
	| { id?: string; type: "mcp_complete_reauth"; flowId: string; completion?: string }
	| { id?: string; type: "mcp_cancel_reauth"; flowId: string }
	| { id?: string; type: "mcp_begin_smithery_login" }
	| { id?: string; type: "mcp_complete_smithery_login"; sessionId: string; apiKey?: string }
	| { id?: string; type: "mcp_logout_smithery" }
	| { id?: string; type: "mcp_search_registry"; query: string; limit?: number; semantic?: boolean }
	| {
			id?: string;
			type: "mcp_deploy_registry_result";
			result: SmitherySearchResult;
			scope: MCPAddScope;
			name?: string;
			values: Record<string, string>;
	  }

	// Diagnostics
	| { id?: string; type: "start_cpu_profile" }
	| { id?: string; type: "stop_cpu_profile" }
	| { id?: string; type: "create_heap_profile" }
	| { id?: string; type: "create_support_bundle" }
	| { id?: string; type: "create_work_profile" }
	| { id?: string; type: "get_recent_logs"; maxLines?: number; olderDays?: number }
	| { id?: string; type: "get_raw_sse" }
	| { id?: string; type: "subscribe_raw_sse" }
	| { id?: string; type: "unsubscribe_raw_sse" }
	| { id?: string; type: "start_inspector" }
	| { id?: string; type: "get_system_info" }
	| { id?: string; type: "get_startup_warnings" }
	| { id?: string; type: "get_artifacts_directory" }
	| { id?: string; type: "clear_artifact_cache"; daysOld?: number }
	| { id?: string; type: "get_mcp_auth_challenges" }
	| { id?: string; type: "resolve_mcp_auth_challenge"; challengeId: string; config?: MCPServerConfig }

	// Voice
	| { id?: string; type: "start_live"; voice?: string }
	| { id?: string; type: "stop_live" }
	| { id?: string; type: "get_live_status" }
	| { id?: string; type: "toggle_live_mute" }
	| { id?: string; type: "start_stt" }
	| { id?: string; type: "stop_stt" }
	| { id?: string; type: "toggle_stt" }
	| { id?: string; type: "get_stt_status" }
	| { id?: string; type: "speak_text"; text: string }
	| { id?: string; type: "clear_speech" }
	| { id?: string; type: "duck_speech" }
	| { id?: string; type: "unduck_speech" }
	| { id?: string; type: "get_speech_status" }
	| { id?: string; type: "set_speech_settings"; enabled?: boolean; mode?: RpcSpeechMode }

	// Collaboration
	| { id?: string; type: "start_collab_hosting"; relayUrl?: string }
	| { id?: string; type: "stop_collab_hosting" }
	| { id?: string; type: "get_collab_status" }
	| { id?: string; type: "join_collab_session"; link: string }
	| { id?: string; type: "leave_collab_session" };

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	isRetrying: boolean;
	isBashRunning: boolean;
	isAborting: boolean;
	isGeneratingHandoff: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	queuedMessageCount: number;
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	configWarnings: string[];
	skillWarnings: Array<{ skillPath: string; message: string }>;
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}

/** Incremental output from an executing bash or Python command. */
export interface RpcExecOutputFrame {
	type: "exec_output";
	source: "bash" | "python";
	id?: string;
	chunk: string;
}

/** Incremental text from an ephemeral `/btw` side turn. */
export interface RpcBtwOutputFrame {
	type: "btw_output";
	id?: string;
	chunk: string;
}

/** Emitted whenever a setting's effective value changes. */
export interface RpcSettingsUpdateFrame {
	type: "settings_update";
	path: string;
	value: unknown;
}

/** Generated `/omfg` draft progress for a specific request. */
export interface RpcTtsrGenerationEventFrame {
	type: "ttsr_generation_event";
	id?: string;
	event: RpcTtsrGenerationDelta;
}

/** Recap produced after the configured RPC idle period. */
export interface RpcIdleRecapFrame {
	type: "idle_recap";
	recap: string;
}

/** Raw SSE debug snapshot pushed after `subscribe_raw_sse`, until `unsubscribe_raw_sse`. */
export interface RpcRawSseUpdateFrame {
	type: "raw_sse_update";
	snapshot: RpcRawSseSnapshot;
}

/**
 * Emitted when an MCP server answers a tool call with a `WWW-Authenticate`
 * challenge. The call blocks until the client answers with
 * `resolve_mcp_auth_challenge`; answering without a `config` fails the call.
 */
export interface RpcMcpAuthChallengeFrame {
	type: "mcp_auth_challenge";
	challenge: RpcMcpAuthChallenge;
}

/** Live-session and speech-to-text activity emitted while voice capture is running. */
export interface RpcVoiceEventFrame {
	type: "voice_event";
	event: RpcVoiceEvent;
}

export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	agentInvoked: boolean;
}

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: [1, 2];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcHandoffResult {
	savedPath?: string;
}
export interface RpcQueuedMessages {
	steering: RestoredQueuedMessage[];
	followUp: RestoredQueuedMessage[];
}

export interface RpcNavigateTreeOptions {
	summarize?: boolean;
	customInstructions?: string;
	allowAskReopen?: boolean;
	reanswerAskResult?: AgentToolResult<AskToolDetails>;
}

export interface RpcNavigateTreeResult {
	editorText?: string;
	cancelled: boolean;
	aborted?: boolean;
	reopenAsk?: { toolCallId: string; questions: AskToolInput["questions"] };
	askReanswerCommitted?: boolean;
}

export interface RpcGenerateTitleResult {
	title: string | null;
	applied: boolean;
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

/** Session metadata without the full message body. Dates are ISO-8601 strings. */
export interface RpcSessionListEntry {
	path: string;
	id: string;
	cwd: string;
	title?: string;
	parentSessionPath?: string;
	created: string;
	modified: string;
	messageCount: number;
	size: number;
	firstMessage: string;
	status?: string;
}

/** Extension metadata with secret-bearing raw capability data removed. */
export type RpcExtension = Omit<Extension, "raw">;

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Protocol
	| {
			id?: string;
			type: "response";
			command: "negotiate_protocol";
			success: true;
			data: { protocolVersion: 2 };
	  }

	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; data?: { agentInvoked: boolean } }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| { id?: string; type: "response"; command: "ask_btw"; success: true; data: RpcBtwAskResult }
	| {
			id?: string;
			type: "response";
			command: "get_last_btw_answer";
			success: true;
			data: { answer: RpcBtwAnswer | null };
	  }
	| { id?: string; type: "response"; command: "cancel_btw"; success: true; data: RpcBtwCancelResult }
	| { id?: string; type: "response"; command: "branch_btw"; success: true; data: RpcBtwBranchResult }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "complete"; success: true; data: RpcCompletionResult }
	| { id?: string; type: "response"; command: "apply_completion"; success: true; data: RpcCompletionApplied }
	| { id?: string; type: "response"; command: "publish_editor_text"; success: true }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| { id?: string; type: "response"; command: "get_settings"; success: true; data: RpcSettingsSnapshot }
	| {
			id?: string;
			type: "response";
			command: "set_setting";
			success: true;
			data: { path: string; value: unknown; configured: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_extensions";
			success: true;
			data: { extensions: RpcExtension[] };
	  }
	| { id?: string; type: "response"; command: "get_repo_status"; success: true; data: RpcRepoStatus }
	| {
			id?: string;
			type: "response";
			command: "get_usage_reports";
			success: true;
			data: { reports: UsageReport[] };
	  }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "subscribe_provider_request_observations";
			success: true;
			data: { subscribed: true };
	  }
	| {
			id?: string;
			type: "response";
			command: "unsubscribe_provider_request_observations";
			success: true;
			data: { subscribed: false };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }

	// Work modes
	| { id?: string; type: "response"; command: "enter_plan_mode"; success: true; data: RpcPlanModeSnapshot }
	| { id?: string; type: "response"; command: "pause_plan_mode"; success: true; data: RpcPlanModeSnapshot }
	| { id?: string; type: "response"; command: "resume_plan_mode"; success: true; data: RpcPlanModeSnapshot }
	| { id?: string; type: "response"; command: "exit_plan_mode"; success: true; data: RpcPlanModeSnapshot }
	| { id?: string; type: "response"; command: "get_plan_mode_state"; success: true; data: RpcPlanModeSnapshot }
	| { id?: string; type: "response"; command: "submit_plan_review"; success: true; data: RpcPlanProposalSnapshot }
	| {
			id?: string;
			type: "response";
			command: "approve_plan_proposal";
			success: true;
			data: RpcPlanDecisionResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "reject_plan_proposal";
			success: true;
			data: RpcPlanDecisionResult;
	  }
	| { id?: string; type: "response"; command: "create_goal"; success: true; data: RpcGoalModeSnapshot }
	| { id?: string; type: "response"; command: "pause_goal"; success: true; data: RpcGoalModeSnapshot }
	| { id?: string; type: "response"; command: "resume_goal"; success: true; data: RpcGoalModeSnapshot }
	| { id?: string; type: "response"; command: "switch_goal"; success: true; data: RpcGoalModeSnapshot }
	| { id?: string; type: "response"; command: "clear_goal"; success: true; data: RpcGoalModeSnapshot }
	| { id?: string; type: "response"; command: "set_goal_budget"; success: true; data: RpcGoalModeSnapshot }
	| { id?: string; type: "response"; command: "get_goal_state"; success: true; data: RpcGoalModeSnapshot }
	| {
			id?: string;
			type: "response";
			command: "begin_guided_goal";
			success: true;
			data: RpcGuidedGoalSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "answer_guided_goal";
			success: true;
			data: RpcGuidedGoalSnapshot;
	  }
	| { id?: string; type: "response"; command: "accept_guided_goal"; success: true; data: RpcGoalModeSnapshot }
	| {
			id?: string;
			type: "response";
			command: "cancel_guided_goal";
			success: true;
			data: RpcGuidedGoalSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_guided_goal_state";
			success: true;
			data: RpcGuidedGoalSnapshot;
	  }
	| { id?: string; type: "response"; command: "enter_vibe_mode"; success: true; data: RpcVibeModeSnapshot }
	| { id?: string; type: "response"; command: "exit_vibe_mode"; success: true; data: RpcVibeModeSnapshot }
	| { id?: string; type: "response"; command: "get_vibe_mode_state"; success: true; data: RpcVibeModeSnapshot }
	| { id?: string; type: "response"; command: "get_work_mode_state"; success: true; data: RpcWorkModeSnapshot }

	// Runtime control
	| { id?: string; type: "response"; command: "enable_loop"; success: true; data: RpcLoopState }
	| { id?: string; type: "response"; command: "disable_loop"; success: true; data: RpcLoopState }
	| { id?: string; type: "response"; command: "get_loop_state"; success: true; data: RpcLoopState }
	| { id?: string; type: "response"; command: "cancel_loop_iteration"; success: true; data: RpcLoopState }
	| { id?: string; type: "response"; command: "pause_agents"; success: true; data: RpcPauseResult }
	| { id?: string; type: "response"; command: "resume_agents"; success: true; data: RpcPauseResult }
	| { id?: string; type: "response"; command: "get_pause_state"; success: true; data: RpcPauseState }
	| { id?: string; type: "response"; command: "get_session_tree"; success: true; data: RpcSessionTreeSnapshot }

	// Agent control
	| {
			id?: string;
			type: "response";
			command: "get_controllable_agents";
			success: true;
			data: RpcControllableAgent[];
	  }
	| { id?: string; type: "response"; command: "revive_agent"; success: true; data: RpcControllableAgent }
	| { id?: string; type: "response"; command: "kill_agent"; success: true; data: RpcAgentControlResult }
	| { id?: string; type: "response"; command: "prompt_agent"; success: true; data: RpcControllableAgent }
	| {
			id?: string;
			type: "response";
			command: "spawn_background_agent";
			success: true;
			data: RpcBackgroundAgent;
	  }

	// Authoring
	| {
			id?: string;
			type: "response";
			command: "get_advisor_config";
			success: true;
			data: RpcAdvisorConfigSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_advisor_config";
			success: true;
			data: RpcAdvisorConfigSnapshot;
	  }
	| {
			id?: string;
			type: "response";
			command: "generate_ttsr_rule";
			success: true;
			data: RpcTtsrGeneratedCandidate;
	  }
	| { id?: string; type: "response"; command: "build_ttsr_rule"; success: true; data: RpcTtsrRuleDraft }
	| {
			id?: string;
			type: "response";
			command: "register_ttsr_rule";
			success: true;
			data: RpcTtsrRegistration;
	  }
	| { id?: string; type: "response"; command: "get_ttsr_rules"; success: true; data: RpcTtsrRule[] }
	| { id?: string; type: "response"; command: "remove_ttsr_rule"; success: true; data: RpcTtsrRemoval }
	| {
			id?: string;
			type: "response";
			command: "get_agent_definitions";
			success: true;
			data: RpcAgentDefinition[];
	  }
	| {
			id?: string;
			type: "response";
			command: "get_agent_definition";
			success: true;
			data: RpcAgentDefinitionDocument | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_agent_definition";
			success: true;
			data: RpcAgentDefinitionDocument;
	  }
	| {
			id?: string;
			type: "response";
			command: "delete_agent_definition";
			success: true;
			data: RpcAgentDefinitionDeleteResult;
	  }
	| { id?: string; type: "response"; command: "get_mental_models"; success: true; data: RpcMentalModelList }
	| {
			id?: string;
			type: "response";
			command: "get_mental_model";
			success: true;
			data: RpcMentalModel | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "create_mental_model";
			success: true;
			data: RpcMentalModelOperation;
	  }
	| {
			id?: string;
			type: "response";
			command: "refresh_mental_model";
			success: true;
			data: RpcMentalModelRefreshOperation;
	  }
	| {
			id?: string;
			type: "response";
			command: "refresh_auto_mental_models";
			success: true;
			data: RpcMentalModelBulkRefresh;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_mental_model_history";
			success: true;
			data: RpcMentalModelHistory | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "seed_mental_models";
			success: true;
			data: RpcMentalModelSeedResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "delete_mental_model";
			success: true;
			data: RpcMentalModelDeleteResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "reload_mental_models";
			success: true;
			data: RpcMentalModelReloadResult;
	  }

	// Presentation
	| { id?: string; type: "response"; command: "get_theme"; success: true; data: RpcThemeSnapshot }
	| {
			id?: string;
			type: "response";
			command: "get_keybindings";
			success: true;
			data: { keybindings: RpcKeybinding[] };
	  }
	| { id?: string; type: "response"; command: "get_session_view"; success: true; data: RpcSessionView }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "set_model_temporary";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_role_models";
			success: true;
			data: RoleModelCycleResult | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }
	| { id?: string; type: "response"; command: "get_model_roles"; success: true; data: RpcModelRolesSnapshot }
	| { id?: string; type: "response"; command: "set_model_role"; success: true; data: RpcModelRolesSnapshot }
	| { id?: string; type: "response"; command: "clear_model_role"; success: true; data: RpcModelRolesSnapshot }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }
	| { id?: string; type: "response"; command: "get_queued_messages"; success: true; data: RpcQueuedMessages }
	| {
			id?: string;
			type: "response";
			command: "pop_queued_message";
			success: true;
			data: { message: RestoredQueuedMessage | null };
	  }
	| { id?: string; type: "response"; command: "clear_queue"; success: true; data: RpcQueuedMessages }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }
	| { id?: string; type: "response"; command: "retry"; success: true; data: { retried: boolean } }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }
	| { id?: string; type: "response"; command: "python"; success: true; data: PythonResult }
	| { id?: string; type: "response"; command: "abort_python"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_sessions";
			success: true;
			data: { sessions: RpcSessionListEntry[]; total: number };
	  }
	| {
			id?: string;
			type: "response";
			command: "delete_session";
			success: true;
			data: { sessionPath: string };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_prompt_history";
			success: true;
			data: { entries: RpcPromptHistoryEntry[] };
	  }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "navigate_tree"; success: true; data: RpcNavigateTreeResult }
	| { id?: string; type: "response"; command: "resume_after_ask_reanswer"; success: true }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	| { id?: string; type: "response"; command: "generate_title"; success: true; data: RpcGenerateTitleResult }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "get_messages_page"; success: true; data: RpcMessagesPage }

	// Login
	| { id?: string; type: "response"; command: "get_login_providers"; success: true; data: RpcLoginProvidersSnapshot }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }
	| {
			id?: string;
			type: "response";
			command: "logout";
			success: true;
			data: { providerId: string; credentialId: number; removed: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "remove_login_account";
			success: true;
			data: { providerId: string; credentialId: number; removed: boolean };
	  }
	| {
			id?: string;
			type: "response";
			command: "remove_provider_credentials";
			success: true;
			data: { providerId: string };
	  }

	// MCP
	| { id?: string; type: "response"; command: "mcp_add_server"; success: true; data: RpcMCPServerResult }
	| { id?: string; type: "response"; command: "mcp_remove_server"; success: true; data: RpcMCPServerResult }
	| { id?: string; type: "response"; command: "mcp_set_server_enabled"; success: true; data: RpcMCPServerResult }
	| { id?: string; type: "response"; command: "mcp_reload"; success: true; data: RpcMCPReloadResult }
	| { id?: string; type: "response"; command: "mcp_reconnect_server"; success: true; data: RpcMCPServerResult }
	| { id?: string; type: "response"; command: "mcp_unauth_server"; success: true; data: RpcMCPServerResult }
	| { id?: string; type: "response"; command: "mcp_begin_reauth"; success: true; data: RpcMCPOAuthBegin }
	| { id?: string; type: "response"; command: "mcp_complete_reauth"; success: true; data: RpcMCPOAuthResult }
	| { id?: string; type: "response"; command: "mcp_cancel_reauth"; success: true }
	| {
			id?: string;
			type: "response";
			command: "mcp_begin_smithery_login";
			success: true;
			data: RpcMCPSmitheryLoginBegin;
	  }
	| {
			id?: string;
			type: "response";
			command: "mcp_complete_smithery_login";
			success: true;
			data: RpcMCPSmitheryLoginResult;
	  }
	| { id?: string; type: "response"; command: "mcp_logout_smithery"; success: true; data: { removed: boolean } }
	| {
			id?: string;
			type: "response";
			command: "mcp_search_registry";
			success: true;
			data: RpcMCPRegistrySearchResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "mcp_deploy_registry_result";
			success: true;
			data: RpcMCPServerResult;
	  }

	// Diagnostics
	| { id?: string; type: "response"; command: "start_cpu_profile"; success: true; data: null }
	| { id?: string; type: "response"; command: "stop_cpu_profile"; success: true; data: RpcDiagnosticArtifact }
	| { id?: string; type: "response"; command: "create_heap_profile"; success: true; data: RpcDiagnosticArtifact }
	| { id?: string; type: "response"; command: "create_support_bundle"; success: true; data: RpcDiagnosticArtifact }
	| { id?: string; type: "response"; command: "create_work_profile"; success: true; data: RpcDiagnosticArtifact }
	| { id?: string; type: "response"; command: "get_recent_logs"; success: true; data: RpcRecentLogs }
	| { id?: string; type: "response"; command: "get_raw_sse"; success: true; data: RpcRawSseSnapshot }
	| { id?: string; type: "response"; command: "subscribe_raw_sse"; success: true; data: { subscribed: boolean } }
	| { id?: string; type: "response"; command: "unsubscribe_raw_sse"; success: true; data: { subscribed: boolean } }
	| { id?: string; type: "response"; command: "start_inspector"; success: true; data: RpcInspectorEndpoint }
	| { id?: string; type: "response"; command: "get_system_info"; success: true; data: RpcSystemInfo }
	| { id?: string; type: "response"; command: "get_startup_warnings"; success: true; data: RpcStartupWarnings }
	| { id?: string; type: "response"; command: "get_artifacts_directory"; success: true; data: RpcDiagnosticArtifact }
	| { id?: string; type: "response"; command: "clear_artifact_cache"; success: true; data: { removed: number } }
	| {
			id?: string;
			type: "response";
			command: "get_mcp_auth_challenges";
			success: true;
			data: { challenges: RpcMcpAuthChallenge[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "resolve_mcp_auth_challenge";
			success: true;
			data: { resolved: boolean };
	  }

	// Voice
	| { id?: string; type: "response"; command: "start_live"; success: true; data: RpcLiveStatus }
	| { id?: string; type: "response"; command: "stop_live"; success: true; data: RpcLiveStatus }
	| { id?: string; type: "response"; command: "get_live_status"; success: true; data: RpcLiveStatus }
	| { id?: string; type: "response"; command: "toggle_live_mute"; success: true; data: RpcLiveStatus }
	| { id?: string; type: "response"; command: "start_stt"; success: true; data: RpcSttStatus }
	| { id?: string; type: "response"; command: "stop_stt"; success: true; data: RpcSttStatus }
	| { id?: string; type: "response"; command: "toggle_stt"; success: true; data: RpcSttStatus }
	| { id?: string; type: "response"; command: "get_stt_status"; success: true; data: RpcSttStatus }
	| { id?: string; type: "response"; command: "speak_text"; success: true; data: RpcSpeechStatus }
	| { id?: string; type: "response"; command: "clear_speech"; success: true; data: RpcSpeechStatus }
	| { id?: string; type: "response"; command: "duck_speech"; success: true; data: RpcSpeechStatus }
	| { id?: string; type: "response"; command: "unduck_speech"; success: true; data: RpcSpeechStatus }
	| { id?: string; type: "response"; command: "get_speech_status"; success: true; data: RpcSpeechStatus }
	| { id?: string; type: "response"; command: "set_speech_settings"; success: true; data: RpcSpeechStatus }

	// Collaboration
	| { id?: string; type: "response"; command: "start_collab_hosting"; success: true; data: RpcCollabLinks }
	| { id?: string; type: "response"; command: "stop_collab_hosting"; success: true; data: null }
	| { id?: string; type: "response"; command: "get_collab_status"; success: true; data: RpcCollabStatus }
	| { id?: string; type: "response"; command: "join_collab_session"; success: true; data: RpcCollabStatus }
	| { id?: string; type: "response"; command: "leave_collab_session"; success: true; data: null }

	// Error response (any command can fail); `code` is an optional machine-readable reason.
	| { id?: string; type: "response"; command: string; success: false; error: string; code?: string };

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

export type RpcSessionEventFrame = AgentSessionEvent | RpcSubagentFrame;

/** Opt-in, redacted snapshot of the final extension context or provider request body. */
export type RpcProviderRequestObservationFrame =
	| {
			type: "provider_request_observation";
			stage: "context";
			requestId: number;
			messages: RpcJsonValue;
			serializationError?: string;
	  }
	| {
			type: "provider_request_observation";
			stage: "before_provider_request";
			requestId: number;
			payload: RpcJsonValue;
			serializationError?: string;
	  };

/** JSON values emitted by observation frames after the runner snapshots provider inputs. */
export type RpcJsonValue = null | boolean | number | string | RpcJsonValue[] | { [key: string]: RpcJsonValue };

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "askDialog";
			questions: ExtensionAskDialogQuestion[];
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "setWorkingMessage"; message?: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
	  };

/** Emitted when a pending extension dialog is aborted or reaches its timeout. */
export interface RpcExtensionUICancelFrame {
	type: "extension_ui_cancel";
	targetId: string;
	timedOut?: boolean;
}

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; result: ExtensionAskDialogResult }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
