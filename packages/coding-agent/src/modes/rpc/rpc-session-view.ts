import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import type { AdvisorRuntimeStatus } from "../../advisor";
import type { AgentSession } from "../../session/agent-session";
import { resolveActiveRepoContextSync } from "../../utils/active-repo-context";
import * as git from "../../utils/git";

export interface RpcSessionView {
	/** Highest-priority session-owned mode, matching the status-line precedence. */
	mode: "plan" | "prewalk" | "goal" | "vibe" | null;
	/** Every session-owned mode that is currently active, in status-line precedence order. */
	activeModes: string[];
	autoThinking: boolean;
	resolvedThinkingLevel: string | null;
	fastMode: boolean;
	advisorEnabled: boolean;
	advisors: Array<{ name: string; status: AdvisorRuntimeStatus }>;
	usingSubscription: boolean;
	/** Session manager cwd, without display normalization. */
	cwd: string;
	/** Process-wide project directory, without display normalization. */
	projectDir: string | null;
	activeRepo: { cwd: string; relativeRepoRoot: string } | null;
	worktree: { projectName: string; worktreeName: string } | null;
}

interface RepoView {
	activeRepo: RpcSessionView["activeRepo"];
	worktree: RpcSessionView["worktree"];
}

let cachedRepoView: (RepoView & { projectDir: string }) | undefined;

function resolveRepoView(projectDir: string): RepoView {
	if (cachedRepoView?.projectDir === projectDir) return cachedRepoView;

	const context = resolveActiveRepoContextSync(projectDir);
	const activeRepo = context ? { cwd: context.cwd, relativeRepoRoot: context.relativeRepoRoot } : null;
	let worktree: RpcSessionView["worktree"] = null;
	if (!context) {
		const linked = git.repo.linkedWorktreeSync(projectDir);
		if (linked) {
			const base = path.basename(linked.primaryRoot);
			const projectName = base.endsWith(".git") ? base.slice(0, -4) : base;
			if (projectName) worktree = { projectName, worktreeName: path.basename(linked.root) };
		}
	}

	cachedRepoView = { projectDir, activeRepo, worktree };
	return cachedRepoView;
}

export function buildRpcSessionView(session: AgentSession): RpcSessionView {
	const activeModes: string[] = [];
	if (session.getPlanModeState()?.enabled) activeModes.push("plan");
	if (session.getPrewalkState()) activeModes.push("prewalk");
	const goal = session.getGoalModeState();
	if (goal?.enabled || goal?.goal.status === "paused") activeModes.push("goal");
	if (session.getVibeModeState()?.enabled) activeModes.push("vibe");

	const projectDir = getProjectDir();
	const { activeRepo, worktree } = resolveRepoView(projectDir);
	const model = session.state.model;
	const advisorOverview = session.getAdvisorStatusOverview();

	return {
		mode: (activeModes[0] as RpcSessionView["mode"] | undefined) ?? null,
		activeModes,
		autoThinking: session.isAutoThinking,
		resolvedThinkingLevel: session.autoResolvedThinkingLevel() ?? null,
		fastMode: session.isFastModeActive(),
		advisorEnabled: advisorOverview.configured,
		advisors: advisorOverview.advisors,
		usingSubscription: model ? session.modelRegistry.isUsingOAuth(model) : false,
		cwd: session.sessionManager.getCwd(),
		projectDir,
		activeRepo,
		worktree,
	};
}
