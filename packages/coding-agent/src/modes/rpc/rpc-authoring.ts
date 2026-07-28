import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@oh-my-pi/pi-utils";
import type { AdvisorConfig, AdvisorConfigScope, WatchdogConfigDoc } from "../../advisor";
import {
	discoverAdvisorConfigs,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
} from "../../advisor";
import type { Rule } from "../../capability/rule";
import { getConfigDirs } from "../../config";
import type {
	CreateMentalModelResponse,
	MentalModelDetail,
	MentalModelHistoryEntry,
	MentalModelMode,
	MentalModelSummary,
	RefreshMentalModelResponse,
} from "../../hindsight";
import {
	ensureMentalModels,
	loadHindsightConfig,
	reloadMentalModelsForSession,
	resolveSeedsForScope,
} from "../../hindsight";
import type { AgentSession } from "../../session/agent-session";
import { parseAgent } from "../../task/agents";
import { discoverAgents } from "../../task/discovery";
import type { AgentDefinition, AgentSource } from "../../task/types";
import { repo } from "../../utils/git";
import {
	buildOmfgRuleForPath,
	generateOmfgCandidate,
	type OmfgRuleSourceLevel,
	parseGeneratedRule,
} from "../controllers/omfg-rule";

export type RpcAuthoringScope = "project" | "user";

export interface RpcAdvisorConfig {
	name: string;
	model?: string;
	tools?: string[];
	instructions?: string;
	enabled?: boolean;
}

export interface RpcAdvisorConfigSnapshot {
	scope: RpcAuthoringScope;
	path: string;
	instructions: string | null;
	advisors: RpcAdvisorConfig[];
}

export interface RpcTtsrRule {
	name: string;
	path: string;
	content: string;
	description: string | null;
	globs: string[];
	alwaysApply: boolean;
	condition: string[];
	astCondition: string[];
	scope: string[];
	interruptMode: "never" | "prose-only" | "tool-only" | "always" | null;
	source: {
		provider: string;
		providerName: string;
		path: string;
		level: "user" | "project" | "native";
	};
}

export interface RpcTtsrRuleDraft {
	rule: RpcTtsrRule;
	fileContent: string;
}

export interface RpcTtsrGeneratedCandidate extends RpcTtsrRuleDraft {
	validated: boolean;
}

export interface RpcTtsrGenerationDelta {
	type: "tts_rule_delta";
	attempt: number;
	delta: string;
}

export type RpcTtsrGenerationEventSink = (event: RpcTtsrGenerationDelta) => void;

export interface RpcTtsrRegistration {
	rule: RpcTtsrRule;
	fileContent: string;
	registered: boolean;
	replaced: boolean;
}

export interface RpcTtsrRemoval {
	name: string;
	removed: boolean;
	persistedDeleted: boolean;
}

export interface RpcAgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: AgentDefinition["thinkingLevel"];
	output?: unknown;
	blocking?: boolean;
	autoloadSkills?: string[];
	readSummarize?: boolean;
	prewalk?: boolean | string;
	source: AgentSource;
	filePath: string | null;
	writable: boolean;
}

export interface RpcAgentDefinitionDocument {
	definition: RpcAgentDefinition;
	content: string | null;
}

export interface RpcAgentDefinitionDeleteResult {
	name: string;
	scope: RpcAuthoringScope;
	path: string;
	deleted: boolean;
}

export interface RpcMentalModel extends MentalModelSummary {}

export interface RpcMentalModelList {
	bankId: string;
	items: RpcMentalModel[];
}

export interface RpcMentalModelHistory {
	bankId: string;
	model: RpcMentalModel;
	history: MentalModelHistoryEntry[];
}

export interface RpcMentalModelOperation extends CreateMentalModelResponse {}

export interface RpcMentalModelRefreshOperation extends RefreshMentalModelResponse {}

