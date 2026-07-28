import type { AutocompleteProvider, SlashCommand } from "@oh-my-pi/pi-tui";
import type { AgentSession } from "../session/agent-session";
import { BUILTIN_SLASH_COMMAND_RESERVED_NAMES, BUILTIN_SLASH_COMMANDS } from "../slash-commands/builtin-registry";
import { PromptActionAutocompleteProvider } from "./prompt-action-autocomplete";

export interface RpcCompletionItem {
	value: string;
	label: string;
	description?: string;
	kind?: string;
}

export interface RpcCompletionResult {
	items: RpcCompletionItem[];
	/** The provider's match text for display/filtering, not an application span. */
	prefix: string;
}

export interface RpcCompletionApplied {
	lines: string[];
	cursor: { line: number; column: number };
}

/**
 * Builds the command order shared by interactive and headless completion.
 * The caller may supply TUI-materialized builtins to retain their live display
 * descriptions; headless callers use the static builtin registry.
 */
export function buildSessionAutocompleteCommands(
	session: AgentSession,
	builtinCommands: ReadonlyArray<SlashCommand> = BUILTIN_SLASH_COMMANDS,
): SlashCommand[] {
	const hookCommands: SlashCommand[] = (
		session.extensionRunner?.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES) ?? []
	).map(command => ({
		name: command.name,
		description: command.description ?? "(hook command)",
		getArgumentCompletions: command.getArgumentCompletions,
	}));
	const customCommands: SlashCommand[] = session.customCommands.map(loaded => ({
		name: loaded.command.name,
		description: `${loaded.command.description} (${loaded.source})`,
	}));
	const skillCommands: SlashCommand[] =
		session.skillsSettings?.enableSkillCommands === false
			? []
			: session.skills.map(skill => ({ name: `skill:${skill.name}`, description: skill.description }));
	const fileCommands: SlashCommand[] = session.slashCommands.map(command => ({
		name: command.name,
		description: command.description,
	}));
	const commands = [...builtinCommands, ...hookCommands, ...customCommands, ...skillCommands, ...fileCommands];
	const reservedNames = new Set<string>();
	for (const command of commands) {
		reservedNames.add(command.name);
		for (const alias of command.aliases ?? []) reservedNames.add(alias);
	}
	const promptTemplateCommands: SlashCommand[] = session.promptTemplates
		.filter(template => !reservedNames.has(template.name))
		.map(template => ({ name: template.name, description: template.description }));

	return [...commands, ...promptTemplateCommands];
}

export function buildSessionAutocompleteProvider(session: AgentSession): AutocompleteProvider {
	return new PromptActionAutocompleteProvider(
		buildSessionAutocompleteCommands(session, BUILTIN_SLASH_COMMANDS),
		session.sessionManager.getCwd(),
		[],
	);
}

/** Builds the shared provider with InteractiveMode's live builtin descriptions. */
export function buildInteractiveSessionAutocompleteProvider(
	session: AgentSession,
	builtinCommands: ReadonlyArray<SlashCommand>,
): AutocompleteProvider {
	return new PromptActionAutocompleteProvider(
		buildSessionAutocompleteCommands(session, builtinCommands),
		session.sessionManager.getCwd(),
		[],
	);
}

export async function completeForSession(
	session: AgentSession,
	lines: string[],
	cursor: { line: number; column: number },
): Promise<RpcCompletionResult> {
	const result = await buildSessionAutocompleteProvider(session).getSuggestions(lines, cursor.line, cursor.column);
	if (!result) return { items: [], prefix: "" };

	return {
		items: result.items.map(item => ({
			value: item.value,
			label: item.label,
			...(typeof item.description === "string" ? { description: item.description } : {}),
		})),
		prefix: result.prefix,
	};
}

/**
 * Applies a currently offered completion through the provider itself. Recomputing
 * avoids serializing provider-private fields; no shared provider item needs
 * fields beyond the DTO to determine its application behavior. It rejects when
 * the item is no longer offered rather than applying a stale completion.
 */
export async function applyCompletionForSession(
	session: AgentSession,
	lines: string[],
	cursor: { line: number; column: number },
	item: RpcCompletionItem,
): Promise<RpcCompletionApplied> {
	const provider = buildSessionAutocompleteProvider(session);
	const suggestions = await provider.getSuggestions(lines, cursor.line, cursor.column);
	if (!suggestions) throw new Error("Completion is no longer available");
	const selected = suggestions.items.find(
		candidate =>
			candidate.value === item.value && candidate.label === item.label && candidate.description === item.description,
	);
	if (!selected) throw new Error("Selected completion is no longer available");

	const applied = provider.applyCompletion(lines, cursor.line, cursor.column, selected, suggestions.prefix);
	return {
		lines: applied.lines,
		cursor: { line: applied.cursorLine, column: applied.cursorCol },
	};
}
