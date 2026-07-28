import type { MCPManager } from "../../mcp/manager";
import {
	clearSmitheryApiKey,
	createSmitheryCliAuthSession,
	getSmitheryApiKey,
	pollSmitheryCliAuthSession,
	saveSmitheryApiKey,
} from "../../mcp/smithery-auth";
import { type SmitherySearchResult, searchSmitheryRegistry, toConfigName } from "../../mcp/smithery-registry";
import type { MCPServerConfig } from "../../mcp/types";
import type { AgentSession } from "../../session/agent-session";
import {
	activateMCPServerTools,
	addMCPServerRuntime,
	authorizeMCP,
	buildSmitheryMCPConfig,
	completeMCPReauth,
	type MCPAddScope,
	type MCPReauthPlan,
	nextAvailableMCPServerName,
	prepareMCPReauth,
	reconnectMCPRuntime,
	reloadMCPRuntime,
	removeMCPServerRuntime,
	setMCPServerEnabledRuntime,
	unauthMCPServerRuntime,
} from "../controllers/mcp-command-controller";

export interface RpcMCPServerResult {
	name: string;
	scope: MCPAddScope | null;
	changed: boolean;
	discovered: boolean;
	state: "connected" | "connecting" | "disconnected";
	toolCount: number;
	errors: Record<string, string>;
}

export interface RpcMCPReloadResult {
	connectedServers: string[];
	toolCount: number;
	errors: Record<string, string>;
}

export interface RpcMCPOAuthBegin {
	flowId: string;
	serverName: string;
	url: string;
	launchUrl: string | null;
	instructions: string | null;
}

export interface RpcMCPOAuthResult extends RpcMCPServerResult {
	credentialStored: true;
}

export interface RpcMCPRegistrySearchResult {
	results: SmitherySearchResult[];
}

export interface RpcMCPSmitheryLoginBegin {
	sessionId: string;
	authUrl: string;
}

export type RpcMCPSmitheryLoginResult =
	| { status: "pending"; authenticated: false }
	| { status: "authenticated"; authenticated: true };

interface ManualInputWaiter {
	promise: Promise<string>;
	resolve(value: string): void;
	reject(reason?: unknown): void;
}

interface PendingMCPAuthorization {
	plan: MCPReauthPlan;
	operation: Promise<MCPServerConfig>;
	abortController: AbortController;
	manualInputs: string[];
	manualWaiter?: ManualInputWaiter;
}

const pendingAuthorizations = new WeakMap<AgentSession, Map<string, PendingMCPAuthorization>>();

function authorizationMap(session: AgentSession): Map<string, PendingMCPAuthorization> {
	let flows = pendingAuthorizations.get(session);
	if (!flows) {
		flows = new Map();
		pendingAuthorizations.set(session, flows);
	}
	return flows;
}

function errorsToRecord(errors: Map<string, string> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [name, error] of errors ?? []) result[name] = error;
	return result;
}

function serverToolCount(manager: MCPManager, name: string): number {
	return manager.getTools().filter(tool => tool.mcpServerName === name).length;
}

async function waitForServer(
	session: AgentSession,
	manager: MCPManager,
	name: string,
): Promise<"connected" | "connecting" | "disconnected"> {
	if (manager.getConnectionStatus(name) === "connecting") {
		try {
			await Promise.race([manager.waitForConnection(name), Bun.sleep(10_000)]);
		} catch {
			// The state snapshot below is authoritative for failed or timed-out connections.
		}
	}
	const state = manager.getConnectionStatus(name);
	if (state === "connected") await session.refreshMCPTools(manager.getTools());
	return state;
}

async function serverResult(
	session: AgentSession,
	manager: MCPManager,
	name: string,
	scope: MCPAddScope | null,
	changed: boolean,
	discovered: boolean,
	errors?: Map<string, string>,
): Promise<RpcMCPServerResult> {
	const state = await waitForServer(session, manager, name);
	return {
		name,
		scope,
		changed,
		discovered,
		state,
		toolCount: serverToolCount(manager, name),
		errors: errorsToRecord(errors),
	};
}

function nextManualInput(pending: PendingMCPAuthorization): Promise<string> {
	const queued = pending.manualInputs.shift();
	if (queued !== undefined) return Promise.resolve(queued);
	const waiter = Promise.withResolvers<string>();
	pending.manualWaiter = waiter;
	return waiter.promise.finally(() => {
		if (pending.manualWaiter === waiter) pending.manualWaiter = undefined;
	});
}

function submitManualInput(pending: PendingMCPAuthorization, completion: string): void {
	const value = completion.trim();
	if (!value) throw new Error("OAuth completion must be an authorization code or redirect URL.");
	const waiter = pending.manualWaiter;
	if (waiter) {
		pending.manualWaiter = undefined;
		waiter.resolve(value);
		return;
	}
	pending.manualInputs.push(value);
}

