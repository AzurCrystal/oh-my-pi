import { describe, expect, it, vi } from "bun:test";
import { CollabHost } from "../src/collab/host";
import {
	disposeRpcCollab,
	getRpcCollabStatus,
	startRpcCollabHosting,
	stopRpcCollabHosting,
} from "../src/modes/rpc/rpc-collab";
import type { AgentSession } from "../src/session/agent-session";

function fakeSession(): AgentSession {
	return {
		sessionManager: { onEntryAppended: undefined },
		settings: {
			get: (path: string) => (path === "collab.webUrl" ? "" : undefined),
		},
		emitNotice: () => {},
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

describe("RPC collaboration hosting lifecycle", () => {
	it("shares one in-flight startup and keeps it reachable to disposal", async () => {
		const startupGate = Promise.withResolvers<void>();
		const start = vi.spyOn(CollabHost.prototype, "start").mockImplementation(async () => {
			await startupGate.promise;
		});
		const stop = vi.spyOn(CollabHost.prototype, "stop");
		const session = fakeSession();

		try {
			const first = startRpcCollabHosting(session, "wss://relay.example.com");
			expect(start).toHaveBeenCalledTimes(1);

			const second = startRpcCollabHosting(session, "wss://relay.example.com");
			const disposal = disposeRpcCollab(session);
			expect(start).toHaveBeenCalledTimes(1);
			expect(stop).not.toHaveBeenCalled();

			startupGate.resolve();
			const [firstLinks, secondLinks] = await Promise.all([first, second, disposal]);

			expect(firstLinks).toEqual(secondLinks);
			expect(start).toHaveBeenCalledTimes(1);
			expect(stop).toHaveBeenCalledTimes(1);
			expect(await getRpcCollabStatus(session)).toEqual({
				role: "none",
				links: null,
				participants: [],
				readOnly: false,
			});
		} finally {
			startupGate.resolve();
			vi.restoreAllMocks();
		}
	});

	it("cleans up a failed startup and permits a retry", async () => {
		const startupError = new Error("relay unavailable");
		const start = vi.spyOn(CollabHost.prototype, "start").mockRejectedValueOnce(startupError).mockResolvedValueOnce();
		const stop = vi.spyOn(CollabHost.prototype, "stop");
		const session = fakeSession();

		try {
			await expect(startRpcCollabHosting(session, "wss://relay.example.com")).rejects.toBe(startupError);
			expect(start).toHaveBeenCalledTimes(1);
			expect(stop).toHaveBeenCalledTimes(1);

			await startRpcCollabHosting(session, "wss://relay.example.com");
			expect(start).toHaveBeenCalledTimes(2);

			await stopRpcCollabHosting(session);
			expect(stop).toHaveBeenCalledTimes(2);
			expect((await getRpcCollabStatus(session)).role).toBe("none");
		} finally {
			vi.restoreAllMocks();
		}
	});
});
