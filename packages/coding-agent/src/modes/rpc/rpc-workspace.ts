import type { UsageReport } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../../session/agent-session";
import * as git from "../../utils/git";
import * as jj from "../../utils/jj";

const STATUS_USAGE_REFRESH_TIMEOUT_MS = 2_000;

export interface RpcRepoStatus {
	cwd: string;
	vcs: "git" | "jj" | null;
	root: string | null;
	branch: string | null;
	detached: boolean;
	staged: number;
	unstaged: number;
	untracked: number;
	pr: { number: number; url: string } | null;
}

async function withDeadline<T>(timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const signal = AbortSignal.timeout(timeoutMs);
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([run(signal), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

async function lookupPr(cwd: string, branch: string): Promise<{ number: number; url: string } | null> {
	return withDeadline(git.GIT_COMMAND_TIMEOUT_MS, async signal => {
		const defaultBranch = (await git.branch.default(cwd, signal)) ?? "main";
		if (branch === defaultBranch) return null;

		const result = await git.github.run(cwd, ["pr", "view", "--json", "number,url"], signal);
		if (result.exitCode !== 0) return null;

		const value = JSON.parse(result.stdout) as { number?: unknown; url?: unknown };
		return typeof value.number === "number" && typeof value.url === "string"
			? { number: value.number, url: value.url }
			: null;
	});
}

export async function buildRpcRepoStatus(cwd: string, options: { includePr?: boolean } = {}): Promise<RpcRepoStatus> {
	const empty: RpcRepoStatus = {
		cwd,
		vcs: null,
		root: null,
		branch: null,
		detached: false,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		pr: null,
	};

	try {
		const head = git.head.resolveSync(cwd);
		const jjRoot = jj.repo.rootSync(cwd);
		const useJj = jjRoot !== null && (head === null || head.kind === "detached");

		if (useJj) {
			const [branch, status] = await withDeadline(git.GIT_COMMAND_TIMEOUT_MS, signal =>
				Promise.all([jj.workingCopy.label(jjRoot, signal), jj.status.summary(jjRoot, signal)]),
			);
			return {
				...empty,
				vcs: "jj",
				root: jjRoot,
				branch,
				staged: status?.staged ?? 0,
				unstaged: status?.unstaged ?? 0,
				untracked: status?.untracked ?? 0,
			};
		}

		if (!head) return empty;

		const branch = head.kind === "ref" ? (head.branchName ?? head.ref) : null;
		const [status, pr] = await Promise.all([
			withDeadline(git.GIT_COMMAND_TIMEOUT_MS, signal => git.status.summary(cwd, signal)).catch(() => null),
			options.includePr === true && branch !== null
				? lookupPr(cwd, branch).catch(() => null)
				: Promise.resolve(null),
		]);
		return {
			...empty,
			vcs: "git",
			root: head.repoRoot,
			branch,
			detached: head.kind === "detached",
			staged: status?.staged ?? 0,
			unstaged: status?.unstaged ?? 0,
			untracked: status?.untracked ?? 0,
			pr,
		};
	} catch {
		return empty;
	}
}

export async function readRpcUsageReports(session: AgentSession): Promise<UsageReport[]> {
	const reports = await withDeadline(STATUS_USAGE_REFRESH_TIMEOUT_MS, signal => session.fetchUsageReports(signal));
	return reports ?? [];
}