export interface RpcMentalModelBulkRefresh {
	bankId: string;
	queued: string[];
	skipped: string[];
	failures: Array<{ id: string; error: string }>;
}

export interface RpcMentalModelSeedResult {
	bankId: string;
	seedIds: string[];
	failures: Array<{ id: string; error: string }>;
}

export interface RpcMentalModelDeleteResult {
	bankId: string;
	id: string;
	deleted: boolean;
	reloaded: boolean;
}

export interface RpcMentalModelReloadResult {
	bankId: string;
	reloaded: boolean;
}

function toRpcAdvisor(config: AdvisorConfig): RpcAdvisorConfig {
	return {
		name: config.name,
		...(config.model !== undefined ? { model: config.model } : {}),
		...(config.tools !== undefined ? { tools: [...config.tools] } : {}),
		...(config.instructions !== undefined ? { instructions: config.instructions } : {}),
		...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
	};
}

async function resolveAdvisorDirs(session: AgentSession): Promise<{ projectDir: string; agentDir: string }> {
	const cwd = session.sessionManager.getCwd();
	let projectDir = cwd;
	try {
		projectDir = (await repo.root(cwd)) ?? cwd;
	} catch {
		projectDir = cwd;
	}
	return { projectDir, agentDir: session.settings.getAgentDir() };
}

async function readAdvisorConfigAt(
	session: AgentSession,
	scope: AdvisorConfigScope,
): Promise<RpcAdvisorConfigSnapshot> {
	const filePath = await resolveAdvisorConfigEditPath(scope, await resolveAdvisorDirs(session));
	const doc = await loadWatchdogConfigFile(filePath);
	return {
		scope,
		path: filePath,
		instructions: doc.instructions ?? null,
		advisors: doc.advisors.map(toRpcAdvisor),
	};
}

function toWatchdogDoc(instructions: string | null, advisors: RpcAdvisorConfig[]): WatchdogConfigDoc {
	const doc: WatchdogConfigDoc = {
		advisors: advisors.map(advisor => ({
			name: advisor.name,
			...(advisor.model !== undefined ? { model: advisor.model } : {}),
			...(advisor.tools !== undefined ? { tools: [...advisor.tools] } : {}),
			...(advisor.instructions !== undefined ? { instructions: advisor.instructions } : {}),
			...(advisor.enabled !== undefined ? { enabled: advisor.enabled } : {}),
		})),
	};
	if (instructions !== null) doc.instructions = instructions;
	return doc;
}

/** Reads one raw project/user WATCHDOG document through the advisor config layer. */
export async function readRpcAdvisorConfig(
	session: AgentSession,
	scope: RpcAuthoringScope,
): Promise<RpcAdvisorConfigSnapshot> {
	return readAdvisorConfigAt(session, scope);
}

/** Saves one WATCHDOG document, then applies the merged roster to the live session. */
export async function writeRpcAdvisorConfig(
	session: AgentSession,
	scope: RpcAuthoringScope,
	instructions: string | null,
	advisors: RpcAdvisorConfig[],
): Promise<RpcAdvisorConfigSnapshot> {
	const dirs = await resolveAdvisorDirs(session);
	const filePath = await resolveAdvisorConfigEditPath(scope, dirs);
	await saveWatchdogConfigFile(filePath, toWatchdogDoc(instructions, advisors));
	const discovered = await discoverAdvisorConfigs(session.sessionManager.getCwd(), dirs.agentDir);
	session.applyAdvisorConfigs(discovered.advisors, discovered.sharedInstructions);
	return readAdvisorConfigAt(session, scope);
}

function toRpcTtsrRule(rule: Rule): RpcTtsrRule {
	return {
		name: rule.name,
		path: rule.path,
		content: rule.content,
		description: rule.description ?? null,
		globs: [...(rule.globs ?? [])],
		alwaysApply: rule.alwaysApply === true,
		condition: [...(rule.condition ?? [])],
		astCondition: [...(rule.astCondition ?? [])],
		scope: [...(rule.scope ?? [])],
		interruptMode: rule.interruptMode ?? null,
		source: { ...rule._source },
	};
}

