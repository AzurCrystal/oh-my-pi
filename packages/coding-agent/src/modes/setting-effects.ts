import { initializeWithSettings } from "../capability";
import type { MCPManager } from "../mcp/manager";
import type { AgentSession } from "../session/agent-session";
import type { ConfiguredThinkingLevel } from "../thinking";
import {
	isSearchProviderId,
	setExcludedSearchProviders,
	setImageProviderOrder,
	setSearchProviderOrder,
} from "../tools";

/**
 * Apply session and runtime effects for a setting change.
 * The caller is responsible for persisting the setting first.
 */
export async function applySettingEffects(
	session: AgentSession,
	path: string,
	value: unknown,
	mcpManager?: MCPManager,
): Promise<void> {
	switch (path) {
		case "advisor.enabled":
			session.setAdvisorEnabled(value as boolean);
			break;
		case "steeringMode":
			session.setSteeringMode(value as "all" | "one-at-a-time");
			break;
		case "followUpMode":
			session.setFollowUpMode(value as "all" | "one-at-a-time");
			break;
		case "interruptMode":
			session.setInterruptMode(value as "immediate" | "wait");
			break;
		case "defaultThinkingLevel":
			session.setThinkingLevel(value as ConfiguredThinkingLevel, true);
			break;
		case "personality":
		case "tools.xdevDocs":
			await session.refreshBaseSystemPrompt();
			break;
		case "memory.backend":
			await session.applyMemoryBackend();
			break;
		case "omitThinking":
			session.agent.hideThinkingSummary = value as boolean;
			break;
		case "temperature": {
			const n = Number(value);
			session.agent.temperature = n >= 0 ? n : undefined;
			break;
		}
		case "topP": {
			const n = Number(value);
			session.agent.topP = n >= 0 ? n : undefined;
			break;
		}
		case "topK": {
			const n = Number(value);
			session.agent.topK = n >= 0 ? n : undefined;
			break;
		}
		case "minP": {
			const n = Number(value);
			session.agent.minP = n >= 0 ? n : undefined;
			break;
		}
		case "presencePenalty": {
			const n = Number(value);
			session.agent.presencePenalty = n >= 0 ? n : undefined;
			break;
		}
		case "repetitionPenalty": {
			const n = Number(value);
			session.agent.repetitionPenalty = n >= 0 ? n : undefined;
			break;
		}
		case "providers.webSearchOrder":
			if (Array.isArray(value)) setSearchProviderOrder(value.filter(isSearchProviderId));
			break;
		case "providers.webSearchExclude":
			if (Array.isArray(value)) setExcludedSearchProviders(value.filter(isSearchProviderId));
			break;
		case "providers.imageOrder":
			if (Array.isArray(value)) {
				setImageProviderOrder(value.filter((entry): entry is string => typeof entry === "string"));
			}
			break;
		case "mcp.notifications":
			mcpManager?.setNotificationsEnabled(value as boolean);
			break;
		case "disabledProviders":
			initializeWithSettings(session.settings);
			break;
	}
}
