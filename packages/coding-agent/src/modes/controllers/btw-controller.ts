import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { type Container, replaceTabs, type TUI } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import btwUserPrompt from "../../prompts/system/btw-user.md" with { type: "text" };
import type { AgentSession } from "../../session/agent-session";
import type { SessionManager } from "../../session/session-manager";
import { copyToClipboard } from "../../utils/clipboard";
import { BtwPanelComponent } from "../components/btw-panel";
export interface BtwControllerContext {
	session: AgentSession;
	sessionManager: SessionManager;
	showStatus(message: string): void;
	showError(message: string): void;
	handleBtwBranch(question: string, assistantMessage: AssistantMessage): Promise<void>;
}
export interface BtwControllerRenderer {
	open(question: string): void;
	appendText(delta: string): void;
	complete(replyText: string): void;
	abort(): void;
	error(message: string): void;
	close(): void;
}
interface BtwTuiControllerContext extends BtwControllerContext {
	ui: TUI;
	btwContainer: Container;
}
interface BtwRequest {
	abortController: AbortController;
	question: string;
	leafId: string | null;
}
export interface BtwAnswer {
	question: string;
	answer: string;
}

function assistantMessageWithReplyText(assistantMessage: AssistantMessage, replyText: string): AssistantMessage {
	const content: AssistantMessage["content"] = [];
	let replacedText = false;
	for (const part of assistantMessage.content) {
		if (part.type === "thinking") {
			content.push({ type: "thinking", thinking: part.thinking });
			continue;
		}
		if (part.type === "redactedThinking") continue;
		if (part.type !== "text") {
			content.push(part);
			continue;
		}
		if (replacedText) continue;
		content.push({ type: "text", text: replyText });
		replacedText = true;
	}
	if (!replacedText) content.push({ type: "text", text: replyText });
	return { ...assistantMessage, content, providerPayload: undefined };
}

class BtwPanelRenderer implements BtwControllerRenderer {
	#component: BtwPanelComponent | undefined;
	readonly #ui: TUI;
	readonly #container: Container;

