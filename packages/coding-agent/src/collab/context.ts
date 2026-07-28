import type { CollabUiRequest, CollabUiResponseValue, CollabUiSelectItem } from "@oh-my-pi/pi-wire";
import type { Settings } from "../config/settings";
import type { AgentSession, AgentSessionEvent } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import type { EventBus } from "../utils/event-bus";
import type { CollabGuestLink } from "./guest";
import type { CollabHost } from "./host";
import type { CollabSessionState } from "./protocol";

/** Dependencies used by the host relay path; renderer hooks are optional. */
export interface CollabHostContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	eventBus?: EventBus;
	collabHost?: CollabHost;
	showStatus?(message: string, options?: { dim?: boolean }): void;
	updatePendingMessagesDisplay?(): void;
	ui?: { requestRender(force?: boolean, options?: { clearScrollback?: boolean }): void };
	statusLine?: {
		getCachedContextBreakdown(): { usedTokens: number; contextWindow: number };
		setCollabStatus(status: { role: "host"; participantCount: number } | null): void;
		invalidate(): void;
	};
}

/** Dependencies used by guest replication; renderer hooks are optional. */
export interface CollabGuestContext {
	session: AgentSession;
	sessionManager: SessionManager;
	settings: Settings;
	eventBus?: EventBus;
	collabGuest?: CollabGuestLink;
	showStatus?(message: string, options?: { dim?: boolean }): void;
	showError?(message: string): void;
	syncRunningSubagentBadge?(): void;
	resetObserverRegistry?(): void;
	updateEditorBorderColor?(): void;
	renderInitialMessages?(options?: { preserveExistingChat?: boolean; clearTerminalHistory?: boolean }): void;
	reloadTodos?(): Promise<void>;
	handleResumeSession?(sessionPath: string): Promise<void>;
	showHookSelector?(
		title: string,
		options: CollabUiSelectItem[],
		dialogOptions?: {
			signal?: AbortSignal;
			initialIndex?: number;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: number[];
			markableCount?: number;
			helpText?: string;
		},
	): Promise<string | undefined>;
	showHookEditor?(
		title: string,
		prefill?: string,
		dialogOptions?: { signal?: AbortSignal },
	): Promise<string | undefined>;
	handleUiRequest?(request: CollabUiRequest, signal: AbortSignal): Promise<CollabUiResponseValue>;
	ui?: { requestRender(force?: boolean, options?: { clearScrollback?: boolean }): void };
	statusLine?: {
		setCollabStatus(
			status: { role: "guest"; participantCount: number; stateOverride?: CollabSessionState | null } | null,
		): void;
		invalidate(): void;
		markActivityStart(): void;
		markActivityEnd(): void;
		resetActiveTime(): void;
	};
	eventController?: { handleEvent(event: AgentSessionEvent): void | Promise<void> };
	handleEvent?(event: AgentSessionEvent): void;
	chatContainer?: { clear(): void };
	statusContainer?: { clear(): void };
	pendingMessagesContainer?: { clear(): void };
	compactionQueuedMessages?: unknown[];
	streamingComponent?: unknown;
	streamingMessage?: unknown;
	pendingTools?: { clear(): void };
	loadingAnimation?: { stop(): void };
}
