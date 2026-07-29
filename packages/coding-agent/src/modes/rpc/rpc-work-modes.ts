import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { CompactionCancelledError, type CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { isEnoent, logger, prompt } from "@oh-my-pi/pi-utils";
import { formatModelString } from "../../config/model-resolver";
import { remainingTokens } from "../../goals/runtime";
import type { Goal, GoalModeState, GoalStatus } from "../../goals/state";
import { type LocalProtocolOptions, resolveLocalUrlToPath } from "../../internal-urls";
import { humanizePlanTitle, type PlanApprovalDetails } from "../../plan-mode/approved-plan";
import { resolvePlanModelTransition } from "../../plan-mode/model-transition";
import { readPlanFile } from "../../plan-mode/plan-files";
import type { PlanModeState } from "../../plan-mode/state";
import guidedGoalInterviewPrompt from "../../prompts/goals/guided-goal-interview.md" with { type: "text" };
import planModeApprovedPrompt from "../../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../../prompts/system/plan-mode-compact-instructions.md" with {
	type: "text",
};
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { ConfiguredThinkingLevel } from "../../thinking";
import type { ToolSession } from "../../tools";
import { normalizeLocalScheme, resolveToCwd } from "../../tools/path-utils";
import { type PlanProposalHandler, PROPOSE_DEVICE_NAME, writeDeviceDispatch } from "../../tools/resolve";
import { VIBE_TOOL_NAMES } from "../../tools/vibe";
import {
	type VibeOwnerScope,
	type VibeParentSession,
	type VibeScopeSuspension,
	VibeSessionRegistry,
} from "../../vibe/runtime";
import type { VibeModeState } from "../../vibe/state";
import { readRpcLoopState } from "./rpc-runtime-control";
import { assertRpcSessionTransitionAllowed } from "./rpc-session-guard";

const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";

export interface RpcPlanProposalSnapshot {
	planFilePath: string;
	title: string;
	content: string;
}

export interface RpcPlanModeSnapshot {
	enabled: boolean;
	planFilePath: string | null;
	workflow: "parallel" | "iterative" | null;
	reentry: boolean;
	proposal: RpcPlanProposalSnapshot | null;
}
export type RpcPlanFinalizationStrategy = "execute" | "keep-context" | "compact-context";

export interface RpcPlanDecisionResult {
	decision: "approved" | "rejected";
	planFilePath: string;
	title: string;
	state: RpcPlanModeSnapshot;
	/** Present only when approving with the `compact-context` strategy. */
	compaction?: {
		outcome: CompactionOutcome;
		error?: string;
	};
}

export interface RpcGoalDescriptor {
	id: string;
	objective: string;
	status: GoalStatus;
	tokensUsed: number;
	timeUsedSeconds: number;
	createdAt: number;
	updatedAt: number;
}

export interface RpcGoalBudgetSnapshot {
	limit: number | null;
	used: number;
	remaining: number | null;
}

export interface RpcGoalModeSnapshot {
	enabled: boolean;
	paused: boolean;
	mode: "active" | "exiting" | null;
	reason: "completed" | null;
	goal: RpcGoalDescriptor | null;
	budget: RpcGoalBudgetSnapshot | null;
}

export interface RpcGuidedGoalKickoffResult {
	queued: boolean;
}

export interface RpcVibeWorkerSnapshot {
	id: string;
	cli: "fast" | "good";
	state: "starting" | "running" | "idle" | "dead";
	model: string | null;
	turns: number;
	queued: number;
	turnStartedAt: number | null;
	turnMessage: string | null;
	currentTool: string | null;
	currentToolArgs: string | null;
	lastIntent: string | null;
	trace: string[];
	outputTail: string[];
	lastActivity: string | null;
	lastActivityAt: number;
}

export interface RpcVibeModeSnapshot {
	enabled: boolean;
	activeTools: string[];
	ephemeralTools: string[];
	workers: RpcVibeWorkerSnapshot[];
}

export interface RpcWorkModeSnapshot {
	activeMode: "plan" | "goal" | "vibe" | null;
	proposalPending: boolean;
	plan: RpcPlanModeSnapshot;
	goal: RpcGoalModeSnapshot;
	vibe: RpcVibeModeSnapshot;
}

interface PlanModelState {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

interface WorkModeRuntime {
	planPreviousTools?: string[];
	planPreviousModel?: PlanModelState;
	planHasEntered?: boolean;
	planProposal?: RpcPlanProposalSnapshot;
	planUnsubscribe?: () => void;
	goalPreviousTools?: string[];
	goalUnsubscribe?: () => void;
	goalContinuationTimer?: NodeJS.Timeout;
	goalTurnHadToolCalls?: boolean;
	goalContinuationTurnInFlight?: boolean;
	goalSuppressNextContinuation?: boolean;
	goalBeginInFlight?: Promise<RpcGuidedGoalKickoffResult>;
	vibePreviousTools?: string[];
	vibeOwnerScope?: VibeOwnerScope;
}

interface RpcTransientModeSnapshot {
	planState: PlanModeState | undefined;
	goalState: GoalModeState | undefined;
	vibeState: VibeModeState | undefined;
	activeTools: string[];
	activeModel: PlanModelState | undefined;
	planProposalHandler: PlanProposalHandler | undefined;
	planPreviousTools: string[] | undefined;
	planPreviousModel: PlanModelState | undefined;
	planHasEntered: boolean | undefined;
	planProposal: RpcPlanProposalSnapshot | undefined;
	goalPreviousTools: string[] | undefined;
	goalTurnHadToolCalls: boolean | undefined;
	goalContinuationTurnInFlight: boolean | undefined;
	goalSuppressNextContinuation: boolean | undefined;
	vibePreviousTools: string[] | undefined;
	vibeOwnerScope: VibeOwnerScope | undefined;
}

/** Reversible process-local mode teardown owned by the RPC transition boundary. */
export interface RpcTransientModeSuspension {
	commit(): Promise<void>;
	rollback(): Promise<void>;
}

const runtimes = new WeakMap<AgentSession, WorkModeRuntime>();

function runtimeFor(session: AgentSession): WorkModeRuntime {
	let runtime = runtimes.get(session);
	if (!runtime) {
		runtime = {};
		runtimes.set(session, runtime);
	}
	return runtime;
}
function localProtocolOptions(session: AgentSession): LocalProtocolOptions {
	return {
		getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
		getSessionId: () => session.sessionManager.getSessionId(),
	};
}

function resolveRpcPlanFilePath(session: AgentSession, planFilePath: string): string {
	return planFilePath.startsWith("local:")
		? resolveLocalUrlToPath(normalizeLocalScheme(planFilePath), localProtocolOptions(session))
		: resolveToCwd(planFilePath, session.sessionManager.getCwd());
}
async function writeRpcPlanFile(session: AgentSession, planFilePath: string, content: string): Promise<void> {
	const resolvedPath = resolveRpcPlanFilePath(session, planFilePath);
	await fs.mkdir(path.dirname(resolvedPath), { recursive: true });
	await Bun.write(resolvedPath, content);
}

async function copyRpcLocalArtifacts(sourceRoot: string, destinationRoot: string): Promise<void> {
	if (sourceRoot === destinationRoot) return;
	const entries = await fs.readdir(sourceRoot, { withFileTypes: true }).catch(error => {
		if (isEnoent(error)) return [];
		throw error;
	});
	await fs.mkdir(destinationRoot, { recursive: true });
	for (const entry of entries) {
		await fs.cp(path.join(sourceRoot, entry.name), path.join(destinationRoot, entry.name), {
			recursive: true,
			force: true,
		});
	}
}

function vibeParentSession(session: AgentSession): VibeParentSession {
	const sessionManager = session.sessionManager;
	return {
		getAgentId: () => session.getAgentId() ?? null,
		getSessionId: () => sessionManager.getSessionId(),
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		sessionManager,
		asyncJobManager: session.asyncJobManager,
		settings: session.settings,
		getActiveModelString: () => (session.model ? formatModelString(session.model) : undefined),
	};
}

function sessionSpawns(session: AgentSession): string {
	const entries = session.sessionManager.getEntries();
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "session_init") {
			// "" denies spawns, "*" allows any, and absent legacy fields default to "*".
			return entry.spawns === undefined ? "*" : entry.spawns;
		}
	}
	return "*";
}