	constructor(ui: TUI, container: Container) {
		this.#ui = ui;
		this.#container = container;
	}
	open(question: string): void {
		const component = new BtwPanelComponent({ question, tui: this.#ui });
		this.#component = component;
		this.#container.clear();
		this.#container.addChild(component);
		this.#ui.requestRender();
	}
	appendText(delta: string): void {
		this.#component?.appendText(delta);
	}
	complete(replyText: string): void {
		this.#component?.setAnswer(replyText);
		this.#component?.markComplete();
	}
	abort(): void {
		this.#component?.markAborted();
	}
	error(message: string): void {
		this.#component?.markError(message);
	}
	close(): void {
		this.#component?.close();
		this.#component = undefined;
		this.#container.clear();
		this.#ui.requestRender();
	}
}
export class BtwController {
	#activeRequest: BtwRequest | undefined;
	#lastQuestion: string | undefined;
	#lastReplyText: string | undefined;
	#lastAssistantMessage: AssistantMessage | undefined;
	#lastLeafId: string | null | undefined;
	#branchInFlight = false;
	#lastCopyText: string | undefined;
	#copyInFlight = false;
	readonly #ctx: BtwControllerContext;
	readonly #renderer: BtwControllerRenderer;
	constructor(ctx: BtwTuiControllerContext);
	constructor(ctx: BtwControllerContext, renderer: BtwControllerRenderer);
	constructor(ctx: BtwControllerContext, renderer?: BtwControllerRenderer) {
		this.#ctx = ctx;
		if (renderer) {
			this.#renderer = renderer;
			return;
		}
		if (!("ui" in ctx) || !("btwContainer" in ctx)) {
			throw new Error("BtwController requires a renderer outside interactive mode");
		}
		const tuiContext = ctx as BtwTuiControllerContext;
		this.#renderer = new BtwPanelRenderer(tuiContext.ui, tuiContext.btwContainer);
	}

	hasActiveRequest(): boolean {
		return this.#activeRequest !== undefined;
	}

	canBranch(): boolean {
		return (
			!this.#branchInFlight &&
			this.#activeRequest !== undefined &&
			this.#lastQuestion !== undefined &&
			this.#lastReplyText !== undefined &&
			this.#lastAssistantMessage !== undefined &&
			this.#lastLeafId !== null &&
			this.#lastLeafId === this.#ctx.sessionManager.getLeafId()
		);
	}
	canCopy(): boolean {
		return !this.#copyInFlight && this.#activeRequest !== undefined && this.#lastCopyText !== undefined;
	}

	async handleCopy(): Promise<boolean> {
		if (!this.canCopy() || this.#lastCopyText === undefined) return false;
		this.#copyInFlight = true;
		try {
			await copyToClipboard(this.#lastCopyText);
			this.#ctx.showStatus("Copied /btw answer to clipboard");
			return true;
		} catch (error) {
			this.#ctx.showError(error instanceof Error ? error.message : String(error));
			return true;
		} finally {
			this.#copyInFlight = false;
		}
	}

	async handleBranch(): Promise<boolean> {
		if (!this.canBranch() || !this.#lastQuestion || !this.#lastAssistantMessage) return false;
		this.#branchInFlight = true;
		try {
			await this.#ctx.handleBtwBranch(this.#lastQuestion, this.#lastAssistantMessage);
			return true;
		} finally {
			this.#branchInFlight = false;
		}
	}

	getLastAnswer(): BtwAnswer | undefined {
		if (this.#lastQuestion === undefined || this.#lastReplyText === undefined) return undefined;
		return { question: this.#lastQuestion, answer: this.#lastReplyText };
	}

	handleEscape(): boolean {
		if (!this.#activeRequest) return false;
		this.#closeActiveRequest({ abort: this.#activeRequest.abortController.signal.aborted === false });
		return true;
	}

	dispose(): void {
		this.#closeActiveRequest({ abort: true });
	}

	async start(question: string): Promise<void> {
		const trimmedQuestion = question.trim();
		if (!trimmedQuestion) {
			this.#ctx.showStatus("Usage: /btw <question>");
			return;
		}
		const model = this.#ctx.session.model;
		if (!model) {
			this.#ctx.showError("No active model available for /btw.");
			return;
		}

		this.#closeActiveRequest({ abort: true });

		const request: BtwRequest = {
			abortController: new AbortController(),
			question: trimmedQuestion,
			leafId: this.#ctx.sessionManager.getLeafId(),
		};
		this.#renderer.open(trimmedQuestion);
		this.#activeRequest = request;
		void this.#runRequest(request);
	}

	async #runRequest(request: BtwRequest): Promise<void> {
		try {
			const promptText = prompt.render(btwUserPrompt, { question: request.question });
			const { replyText, assistantMessage } = await this.#ctx.session.runEphemeralTurn({
				promptText,
				onTextDelta: delta => {
					if (this.#isActiveRequest(request)) {
						this.#renderer.appendText(delta);
					}
				},
				signal: request.abortController.signal,
			});

			if (!this.#isActiveRequest(request)) {
				return;
			}
			this.#renderer.complete(replyText);
			const copyText = replaceTabs(replyText).trim();
			if (copyText) {
				this.#lastQuestion = request.question;
				this.#lastReplyText = replyText;
				this.#lastCopyText = copyText;
				this.#lastAssistantMessage = assistantMessageWithReplyText(assistantMessage, replyText);
				this.#lastLeafId = request.leafId;
			} else {
				this.#clearCompletedState();
			}
		} catch (error) {
			if (!this.#isActiveRequest(request)) {
				return;
			}
			if (request.abortController.signal.aborted) {
				this.#renderer.abort();
				return;
			}
			this.#renderer.error(error instanceof Error ? error.message : String(error));
		}
	}

	#closeActiveRequest(options: { abort: boolean }): void {
		const request = this.#activeRequest;
		if (!request) return;
		this.#activeRequest = undefined;
		this.#clearCompletedState();
		if (options.abort) {
			request.abortController.abort();
		}
		this.#renderer.close();
	}

	#clearCompletedState(): void {
		this.#lastQuestion = undefined;
		this.#lastReplyText = undefined;
		this.#lastAssistantMessage = undefined;
		this.#lastCopyText = undefined;
		this.#lastLeafId = undefined;
	}

	#isActiveRequest(request: BtwRequest): boolean {
		return this.#activeRequest === request;
	}
}