function buildTtsrCandidate(
	name: string,
	description: string,
	conditions: string[],
	scopes: string[],
	body: string,
): { rule: Rule; fileContent: string } {
	const parsed = parseGeneratedRule(JSON.stringify({ name, description, condition: conditions, scope: scopes, body }));
	if ("error" in parsed) throw new Error(parsed.error);
	return parsed;
}

function resolveTtsrPath(session: AgentSession, scope: RpcAuthoringScope, ruleName: string): string {
	return scope === "user"
		? path.join(session.settings.getAgentDir(), "rules", `${ruleName}.md`)
		: path.join(session.sessionManager.getCwd(), CONFIG_DIR_NAME, "rules", `${ruleName}.md`);
}

/** Builds and validates the same canonical Markdown candidate used by `/omfg`. */
export async function buildRpcTtsrRule(
	_session: AgentSession,
	name: string,
	description: string,
	conditions: string[],
	scopes: string[],
	body: string,
): Promise<RpcTtsrRuleDraft> {
	const candidate = buildTtsrCandidate(name, description, conditions, scopes, body);
	return { rule: toRpcTtsrRule(candidate.rule), fileContent: candidate.fileContent };
}

/**
 * Generates an OMFG rule from a complaint. Passing both feedback and the
 * previous canonical Markdown candidate performs the amendment round-trip.
 */
export async function generateRpcTtsrRule(
	session: AgentSession,
	complaint: string,
	feedback?: string,
	previousRule?: string,
	emit?: RpcTtsrGenerationEventSink,
): Promise<RpcTtsrGeneratedCandidate> {
	const trimmedComplaint = complaint.trim();
	if (!trimmedComplaint) throw new Error("TTSR generation requires a complaint");
	if (!session.model) throw new Error("No active model available for TTSR generation");

	const trimmedFeedback = feedback?.trim();
	const trimmedPreviousRule = previousRule?.trim();
	if (feedback !== undefined && !trimmedFeedback) throw new Error("TTSR amendment feedback cannot be empty");
	if (previousRule !== undefined && !trimmedPreviousRule) {
		throw new Error("TTSR amendment previousRule cannot be empty");
	}
	if ((trimmedFeedback === undefined) !== (trimmedPreviousRule === undefined)) {
		throw new Error("TTSR amendment requires both feedback and previousRule");
	}

	const candidate = await generateOmfgCandidate(session, trimmedComplaint, {
		...(trimmedFeedback !== undefined
			? { initialFeedback: `User requested this amendment before saving:\n${trimmedFeedback}` }
			: {}),
		...(previousRule !== undefined ? { previousRule } : {}),
		onEvent: event => {
			if (event.type === "text_delta") {
				emit?.({ type: "tts_rule_delta", attempt: event.attempt, delta: event.delta });
			}
		},
	});
	if (!candidate) throw new Error("The model did not return a valid TTSR rule");
	return {
		rule: toRpcTtsrRule(candidate.rule),
		fileContent: candidate.fileContent,
		validated: candidate.validated,
	};
}

/** Persists an OMFG rule and installs/replaces it in the live TTSR manager. */
export async function registerRpcTtsrRule(
	session: AgentSession,
	scope: RpcAuthoringScope,
	name: string,
	description: string,
	conditions: string[],
	scopes: string[],
	body: string,
	overwrite: boolean,
): Promise<RpcTtsrRegistration> {
	const candidate = buildTtsrCandidate(name, description, conditions, scopes, body);
	const filePath = resolveTtsrPath(session, scope, candidate.rule.name);
	if (!overwrite && (await Bun.file(filePath).exists())) throw new Error(`TTSR rule already exists: ${filePath}`);

	await Bun.write(filePath, candidate.fileContent);
	const rule = buildOmfgRuleForPath(
		candidate.rule.name,
		candidate.fileContent,
		filePath,
		scope as OmfgRuleSourceLevel,
	);
	const manager = session.ttsrManager;
	const previous = manager?.getRules().find(existing => existing.name === rule.name);
	if (previous) manager?.removeRule(rule.name);
	const registered = manager?.addRule(rule) ?? false;
	if (!registered && previous) manager?.addRule(previous);
	return {
		rule: toRpcTtsrRule(rule),
		fileContent: candidate.fileContent,
		registered,
		replaced: previous !== undefined,
	};
}