function vibeToolSession(session: AgentSession): ToolSession {
	const sessionManager = session.sessionManager;
	return {
		...vibeParentSession(session),
		get cwd() {
			return sessionManager.getCwd();
		},
		hasUI: false,
		sessionManager,
		getSessionSpawns: () => sessionSpawns(session),
	};
}

function assertModeAvailable(session: AgentSession, requested: "plan" | "goal" | "vibe"): void {
	if (
		requested !== "plan" &&
		(session.getPlanModeState()?.enabled || session.sessionManager.buildSessionContext().mode === "plan_paused")
	) {
		throw new Error("Exit plan mode first.");
	}
	const goal = session.getGoalModeState();
	if (requested !== "goal" && goal && (goal.enabled || goal.goal.status === "paused")) {
		throw new Error("Exit goal mode first.");
	}
	if (requested !== "vibe" && session.getVibeModeState()?.enabled) {
		throw new Error("Exit vibe mode first.");
	}
}

async function abortPlanTurn(session: AgentSession): Promise<void> {
	if (!session.isStreaming) return;
	session.markPlanInternalAbortPending();
	try {
		await session.abort();
	} finally {
		session.clearPlanInternalAbortPending();
	}
}

async function stagePreparedPlanProposal(
	session: AgentSession,
	prepared: { details?: PlanApprovalDetails },
): Promise<RpcPlanProposalSnapshot> {
	const details = prepared.details;
	if (!details) throw new Error("Plan review did not include proposal details.");
	const content = await readPlanFile(details.planFilePath, {
		localProtocolOptions: {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		},
		cwd: session.sessionManager.getCwd(),
	});
	if (!content?.trim()) throw new Error(`Plan file not found at ${details.planFilePath}`);

	const proposal: RpcPlanProposalSnapshot = {
		planFilePath: details.planFilePath,
		title: details.title,
		content,
	};
	const runtime = runtimeFor(session);
	runtime.planProposal = proposal;
	const state = session.getPlanModeState();
	if (state?.enabled && state.planFilePath !== proposal.planFilePath) {
		session.setPlanModeState({ ...state, planFilePath: proposal.planFilePath });
		session.sessionManager.appendModeChange("plan", { planFilePath: proposal.planFilePath });
	}
	return proposal;
}

function installPlanProposalHandler(session: AgentSession): void {
	const runtime = runtimeFor(session);
	runtime.planUnsubscribe?.();
	runtime.planUnsubscribe = session.subscribe(event => {
		if (event.type !== "tool_execution_end" || event.isError) return;
		const dispatch = writeDeviceDispatch(event.toolName, event.result);
		if (dispatch?.tool !== PROPOSE_DEVICE_NAME || dispatch.mode !== "execute") return;
		session.markPlanInternalAbortPending();
		void session
			.abort()
			.catch(error => logger.warn("Failed to pause plan proposal turn", { error: String(error) }))
			.finally(() => session.clearPlanInternalAbortPending());
	});
	session.setPlanProposalHandler(async title => {
		const prepared = await session.preparePlanForReview(title);
		await stagePreparedPlanProposal(session, prepared);
		return prepared;
	});
}

