import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { CollabUiRequest, CollabUiResponseValue } from "@oh-my-pi/pi-wire";
import { resolveCollabUrls } from "../../collab/config";
import type { CollabGuestContext, CollabHostContext } from "../../collab/context";
import { CollabGuestLink } from "../../collab/guest";
import { CollabHost } from "../../collab/host";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import type { EventBus } from "../../utils/event-bus";

export interface RpcCollabLinks {
	link: string;
	viewLink: string;
	webLink: string;
	webViewLink: string;
}

export interface RpcCollabParticipant {
	name: string;
	role: "host" | "guest";
	readOnly: boolean;
}

export interface RpcCollabStatus {
	role: "host" | "guest" | "none";
	links: RpcCollabLinks | null;
	participants: RpcCollabParticipant[];
	readOnly: boolean;
}

/** Machine-readable reasons a guest action cannot be routed to the collab host. */
export type RpcCollabGuestRoutingErrorCode = "not_guest" | "read_only" | "link_unavailable";

/** Thrown when RPC attempts to route a guest action that cannot reach the host. */
export class RpcCollabGuestRoutingError extends Error {
	constructor(
		message: string,
		readonly code: RpcCollabGuestRoutingErrorCode,
	) {
		super(message);
		this.name = "RpcCollabGuestRoutingError";
	}
}

type RpcCollabContext = CollabHostContext &
	CollabGuestContext & {
		collabHostStart?: Promise<CollabHost>;
		collabGuestStart?: Promise<CollabGuestLink>;
		disposed?: boolean;
		collabGuestOwnership?: {
			guest: CollabGuestLink;
			startup: Promise<CollabGuestLink>;
			releaseTransition: () => void;
		};
	};

const contexts = new WeakMap<AgentSession, RpcCollabContext>();

function getContext(session: AgentSession, eventBus?: EventBus): RpcCollabContext {
	let context = contexts.get(session);
	if (!context) {
		context = {
			session,
			sessionManager: session.sessionManager,
			settings: session.settings,
			eventBus,
			showStatus: message => session.emitNotice("info", message, "collab"),
			showError: message => session.emitNotice("error", message, "collab"),
		};
		contexts.set(session, context);
	} else if (eventBus) {
		context.eventBus = eventBus;
	}
	return context;
}

function links(host: CollabHost): RpcCollabLinks {
	return {
		link: host.link,
		viewLink: host.viewLink,
		webLink: host.webLink,
		webViewLink: host.webViewLink,
	};
}

function participants(host: CollabHost): RpcCollabParticipant[] {
	return host.participants.map(participant => ({
		name: participant.name,
		role: participant.role,
		readOnly: participant.readOnly === true,
	}));
}

function writableGuest(session: AgentSession): CollabGuestLink {
	const guest = contexts.get(session)?.collabGuest;
	if (!guest) {
		throw new RpcCollabGuestRoutingError("This session is not a collaboration guest", "not_guest");
	}
	if (guest.readOnly) {
		throw new RpcCollabGuestRoutingError("This collaboration guest is read-only", "read_only");
	}
	if (!guest.isConnected) {
		throw new RpcCollabGuestRoutingError("The collaboration guest link is unavailable", "link_unavailable");
	}
	return guest;
}

async function ownedHost(context: RpcCollabContext | undefined): Promise<CollabHost | undefined> {
	if (!context) return undefined;
	if (context.collabHost) return context.collabHost;
	try {
		return await context.collabHostStart;
	} catch {
		return undefined;
	}
}

async function ownedGuest(context: RpcCollabContext | undefined): Promise<CollabGuestLink | undefined> {
	if (!context) return undefined;
	if (context.collabGuest) return context.collabGuest;
	try {
		return await context.collabGuestStart;
	} catch {
		return undefined;
	}
}

/** Release the transition lease only after a failed join no longer owns a committed replica. */
function releaseGuestOwnership(session: AgentSession, context: RpcCollabContext, guest: CollabGuestLink): void {
	const ownership = context.collabGuestOwnership;
	if (!ownership || ownership.guest !== guest) return;
	if (context.collabGuestStart === ownership.startup) context.collabGuestStart = undefined;
	context.runSessionTransition = (transition, options) => session.runSessionTransition(transition, options);
	context.collabGuestOwnership = undefined;
	ownership.releaseTransition();
}

/** Whether this session is currently a collaboration guest replica. */
export function isRpcCollabGuest(session: AgentSession): boolean {
	return contexts.get(session)?.collabGuest !== undefined;
}

/** How guest input relates to the authoritative host's logical agent lifecycle. */
export function getRpcCollabGuestLifecycleDisposition(session: AgentSession): "current" | "future" | undefined {
	const guest = contexts.get(session)?.collabGuest;
	if (!guest) return undefined;
	return guest.remoteAgentActive ? "current" : "future";
}

/**
 * Route a guest message to the authoritative host. The collab protocol has one
 * prompt frame, so normal prompts, steer, and follow-up share host-side steer semantics.
 */
export function sendRpcCollabGuestPrompt(session: AgentSession, text: string, images?: ImageContent[]): void {
	writableGuest(session).sendPrompt(text, images);
}