/** Add a configured server, reload the live manager, and activate its tools. */
export async function addRpcMCPServer(
	session: AgentSession,
	mcpManager: MCPManager,
	name: string,
	config: MCPServerConfig,
	scope: MCPAddScope,
): Promise<RpcMCPServerResult> {
	const serverName = name.trim();
	if (!serverName) throw new Error("MCP server name is required.");
	const load = await addMCPServerRuntime({ session, mcpManager }, serverName, config, scope);
	const state = config.enabled === false ? "disconnected" : await waitForServer(session, mcpManager, serverName);
	if (state === "connected") await activateMCPServerTools({ session, mcpManager }, serverName);
	return {
		name: serverName,
		scope,
		changed: true,
		discovered: false,
		state,
		toolCount: serverToolCount(mcpManager, serverName),
		errors: errorsToRecord(load.errors),
	};
}

/** Remove a configured server and its live tools. */
export async function removeRpcMCPServer(
	session: AgentSession,
	mcpManager: MCPManager,
	name: string,
	scope: MCPAddScope,
): Promise<RpcMCPServerResult> {
	const serverName = name.trim();
	if (!serverName) throw new Error("MCP server name is required.");
	await removeMCPServerRuntime({ session, mcpManager }, serverName, scope);
	return {
		name: serverName,
		scope,
		changed: true,
		discovered: false,
		state: "disconnected",
		toolCount: 0,
		errors: {},
	};
}

/** Enable or disable a configured/discovered server in persistence and the live manager. */
export async function setRpcMCPServerEnabled(
	session: AgentSession,
	mcpManager: MCPManager,
	name: string,
	enabled: boolean,
): Promise<RpcMCPServerResult> {
	const serverName = name.trim();
	if (!serverName) throw new Error("MCP server name is required.");
	const change = await setMCPServerEnabledRuntime({ session, mcpManager }, serverName, enabled);
	return serverResult(session, mcpManager, serverName, change.scope, change.changed, change.discovered, change.errors);
}

/** Force a complete live MCP rediscovery and tool refresh. */
export async function reloadRpcMCP(session: AgentSession, mcpManager: MCPManager): Promise<RpcMCPReloadResult> {
	const result = await reloadMCPRuntime({ session, mcpManager });
	return {
		connectedServers: mcpManager.getConnectedServers(),
		toolCount: mcpManager.getTools().length,
		errors: errorsToRecord(result.errors),
	};
}

/** Reconnect one server and replace its live tools. */
export async function reconnectRpcMCPServer(
	session: AgentSession,
	mcpManager: MCPManager,
	name: string,
): Promise<RpcMCPServerResult> {
	const serverName = name.trim();
	if (!serverName) throw new Error("MCP server name is required.");
	await reconnectMCPRuntime({ session, mcpManager }, serverName);
	return serverResult(session, mcpManager, serverName, null, true, false);
}

/** Remove OMP-managed OAuth credentials and reload the live server. */
export async function unauthRpcMCPServer(
	session: AgentSession,
	mcpManager: MCPManager,
	name: string,
): Promise<RpcMCPServerResult> {
	const serverName = name.trim();
	if (!serverName) throw new Error("MCP server name is required.");
	const change = await unauthMCPServerRuntime({ session, mcpManager }, serverName);
	return serverResult(session, mcpManager, serverName, change.scope, change.changed, change.discovered);
}

/** Start proactive MCP OAuth and return the URL instead of opening a browser. */
export async function beginRpcMCPReauth(
	session: AgentSession,
	mcpManager: MCPManager,
	name: string,
): Promise<RpcMCPOAuthBegin> {
	const serverName = name.trim();
	if (!serverName) throw new Error("MCP server name is required.");
	const plan = await prepareMCPReauth({ session, mcpManager }, serverName);
	const flowId = crypto.randomUUID();
	const authReady = Promise.withResolvers<{ url: string; launchUrl?: string; instructions?: string }>();
	const abortController = new AbortController();
	const manualInputs: string[] = [];
	let pending: PendingMCPAuthorization;
	const operation = authorizeMCP(
		session,
		{
			authorizationUrl: plan.oauth.authorizationUrl,
			tokenUrl: plan.oauth.tokenUrl,
			clientId: plan.flowClientId,
			clientSecret: plan.flowClientSecret,
			scopes: plan.oauth.scopes,
			callbackPort: plan.found.config.oauth?.callbackPort,
			callbackPath: plan.found.config.oauth?.callbackPath,
			redirectUri: plan.found.config.oauth?.redirectUri,
			prompt: plan.found.config.oauth?.prompt,
			serverUrl: plan.serverUrl,
			registrationUrl: plan.oauth.registrationUrl,
			resource: plan.oauthResource,
			stripSameOriginResource: plan.oauthResourceIsFallback,
		},
		{
			onAuth: authReady.resolve,
			onManualCodeInput: () => nextManualInput(pending),
			signal: abortController.signal,
		},
	).then(result => completeMCPReauth({ session, mcpManager }, plan, result));
	pending = { plan, operation, abortController, manualInputs };
	const flows = authorizationMap(session);
	flows.set(flowId, pending);
	void operation.catch(authReady.reject);
	try {
		const authorization = await authReady.promise;
		return {
			flowId,
			serverName,
			url: authorization.url,
			launchUrl: authorization.launchUrl ?? null,
			instructions: authorization.instructions ?? null,
		};
	} catch (error) {
		flows.delete(flowId);
		throw error;
	}
}