/** Lists rules currently compiled into the live session's TTSR manager. */
export async function listRpcTtsrRules(session: AgentSession): Promise<RpcTtsrRule[]> {
	return (session.ttsrManager?.getRules() ?? []).map(toRpcTtsrRule);
}

/** Removes a rule from live matching and optionally deletes its OMFG-authored file. */
export async function removeRpcTtsrRule(
	session: AgentSession,
	name: string,
	deletePersisted: boolean,
): Promise<RpcTtsrRemoval> {
	const manager = session.ttsrManager;
	if (!manager) throw new Error("TTSR is not active for this session");
	const rule = manager.getRules().find(candidate => candidate.name === name);
	if (!rule) return { name, removed: false, persistedDeleted: false };
	if (deletePersisted) {
		if (rule._source.provider !== "omfg") throw new Error(`Rule ${name} is not an OMFG-authored rule`);
		await fs.rm(rule.path, { force: true });
	}
	return {
		name,
		removed: manager.removeRule(name),
		persistedDeleted: deletePersisted,
	};
}

function toRpcAgentDefinition(definition: AgentDefinition, writable: boolean): RpcAgentDefinition {
	return {
		name: definition.name,
		description: definition.description,
		systemPrompt: definition.systemPrompt,
		...(definition.tools !== undefined ? { tools: [...definition.tools] } : {}),
		...(definition.spawns !== undefined ? { spawns: definition.spawns === "*" ? "*" : [...definition.spawns] } : {}),
		...(definition.model !== undefined ? { model: [...definition.model] } : {}),
		...(definition.thinkingLevel !== undefined ? { thinkingLevel: definition.thinkingLevel } : {}),
		...(definition.output !== undefined ? { output: definition.output } : {}),
		...(definition.blocking !== undefined ? { blocking: definition.blocking } : {}),
		...(definition.autoloadSkills !== undefined ? { autoloadSkills: [...definition.autoloadSkills] } : {}),
		...(definition.readSummarize !== undefined ? { readSummarize: definition.readSummarize } : {}),
		...(definition.prewalk !== undefined ? { prewalk: definition.prewalk } : {}),
		source: definition.source,
		filePath: definition.filePath ?? null,
		writable,
	};
}

function assertAgentName(name: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error(`Invalid agent name: ${name}`);
}

function resolveAgentPath(session: AgentSession, scope: RpcAuthoringScope, name: string): string {
	assertAgentName(name);
	const dirs = getConfigDirs("agents", {
		user: scope === "user",
		project: scope === "project",
		cwd: session.sessionManager.getCwd(),
	});
	const targetDir = dirs[0]?.path;
	if (!targetDir) throw new Error(`Cannot resolve ${scope} agents directory`);
	return path.join(targetDir, `${name}.md`);
}

function isWritableAgentDefinition(session: AgentSession, definition: AgentDefinition): boolean {
	if (!definition.filePath || definition.source === "bundled") return false;
	const cwd = session.sessionManager.getCwd();
	const writableDirs = [
		...getConfigDirs("agents", { user: false, cwd }),
		...getConfigDirs("agents", { project: false, cwd }),
	].map(entry => path.resolve(entry.path));
	return writableDirs.includes(path.dirname(path.resolve(definition.filePath)));
}

