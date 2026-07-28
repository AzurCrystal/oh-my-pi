import type { Keybinding } from "@oh-my-pi/pi-tui";
import { KEYBINDINGS, KeybindingsManager } from "../../config/keybindings";
import { HistoryStorage } from "../../session/history-storage";

export interface RpcKeybinding {
	action: string;
	keys: string[];
	display: string;
	description?: string;
}

export async function buildRpcKeybindings(): Promise<RpcKeybinding[]> {
	try {
		const manager = KeybindingsManager.create();
		const effective = manager.getEffectiveConfig();
		return Object.entries(KEYBINDINGS).map(([action, definition]) => {
			const configured = effective[action];
			const keys = configured === undefined ? [] : Array.isArray(configured) ? configured : [configured];
			return {
				action,
				keys: keys.map(key => String(key)),
				display: manager.getDisplayString(action as Keybinding),
				...(definition.description === undefined ? {} : { description: definition.description }),
			};
		});
	} catch {
		return [];
	}
}

export interface RpcPromptHistoryEntry {
	text: string;
	cwd?: string;
	sessionId?: string;
	at?: string;
}

export async function readRpcPromptHistory(options: {
	cwd?: string;
	query?: string;
	limit?: number;
}): Promise<RpcPromptHistoryEntry[]> {
	try {
		const limit = Math.max(1, Math.min(1000, options.limit ?? 100));
		const storage = HistoryStorage.open();
		const entries =
			options.query === undefined
				? storage.getRecent(options.cwd === undefined ? limit : 1000)
				: storage.search(options.query, options.cwd === undefined ? limit : 1000);

		return entries
			.filter(entry => options.cwd === undefined || entry.cwd === options.cwd)
			.slice(0, limit)
			.map(entry => ({
				text: entry.prompt,
				...(entry.cwd === undefined ? {} : { cwd: entry.cwd }),
				...(entry.sessionId === undefined ? {} : { sessionId: entry.sessionId }),
				...(Number.isFinite(entry.created_at) ? { at: new Date(entry.created_at * 1000).toISOString() } : {}),
			}));
	} catch {
		return [];
	}
}
