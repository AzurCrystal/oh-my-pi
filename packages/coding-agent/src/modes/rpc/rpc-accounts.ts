import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { AgentSession } from "../../session/agent-session";
import { toLogoutAccounts } from "../../slash-commands/helpers/logout";

/** A stored credential identity safe to expose to an RPC client. */
export interface RpcLoginAccount {
	credentialId: number;
	provider: string;
	label: string;
	detail: string;
	type: "api_key" | "oauth";
	active: boolean;
}

export interface RpcLoginProvider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
	accounts: RpcLoginAccount[];
}

export interface RpcLoginProvidersSnapshot {
	providers: RpcLoginProvider[];
}

function assertOAuthProvider(providerId: string): void {
	if (!getOAuthProviders().some(provider => provider.id === providerId)) {
		throw new Error(`Unknown OAuth provider: ${providerId}`);
	}
}

/** Lists every stored account for each OAuth provider without exposing credential material. */
export async function readRpcLoginProviders(session: AgentSession): Promise<RpcLoginProvidersSnapshot> {
	const authStorage = session.modelRegistry.authStorage;
	await authStorage.reload();

	return {
		providers: getOAuthProviders().map(provider => ({
			id: provider.id,
			name: provider.name,
			available: provider.available,
			authenticated: authStorage.hasAuth(provider.id),
			accounts: toLogoutAccounts(provider.id, authStorage.listStoredCredentials(provider.id), {
				activeIdentity: authStorage.getOAuthAccountIdentity(provider.id, session.sessionId),
				activeApiKey: authStorage.getCredentialOrigin(provider.id)?.kind === "api_key",
			}),
		})),
	};
}

/** Removes exactly one stored credential, preserving sibling accounts for the provider. */
export async function removeRpcLoginAccount(
	session: AgentSession,
	providerId: string,
	credentialId: number,
): Promise<{ providerId: string; credentialId: number; removed: boolean }> {
	assertOAuthProvider(providerId);
	const removed = await session.modelRegistry.authStorage.removeCredential(providerId, credentialId);
	if (removed) await session.modelRegistry.refreshProvider(providerId, "online");
	return { providerId, credentialId, removed };
}

/** Destructive: removes every stored credential for one OAuth provider. */
export async function removeRpcProviderCredentials(
	session: AgentSession,
	providerId: string,
): Promise<{ providerId: string }> {
	assertOAuthProvider(providerId);
	await session.modelRegistry.authStorage.remove(providerId);
	await session.modelRegistry.refreshProvider(providerId, "online");
	return { providerId };
}
