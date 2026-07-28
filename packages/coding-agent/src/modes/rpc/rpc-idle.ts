import { logger, prompt } from "@oh-my-pi/pi-utils";
import idleRecapPrompt from "../../prompts/system/recap-user.md" with { type: "text" };
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { previewLine, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { nextActionableTask, todoMatchesAnyDescription } from "../../tools/todo";
import type { EventBus } from "../../utils/event-bus";
import { SessionObserverRegistry } from "../session-observer-registry";

const IDLE_RECAP_MIN_SECONDS = 1;
const IDLE_RECAP_MAX_SECONDS = 3600;

/** Receives an idle recap after it remains valid through the ephemeral turn. */
export type RpcIdleRecapSink = (recap: string) => void;

/** Stateful RPC idle behaviors. Call {@link dispose} during RPC teardown. */
export interface RpcIdleBehavior {
	handleSessionEvent(event: AgentSessionEvent): void;
	dispose(): void;
}

/** Feed an AgentSession event from RPC's existing session subscription. */
export function feedRpcIdleEvent(behavior: RpcIdleBehavior, event: AgentSessionEvent): void {
	behavior.handleSessionEvent(event);
}

/**
 * Installs the idle compaction, idle recap, and subagent-driven todo completion
 * behaviors that the interactive EventController normally owns.
 */
export function installRpcIdleBehavior(
	session: AgentSession,
	eventBus: EventBus | undefined,
	onRecap: RpcIdleRecapSink,
): RpcIdleBehavior {
	let disposed = false;
	let idleCompactionTimer: NodeJS.Timeout | undefined;
	let idleRecapTimer: NodeJS.Timeout | undefined;
	let idleRecapAbort: AbortController | undefined;
	const observerRegistry = eventBus ? new SessionObserverRegistry() : undefined;

	const cancelIdleCompaction = (): void => {
		if (!idleCompactionTimer) return;
		clearTimeout(idleCompactionTimer);
		idleCompactionTimer = undefined;
	};

	const cancelIdleRecap = (): void => {
		if (idleRecapTimer) {
			clearTimeout(idleRecapTimer);
			idleRecapTimer = undefined;
		}
		if (idleRecapAbort) {
			idleRecapAbort.abort();
			idleRecapAbort = undefined;
		}
	};

	const idleConditionsHold = (): boolean =>
		!disposed && !session.isDisposed && !session.isStreaming && !session.isCompacting;

	const currentContextTokens = (): number => session.getContextUsage()?.tokens ?? 0;

	const idleRecapGoalText = (): string | undefined => {
		const goal = session.getGoalModeState()?.goal.objective.trim();
		if (goal) return goal;
		const title = session.sessionManager.getSessionName()?.trim();
		return title || undefined;
	};

	const runIdleRecap = async (): Promise<void> => {
		if (!idleConditionsHold()) return;
		if (!session.model) return;
		if (session.messages.length === 0) return;

		const promptText = prompt.render(idleRecapPrompt, {
			goal: idleRecapGoalText() ?? "",
			task: nextActionableTask(session.getTodoPhases())?.content ?? "",
		});
		const abort = new AbortController();
		idleRecapAbort = abort;
		try {
			const { replyText } = await session.runEphemeralTurn({ promptText, signal: abort.signal });
			if (idleRecapAbort !== abort || abort.signal.aborted || !idleConditionsHold()) return;
			const recap = previewLine(replyText, TRUNCATE_LENGTHS.RECAP);
			if (recap) onRecap(recap);
		} catch (error) {
			if (!abort.signal.aborted) logger.debug("Idle recap turn failed", { error: String(error) });
		} finally {
			if (idleRecapAbort === abort) idleRecapAbort = undefined;
		}
	};

	const scheduleIdleCompaction = (): void => {
		cancelIdleCompaction();
		if (disposed || session.isDisposed || session.isCompacting) return;

		const idleSettings = session.settings.getGroup("compaction");
		if (!idleSettings.idleEnabled) return;
		const threshold = idleSettings.idleThresholdTokens;
		if (threshold <= 0 || currentContextTokens() < threshold) return;

		const timeoutMs = Math.max(60, Math.min(3600, idleSettings.idleTimeoutSeconds)) * 1000;
		idleCompactionTimer = setTimeout(() => {
			idleCompactionTimer = undefined;
			if (disposed || session.isDisposed || session.isStreaming || session.isCompacting) return;
			if (currentContextTokens() < threshold) return;
			void session.runIdleCompaction();
		}, timeoutMs);
		idleCompactionTimer.unref?.();
	};

	const scheduleIdleRecap = (): void => {
		cancelIdleRecap();
		if (disposed || session.isDisposed || session.isCompacting) return;

		const recapSettings = session.settings.getGroup("recap");
		if (!recapSettings.enabled) return;
		const timeoutMs =
			Math.max(IDLE_RECAP_MIN_SECONDS, Math.min(IDLE_RECAP_MAX_SECONDS, recapSettings.idleSeconds)) * 1000;
		idleRecapTimer = setTimeout(() => {
			idleRecapTimer = undefined;
			void runIdleRecap();
		}, timeoutMs);
		idleRecapTimer.unref?.();
	};

	const reconcileTodosWithSubagents = (): void => {
		if (disposed || !observerRegistry) return;
		const completedDescriptions: string[] = [];
		for (const observedSession of observerRegistry.getSessions()) {
			if (observedSession.kind !== "subagent" || observedSession.status !== "completed") continue;
			const description =
				observedSession.description?.trim() ||
				observedSession.progress?.description?.trim() ||
				observedSession.label?.trim();
			if (description) completedDescriptions.push(description);
		}
		if (completedDescriptions.length === 0) return;

		let mutated = false;
		const next = session.getTodoPhases().map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => {
				if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "blocked") return task;
				if (!todoMatchesAnyDescription(task.content, completedDescriptions)) return task;
				mutated = true;
				return { content: task.content, status: "completed" as const };
			}),
		}));
		if (mutated) session.setTodoPhases(next);
	};

	const unsubscribeObservers = observerRegistry?.onChange(kind => {
		if (kind !== "progress") reconcileTodosWithSubagents();
	});
	if (observerRegistry && eventBus) {
		observerRegistry.subscribeToEventBus(eventBus);
		observerRegistry.setMainSession(session.sessionManager.getSessionFile() ?? undefined);
	}

	return {
		handleSessionEvent(event: AgentSessionEvent): void {
			if (disposed || session.isDisposed) return;
			switch (event.type) {
				case "agent_start":
					cancelIdleCompaction();
					cancelIdleRecap();
					break;
				case "agent_end":
					if (session.isStreaming) return;
					scheduleIdleCompaction();
					scheduleIdleRecap();
					break;
				case "auto_compaction_start":
				case "auto_compaction_end":
					cancelIdleCompaction();
					cancelIdleRecap();
					break;
			}
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			cancelIdleCompaction();
			cancelIdleRecap();
			unsubscribeObservers?.();
			observerRegistry?.dispose();
		},
	};
}
