import { getWorkProfile } from "@oh-my-pi/pi-natives";
import { getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import { generateHeapSnapshotData, type ProfilerSession, startCpuProfile } from "../../debug/profiler";
import { type RawSseDebugRecord, resolveRawSseDebugBuffer } from "../../debug/raw-sse-buffer";
import { getRemoteDebugger, startRemoteDebuggerServer } from "../../debug/remote-debugger";
import { clearArtifactCache, createDebugLogSource, createReportBundle } from "../../debug/report-bundle";
import { collectSystemInfo } from "../../debug/system-info";
import type { MCPAuthHandler } from "../../mcp/manager";
import type { MCPAuthChallenge, MCPServerConfig } from "../../mcp/types";
import type { AgentSession } from "../../session/agent-session";

export interface RpcDiagnosticArtifact {
	path: string;
}

export interface RpcRecentLogs {
	lines: string[];
}

export type RpcRawSseRecord =
	| {
			kind: "response";
			sequence: number;
			timestamp: number;
			provider: string | null;
			model: string | null;
			api: string | null;
			status: number;
			requestId: string | null;
			transport: string | null;
	  }
	| {
			kind: "event";
			sequence: number;
			timestamp: number;
			provider: string | null;
			model: string | null;
			api: string | null;
			event: string | null;
			raw: string[];
			truncated: boolean;
			originalChars: number;
	  };

export interface RpcRawSseSnapshot {
	records: RpcRawSseRecord[];
	droppedRecords: number;
	droppedChars: number;
	totalEvents: number;
	lastUpdatedAt: number | null;
}

export interface RpcInspectorEndpoint {
	host: string;
	port: number;
}

export interface RpcSystemInfo {
	os: string;
	arch: string;
	cpu: string;
	memory: { total: number; free: number };
	versions: { app: string; bun: string; node: string };
	cwd: string;
	shell: string;
	terminal: string | null;
}

export interface RpcStartupWarnings {
	configWarnings: string[];
	skillWarnings: Array<{ skillPath: string; message: string }>;
}

export interface RpcMcpAuthChallenge {
	id: string;
	serverName: string;
	wwwAuthenticate: string[];
}

export interface RpcMcpAuthChallengeController {
	handler: MCPAuthHandler;
}

type PendingMcpAuthChallenge = {
	challenge: RpcMcpAuthChallenge;
	resolve: (config: MCPServerConfig | undefined) => void;
};

const cpuProfiles = new WeakMap<AgentSession, Promise<ProfilerSession>>();
const mcpAuthStates = new WeakMap<RpcMcpAuthChallengeController, Map<string, PendingMcpAuthChallenge>>();

function resolvedSettings(session: AgentSession): Record<string, unknown> {
	return {
		model: session.model?.id,
		thinkingLevel: session.thinkingLevel,
	};
}

function rawSseText(session: AgentSession): string | undefined {
	const text = resolveRawSseDebugBuffer(session).toRawText();
	return text.trim().length > 0 ? text : undefined;
}

function toRpcRawSseRecord(record: RawSseDebugRecord): RpcRawSseRecord {
	if (record.kind === "response") {
		return {
			kind: record.kind,
			sequence: record.sequence,
			timestamp: record.timestamp,
			provider: record.provider ?? null,
			model: record.model ?? null,
			api: record.api ?? null,
			status: record.status,
			requestId: record.requestId ?? null,
			transport: record.transport ?? null,
		};
	}
	return {
		kind: record.kind,
		sequence: record.sequence,
		timestamp: record.timestamp,
		provider: record.provider ?? null,
		model: record.model ?? null,
		api: record.api ?? null,
		event: record.event,
		raw: [...record.raw],
		truncated: record.truncated,
		originalChars: record.originalChars,
	};
}

function rpcRawSseSnapshot(session: AgentSession): RpcRawSseSnapshot {
	const snapshot = resolveRawSseDebugBuffer(session).snapshot();
	return {
		records: snapshot.records.map(toRpcRawSseRecord),
		droppedRecords: snapshot.droppedRecords,
		droppedChars: snapshot.droppedChars,
		totalEvents: snapshot.totalEvents,
		lastUpdatedAt: snapshot.lastUpdatedAt ?? null,
	};
}

export async function startRpcCpuProfile(session: AgentSession): Promise<void> {
	if (cpuProfiles.has(session)) throw new Error("CPU profiling is already running");
	const profiler = startCpuProfile();
	cpuProfiles.set(session, profiler);
	try {
		await profiler;
	} catch (error) {
		cpuProfiles.delete(session);
		throw error;
	}
}

export async function stopRpcCpuProfile(session: AgentSession): Promise<RpcDiagnosticArtifact> {
	const startedProfiler = cpuProfiles.get(session);
	if (!startedProfiler) throw new Error("CPU profiling is not running");

	const cpuProfile = await (await startedProfiler).stop();
	cpuProfiles.delete(session);
	const report = await createReportBundle({
		sessionFile: session.sessionManager.getSessionFile(),
		settings: resolvedSettings(session),
		rawSseText: rawSseText(session),
		cpuProfile,
		workProfile: getWorkProfile(30),
	});
	return { path: report.path };
}

export async function createRpcHeapProfile(session: AgentSession): Promise<RpcDiagnosticArtifact> {
	const report = await createReportBundle({
		sessionFile: session.sessionManager.getSessionFile(),
		settings: resolvedSettings(session),
		rawSseText: rawSseText(session),
		heapSnapshot: generateHeapSnapshotData(),
	});
	return { path: report.path };
}

export async function createRpcSupportBundle(session: AgentSession): Promise<RpcDiagnosticArtifact> {
	const report = await createReportBundle({
		sessionFile: session.sessionManager.getSessionFile(),
		settings: resolvedSettings(session),
		rawSseText: rawSseText(session),
	});
	return { path: report.path };
}

export async function createRpcWorkProfile(session: AgentSession): Promise<RpcDiagnosticArtifact> {
	const report = await createReportBundle({
		sessionFile: session.sessionManager.getSessionFile(),
		settings: resolvedSettings(session),
		rawSseText: rawSseText(session),
		workProfile: getWorkProfile(30),
	});
	return { path: report.path };
}

export async function readRpcRecentLogs(
	_session: AgentSession,
	maxLines: number = 50,
	olderDays: number = 0,
): Promise<RpcRecentLogs> {
	const source = await createDebugLogSource();
	const current = await source.getInitialText();
	const days = Number.isFinite(olderDays) ? Math.max(0, Math.floor(olderDays)) : 0;
	const previous = days > 0 ? await source.loadOlderLogs(Math.max(1, days)) : "";
	const limit = Number.isFinite(maxLines) ? Math.max(1, Math.min(5_000, Math.floor(maxLines))) : 50;
	const text = `${previous}${previous && current ? "\n" : ""}${current}`;
	return { lines: text.length === 0 ? [] : text.split("\n").slice(-limit) };
}

export async function readRpcRawSseSnapshot(session: AgentSession): Promise<RpcRawSseSnapshot> {
	return rpcRawSseSnapshot(session);
}

/** Raw SSE is captured continuously; unsubscribe to stop forwarding snapshots to the RPC host. */
export function subscribeRpcRawSse(session: AgentSession, listener: (snapshot: RpcRawSseSnapshot) => void): () => void {
	const buffer = resolveRawSseDebugBuffer(session);
	return buffer.subscribe(() => {
		try {
			listener(rpcRawSseSnapshot(session));
		} catch (error) {
			logger.error("Failed to forward raw SSE diagnostics", { error });
		}
	});
}

export async function startRpcInspector(_session: AgentSession): Promise<RpcInspectorEndpoint> {
	return getRemoteDebugger() ?? (await startRemoteDebuggerServer());
}

export async function readRpcSystemInfo(_session: AgentSession): Promise<RpcSystemInfo> {
	const info = await collectSystemInfo();
	return { ...info, terminal: info.terminal ?? null };
}

export async function readRpcStartupWarnings(session: AgentSession): Promise<RpcStartupWarnings> {
	return {
		configWarnings: [...session.configWarnings],
		skillWarnings: session.skillWarnings.map(({ skillPath, message }) => ({ skillPath, message })),
	};
}

export async function getRpcArtifactsDirectory(session: AgentSession): Promise<RpcDiagnosticArtifact> {
	const sessionFile = session.sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("No active session file");
	return { path: sessionFile.slice(0, -6) };
}

export async function clearRpcArtifactCache(
	_session: AgentSession,
	daysOld: number = 30,
): Promise<{ removed: number }> {
	const days = Number.isFinite(daysOld) ? Math.max(0, Math.floor(daysOld)) : 30;
	return await clearArtifactCache(getSessionsDir(), days);
}

export function buildRpcMcpAuthHandler(
	onChallenge: (challenge: RpcMcpAuthChallenge) => void,
): RpcMcpAuthChallengeController {
	const pending = new Map<string, PendingMcpAuthChallenge>();
	const controller = {
		handler: async (serverName: string, challenge: MCPAuthChallenge): Promise<MCPServerConfig | undefined> => {
			const completion = Promise.withResolvers<MCPServerConfig | undefined>();
			const pendingChallenge: RpcMcpAuthChallenge = {
				id: crypto.randomUUID(),
				serverName,
				wwwAuthenticate: [...challenge.wwwAuthenticate],
			};
			pending.set(pendingChallenge.id, { challenge: pendingChallenge, resolve: completion.resolve });
			try {
				onChallenge(pendingChallenge);
			} catch (error) {
				pending.delete(pendingChallenge.id);
				completion.reject(error);
			}
			return await completion.promise;
		},
	};
	mcpAuthStates.set(controller, pending);
	return controller;
}

export function readPendingRpcMcpAuthChallenges(controller: RpcMcpAuthChallengeController): RpcMcpAuthChallenge[] {
	const pending = mcpAuthStates.get(controller);
	if (!pending) throw new Error("Unknown MCP auth challenge controller");
	return [...pending.values()].map(({ challenge }) => ({
		...challenge,
		wwwAuthenticate: [...challenge.wwwAuthenticate],
	}));
}

export function resolveRpcMcpAuthChallenge(
	controller: RpcMcpAuthChallengeController,
	challengeId: string,
	config: MCPServerConfig | undefined,
): boolean {
	const pending = mcpAuthStates.get(controller);
	if (!pending) throw new Error("Unknown MCP auth challenge controller");
	const challenge = pending.get(challengeId);
	if (!challenge) return false;
	pending.delete(challengeId);
	challenge.resolve(config);
	return true;
}