/** Route a guest abort to the authoritative host. */
export function sendRpcCollabGuestAbort(session: AgentSession): void {
	writableGuest(session).sendAbort();
}

/** Start sharing the current session through the configured collaboration relay. */
export async function startRpcCollabHosting(
	session: AgentSession,
	relayUrl?: string,
	eventBus?: EventBus,
): Promise<RpcCollabLinks> {
	const context = getContext(session, eventBus);
	if (context.disposed) throw new Error("Collaboration session is shutting down");
	if (context.collabGuest || context.collabGuestStart) {
		throw new Error("Already in a collab session as a guest; leave first");
	}
	if (context.collabHost) return links(context.collabHost);
	if (context.collabHostStart) return links(await context.collabHostStart);

	const urls = resolveCollabUrls(session.settings, relayUrl);
	if (!urls) throw new Error("No collaboration relay configured");

	const host = new CollabHost(context);
	const startup = (async () => {
		try {
			await host.start(urls.relayUrl, urls.webUrl);
			context.collabHost = host;
			return host;
		} catch (error) {
			await host.stop("host startup failed");
			throw error;
		}
	})();
	context.collabHostStart = startup;
	try {
		return links(await startup);
	} finally {
		if (context.collabHostStart === startup) context.collabHostStart = undefined;
	}
}

/** Stop sharing the current session. No-op when the session is not hosting. */
export async function stopRpcCollabHosting(session: AgentSession): Promise<void> {
	await (await ownedHost(contexts.get(session)))?.stop("host stopped");
}

/** Read the collaboration role, links, and participant display names. */
export async function getRpcCollabStatus(session: AgentSession): Promise<RpcCollabStatus> {
	const context = contexts.get(session);
	const host = context?.collabHost;
	if (host) {
		return {
			role: "host",
			links: links(host),
			participants: participants(host),
			readOnly: false,
		};
	}
	const guest = context?.collabGuest;
	if (guest) {
		return {
			role: "guest",
			links: null,
			participants:
				guest.state?.participants.map(participant => ({
					name: participant.name,
					role: participant.role,
					readOnly: participant.readOnly === true,
				})) ?? [],
			readOnly: guest.readOnly,
		};
	}
	return { role: "none", links: null, participants: [], readOnly: false };
}

/** Join a shared session and replicate it into the supplied AgentSession. */
export async function joinRpcCollabSession(
	session: AgentSession,
	link: string,
	eventBus?: EventBus,
	onEvent?: (event: AgentSessionEvent) => void,
	onUiRequest?: (request: CollabUiRequest, signal: AbortSignal) => Promise<CollabUiResponseValue>,
): Promise<RpcCollabStatus> {
	if (session.getVibeModeState()?.enabled) {
		throw new Error("Exit vibe mode before joining a collab session.");
	}
	const transitionLease = session.acquireSessionTransition();
	const context = getContext(session, eventBus);
	if (context.disposed) {
		transitionLease.release();
		throw new Error("Collaboration session is shutting down");
	}
	if (context.collabHost || context.collabHostStart) {
		transitionLease.release();
		throw new Error("Stop hosting before joining a collab session");
	}
	if (context.collabGuest || context.collabGuestStart) {
		transitionLease.release();
		throw new Error("Already in a collab session; leave first");
	}
	context.handleEvent = onEvent;
	context.handleUiRequest = onUiRequest;
	context.runSessionTransition = transitionLease.run;
	const guest = new CollabGuestLink(context);
	const startup = (async () => {
		try {
			await guest.join(link);
			return guest;
		} catch (error) {
			if (!guest.hasCommittedReplica) await guest.leave("join failed").catch(() => {});
			if (guest.hasCommittedReplica) context.collabGuest = guest;
			throw error;
		}
	})();
	context.collabGuestStart = startup;
	context.collabGuestOwnership = {
		guest,
		startup,
		releaseTransition: transitionLease.release,
	};
	let joined = false;
	try {
		await startup;
		joined = true;
		return getRpcCollabStatus(session);
	} finally {
		if (joined || !guest.hasCommittedReplica) releaseGuestOwnership(session, context, guest);
	}
}

/** Leave a guest session, or stop hosting when called by the current host. */
export async function leaveRpcCollabSession(session: AgentSession): Promise<void> {
	const context = contexts.get(session);
	const guest = await ownedGuest(context);
	if (guest) {
		try {
			await guest.leave("left");
		} finally {
			if (context && !guest.hasCommittedReplica) {
				releaseGuestOwnership(session, context, guest);
				if (context.disposed) contexts.delete(session);
			}
		}
		return;
	}
	await (await ownedHost(context))?.stop("host stopped");
}

/** Dispose every collaboration relay owned by this session. No-op when inactive. */
export async function disposeRpcCollab(session: AgentSession): Promise<void> {
	const context = contexts.get(session);
	if (!context) return;
	context.disposed = true;
	const guest = await ownedGuest(context);
	try {
		await guest?.leave("session ended");
	} finally {
		if (!guest?.hasCommittedReplica) {
			if (guest) releaseGuestOwnership(session, context, guest);
			try {
				await (await ownedHost(context))?.stop("session ended");
			} finally {
				contexts.delete(session);
			}
		}
	}
}
