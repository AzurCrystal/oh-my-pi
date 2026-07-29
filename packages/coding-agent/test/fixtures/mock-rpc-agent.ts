#!/usr/bin/env bun
/**
 * Test fixture: a stand-in for the coding-agent RPC mode.
 *
 * Emits the `ready` frame immediately, echoes each inbound command with a
 * success response, and stays alive until stdin closes or SIGTERM arrives.
 * Used by rpc-client lifecycle tests that need to exercise start/stop/start
 * without booting the full agent runtime (which requires provider credentials).
 */
import { readLines } from "@oh-my-pi/pi-utils";

if (Bun.env.MOCK_RPC_PID_FILE) {
	await Bun.write(Bun.env.MOCK_RPC_PID_FILE, String(process.pid));
}
if (Bun.env.MOCK_RPC_IGNORE_SIGTERM === "1") {
	process.on("SIGTERM", () => {});
}

const supportsProtocolV2 = Bun.env.MOCK_RPC_V2 === "1";
const supportsPromptResult = Bun.env.MOCK_RPC_OLD_RUNTIME !== "1";
let protocolV2Enabled = false;
let lifecycleScenario:
	| "queued"
	| "continuing"
	| "extension-delayed"
	| "extension-error"
	| "duplicate-current"
	| undefined;
let lifecyclePromptId: string | undefined;
const tombstonePromptIds: string[] = [];
process.stdout.write(
	`${JSON.stringify(
		supportsProtocolV2
			? {
					type: "ready",
					protocolVersion: 1,
					supportedProtocolVersions: [1, 2],
					...(supportsPromptResult ? { capabilities: ["prompt_result", "prompt_lifecycle_disposition"] } : {}),
					maxFrameBytes: 1024 * 1024,
					maxReassembledFrameBytes: 64 * 1024 * 1024,
				}
			: {
					type: "ready",
					...(supportsPromptResult ? { capabilities: ["prompt_result", "prompt_lifecycle_disposition"] } : {}),
				},
	)}\n`,
);

function writeFrame(frame: Record<string, unknown>): void {
	const logical = Buffer.from(JSON.stringify(frame), "utf8");
	if (!protocolV2Enabled || logical.byteLength <= 1024 * 1024) {
		process.stdout.write(`${logical.toString("utf8")}\n`);
		return;
	}
	const chunkBytes = 256 * 1024;
	const count = Math.ceil(logical.byteLength / chunkBytes);
	for (let index = 0; index < count; index++) {
		process.stdout.write(
			`${JSON.stringify({
				type: "rpc_chunk",
				chunkId: "mock-rpc-v2",
				index,
				count,
				byteLength: logical.byteLength,
				data: logical.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
			})}\n`,
		);
	}
}

