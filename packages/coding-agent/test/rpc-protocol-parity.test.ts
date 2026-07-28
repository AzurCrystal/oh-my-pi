import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import {
	array,
	type Command,
	type Frame,
	type RpcHarness,
	record,
	removeTempDir,
	response,
	spawnRpcHarness,
} from "./rpc-test-harness";

async function spawnRpc(root: TempDir, agentDir: string): Promise<RpcHarness> {
	const projectDir = root.join("project");
	const homeDir = root.join("home");
	const xdgDir = root.join("xdg");
	await Promise.all([
		fs.mkdir(projectDir, { recursive: true }),
		fs.mkdir(homeDir, { recursive: true }),
		fs.mkdir(xdgDir, { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
	]);

	return spawnRpcHarness({ projectDir, homeDir, xdgDir, agentDir });
}

describe("RPC protocol TUI parity", () => {
	const secretMarker = `rpc-secret-${crypto.randomUUID()}`;
	let firstRoot: TempDir | undefined;
	let secondRoot: TempDir | undefined;
	let frames: Frame[] = [];
	let persistenceFrames: Frame[] = [];

	beforeAll(async () => {
		firstRoot = TempDir.createSync("@omp-rpc-parity-primary-");
		secondRoot = TempDir.createSync("@omp-rpc-parity-persistence-");
		const agentDir = firstRoot.join("agent");
		await fs.mkdir(agentDir, { recursive: true });
		await Bun.write(path.join(agentDir, "config.yml"), `auth:\n  broker:\n    token: ${secretMarker}\n`);

		const primary = await spawnRpc(firstRoot, agentDir);
		let primaryStderr: string;
		try {
			await primary.collectUntil([], current => current.some(frame => frame.type === "ready"));

			await primary.collectUntil([{ id: "negotiate", type: "negotiate_protocol", protocolVersion: 2 }], current =>
				current.some(frame => frame.type === "response" && frame.id === "negotiate"),
			);

			const initialCommands: Command[] = [
				{ id: "settings", type: "get_settings" },
				{ id: "invalid-setting", type: "set_setting", path: "compaction.enabled", value: "yes" },
				{ id: "unknown-setting", type: "set_setting", path: "nope.nope", value: 1 },
				{ id: "unknown-1", type: "definitely_not_a_command" },
				{ id: "set-steering", type: "set_setting", path: "steeringMode", value: "all" },
				{ id: "state", type: "get_state" },
				{ id: "sessions", type: "get_sessions" },
				{ id: "sessions-empty", type: "get_sessions", query: "zzz-no-such-session-zzz" },
				{ id: "extensions", type: "get_extensions" },
				{ id: "delete-bogus", type: "delete_session", sessionPath: firstRoot.join("not-a-session.jsonl") },
			];
			const initialIds = new Set(initialCommands.map(command => command.id));
			await primary.collectUntil(
				initialCommands,
				current =>
					current.filter(
						frame => frame.type === "response" && typeof frame.id === "string" && initialIds.has(frame.id),
					).length === initialIds.size,
				60_000,
			);

			const stateData = record(response(primary.frames, "state").data, "get_state data");
			if (typeof stateData.sessionFile !== "string")
				throw new Error("get_state did not return an active sessionFile");
			await primary.collectUntil(
				[{ id: "delete-active", type: "delete_session", sessionPath: stateData.sessionFile }],
				current => current.some(frame => frame.type === "response" && frame.id === "delete-active"),
			);
			await primary.collectUntil([{ id: "state-after-delete", type: "get_state" }], current =>
				current.some(frame => frame.type === "response" && frame.id === "state-after-delete"),
			);

			await primary.collectUntil([{ id: "bash", type: "bash", command: "echo hello-rpc" }], current =>
				current.some(frame => frame.type === "response" && frame.id === "bash"),
			);
			await primary.collectUntil(
				[{ id: "python", type: "python", code: "print('hello-py')" }],
				current => current.some(frame => frame.type === "response" && frame.id === "python"),
				60_000,
			);
			await primary.collectUntil(
				[
					{
						id: "loop",
						type: "bash",
						command: `bun -e "for(let i=0;i<20000;i++) console.log('x'.repeat(100))"`,
					},
				],
				current =>
					current.filter(frame => frame.type === "exec_output" && frame.id === "loop").length > 1 ||
					current.some(frame => frame.type === "response" && frame.id === "loop"),
				60_000,
			);
			await primary.collectUntil(
				[{ id: "abort-loop", type: "abort_bash" }],
				current =>
					current.some(frame => frame.type === "response" && frame.id === "loop") &&
					current.some(frame => frame.type === "response" && frame.id === "abort-loop"),
				60_000,
			);
		} finally {
			primaryStderr = await primary.stop();
			frames = [...primary.frames];
		}
		if (!response(frames, "negotiate").success) throw new Error(`Protocol setup failed: ${primaryStderr}`);

		const persistence = await spawnRpc(secondRoot, agentDir);
		let persistenceStderr: string;
		try {
			await persistence.collectUntil([], current => current.some(frame => frame.type === "ready"));
			await persistence.collectUntil([{ id: "persisted-settings", type: "get_settings" }], current =>
				current.some(frame => frame.type === "response" && frame.id === "persisted-settings"),
			);
		} finally {
			persistenceStderr = await persistence.stop();
			persistenceFrames = [...persistence.frames];
		}
		if (!response(persistenceFrames, "persisted-settings").success)
			throw new Error(`Persistence setup failed: ${persistenceStderr}`);
	}, 180_000);

	afterAll(async () => {
		await Promise.all([removeTempDir(secondRoot), removeTempDir(firstRoot)]);
	});

	it("exposes the complete settings schema with resolved runtime options", () => {
		const settingsResponse = response(frames, "settings");
		expect(settingsResponse.success).toBe(true);
		const data = record(settingsResponse.data, "get_settings data");
		const tabs = array(data.tabs, "settings tabs").map((tab, index) => record(tab, `tab ${index}`));
		expect(tabs.some(tab => tab.id === "appearance")).toBe(true);

		const settings = array(data.settings, "settings descriptors").map((setting, index) =>
			record(setting, `setting ${index}`),
		);
		const darkTheme = settings.find(setting => setting.path === "theme.dark");
		expect(darkTheme).toBeDefined();
		const themeUi = record(darkTheme?.ui, "theme.dark ui");
		const themeOptions = array(themeUi.options, "theme.dark options").map((option, index) =>
			record(option, `theme option ${index}`),
		);
		expect(themeOptions.some(option => option.value === "titanium")).toBe(true);
		expect(settings.every(setting => Object.hasOwn(setting, "value") && setting.value !== undefined)).toBe(true);
		expect(settings.every(setting => Object.hasOwn(setting, "default") && setting.default !== undefined)).toBe(true);
	});

	it("redacts credential settings from every emitted frame", () => {
		expect(JSON.stringify(frames)).not.toContain(secretMarker);
		const data = record(response(frames, "settings").data, "get_settings data");
		const brokerToken = array(data.settings, "settings descriptors")
			.map((setting, index) => record(setting, `setting ${index}`))
			.find(setting => setting.path === "auth.broker.token");
		expect(brokerToken).toMatchObject({ secret: true, value: null, configured: true });
	});

	it("rejects invalid and unknown settings with stable error codes", () => {
		expect(response(frames, "invalid-setting")).toMatchObject({
			success: false,
			code: "invalid_value",
		});
		expect(response(frames, "unknown-setting")).toMatchObject({
			success: false,
			code: "unknown_setting",
		});
	});

	it("correlates unknown command failures with the request id", () => {
		expect(response(frames, "unknown-1")).toMatchObject({
			type: "response",
			id: "unknown-1",
			command: "definitely_not_a_command",
			success: false,
		});
	});

	it("applies a setting to the live session and emits its push update", () => {
		expect(response(frames, "set-steering").success).toBe(true);
		expect(frames).toContainEqual(
			expect.objectContaining({ type: "settings_update", path: "steeringMode", value: "all" }),
		);
		expect(record(response(frames, "state").data, "get_state data").steeringMode).toBe("all");
	});

	it("persists an acknowledged setting across RPC processes", () => {
		const data = record(response(persistenceFrames, "persisted-settings").data, "persisted get_settings data");
		const steeringMode = array(data.settings, "persisted settings descriptors")
			.map((setting, index) => record(setting, `persisted setting ${index}`))
			.find(setting => setting.path === "steeringMode");
		expect(steeringMode).toMatchObject({ value: "all", configured: true });
	});

	it("lists and searches sessions without returning their full message text", () => {
		const sessionsData = record(response(frames, "sessions").data, "get_sessions data");
		const sessions = array(sessionsData.sessions, "sessions");
		expect(sessions.every(session => isRecord(session) && !Object.hasOwn(session, "allMessagesText"))).toBe(true);
		expect(record(response(frames, "sessions-empty").data, "queried get_sessions data").total).toBe(0);
	});

	it("deletes the active session, replaces it, and keeps RPC execution usable", async () => {
		const deletedSessionFile = record(response(frames, "state").data, "initial get_state data").sessionFile;
		if (typeof deletedSessionFile !== "string")
			throw new Error("initial get_state did not return an active sessionFile");

		expect(response(frames, "delete-active")).toMatchObject({ success: true });
		const replacementSessionFile = record(
			response(frames, "state-after-delete").data,
			"get_state after deletion data",
		).sessionFile;
		expect(replacementSessionFile).toEqual(expect.any(String));
		expect(replacementSessionFile).not.toBe(deletedSessionFile);
		await expect(fs.access(deletedSessionFile)).rejects.toThrow();
		expect(response(frames, "bash").success).toBe(true);
		expect(response(frames, "delete-bogus")).toMatchObject({ success: false, code: "unknown_session" });
	});

	it("lists extensions without exposing their raw capability payloads", () => {
		const data = record(response(frames, "extensions").data, "get_extensions data");
		const extensions = array(data.extensions, "extensions");
		expect(extensions.every(extension => isRecord(extension) && !Object.hasOwn(extension, "raw"))).toBe(true);
	});

	it("streams bash output before returning the final result", () => {
		const responseIndex = frames.findIndex(frame => frame.type === "response" && frame.id === "bash");
		const outputIndices = frames
			.map((frame, index) => ({ frame, index }))
			.filter(({ frame }) => frame.type === "exec_output" && frame.source === "bash" && frame.id === "bash")
			.map(({ index }) => index);
		expect(outputIndices.length).toBeGreaterThan(0);
		expect(outputIndices.some(index => String(frames[index]?.chunk).includes("hello-rpc"))).toBe(true);
		expect(outputIndices.every(index => index < responseIndex)).toBe(true);
		const data = record(response(frames, "bash").data, "bash response data");
		expect(data.exitCode).toBe(0);
		expect(String(data.output)).toContain("hello-rpc");
	});

	it("streams Python output before returning a successful result", () => {
		const pythonResponse = response(frames, "python");
		expect(pythonResponse.success).toBe(true);

		const responseIndex = frames.findIndex(frame => frame.type === "response" && frame.id === "python");
		const outputIndices = frames
			.map((frame, index) => ({ frame, index }))
			.filter(({ frame }) => frame.type === "exec_output" && frame.source === "python" && frame.id === "python")
			.map(({ index }) => index);
		expect(outputIndices.length).toBeGreaterThan(0);
		expect(outputIndices.some(index => String(frames[index]?.chunk).includes("hello-py"))).toBe(true);
		expect(outputIndices.every(index => index < responseIndex)).toBe(true);
		const data = record(pythonResponse.data, "python response data");
		expect(data.exitCode).toBe(0);
		expect(String(data.output)).toContain("hello-py");
	});

	it("negotiates v2, preserves voluminous output frames, and permits preemption", () => {
		expect(response(frames, "negotiate").success).toBe(true);
		const responseIndex = frames.findIndex(frame => frame.type === "response" && frame.id === "loop");
		expect(responseIndex).toBeGreaterThan(-1);
		const outputIndices = frames
			.map((frame, index) => ({ frame, index }))
			.filter(({ frame }) => frame.type === "exec_output" && frame.source === "bash" && frame.id === "loop")
			.map(({ index }) => index);
		expect(outputIndices.length).toBeGreaterThan(1);
		expect(outputIndices.every(index => index < responseIndex)).toBe(true);

		const loopResponse = response(frames, "loop");
		if (loopResponse.success === true) {
			const data = record(loopResponse.data, "loop response data");
			if (data.cancelled === false) expect(data.exitCode).toBeDefined();
		}
	});

	// Note: this does NOT pin the `await stdoutQueue` guard on the EOF path — verified by
	// mutation, the assertions still pass without it because `inputDispatcher.drain()` and
	// `session.dispose()` already give the queue time to flush. What it does defend is
	// large-output streaming: many ordered `exec_output` frames, the tail chunk intact,
	// and the final response, when stdin closes right after the command is sent.
	it("streams a large bash output in order and still answers when stdin closes immediately", async () => {
		const root = TempDir.createSync("@omp-rpc-parity-drain-");
		const rpc = await spawnRpc(root, root.join("agent"));
		let stopped = false;
		try {
			await rpc.collectUntil([], current => current.some(frame => frame.type === "ready"));
			const marker = `drain-last-${crypto.randomUUID()}`;
			await rpc.collectUntil(
				[
					{
						id: "drain",
						type: "bash",
						command: `bun -e "for(let i=0;i<8500;i++) console.log('x'.repeat(100));console.log('${marker}')"`,
					},
				],
				current => current.some(frame => frame.type === "ready"),
			);

			await rpc.stop();
			stopped = true;

			const responseIndex = rpc.frames.findIndex(frame => frame.type === "response" && frame.id === "drain");
			const output = rpc.frames
				.map((frame, index) => ({ frame, index }))
				.filter(({ frame }) => frame.type === "exec_output" && frame.source === "bash" && frame.id === "drain");
			expect(responseIndex).toBeGreaterThan(-1);
			expect(output.length).toBeGreaterThan(1);
			expect(output.every(({ index }) => index < responseIndex)).toBe(true);
			expect(String(output.at(-1)?.frame.chunk)).toContain(marker);
			expect(response(rpc.frames, "drain").success).toBe(true);
		} finally {
			if (!stopped) await rpc.stop().catch(() => {});
			await removeTempDir(root);
		}
	}, 60_000);
});