/** Supply a pasted code/redirect URL, or just await an already-open browser callback. */
export async function completeRpcMCPReauth(
	session: AgentSession,
	mcpManager: MCPManager,
	flowId: string,
	completion?: string,
): Promise<RpcMCPOAuthResult> {
	const flows = authorizationMap(session);
	const pending = flows.get(flowId);
	if (!pending) throw new Error(`Unknown or expired MCP OAuth flow: ${flowId}`);
	if (completion !== undefined) submitManualInput(pending, completion);
	try {
		await pending.operation;
		const result = await serverResult(
			session,
			mcpManager,
			pending.plan.name,
			pending.plan.found.scope,
			true,
			pending.plan.found.discovered,
		);
		return { ...result, credentialStored: true };
	} finally {
		flows.delete(flowId);
	}
}

/** Abort a pending proactive OAuth flow. */
export async function cancelRpcMCPReauth(session: AgentSession, flowId: string): Promise<void> {
	const flows = authorizationMap(session);
	const pending = flows.get(flowId);
	if (!pending) return;
	pending.abortController.abort("MCP OAuth flow cancelled by RPC client");
	pending.manualWaiter?.reject(new Error("MCP OAuth flow cancelled by RPC client"));
	try {
		await pending.operation;
	} catch {
		// Cancellation owns the expected rejection.
	} finally {
		flows.delete(flowId);
	}
}

/** Start Smithery CLI authorization without opening its URL. */
export async function beginRpcMCPSmitheryLogin(): Promise<RpcMCPSmitheryLoginBegin> {
	return createSmitheryCliAuthSession();
}

/** Poll one Smithery login session, or complete directly with a supplied API key. */
export async function completeRpcMCPSmitheryLogin(
	sessionId: string,
	apiKey?: string,
): Promise<RpcMCPSmitheryLoginResult> {
	let resolvedApiKey = apiKey?.trim();
	if (!resolvedApiKey) {
		const response = await pollSmitheryCliAuthSession(sessionId);
		if (response.status === "pending") return { status: "pending", authenticated: false };
		if (response.status === "error") throw new Error(response.message ?? "Smithery authorization failed.");
		resolvedApiKey = response.apiKey?.trim();
	}
	if (!resolvedApiKey) throw new Error("Smithery authorization completed without an API key.");
	await searchSmitheryRegistry("mcp", { limit: 1, apiKey: resolvedApiKey });
	await saveSmitheryApiKey(resolvedApiKey);
	return { status: "authenticated", authenticated: true };
}

/** Remove the cached Smithery credential. */
export async function logoutRpcMCPSmithery(): Promise<{ removed: boolean }> {
	return { removed: await clearSmitheryApiKey() };
}

/** Return complete deployable Smithery results, including config and required inputs. */
export async function searchRpcMCPRegistry(
	query: string,
	limit?: number,
	semantic?: boolean,
): Promise<RpcMCPRegistrySearchResult> {
	const keyword = query.trim();
	if (!keyword) throw new Error("Smithery search query is required.");
	const apiKey = await getSmitheryApiKey();
	if (!apiKey) throw new Error("Smithery login required. Start a Smithery login first.");
	return {
		results: await searchSmitheryRegistry(keyword, {
			limit,
			apiKey,
			includeSemantic: semantic,
		}),
	};
}

/** Configure and deploy one Smithery result into persistence and the live manager. */
export async function deployRpcMCPRegistryResult(
	session: AgentSession,
	mcpManager: MCPManager,
	result: SmitherySearchResult,
	scope: MCPAddScope,
	name: string | undefined,
	values: Record<string, string>,
): Promise<RpcMCPServerResult> {
	const requestedName = name?.trim();
	const serverName = requestedName || (await nextAvailableMCPServerName(scope, toConfigName(result.name)));
	const config = buildSmitheryMCPConfig(result, values);
	return addRpcMCPServer(session, mcpManager, serverName, config, scope);
}