const decoder = new TextDecoder();
for await (const line of readLines(Bun.stdin.stream())) {
	const raw = decoder.decode(line).trim();
	if (!raw) continue;
	try {
		const frame = JSON.parse(raw) as Record<string, unknown>;
		if (frame && typeof frame === "object" && typeof frame.type === "string") {
			if (Bun.env.MOCK_RPC_EXIT_ON_COMMAND) {
				process.stderr.write(Bun.env.MOCK_RPC_EXIT_STDERR ?? "");
				process.exit(Number(Bun.env.MOCK_RPC_EXIT_ON_COMMAND));
			}
			if (Bun.env.MOCK_RPC_INVALID_OUTPUT === "1") {
				process.stdout.write("{invalid-json\n");
				continue;
			}
			if (Bun.env.MOCK_RPC_IGNORE_COMMANDS === "1") continue;
			const id = typeof frame.id === "string" ? frame.id : undefined;
			if (frame.type === "negotiate_protocol" && frame.protocolVersion === 2) {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: { protocolVersion: 2 },
				});
				protocolV2Enabled = true;
				continue;
			}
			if (Bun.env.MOCK_RPC_TOMBSTONES === "1") {
				if (frame.type === "prompt" && id) {
					tombstonePromptIds.push(id);
					writeFrame({ id, type: "response", command: frame.type, success: true });
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "late prompt failure",
						code: "prompt_scheduling_failed",
					});
					continue;
				}
				if (frame.type === "get_state") {
					const newestId = tombstonePromptIds.at(-1);
					const oldestId = tombstonePromptIds[0];
					for (const promptId of [newestId, oldestId]) {
						if (!promptId) continue;
						writeFrame({
							id: promptId,
							type: "response",
							command: "prompt",
							success: false,
							error: "duplicate late prompt failure",
							code: "prompt_scheduling_failed",
						});
					}
					writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
					continue;
				}
			}
			if (Bun.env.MOCK_RPC_LIFECYCLE === "1") {
				if (frame.type === "prompt") {
					if (frame.message === "duplicate-current") {
						lifecycleScenario = "duplicate-current";
						writeFrame({
							type: "prompt_result",
							id,
							agentInvoked: true,
							lifecycleDisposition: "current",
						});
						writeFrame({
							id,
							type: "response",
							command: frame.type,
							success: true,
							data: { agentInvoked: true, lifecycleDisposition: "current" },
						});
						continue;
					}
					await writeFrame({ id, type: "response", command: frame.type, success: true });
					if (frame.message === "local-only") {
						writeFrame({
							type: "prompt_result",
							id,
							agentInvoked: false,
							lifecycleDisposition: "none",
						});
					} else if (frame.message === "queued-B") {
						lifecycleScenario = "queued";
						writeFrame({
							type: "prompt_result",
							id,
							agentInvoked: true,
							lifecycleDisposition: "future",
						});
					} else if (frame.message === "extension-delayed") {
						lifecycleScenario = "extension-delayed";
						lifecyclePromptId = id;
					} else if (frame.message === "extension-prestart-error") {
						lifecycleScenario = "extension-error";
						lifecyclePromptId = id;
					} else {
						if (frame.message === "continuing") lifecycleScenario = "continuing";
						writeFrame({ type: "agent_start" });
						writeFrame({
							type: "prompt_result",
							id,
							agentInvoked: true,
							lifecycleDisposition: "future",
						});
					}
					continue;
				}
				if (frame.type === "follow_up" && frame.message === "guest-current") {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: true,
						data: { agentInvoked: true, lifecycleDisposition: "current" },
					});
					continue;
				}
				if (frame.type === "abort_and_prompt") {
					if (frame.message === "immediate-reject") {
						writeFrame({
							id,
							type: "response",
							command: frame.type,
							success: false,
							error: "Replacement rejected immediately",
							code: "operation_failed",
						});
						continue;
					}
					if (frame.message === "local-only") {
						writeFrame({ id, type: "response", command: frame.type, success: true });
						writeFrame({
							type: "prompt_result",
							id,
							agentInvoked: false,
							lifecycleDisposition: "none",
						});
						continue;
					}
					writeFrame({ id, type: "response", command: frame.type, success: true });
					await Promise.resolve();
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "Replacement scheduling failed",
						code: "prompt_scheduling_failed",
					});
					continue;
				}
				if (frame.type === "get_state") {
					if (lifecycleScenario === "extension-delayed") {
						writeFrame({ type: "agent_start" });
						writeFrame({ type: "agent_end", messages: [] });
						if (lifecyclePromptId) {
							writeFrame({
								type: "prompt_result",
								id: lifecyclePromptId,
								agentInvoked: true,
								lifecycleDisposition: "future",
							});
						}
						lifecycleScenario = undefined;
						lifecyclePromptId = undefined;
					} else if (lifecycleScenario === "extension-error") {
						if (lifecyclePromptId) {
							writeFrame({
								id: lifecyclePromptId,
								type: "response",
								command: "prompt",
								success: false,
								error: "Extension task failed before agent start",
								code: "prompt_scheduling_failed",
							});
						}
						lifecycleScenario = undefined;
						lifecyclePromptId = undefined;
					} else {
						writeFrame({
							type: "agent_end",
							messages: [],
							...(lifecycleScenario === "continuing" ? { isTerminal: false } : {}),
						});
					}
					writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
					continue;
				}
				if (frame.type === "get_settings") {
					if (lifecycleScenario === "duplicate-current") {
						writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
						continue;
					}
					writeFrame({ type: "agent_start" });
					writeFrame({ type: "agent_end", messages: [] });
					writeFrame({ id, type: "response", command: frame.type, success: true, data: {} });
					continue;
				}
			}
			if (frame.type === "prompt" && Bun.env.MOCK_RPC_PROMPT_RESULTS === "1") {
				const agentInvoked = frame.message === "agent" ? true : frame.message === "no-agent" ? false : undefined;
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: agentInvoked === undefined ? undefined : { agentInvoked },
				});
				await Promise.resolve();
				if (frame.message === "late-error") {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "Prompt scheduling failed",
						code: "prompt_scheduling_failed",
					});
					continue;
				}
				writeFrame({
					type: "prompt_result",
					id,
					agentInvoked: agentInvoked ?? false,
					lifecycleDisposition: agentInvoked ? "future" : "none",
				});
				continue;
			}
			if (frame.type === "get_messages_page") {
				if (Bun.env.MOCK_RPC_PAGE_BUSY === "1") {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "Cannot page messages while the session is changing",
						code: "session_busy",
					});
					continue;
				}
				if (Bun.env.MOCK_RPC_PAGE_STALE === "1" && frame.cursor !== undefined) {
					writeFrame({
						id,
						type: "response",
						command: frame.type,
						success: false,
						error: "RPC message cursor is stale",
						code: "stale_cursor",
					});
					continue;
				}
				const first = frame.cursor === undefined;
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: first
						? {
								messages: [{ role: "user", content: "first", timestamp: 1 }],
								nextCursor: "second-page",
								totalMessages: 2,
							}
						: {
								messages: [{ role: "assistant", content: [{ type: "text", text: "second" }], timestamp: 2 }],
								totalMessages: 2,
							},
				});
				continue;
			}
			if (
				frame.type === "get_messages" &&
				(Bun.env.MOCK_RPC_PAGE_BUSY === "1" || Bun.env.MOCK_RPC_PAGE_STALE === "1")
			) {
				writeFrame({
					id,
					type: "response",
					command: frame.type,
					success: true,
					data: {
						messages: [
							{ role: "assistant", content: [{ type: "text", text: "streaming snapshot" }], timestamp: 3 },
						],
					},
				});
				continue;
			}
			writeFrame({
				id,
				type: "response",
				command: frame.type,
				success: true,
				data: supportsProtocolV2 ? { payload: "😀".repeat(400_000) } : {},
			});
		}
	} catch {
		// ignore parse errors — the test harness sends well-formed frames.
	}
}
process.exit(0);