async function restorePlanModel(session: AgentSession, previous: PlanModelState): Promise<void> {
	if (modelsAreEqual(session.model, previous.model)) {
		session.setThinkingLevel(previous.thinkingLevel);
		return;
	}
	await session.setModelTemporary(previous.model, previous.thinkingLevel);
}
async function applyPlanExecutionModel(
	session: AgentSession,
	model: Model | undefined,
	thinkingLevel: ConfiguredThinkingLevel | undefined,
): Promise<void> {
	if (!model) {
		if (thinkingLevel !== undefined) session.setThinkingLevel(thinkingLevel);
		return;
	}
	if (modelsAreEqual(session.model, model)) {
		if (thinkingLevel !== undefined) session.setThinkingLevel(thinkingLevel);
		return;
	}
	await session.setModelTemporary(model, thinkingLevel);
}

function clonePlanSnapshot(session: AgentSession): RpcPlanModeSnapshot {
	const state = session.getPlanModeState();
	const proposal = runtimeFor(session).planProposal;
	return {
		enabled: state?.enabled === true,
		planFilePath: state?.planFilePath ?? null,
		workflow: state?.workflow ?? null,
		reentry: state?.reentry === true,
		proposal: proposal ? { ...proposal } : null,
	};
}

function cloneGoalDescriptor(goal: Goal): RpcGoalDescriptor {
	return {
		id: goal.id,
		objective: goal.objective,
		status: goal.status,
		tokensUsed: goal.tokensUsed,
		timeUsedSeconds: goal.timeUsedSeconds,
		createdAt: goal.createdAt,
		updatedAt: goal.updatedAt,
	};
}

function cloneGoalSnapshot(session: AgentSession): RpcGoalModeSnapshot {
	const state = session.getGoalModeState();
	const goal = state?.goal;
	return {
		enabled: state?.enabled === true,
		paused: state?.enabled !== true && goal?.status === "paused",
		mode: state?.mode ?? null,
		reason: state?.reason ?? null,
		goal: goal ? cloneGoalDescriptor(goal) : null,
		budget: goal
			? {
					limit: goal.tokenBudget ?? null,
					used: goal.tokensUsed,
					remaining: remainingTokens(goal),
				}
			: null,
	};
}
function cancelRpcGoalContinuation(runtime: WorkModeRuntime): void {
	if (!runtime.goalContinuationTimer) return;
	clearTimeout(runtime.goalContinuationTimer);
	runtime.goalContinuationTimer = undefined;
}

