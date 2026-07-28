import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import {
	array,
	type Frame,
	type RpcHarness,
	record,
	removeTempDir,
	response,
	spawnRpcHarness,
} from "./rpc-test-harness";

async function spawnRpc(root: TempDir): Promise<RpcHarness> {
	const projectDir = root.join("project");
	const homeDir = root.join("home");
	const xdgDir = root.join("xdg");
	const agentDir = root.join("agent");
	const extensionDir = path.join(projectDir, ".omp", "extensions");
	const invalidSkillDirectory = path.join(projectDir, "not-a-directory.txt");
	await Promise.all([
		fs.mkdir(extensionDir, { recursive: true }),
		fs.mkdir(homeDir, { recursive: true }),
		fs.mkdir(xdgDir, { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
	]);
	await Promise.all([
		Bun.write(
			path.join(extensionDir, "editor-contract.ts"),
			`export default function (pi) {
	pi.registerCommand("read-editor-contract", {
		description: "Return the RPC editor draft",
		handler: async (_args, ctx) => {
			ctx.ui.notify("editor-contract:" + ctx.ui.getEditorText(), "info");
		},
	});
}
`,
		),
		Bun.write(invalidSkillDirectory, "This file deliberately occupies a configured skill-directory path.\n"),
		Bun.write(
			path.join(agentDir, "config.yml"),
			`skills:\n  customDirectories:\n    - '${invalidSkillDirectory.replaceAll("\\", "/")}'\nretry:\n  fallbackChains:\n    default:\n      - missing-contract-provider/missing-contract-model\n`,
		),
	]);

	return spawnRpcHarness({ projectDir, homeDir, xdgDir, agentDir });
}

function collectTreeIds(nodes: unknown[]): string[] {
	const ids: string[] = [];
	for (let index = 0; index < nodes.length; index++) {
		const node = record(nodes[index], `tree node ${index}`);
		if (typeof node.id !== "string") throw new Error(`tree node ${index} has no string id`);
		ids.push(node.id);
		ids.push(...collectTreeIds(array(node.children, `tree node ${index} children`)));
	}
	return ids;
}

describe("RPC parity regression contracts", () => {
	let root: TempDir | undefined;
	let frames: Frame[] = [];
	let startupStderr = "";

	beforeAll(async () => {
		root = TempDir.createSync("@omp-rpc-contracts-");
		const rpc = await spawnRpc(root);
		try {
			await rpc.collectUntil([], current => current.some(frame => frame.type === "ready"));

			await rpc.collectUntil(
				[
					{ id: "unknown-contract", type: "command-that-must-never-exist" },
					{ id: "tree-contract", type: "get_session_tree" },
					{ id: "state-contract", type: "get_state" },
					{ id: "warnings-contract", type: "get_startup_warnings" },
				],
				current =>
					["unknown-contract", "tree-contract", "state-contract", "warnings-contract"].every(id =>
						current.some(frame => frame.type === "response" && frame.id === id),
					),
			);

			const treeData = record(response(rpc.frames, "tree-contract").data, "get_session_tree data");
			if (typeof treeData.leafId !== "string") throw new Error("get_session_tree returned no active leaf id");
			await rpc.collectUntil(
				[{ id: "navigate-contract", type: "navigate_tree", targetId: treeData.leafId }],
				current => current.some(frame => frame.type === "response" && frame.id === "navigate-contract"),
			);

			const draft = `draft-${crypto.randomUUID()}`;
			await rpc.collectUntil(
				[
					{ id: "publish-contract", type: "publish_editor_text", text: draft },
					{ id: "read-editor-contract", type: "prompt", message: "/read-editor-contract" },
				],
				current =>
					current.some(frame => frame.type === "response" && frame.id === "publish-contract") &&
					current.some(frame => frame.type === "response" && frame.id === "read-editor-contract") &&
					current.some(
						frame =>
							frame.type === "extension_ui_request" &&
							frame.method === "notify" &&
							frame.message === `editor-contract:${draft}`,
					),
			);

			// This delay is the cancellable work under test, not synchronization:
			// the test waits for its output marker, then must observe abort_bash end it early.
			await rpc.collectUntil(
				[
					{
						id: "long-bash-contract",
						type: "bash",
						command: `bun -e "console.log('rpc-cancel-ready'); await Bun.sleep(30000)"`,
					},
				],
				current =>
					current.some(
						frame =>
							frame.type === "exec_output" &&
							frame.id === "long-bash-contract" &&
							typeof frame.chunk === "string" &&
							frame.chunk.includes("rpc-cancel-ready"),
					),
				60_000,
			);
			await rpc.collectUntil(
				[{ id: "abort-bash-contract", type: "abort_bash" }],
				current =>
					current.some(frame => frame.type === "response" && frame.id === "abort-bash-contract") &&
					current.some(frame => frame.type === "response" && frame.id === "long-bash-contract"),
				60_000,
			);
		} finally {
			startupStderr = await rpc.stop();
			frames = [...rpc.frames];
		}
	}, 150_000);

	afterAll(async () => {
		await removeTempDir(root);
	});

	it("lets abort_bash overtake the long-running bash command it cancels", () => {
		const abortIndex = frames.findIndex(frame => frame.type === "response" && frame.id === "abort-bash-contract");
		const bashIndex = frames.findIndex(frame => frame.type === "response" && frame.id === "long-bash-contract");
		expect(abortIndex).toBeGreaterThan(-1);
		expect(bashIndex).toBeGreaterThan(abortIndex);
		expect(response(frames, "abort-bash-contract")).toMatchObject({ success: true, command: "abort_bash" });
		const bashData = record(response(frames, "long-bash-contract").data, "cancelled bash data");
		expect(bashData.cancelled).toBe(true);
	});

	it("rejects an unknown command without losing its request id", () => {
		expect(response(frames, "unknown-contract")).toMatchObject({
			id: "unknown-contract",
			command: "command-that-must-never-exist",
			success: false,
		});
		expect(response(frames, "unknown-contract").error).toContain("Unknown command");
	});

	it("returns session-tree node ids that navigate_tree accepts", () => {
		const treeResponse = response(frames, "tree-contract");
		expect(treeResponse.success).toBe(true);
		const treeData = record(treeResponse.data, "get_session_tree data");
		const ids = collectTreeIds(array(treeData.tree, "session tree"));
		if (typeof treeData.leafId !== "string") throw new Error("get_session_tree must report a string leafId");
		expect(ids).toContain(treeData.leafId);
		expect(response(frames, "navigate-contract")).toMatchObject({
			id: "navigate-contract",
			command: "navigate_tree",
			success: true,
		});
	});

	it("publishes editor text into the synchronous extension getEditorText snapshot", () => {
		expect(response(frames, "publish-contract")).toMatchObject({ success: true, command: "publish_editor_text" });
		expect(response(frames, "read-editor-contract")).toMatchObject({ success: true, command: "prompt" });
		const notify = frames.find(
			frame =>
				frame.type === "extension_ui_request" &&
				frame.method === "notify" &&
				typeof frame.message === "string" &&
				frame.message.startsWith("editor-contract:draft-"),
		);
		expect(notify).toBeDefined();
		expect(notify?.message).not.toBe("editor-contract:");
	});

	it("exposes typed startup warnings and get_state activity flags", () => {
		const state = record(response(frames, "state-contract").data, "get_state data");
		for (const flag of ["isRetrying", "isBashRunning", "isAborting", "isGeneratingHandoff"]) {
			expect(typeof state[flag]).toBe("boolean");
		}
		const configWarnings = array(state.configWarnings, "get_state configWarnings");
		const skillWarnings = array(state.skillWarnings, "get_state skillWarnings");
		expect(configWarnings.some(warning => typeof warning === "string" && warning.includes("missing-contract"))).toBe(
			true,
		);
		expect(
			skillWarnings.some(warning => {
				if (!isRecord(warning)) return false;
				return (
					typeof warning.skillPath === "string" &&
					warning.skillPath.includes("not-a-directory.txt") &&
					typeof warning.message === "string" &&
					warning.message.includes("Failed to read skills directory")
				);
			}),
		).toBe(true);

		const startup = record(response(frames, "warnings-contract").data, "get_startup_warnings data");
		expect(startup.configWarnings).toEqual(state.configWarnings);
		expect(startup.skillWarnings).toEqual(state.skillWarnings);
		expect(startupStderr).not.toContain("RPC process did not exit");
	});
});
