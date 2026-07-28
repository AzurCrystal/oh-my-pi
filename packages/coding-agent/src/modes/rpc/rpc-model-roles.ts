import type { AgentSession } from "../../session/agent-session";

export type RpcModelRoleScope = "global" | "project";
export type RpcModelRoleProvenance = "runtime" | "overlay" | "project" | "global" | "default";

export interface RpcModelRole {
	model: string;
	provenance: RpcModelRoleProvenance;
}

export interface RpcModelRolesSnapshot {
	roles: Record<string, RpcModelRole>;
}

function readModelRoles(session: AgentSession): RpcModelRolesSnapshot {
	const roles: Record<string, RpcModelRole> = {};
	for (const [role, model] of Object.entries(session.settings.getModelRoles())) {
		if (model === undefined) continue;
		roles[role] = {
			model,
			provenance: session.settings.getModelRoleProvenance(role),
		};
	}
	return { roles };
}

/** Reads effective model roles with the settings layer that supplies each role. */
export async function readRpcModelRoles(session: AgentSession): Promise<RpcModelRolesSnapshot> {
	return readModelRoles(session);
}

/** Persists one model role in the requested global or project settings layer. */
export async function setRpcModelRole(
	session: AgentSession,
	role: string,
	model: string,
	scope: RpcModelRoleScope,
): Promise<RpcModelRolesSnapshot> {
	if (scope === "project") {
		session.settings.setProjectModelRole(role, model);
	} else {
		session.settings.setModelRole(role, model);
	}
	return readModelRoles(session);
}

/** Clears one model role from the requested global or project settings layer. */
export async function clearRpcModelRole(
	session: AgentSession,
	role: string,
	scope: RpcModelRoleScope,
): Promise<RpcModelRolesSnapshot> {
	if (scope === "project") {
		session.settings.clearProjectModelRole(role);
	} else {
		session.settings.setModelRole(role, undefined);
	}
	return readModelRoles(session);
}
