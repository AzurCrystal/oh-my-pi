import type { Settings } from "../config/settings";

export interface CollabUrls {
	relayUrl: string;
	webUrl: string;
}

/** Resolve configured collaboration URLs; scheme-less relays default to secure WebSockets. */
export function resolveCollabUrls(settings: Settings, explicitRelayUrl?: string): CollabUrls | null {
	const relayInput = explicitRelayUrl?.trim() || settings.get("collab.relayUrl") || "";
	if (!relayInput) return null;
	return {
		relayUrl: relayInput.includes("://") ? relayInput : `wss://${relayInput}`,
		webUrl: settings.get("collab.webUrl") || "",
	};
}