/** Lists the effective task-agent catalog in discovery precedence order. */
export async function listRpcAgentDefinitions(session: AgentSession): Promise<RpcAgentDefinition[]> {
	const { agents } = await discoverAgents(session.sessionManager.getCwd());
	return agents.map(agent => toRpcAgentDefinition(agent, isWritableAgentDefinition(session, agent)));
}

/** Reads either the effective definition or a specific project/user definition. */
export async function readRpcAgentDefinition(
	session: AgentSession,
	name: string,
	scope: RpcAuthoringScope | null,
): Promise<RpcAgentDefinitionDocument | null> {
	assertAgentName(name);
	let definition: AgentDefinition | undefined;
	if (scope === null) {
		definition = (await discoverAgents(session.sessionManager.getCwd())).agents.find(agent => agent.name === name);
	} else {
		const filePath = resolveAgentPath(session, scope, name);
		if (!(await Bun.file(filePath).exists())) return null;
		definition = parseAgent(filePath, await Bun.file(filePath).text(), scope);
	}
	if (!definition) return null;
	const writable = isWritableAgentDefinition(session, definition);
	const content = definition.filePath ? await Bun.file(definition.filePath).text() : null;
	return { definition: toRpcAgentDefinition(definition, writable), content };
}

/** Creates or replaces an agent definition after validation by the canonical parser. */
export async function writeRpcAgentDefinition(
	session: AgentSession,
	scope: RpcAuthoringScope,
	name: string,
	content: string,
	overwrite: boolean,
): Promise<RpcAgentDefinitionDocument> {
	const filePath = resolveAgentPath(session, scope, name);
	if (!overwrite && (await Bun.file(filePath).exists()))
		throw new Error(`Agent definition already exists: ${filePath}`);
	const definition = parseAgent(filePath, content, scope);
	if (definition.name !== name) throw new Error(`Agent frontmatter name ${definition.name} does not match ${name}`);
	await Bun.write(filePath, content);
	return { definition: toRpcAgentDefinition(definition, true), content };
}

/** Deletes a project/user agent definition; bundled and extension-owned files are never targeted. */
export async function deleteRpcAgentDefinition(
	session: AgentSession,
	scope: RpcAuthoringScope,
	name: string,
): Promise<RpcAgentDefinitionDeleteResult> {
	const filePath = resolveAgentPath(session, scope, name);
	const deleted = await Bun.file(filePath).exists();
	await fs.rm(filePath, { force: true });
	return { name, scope, path: filePath, deleted };
}

function requireHindsightState(session: AgentSession) {
	const state = session.getHindsightSessionState();
	const primary = state && !state.aliasOf ? state : undefined;
	if (!primary) throw new Error("Hindsight backend is not active for this session");
	if (!primary.config.mentalModelsEnabled) {
		throw new Error("Mental models are disabled (hindsight.mentalModelsEnabled = false)");
	}
	return primary;
}

/** Lists mental models on the active Hindsight bank. */
export async function listRpcMentalModels(
	session: AgentSession,
	detail: MentalModelDetail,
): Promise<RpcMentalModelList> {
	const state = requireHindsightState(session);
	const response = await state.client.listMentalModels(state.bankId, { detail });
	return { bankId: state.bankId, items: response.items ?? [] };
}

/** Reads one mental model from the active Hindsight bank. */
export async function readRpcMentalModel(
	session: AgentSession,
	id: string,
	detail: MentalModelDetail,
): Promise<RpcMentalModel | null> {
	const state = requireHindsightState(session);
	return state.client.getMentalModel(state.bankId, id, { detail });
}

