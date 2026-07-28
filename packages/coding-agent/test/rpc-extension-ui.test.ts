import { describe, expect, it, vi } from "bun:test";
import { type PendingExtensionRequest, requestRpcDialog } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";

describe("RPC extension UI", () => {
	it("cancels the remote dialog when its signal aborts", async () => {
		const pendingRequests = new Map<string, PendingExtensionRequest>();
		const output = vi.fn<(frame: object) => void>();
		const controller = new AbortController();
		const result = requestRpcDialog(
			pendingRequests,
			output,
			{ signal: controller.signal },
			false,
			{ method: "confirm", title: "High-risk command", message: "Allow this command?" },
			response => ("confirmed" in response ? response.confirmed : false),
		);
		const request = output.mock.calls[0]?.[0];
		if (!request || !("id" in request) || typeof request.id !== "string") {
			throw new Error("Expected the RPC dialog request to carry an id");
		}

		controller.abort();

		expect(await result).toBe(false);
		expect(output).toHaveBeenNthCalledWith(1, {
			type: "extension_ui_request",
			id: request.id,
			method: "confirm",
			title: "High-risk command",
			message: "Allow this command?",
		});
		expect(output).toHaveBeenNthCalledWith(2, {
			type: "extension_ui_cancel",
			targetId: request.id,
		});
		expect(pendingRequests.size).toBe(0);
	});

	it("cancels the remote dialog on timeout and notifies exactly once", async () => {
		vi.useFakeTimers();
		try {
			const pendingRequests = new Map<string, PendingExtensionRequest>();
			const output = vi.fn<(frame: object) => void>();
			const onTimeout = vi.fn();
			const result = requestRpcDialog(
				pendingRequests,
				output,
				{ timeout: 25, onTimeout },
				undefined,
				{ method: "input", title: "Name" },
				response => ("value" in response ? response.value : undefined),
			);
			const request = output.mock.calls[0]?.[0];
			if (!request || !("id" in request) || typeof request.id !== "string") {
				throw new Error("Expected the RPC dialog request to carry an id");
			}
			const pendingRequest = pendingRequests.get(request.id);

			vi.advanceTimersByTime(25);

			expect(await result).toBeUndefined();
			expect(output).toHaveBeenNthCalledWith(2, {
				type: "extension_ui_cancel",
				targetId: request.id,
				timedOut: true,
			});
			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(pendingRequests.size).toBe(0);

			pendingRequest?.resolve({
				type: "extension_ui_response",
				id: request.id,
				cancelled: true,
				timedOut: true,
			});
			expect(onTimeout).toHaveBeenCalledTimes(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
