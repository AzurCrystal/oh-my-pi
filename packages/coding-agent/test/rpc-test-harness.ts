import * as path from "node:path";
import { isRecord, readJsonl, type TempDir } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder } from "../src/modes/rpc/rpc-frame";

export type Frame = Record<string, unknown>;
export type Command = Record<string, unknown> & { type: string };

const cliPath = path.join(import.meta.dir, "..", "src", "cli.ts");

function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
	// An external-process E2E watchdog must use wall-clock time: fake timers cannot
	// advance or terminate the child process and would leak it on a regression.
	const deferred = Promise.withResolvers<T>();
	const timer = setTimeout(() => deferred.reject(new Error(message)), timeout);
	promise.then(
		value => {
			clearTimeout(timer);
			deferred.resolve(value);
		},
		error => {
			clearTimeout(timer);
			deferred.reject(error);
		},
	);
	return deferred.promise;
}

export interface RpcHarness {
	frames: Frame[];
	collectUntil(commands: Command[], predicate: (frames: Frame[]) => boolean, timeout?: number): Promise<void>;
	stop(): Promise<string>;
}

export interface RpcHarnessPaths {
	projectDir: string;
	homeDir: string;
	xdgDir: string;
	agentDir: string;
}

export function response(frames: Frame[], id: string): Frame {
	const found = frames.find(frame => frame.type === "response" && frame.id === id);
	if (!found) throw new Error(`Missing RPC response for ${id}`);
	return found;
}

export function record(value: unknown, label: string): Frame {
	if (!isRecord(value)) throw new Error(`${label} is not an object`);
	return value;
}

export function array(value: unknown, label: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`${label} is not an array`);
	return value;
}

export async function removeTempDir(tempDir: TempDir | undefined): Promise<void> {
	// Windows can keep short-lived process files open briefly; cleanup failure must
	// not turn a passing protocol contract into a flaky EBUSY failure.
	await tempDir?.remove().catch(() => {});
}

export function spawnRpcHarness({ projectDir, homeDir, xdgDir, agentDir }: RpcHarnessPaths): RpcHarness {
	const child = Bun.spawn(
		["bun", cliPath, "--mode", "rpc", "--provider", "anthropic", "--model", "claude-sonnet-4-5"],
		{
			cwd: projectDir,
			env: {
				...Bun.env,
				BUN_ENV: undefined,
				NODE_ENV: undefined,
				PI_NO_TITLE: "1",
				PI_CODING_AGENT_DIR: agentDir,
				HOME: homeDir,
				USERPROFILE: homeDir,
				XDG_CONFIG_HOME: xdgDir,
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);

	const frames: Frame[] = [];
	const decoder = new RpcFrameDecoder();
	const waiters = new Set<() => void>();
	const notifyWaiters = () => {
		for (const waiter of [...waiters]) waiter();
	};
	let readerError: unknown;
	let exited = false;
	const exitPromise = child.exited.then(() => {
		exited = true;
		notifyWaiters();
	});
	const stderrPromise = new Response(child.stderr as ReadableStream<Uint8Array>).text();
	const readerPromise = (async () => {
		for await (const physicalFrame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
			const logicalFrame = decoder.push(physicalFrame);
			if (logicalFrame && isRecord(logicalFrame)) {
				frames.push(logicalFrame);
				notifyWaiters();
			}
		}
	})().catch(error => {
		readerError = error;
		notifyWaiters();
	});

	return {
		frames,
		async collectUntil(commands, predicate, timeout = 45_000) {
			for (const command of commands) {
				child.stdin.write(`${JSON.stringify(command)}\n`);
				await child.stdin.flush();
			}
			if (predicate(frames)) return;

			const deferred = Promise.withResolvers<void>();
			const check = () => {
				if (predicate(frames)) {
					waiters.delete(check);
					deferred.resolve();
				} else if (readerError) {
					waiters.delete(check);
					deferred.reject(readerError);
				} else if (exited) {
					waiters.delete(check);
					deferred.reject(new Error("RPC process exited before the expected frames arrived"));
				}
			};
			waiters.add(check);
			check();
			await withTimeout(deferred.promise, timeout, `Timed out waiting for RPC frames after ${timeout} ms`);
		},
		async stop() {
			if (!exited) child.stdin.end();
			try {
				await withTimeout(exitPromise, 10_000, "RPC process did not exit after stdin closed");
			} catch {
				child.kill();
				await exitPromise.catch(() => {});
			}
			await readerPromise;
			return stderrPromise;
		},
	};
}