function scheduleRpcGoalContinuation(session: AgentSession): void {
	const runtime = runtimeFor(session);
	cancelRpcGoalContinuation(runtime);
	void readRpcLoopState(session)
		.then(loopState => {
			if (loopState.enabled || runtimes.get(session) !== runtime) return;
			if (!session.settings.get("goal.continuationModes").includes("interactive")) return;
			if (session.getPlanModeState()?.enabled) return;
			if (runtime.goalSuppressNextContinuation) return;
			const state = session.getGoalModeState();
			if (!state?.enabled || state.goal.status !== "active") return;
			const continuationPrompt = session.goalRuntime.buildContinuationPrompt();
			if (!continuationPrompt) return;

			runtime.goalContinuationTimer = setTimeout(() => {
				runtime.goalContinuationTimer = undefined;
				void readRpcLoopState(session)
					.then(latestLoopState => {
						if (latestLoopState.enabled || runtimes.get(session) !== runtime) return;
						if (session.isStreaming || session.isCompacting || session.hasPostPromptWork) return;
						const latestState = session.getGoalModeState();
						if (!latestState?.enabled || latestState.goal.status !== "active") return;
						runtime.goalContinuationTurnInFlight = true;
						void session
							.promptCustomMessage(
								{
									customType: "goal-continuation",
									content: continuationPrompt,
									display: false,
									attribution: "agent",
								},
								{ streamingBehavior: "followUp" },
							)
							.catch(error => {
								runtime.goalContinuationTurnInFlight = false;
								logger.warn("Failed to dispatch RPC goal continuation", {
									error: error instanceof Error ? error.message : String(error),
								});
							});
					})
					.catch(error => {
						logger.warn("Failed to read RPC loop state for goal continuation", {
							error: error instanceof Error ? error.message : String(error),
						});
					});
			}, 800);
		})
		.catch(error => {
			logger.warn("Failed to read RPC loop state for goal continuation", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
}

async function finishRpcGoal(session: AgentSession, completed: boolean): Promise<void> {
	const runtime = runtimeFor(session);
	const state = session.getGoalModeState();
	if (runtime.goalPreviousTools) await session.setActiveToolsByName(runtime.goalPreviousTools);
	if (completed) {
		session.setGoalModeState(undefined);
		session.sessionManager.appendModeChange("none");
		session.sessionManager.appendCustomEntry("goal-completed", {
			objective: state?.goal.objective,
			tokensUsed: state?.goal.tokensUsed,
			tokenBudget: state?.goal.tokenBudget,
			timeUsedSeconds: state?.goal.timeUsedSeconds,
		});
	}
	runtime.goalPreviousTools = undefined;
	runtime.goalTurnHadToolCalls = false;
	runtime.goalContinuationTurnInFlight = false;
	runtime.goalSuppressNextContinuation = false;
	cancelRpcGoalContinuation(runtime);
}

async function handleRpcGoalSessionEvent(session: AgentSession, event: AgentSessionEvent): Promise<void> {
	const runtime = runtimeFor(session);
	if (event.type === "agent_start") {
		runtime.goalTurnHadToolCalls = false;
		cancelRpcGoalContinuation(runtime);
		return;
	}
	if (event.type === "tool_execution_start") {
		runtime.goalTurnHadToolCalls = true;
		if (!runtime.goalContinuationTurnInFlight) runtime.goalSuppressNextContinuation = false;
		return;
	}
	if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
		runtime.goalSuppressNextContinuation = false;
		return;
	}
	if (event.type === "goal_updated") {
		if (event.state?.goal?.status === "dropped") {
			await finishRpcGoal(session, false);
			return;
		}
		if (!event.state?.enabled) cancelRpcGoalContinuation(runtime);
		return;
	}
	if (event.type !== "agent_end") return;
	if (runtime.goalContinuationTurnInFlight) {
		runtime.goalSuppressNextContinuation = !runtime.goalTurnHadToolCalls;
		runtime.goalContinuationTurnInFlight = false;
	}
	if (session.getGoalModeState()?.mode === "exiting") {
		await finishRpcGoal(session, true);
		return;
	}
	scheduleRpcGoalContinuation(session);
}

function installRpcGoalScheduler(session: AgentSession): void {
	const runtime = runtimeFor(session);
	if (runtime.goalUnsubscribe) return;
	runtime.goalUnsubscribe = session.subscribe(event => {
		void handleRpcGoalSessionEvent(session, event).catch(error => {
			logger.warn("RPC goal scheduler failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	});
}

function startRpcGoalTurn(session: AgentSession, objective: string): void {
	void session.prompt(objective, { streamingBehavior: "followUp" }).catch(error => {
		logger.warn("Failed to start RPC goal turn", {
			error: error instanceof Error ? error.message : String(error),
		});
	});
}

export async function enterRpcPlanMode(
	session: AgentSession,
	planFilePath?: string,
	workflow: "parallel" | "iterative" = "parallel",
): Promise<RpcPlanModeSnapshot> {
	const current = session.getPlanModeState();
	if (current?.enabled) return clonePlanSnapshot(session);
	assertModeAvailable(session, "plan");
	if (!session.settings.get("plan.enabled")) {
		throw new Error("Plan mode is disabled. Enable plan.enabled first.");
	}
	await session.waitForIdle();

	const runtime = runtimeFor(session);
	const previousTools = session.getEnabledToolNames();
	const previousModel = session.model
		? { model: session.model, thinkingLevel: session.configuredThinkingLevel() }
		: undefined;
	const nextPlanFilePath = planFilePath?.trim() || session.getPlanReferencePath() || DEFAULT_PLAN_FILE_URL;
	const planTools = session.hasBuiltInTool("write") ? [...new Set([...previousTools, "write"])] : previousTools;

	await session.setActiveToolsByName(planTools);
	runtime.planPreviousTools = previousTools;
	runtime.planPreviousModel = previousModel;
	runtime.planProposal = undefined;
	session.setPlanModeState({
		enabled: true,
		planFilePath: nextPlanFilePath,
		workflow,
		reentry: runtime.planHasEntered === true,
	});
	installPlanProposalHandler(session);
	try {
		const transition = resolvePlanModelTransition(session.model, session.resolveRoleModelWithThinking("plan"), false);
		if (transition.kind === "thinking") {
			session.setThinkingLevel(transition.thinkingLevel);
		} else if (transition.kind === "apply") {
			await session.setModelTemporary(transition.model, transition.thinkingLevel);
		}
	} catch (error) {
		session.setPlanProposalHandler(null);
		runtime.planUnsubscribe?.();
		runtime.planUnsubscribe = undefined;
		session.setPlanModeState(undefined);
		await session.setActiveToolsByName(previousTools);
		runtime.planPreviousTools = undefined;
		runtime.planPreviousModel = undefined;
		throw new Error(`Failed to enter plan mode: ${error instanceof Error ? error.message : String(error)}`);
	}
	runtime.planHasEntered = true;
	session.sessionManager.appendModeChange("plan", { planFilePath: nextPlanFilePath });
	return clonePlanSnapshot(session);
}

async function leaveRpcPlanMode(session: AgentSession, deferModelRestore: boolean): Promise<RpcPlanModeSnapshot> {
	const state = session.getPlanModeState();
	if (!state?.enabled) return clonePlanSnapshot(session);
	await abortPlanTurn(session);
	const runtime = runtimeFor(session);
	const planTools = session.getEnabledToolNames();
	const planModel = session.model
		? { model: session.model, thinkingLevel: session.configuredThinkingLevel() }
		: undefined;
	session.setPlanModeState(undefined);
	try {
		if (runtime.planPreviousTools) await session.setActiveToolsByName(runtime.planPreviousTools);
		if (runtime.planPreviousModel && !deferModelRestore) {
			await restorePlanModel(session, runtime.planPreviousModel);
		}
	} catch (error) {
		session.setPlanModeState(state);
		if (planModel) {
			try {
				await restorePlanModel(session, planModel);
			} catch (rollbackError) {
				logger.warn("Failed to restore plan model after RPC plan exit failure", { error: String(rollbackError) });
			}
		}
		try {
			await session.setActiveToolsByName(planTools);
		} catch (rollbackError) {
			logger.warn("Failed to restore plan tools after RPC plan exit failure", { error: String(rollbackError) });
		}
		throw new Error(`Failed to exit plan mode: ${error instanceof Error ? error.message : String(error)}`);
	}
	session.setPlanProposalHandler(null);
	runtime.planUnsubscribe?.();
	runtime.planUnsubscribe = undefined;
	runtime.planPreviousTools = undefined;
	if (!deferModelRestore) runtime.planPreviousModel = undefined;
	runtime.planProposal = undefined;
	session.sessionManager.appendModeChange("none");
	return clonePlanSnapshot(session);
}

export async function exitRpcPlanMode(session: AgentSession): Promise<RpcPlanModeSnapshot> {
	return leaveRpcPlanMode(session, false);
}

export async function readRpcPlanModeState(session: AgentSession): Promise<RpcPlanModeSnapshot> {
	return clonePlanSnapshot(session);
}

export async function submitRpcPlanReview(session: AgentSession, title = ""): Promise<RpcPlanProposalSnapshot> {
	if (!session.getPlanModeState()?.enabled) throw new Error("Plan mode is not active.");
	await abortPlanTurn(session);
	const prepared = await session.preparePlanForReview(title);
	return stagePreparedPlanProposal(session, prepared);
}

export async function approveRpcPlanProposal(
	session: AgentSession,
	editedContent?: string,
	strategy: RpcPlanFinalizationStrategy = "keep-context",
	executionModel?: Model,
	thinkingLevel?: ConfiguredThinkingLevel,
): Promise<RpcPlanDecisionResult> {
	const runtime = runtimeFor(session);
	const proposal = runtime.planProposal;
	if (!proposal) throw new Error("No plan proposal is pending.");
	if (strategy !== "execute" && strategy !== "keep-context" && strategy !== "compact-context") {
		throw new Error(`Unknown plan finalization strategy: ${String(strategy)}`);
	}
	if (strategy === "execute") assertRpcSessionTransitionAllowed(session);

	const planContent =
		editedContent ??
		(await readPlanFile(proposal.planFilePath, {
			localProtocolOptions: localProtocolOptions(session),
			cwd: session.sessionManager.getCwd(),
		}));
	if (!planContent?.trim()) throw new Error(`Plan file not found at ${proposal.planFilePath}`);
	if (editedContent !== undefined) {
		await writeRpcPlanFile(session, proposal.planFilePath, editedContent);
		runtime.planProposal = { ...proposal, content: editedContent };
	}

	await abortPlanTurn(session);
	const previousTools = runtime.planPreviousTools ?? session.getEnabledToolNames();
	const compactBeforeExecute = strategy === "compact-context";
	let compactOutcome: CompactionOutcome | undefined;
	let compactError = "Unknown compaction error";
	if (compactBeforeExecute) session.markPlanInternalAbortPending();
	try {
		if (strategy === "execute") {
			const sourceRoot = resolveLocalUrlToPath("local://", localProtocolOptions(session));
			const created = await session.runSessionTransition(async transitionOptions => {
				const didCreate = await session.newSession(transitionOptions);
				return {
					result: didCreate,
					committed: didCreate,
					honorPlanDefault: false,
				};
			});
			if (!created) throw new Error("Plan execution session creation was cancelled.");
			const destinationRoot = resolveLocalUrlToPath("local://", localProtocolOptions(session));
			await copyRpcLocalArtifacts(sourceRoot, destinationRoot);
			await writeRpcPlanFile(session, proposal.planFilePath, planContent);
		} else {
			await leaveRpcPlanMode(session, compactBeforeExecute);
			if (compactBeforeExecute) {
				session.setPlanReferencePath(proposal.planFilePath);
				const compactPrompt = prompt.render(planModeCompactInstructionsPrompt, {
					planFilePath: proposal.planFilePath,
				});
				try {
					await session.compact(undefined, { internalGuidance: compactPrompt });
					compactOutcome = "ok";
				} catch (error) {
					if (error instanceof CompactionCancelledError) {
						compactOutcome = "cancelled";
					} else {
						compactOutcome = "failed";
						compactError = (error instanceof Error ? error.message : String(error)) || "Unknown compaction error";
						logger.warn("Failed to compact context for RPC plan approval", {
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
		}
	} finally {
		session.clearPlanInternalAbortPending();
	}

	await session.setActiveToolsByName(previousTools.includes("read") ? previousTools : [...previousTools, "read"]);
	session.setPlanReferencePath(proposal.planFilePath);
	if (compactBeforeExecute) {
		if (compactOutcome !== "failed") {
			const previousModel = runtime.planPreviousModel;
			runtime.planPreviousModel = undefined;
			if (executionModel || thinkingLevel !== undefined) {
				await applyPlanExecutionModel(session, executionModel, thinkingLevel);
			} else if (previousModel) {
				await restorePlanModel(session, previousModel);
			}
		}
	} else {
		await applyPlanExecutionModel(session, executionModel, thinkingLevel);
	}

	if (compactOutcome !== "cancelled") {
		const sessionName = humanizePlanTitle(proposal.title);
		if (sessionName && !session.sessionManager.getSessionName()) {
			await session.sessionManager.setSessionName(sessionName, "auto");
		}
		session.markPlanReferenceSent();
		const executionPrompt = prompt.render(planModeApprovedPrompt, {
			planFilePath: proposal.planFilePath,
			contextPreserved: strategy !== "execute",
		});
		if (session.isStreaming) {
			await session.followUp(executionPrompt, undefined, { synthetic: true });
		} else {
			await session.prompt(executionPrompt, { synthetic: true });
		}
	}

	return {
		decision: "approved",
		planFilePath: proposal.planFilePath,
		title: proposal.title,
		state: clonePlanSnapshot(session),
		...(compactOutcome
			? {
					compaction: {
						outcome: compactOutcome,
						...(compactOutcome === "failed" ? { error: compactError } : {}),
					},
				}
			: {}),
	};
}

export async function rejectRpcPlanProposal(session: AgentSession, feedback = ""): Promise<RpcPlanDecisionResult> {
	const runtime = runtimeFor(session);
	const proposal = runtime.planProposal;
	if (!proposal) throw new Error("No plan proposal is pending.");
	await abortPlanTurn(session);
	runtime.planProposal = undefined;
	const refinement = feedback.trim();
	if (refinement) await session.prompt(refinement);
	return {
		decision: "rejected",
		planFilePath: proposal.planFilePath,
		title: proposal.title,
		state: clonePlanSnapshot(session),
	};
}

export async function createRpcGoal(
	session: AgentSession,
	objective: string,
	tokenBudget?: number,
): Promise<RpcGoalModeSnapshot> {
	assertModeAvailable(session, "goal");
	if (!session.settings.get("goal.enabled")) {
		throw new Error("Goal mode is disabled. Enable goal.enabled first.");
	}
	const normalizedObjective = objective.trim();
	if (!normalizedObjective) throw new Error("Goal objective is required.");
	const runtime = runtimeFor(session);
	cancelRpcGoalContinuation(runtime);
	const previousTools = session.getEnabledToolNames().filter(name => name !== "goal");
	const state = await session.goalRuntime.createGoal({ objective: normalizedObjective, tokenBudget });
	try {
		await session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
	} catch (error) {
		await session.goalRuntime.dropGoal();
		throw new Error(`Failed to enter goal mode: ${error instanceof Error ? error.message : String(error)}`);
	}
	runtime.goalPreviousTools = previousTools;
	runtime.goalTurnHadToolCalls = false;
	runtime.goalContinuationTurnInFlight = false;
	runtime.goalSuppressNextContinuation = false;
	session.setGoalModeState(state);
	installRpcGoalScheduler(session);
	if (session.isStreaming) {
		await session.sendGoalModeContext({ deliverAs: "steer" });
	} else {
		startRpcGoalTurn(session, normalizedObjective);
	}
	return cloneGoalSnapshot(session);
}

export async function pauseRpcGoal(session: AgentSession): Promise<RpcGoalModeSnapshot> {
	const state = session.getGoalModeState();
	if (!state?.enabled) throw new Error("No active goal to pause.");
	const runtime = runtimeFor(session);
	const previousTools = runtime.goalPreviousTools;
	const previousTurnHadToolCalls = runtime.goalTurnHadToolCalls;
	const previousContinuationInFlight = runtime.goalContinuationTurnInFlight;
	const previousSuppressContinuation = runtime.goalSuppressNextContinuation;
	cancelRpcGoalContinuation(runtime);
	await session.goalRuntime.pauseGoal();
	try {
		if (previousTools) await session.setActiveToolsByName(previousTools);
	} catch (error) {
		const resumed = await session.goalRuntime.resumeGoal();
		session.setGoalModeState(resumed);
		runtime.goalPreviousTools = previousTools;
		runtime.goalTurnHadToolCalls = previousTurnHadToolCalls;
		runtime.goalContinuationTurnInFlight = previousContinuationInFlight;
		runtime.goalSuppressNextContinuation = previousSuppressContinuation;
		scheduleRpcGoalContinuation(session);
		throw new Error(`Failed to pause goal mode: ${error instanceof Error ? error.message : String(error)}`);
	}
	runtime.goalPreviousTools = undefined;
	runtime.goalContinuationTurnInFlight = false;
	return cloneGoalSnapshot(session);
}

export async function resumeRpcGoal(session: AgentSession): Promise<RpcGoalModeSnapshot> {
	assertModeAvailable(session, "goal");
	const current = session.getGoalModeState();
	if (current?.enabled || current?.goal.status !== "paused") throw new Error("No paused goal to resume.");
	const runtime = runtimeFor(session);
	const previousTools = session.getEnabledToolNames().filter(name => name !== "goal");
	const state = await session.goalRuntime.resumeGoal();
	try {
		await session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
	} catch (error) {
		await session.goalRuntime.pauseGoal();
		throw new Error(`Failed to resume goal mode: ${error instanceof Error ? error.message : String(error)}`);
	}
	runtime.goalPreviousTools = previousTools;
	runtime.goalTurnHadToolCalls = false;
	runtime.goalContinuationTurnInFlight = false;
	runtime.goalSuppressNextContinuation = false;
	session.setGoalModeState(state);
	installRpcGoalScheduler(session);
	if (session.isStreaming) await session.sendGoalModeContext({ deliverAs: "steer" });
	scheduleRpcGoalContinuation(session);
	return cloneGoalSnapshot(session);
}

export async function switchRpcGoal(
	session: AgentSession,
	objective: string,
	tokenBudget?: number,
): Promise<RpcGoalModeSnapshot> {
	const state = session.getGoalModeState();
	if (!state?.enabled) throw new Error("No active goal to replace.");
	const normalizedObjective = objective.trim();
	if (!normalizedObjective) throw new Error("Goal objective is required.");
	const runtime = runtimeFor(session);
	cancelRpcGoalContinuation(runtime);
	const next = await session.goalRuntime.replaceGoal({ objective: normalizedObjective, tokenBudget });
	runtime.goalTurnHadToolCalls = false;
	runtime.goalContinuationTurnInFlight = false;
	runtime.goalSuppressNextContinuation = false;
	session.setGoalModeState(next);
	installRpcGoalScheduler(session);
	if (session.isStreaming) {
		await session.sendGoalModeContext({ deliverAs: "steer" });
	} else {
		startRpcGoalTurn(session, normalizedObjective);
	}
	return cloneGoalSnapshot(session);
}

export async function clearRpcGoal(session: AgentSession): Promise<RpcGoalModeSnapshot> {
	const runtime = runtimeFor(session);
	cancelRpcGoalContinuation(runtime);
	const state = session.getGoalModeState();
	if (!state?.goal) return cloneGoalSnapshot(session);
	await session.goalRuntime.dropGoal();
	if (state.enabled && runtime.goalPreviousTools) {
		await session.setActiveToolsByName(runtime.goalPreviousTools);
	}
	runtime.goalPreviousTools = undefined;
	runtime.goalContinuationTurnInFlight = false;
	runtime.goalSuppressNextContinuation = false;
	session.setGoalModeState(undefined);
	return cloneGoalSnapshot(session);
}

export async function setRpcGoalBudget(
	session: AgentSession,
	tokenBudget: number | null,
): Promise<RpcGoalModeSnapshot> {
	const state = session.getGoalModeState();
	if (!state?.enabled) throw new Error("No active goal.");
	if (state.goal.status === "complete") throw new Error("Goal is already complete.");
	if (tokenBudget !== null && (!Number.isInteger(tokenBudget) || tokenBudget <= 0)) {
		throw new Error("Goal budget must be a positive integer or null.");
	}
	const runtime = runtimeFor(session);
	cancelRpcGoalContinuation(runtime);
	await session.goalRuntime.onBudgetMutated(tokenBudget ?? undefined);
	runtime.goalSuppressNextContinuation = false;
	scheduleRpcGoalContinuation(session);
	return cloneGoalSnapshot(session);
}

export async function readRpcGoalState(session: AgentSession): Promise<RpcGoalModeSnapshot> {
	return cloneGoalSnapshot(session);
}

export async function beginRpcGuidedGoal(
	session: AgentSession,
	initialObjective?: string,
): Promise<RpcGuidedGoalKickoffResult> {
	assertModeAvailable(session, "goal");
	if (!session.settings.get("goal.enabled")) {
		throw new Error("Goal mode is disabled. Enable it in settings (goal.enabled).");
	}
	const goalState = session.getGoalModeState();
	if (goalState?.enabled) {
		throw new Error("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
	}
	if (goalState?.goal.status === "paused") {
		throw new Error("Resume the current goal first, or drop it before setting a new objective.");
	}

	const runtime = runtimeFor(session);
	if (runtime.goalBeginInFlight) throw new Error("Goal setup is already in progress.");
	const previousRuntimeTools = runtime.goalPreviousTools;
	const previousTurnHadToolCalls = runtime.goalTurnHadToolCalls;
	const previousContinuationInFlight = runtime.goalContinuationTurnInFlight;
	const previousSuppressContinuation = runtime.goalSuppressNextContinuation;
	const enabledTools = session.getEnabledToolNames();
	const kickoffTask = (async (): Promise<RpcGuidedGoalKickoffResult> => {
		try {
			runtime.goalPreviousTools = enabledTools.filter(name => name !== "goal");
			if (!enabledTools.includes("goal")) {
				await session.setActiveToolsByName([...enabledTools, "goal"]);
			}
			installRpcGoalScheduler(session);

			const kickoff = prompt.render(guidedGoalInterviewPrompt, {
				initial: initialObjective?.trim() || undefined,
			});
			if (session.isStreaming) {
				await session.followUp(kickoff, undefined, { synthetic: true });
				return { queued: true };
			}
			try {
				await session.prompt(kickoff, { synthetic: true });
				return { queued: false };
			} catch (error) {
				if (!(error instanceof AgentBusyError)) throw error;
				await session.followUp(kickoff, undefined, { synthetic: true });
				return { queued: true };
			}
		} catch (error) {
			if (!session.getGoalModeState()?.goal) {
				cancelRpcGoalContinuation(runtime);
				runtime.goalUnsubscribe?.();
				runtime.goalUnsubscribe = undefined;
				try {
					await session.setActiveToolsByName(enabledTools);
				} finally {
					runtime.goalPreviousTools = previousRuntimeTools;
					runtime.goalTurnHadToolCalls = previousTurnHadToolCalls;
					runtime.goalContinuationTurnInFlight = previousContinuationInFlight;
					runtime.goalSuppressNextContinuation = previousSuppressContinuation;
				}
			}
			throw error;
		}
	})();
	runtime.goalBeginInFlight = kickoffTask;
	try {
		return await kickoffTask;
	} finally {
		if (runtime.goalBeginInFlight === kickoffTask) runtime.goalBeginInFlight = undefined;
	}
}

export async function enterRpcVibeMode(session: AgentSession): Promise<RpcVibeModeSnapshot> {
	if (session.getVibeModeState()?.enabled) return readRpcVibeModeState(session);
	assertModeAvailable(session, "vibe");
	const runtime = runtimeFor(session);
	const registry = VibeSessionRegistry.global();
	const vibeSession = vibeParentSession(session);
	const ownerScope = registry.ownerScope(vibeSession);
	await registry.rehydrate(vibeSession);
	registry.activateScope(ownerScope);
	const previousTools = session.getEnabledToolNames();
	await session.activateVibeTools(["read"]);
	runtime.vibePreviousTools = previousTools;
	runtime.vibeOwnerScope = ownerScope;
	session.setVibeModeState({ enabled: true });
	if (session.isStreaming) await session.sendVibeModeContext({ deliverAs: "steer" });
	session.sessionManager.appendModeChange("vibe");
	return readRpcVibeModeState(session);
}

export async function exitRpcVibeMode(session: AgentSession): Promise<RpcVibeModeSnapshot> {
	if (!session.getVibeModeState()?.enabled) return readRpcVibeModeState(session);
	const runtime = runtimeFor(session);
	await VibeSessionRegistry.global().killAll(vibeParentSession(session), runtime.vibeOwnerScope);
	await session.deactivateVibeTools(runtime.vibePreviousTools ?? []);
	session.sessionManager.appendModeChange("none");
	session.setVibeModeState(undefined);
	runtime.vibePreviousTools = undefined;
	runtime.vibeOwnerScope = undefined;
	return readRpcVibeModeState(session);
}

export async function readRpcVibeModeState(session: AgentSession): Promise<RpcVibeModeSnapshot> {
	const enabled = session.getVibeModeState()?.enabled === true;
	const activeTools = enabled ? session.getEnabledToolNames() : [];
	const workers = enabled ? VibeSessionRegistry.global().screens(vibeToolSession(session)) : [];
	return {
		enabled,
		activeTools,
		ephemeralTools: activeTools.filter(name => (VIBE_TOOL_NAMES as readonly string[]).includes(name)),
		workers: workers.map(worker => ({
			id: worker.id,
			cli: worker.cli,
			state: worker.state,
			model: worker.model ?? null,
			turns: worker.turns,
			queued: worker.queued,
			turnStartedAt: worker.turnStartedAt ?? null,
			turnMessage: worker.turnMessage ?? null,
			currentTool: worker.currentTool ?? null,
			currentToolArgs: worker.currentToolArgs ?? null,
			lastIntent: worker.lastIntent ?? null,
			trace: [...worker.trace],
			outputTail: [...worker.outputTail],
			lastActivity: worker.lastActivity ?? null,
			lastActivityAt: worker.lastActivityAt,
		})),
	};
}

export async function buildRpcWorkModeSnapshot(session: AgentSession): Promise<RpcWorkModeSnapshot> {
	const plan = clonePlanSnapshot(session);
	const goal = cloneGoalSnapshot(session);
	const vibe = await readRpcVibeModeState(session);
	return {
		activeMode: plan.enabled ? "plan" : goal.enabled || goal.paused ? "goal" : vibe.enabled ? "vibe" : null,
		proposalPending: plan.proposal !== null,
		plan,
		goal,
		vibe,
	};
}

/** Releases work-mode subscriptions and pending goal continuations for an RPC session. */
export function disposeRpcWorkModes(session: AgentSession): void {
	const runtime = runtimes.get(session);
	if (!runtime) return;
	cancelRpcGoalContinuation(runtime);
	runtime.goalUnsubscribe?.();
	runtime.planUnsubscribe?.();
	session.setPlanProposalHandler(null);
	runtimes.delete(session);
}

/**
 * Releases transient process-local work-mode state without persisting a
 * `mode_change`. With reversible preparation, rollback restores the exact
 * outgoing mode runtime, including a pending plan proposal and its handlers.
 */
export async function clearRpcTransientModeState(
	session: AgentSession,
	options?: { reversibleVibeSuspension?: boolean },
): Promise<RpcTransientModeSuspension | undefined> {
	const runtime = runtimes.get(session);
	const planState = session.getPlanModeState();
	const goalState = session.getGoalModeState();
	const vibeState = session.getVibeModeState();
	const snapshot: RpcTransientModeSnapshot = {
		planState: planState ? { ...planState } : undefined,
		goalState: goalState ? { ...goalState, goal: { ...goalState.goal } } : undefined,
		vibeState: vibeState ? { ...vibeState } : undefined,
		activeTools: session.getEnabledToolNames(),
		activeModel: session.model
			? { model: session.model, thinkingLevel: session.configuredThinkingLevel() }
			: undefined,
		planProposalHandler: session.peekPlanProposalHandler(),
		planPreviousTools: runtime?.planPreviousTools ? [...runtime.planPreviousTools] : undefined,
		planPreviousModel: runtime?.planPreviousModel,
		planHasEntered: runtime?.planHasEntered,
		planProposal: runtime?.planProposal ? { ...runtime.planProposal } : undefined,
		goalPreviousTools: runtime?.goalPreviousTools ? [...runtime.goalPreviousTools] : undefined,
		goalTurnHadToolCalls: runtime?.goalTurnHadToolCalls,
		goalContinuationTurnInFlight: runtime?.goalContinuationTurnInFlight,
		goalSuppressNextContinuation: runtime?.goalSuppressNextContinuation,
		vibePreviousTools: runtime?.vibePreviousTools ? [...runtime.vibePreviousTools] : undefined,
		vibeOwnerScope: runtime?.vibeOwnerScope,
	};
	const restoreTools = snapshot.planPreviousTools ?? snapshot.goalPreviousTools;
	const restoreModel = snapshot.planPreviousModel;
	const vibeEnabled = snapshot.vibeState?.enabled === true;
	let vibeSuspension: VibeScopeSuspension | undefined;

	if (vibeEnabled && snapshot.vibeOwnerScope) {
		vibeSuspension = await VibeSessionRegistry.global().suspendScopeReversibly(
			snapshot.vibeOwnerScope,
			session.asyncJobManager,
		);
	}
	try {
		if (vibeEnabled) {
			if (snapshot.vibePreviousTools) await session.deactivateVibeTools(snapshot.vibePreviousTools);
			else await session.removeVibeToolsPreservingActive();
		} else if (restoreTools) {
			await session.setActiveToolsByName(restoreTools);
		}
		if (restoreModel) await restorePlanModel(session, restoreModel);
	} catch (error) {
		try {
			await vibeSuspension?.rollback();
		} finally {
			try {
				if (snapshot.activeModel) await restorePlanModel(session, snapshot.activeModel);
			} finally {
				await session.setActiveToolsByName(snapshot.activeTools);
			}
		}
		throw error;
	}

	session.setPlanModeState(undefined);
	session.setGoalModeState(undefined);
	session.setVibeModeState(undefined);
	disposeRpcWorkModes(session);

	let settled = false;
	const suspension: RpcTransientModeSuspension = {
		commit: async () => {
			if (settled) return;
			settled = true;
			await vibeSuspension?.commit();
		},
		rollback: async () => {
			if (settled) return;
			settled = true;
			try {
				await vibeSuspension?.rollback();
			} finally {
				const restoredRuntime = runtimeFor(session);
				restoredRuntime.planPreviousTools = snapshot.planPreviousTools;
				restoredRuntime.planPreviousModel = snapshot.planPreviousModel;
				restoredRuntime.planHasEntered = snapshot.planHasEntered;
				restoredRuntime.planProposal = snapshot.planProposal;
				restoredRuntime.goalPreviousTools = snapshot.goalPreviousTools;
				restoredRuntime.goalTurnHadToolCalls = snapshot.goalTurnHadToolCalls;
				restoredRuntime.goalContinuationTurnInFlight = snapshot.goalContinuationTurnInFlight;
				restoredRuntime.goalSuppressNextContinuation = snapshot.goalSuppressNextContinuation;
				restoredRuntime.vibePreviousTools = snapshot.vibePreviousTools;
				restoredRuntime.vibeOwnerScope = snapshot.vibeOwnerScope;
				session.setPlanModeState(snapshot.planState);
				session.setGoalModeState(snapshot.goalState);
				session.setVibeModeState(snapshot.vibeState);
				if (snapshot.activeModel) await restorePlanModel(session, snapshot.activeModel);
				await session.setActiveToolsByName(snapshot.activeTools);
				if (snapshot.planState?.enabled) {
					installPlanProposalHandler(session);
					if (snapshot.planProposalHandler) session.setPlanProposalHandler(snapshot.planProposalHandler);
				}
				if (snapshot.goalState?.enabled) installRpcGoalScheduler(session);
			}
		},
	};
	if (options?.reversibleVibeSuspension) return suspension;
	await suspension.commit();
	return undefined;
}