/** Creates a mental model through the active session's Hindsight client. */
export async function createRpcMentalModel(
	session: AgentSession,
	name: string,
	sourceQuery: string,
	id: string | null,
	tags: string[] | null,
	maxTokens: number | null,
	mode: MentalModelMode | null,
	refreshAfterConsolidation: boolean | null,
): Promise<RpcMentalModelOperation> {
	const state = requireHindsightState(session);
	return state.client.createMentalModel(state.bankId, name, sourceQuery, {
		id: id ?? undefined,
		tags: tags ?? undefined,
		maxTokens: maxTokens ?? undefined,
		trigger:
			mode !== null || refreshAfterConsolidation !== null
				? {
						...(mode !== null ? { mode } : {}),
						...(refreshAfterConsolidation !== null
							? { refresh_after_consolidation: refreshAfterConsolidation }
							: {}),
					}
				: undefined,
	});
}

/** Queues a refresh for one mental model. */
export async function refreshRpcMentalModel(
	session: AgentSession,
	id: string,
): Promise<RpcMentalModelRefreshOperation> {
	const state = requireHindsightState(session);
	const result = await state.client.refreshMentalModel(state.bankId, id);
	await Bun.sleep(500);
	await reloadMentalModelsForSession(state.session);
	return result;
}

/** Queues refreshes for every model that opted into bank-wide auto-refresh. */
export async function refreshRpcAutoMentalModels(session: AgentSession): Promise<RpcMentalModelBulkRefresh> {
	const state = requireHindsightState(session);
	const list = await state.client.listMentalModels(state.bankId, { detail: "content" });
	const targets = (list.items ?? []).filter(model => model.trigger?.refresh_after_consolidation === true);
	const skipped = (list.items ?? [])
		.filter(model => model.trigger?.refresh_after_consolidation !== true)
		.map(model => model.id);
	const queued: string[] = [];
	const failures: Array<{ id: string; error: string }> = [];
	for (const model of targets) {
		try {
			await state.client.refreshMentalModel(state.bankId, model.id);
			queued.push(model.id);
		} catch (error) {
			failures.push({ id: model.id, error: error instanceof Error ? error.message : String(error) });
		}
	}
	await Bun.sleep(500);
	await reloadMentalModelsForSession(state.session);
	return { bankId: state.bankId, queued, skipped, failures };
}

/** Returns a model and its most-recent-first content history. */
export async function readRpcMentalModelHistory(
	session: AgentSession,
	id: string,
): Promise<RpcMentalModelHistory | null> {
	const state = requireHindsightState(session);
	const [model, history] = await Promise.all([
		state.client.getMentalModel(state.bankId, id, { detail: "content" }),
		state.client.getMentalModelHistory(state.bankId, id),
	]);
	return model ? { bankId: state.bankId, model, history } : null;
}

/** Idempotently creates the built-in mental models applicable to the active bank scope. */
export async function seedRpcMentalModels(session: AgentSession): Promise<RpcMentalModelSeedResult> {
	const state = requireHindsightState(session);
	const config = loadHindsightConfig(session.settings);
	const seeds = resolveSeedsForScope(
		{
			bankId: state.bankId,
			retainTags: state.retainTags,
			recallTags: state.recallTags,
			recallTagsMatch: state.recallTagsMatch,
		},
		config.scoping,
	);
	const { seedIds, failures } = await ensureMentalModels(state.client, state.bankId, seeds, config.debug);
	return { bankId: state.bankId, seedIds, failures };
}

/** Deletes one mental model and refreshes the live system-prompt cache. */
export async function deleteRpcMentalModel(session: AgentSession, id: string): Promise<RpcMentalModelDeleteResult> {
	const state = requireHindsightState(session);
	const deleted = await state.client.deleteMentalModel(state.bankId, id);
	const reloaded = deleted ? await reloadMentalModelsForSession(state.session) : false;
	return { bankId: state.bankId, id, deleted, reloaded };
}

/** Re-pulls the active bank's cached mental-model block into the session. */
export async function reloadRpcMentalModels(session: AgentSession): Promise<RpcMentalModelReloadResult> {
	const state = requireHindsightState(session);
	return { bankId: state.bankId, reloaded: await reloadMentalModelsForSession(state.session) };
}
