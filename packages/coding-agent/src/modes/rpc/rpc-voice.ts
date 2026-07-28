import { logger } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../../commit/utils";
import { LiveSessionController, type LiveTranscript } from "../../live/controller";
import type { AgentSession } from "../../session/agent-session";
import type { AgentSessionEvent } from "../../session/agent-session-events";
import { STTController, type SttControllerNotifications, type SttState, type SttTranscript } from "../../stt";
import { SpeechEnhancer, vocalizer } from "../../tts";

export type RpcLivePhase = "connecting" | "listening" | "working" | "speaking" | "muted" | "error";
export type RpcSpeechMode = "all" | "assistant" | "yield";

export interface RpcLiveStatus {
	active: boolean;
	phase: RpcLivePhase | null;
	muted: boolean;
	inputLevel: number;
	outputLevel: number;
	transcript: LiveTranscript | null;
	error: string | null;
}

export interface RpcSttStatus {
	state: SttState;
}

export interface RpcSpeechStatus {
	enabled: boolean;
	mode: RpcSpeechMode;
	speaking: boolean;
}

export interface RpcSpeechSettings {
	enabled?: boolean;
	mode?: RpcSpeechMode;
}

export interface RpcLiveStartOptions {
	voice?: string;
}

export interface RpcLivePhaseEvent {
	type: "live_phase";
	phase: RpcLivePhase;
}

export interface RpcLiveLevelsEvent {
	type: "live_levels";
	input: number;
	output: number;
}

export interface RpcLiveTranscriptEvent {
	type: "live_transcript";
	transcript: LiveTranscript | null;
}

export interface RpcLiveTerminalEvent {
	type: "live_terminal";
	error: string | null;
}

export interface RpcSttStateEvent {
	type: "stt_state";
	state: SttState;
}

export interface RpcSttTranscriptEvent {
	type: "stt_transcript";
	transcript: SttTranscript;
}

export interface RpcSttNoticeEvent {
	type: "stt_notice";
	level: "status" | "warning";
	message: string;
}

export type RpcVoiceEvent =
	| RpcLivePhaseEvent
	| RpcLiveLevelsEvent
	| RpcLiveTranscriptEvent
	| RpcLiveTerminalEvent
	| RpcSttStateEvent
	| RpcSttTranscriptEvent
	| RpcSttNoticeEvent;

export type RpcVoiceEventSink = (event: RpcVoiceEvent) => void;

interface LiveRuntime {
	controller: LiveSessionController | undefined;
	settling: Promise<void> | undefined;
	releaseVocalizer: (() => void) | undefined;
	emit: RpcVoiceEventSink | undefined;
	phase: RpcLivePhase | null;
	muted: boolean;
	inputLevel: number;
	outputLevel: number;
	transcript: LiveTranscript | null;
	error: string | null;
}

interface SttRuntime {
	controller: STTController;
	notifications: SttControllerNotifications;
	emit: RpcVoiceEventSink | undefined;
	operation: Promise<void> | undefined;
}

interface VoiceRuntime {
	live: LiveRuntime;
	stt: SttRuntime | undefined;
}

const runtimes = new WeakMap<AgentSession, VoiceRuntime>();
const enhancers = new WeakMap<AgentSession, SpeechEnhancer>();
let enhancerSession: AgentSession | undefined;

function createRuntime(): VoiceRuntime {
	return {
		live: {
			controller: undefined,
			settling: undefined,
			releaseVocalizer: undefined,
			emit: undefined,
			phase: null,
			muted: false,
			inputLevel: 0,
			outputLevel: 0,
			transcript: null,
			error: null,
		},
		stt: undefined,
	};
}

function runtimeFor(session: AgentSession): VoiceRuntime {
	let runtime = runtimes.get(session);
	if (!runtime) {
		runtime = createRuntime();
		runtimes.set(session, runtime);
	}
	return runtime;
}

function liveStatus(runtime: LiveRuntime): RpcLiveStatus {
	return {
		active: runtime.controller !== undefined,
		phase: runtime.phase,
		muted: runtime.muted,
		inputLevel: runtime.inputLevel,
		outputLevel: runtime.outputLevel,
		transcript: runtime.transcript ? { ...runtime.transcript } : null,
		error: runtime.error,
	};
}

function emitLive(runtime: LiveRuntime, event: RpcVoiceEvent): void {
	runtime.emit?.(event);
}

function settleLive(runtime: LiveRuntime, controller: LiveSessionController, error?: Error): void {
	if (runtime.controller !== controller) return;
	runtime.controller = undefined;
	runtime.inputLevel = 0;
	runtime.outputLevel = 0;
	runtime.error = error?.message ?? null;
	runtime.phase = error ? "error" : null;
	runtime.releaseVocalizer?.();
	runtime.releaseVocalizer = undefined;
	emitLive(runtime, { type: "live_terminal", error: runtime.error });

	const settling = controller.stop().catch(cause => {
		logger.debug("RPC live session cleanup failed", {
			error: cause instanceof Error ? cause.message : String(cause),
		});
	});
	runtime.settling = settling;
	void settling.finally(() => {
		if (runtime.settling === settling) runtime.settling = undefined;
	});
}

function ensureSttRuntime(runtime: VoiceRuntime): SttRuntime {
	if (runtime.stt) return runtime.stt;
	const stt: SttRuntime = {
		controller: new STTController(),
		emit: undefined,
		operation: undefined,
		notifications: {
			showWarning: message => stt.emit?.({ type: "stt_notice", level: "warning", message }),
			showStatus: message => stt.emit?.({ type: "stt_notice", level: "status", message }),
			onStateChange: state => {
				if (state === "recording") vocalizer.duck();
				else vocalizer.unduck();
				stt.emit?.({ type: "stt_state", state });
			},
			onTranscript: transcript => stt.emit?.({ type: "stt_transcript", transcript: { ...transcript } }),
		},
	};
	runtime.stt = stt;
	return stt;
}

async function setSttRecording(stt: SttRuntime, recording?: boolean): Promise<void> {
	if (stt.operation) await stt.operation;
	const isRecording = stt.controller.state === "recording";
	if (recording !== undefined && recording === isRecording) return;
	const operation = stt.controller.toggle(undefined, stt.notifications);
	stt.operation = operation;
	try {
		await operation;
	} finally {
		if (stt.operation === operation) stt.operation = undefined;
	}
}

function wireEnhancer(session: AgentSession): void {
	if (enhancerSession === session) return;
	let enhancer = enhancers.get(session);
	if (!enhancer) {
		enhancer = new SpeechEnhancer({
			settings: session.settings,
			registry: session.modelRegistry,
			sessionId: session.sessionId,
			metadataResolver: provider => session.agent.metadataForProvider(provider),
		});
		enhancers.set(session, enhancer);
	}
	vocalizer.setEnhancer(enhancer);
	enhancerSession = session;
}

/** Starts native realtime audio and emits phase, level, transcript, and terminal events. */
export async function startRpcLive(
	session: AgentSession,
	emit: RpcVoiceEventSink,
	options: RpcLiveStartOptions = {},
): Promise<RpcLiveStatus> {
	const runtime = runtimeFor(session).live;
	runtime.emit = emit;
	if (runtime.controller) return liveStatus(runtime);
	if (runtime.settling) await runtime.settling;
	if (runtime.controller) return liveStatus(runtime);

	runtime.phase = "connecting";
	runtime.muted = false;
	runtime.inputLevel = 0;
	runtime.outputLevel = 0;
	runtime.transcript = null;
	runtime.error = null;
	runtime.releaseVocalizer = vocalizer.suspend();

	let controller: LiveSessionController;
	controller = new LiveSessionController({
		session,
		voice: options.voice,
		extractAssistantText: extractTextContent,
		callbacks: {
			onPhase: phase => {
				runtime.phase = phase;
				runtime.muted = controller.muted;
				emitLive(runtime, { type: "live_phase", phase });
			},
			onLevels: (input, output) => {
				runtime.inputLevel = input;
				runtime.outputLevel = output;
				emitLive(runtime, { type: "live_levels", input, output });
			},
			onTranscript: transcript => {
				runtime.transcript = transcript ? { ...transcript } : null;
				emitLive(runtime, { type: "live_transcript", transcript: runtime.transcript });
			},
			onTerminal: error => settleLive(runtime, controller, error),
		},
	});
	runtime.controller = controller;
	try {
		await controller.start();
	} catch (error) {
		if (runtime.controller === controller)
			settleLive(runtime, controller, error instanceof Error ? error : new Error(String(error)));
		throw error;
	}
	return liveStatus(runtime);
}

/** Stops native realtime audio and drains its transport. */
export async function stopRpcLive(session: AgentSession): Promise<RpcLiveStatus> {
	const runtime = runtimes.get(session)?.live;
	if (!runtime) return liveStatus(createRuntime().live);
	const controller = runtime.controller;
	if (controller) await controller.stop();
	if (runtime.settling) await runtime.settling;
	return liveStatus(runtime);
}

/** Reads the latest live phase, levels, transcript, mute state, and terminal error. */
export async function getRpcLiveStatus(session: AgentSession): Promise<RpcLiveStatus> {
	const runtime = runtimes.get(session)?.live;
	return liveStatus(runtime ?? createRuntime().live);
}

/** Toggles the harness microphone while keeping the realtime session connected. */
export async function toggleRpcLiveMute(session: AgentSession): Promise<RpcLiveStatus> {
	const runtime = runtimes.get(session)?.live;
	if (!runtime?.controller) throw new Error("No live session is active.");
	runtime.controller.toggleMute();
	runtime.muted = runtime.controller.muted;
	return liveStatus(runtime);
}

/** Starts native microphone transcription without requiring a composer/editor. */
export async function startRpcStt(session: AgentSession, emit: RpcVoiceEventSink): Promise<RpcSttStatus> {
	const stt = ensureSttRuntime(runtimeFor(session));
	stt.emit = emit;
	await setSttRecording(stt, true);
	return { state: stt.controller.state };
}

/** Stops recording and waits for the final transcript. */
export async function stopRpcStt(session: AgentSession): Promise<RpcSttStatus> {
	const stt = runtimes.get(session)?.stt;
	if (!stt) return { state: "idle" };
	await setSttRecording(stt, false);
	return { state: stt.controller.state };
}

/** Matches the TUI push-to-talk toggle while emitting state and transcript events. */
export async function toggleRpcStt(session: AgentSession, emit: RpcVoiceEventSink): Promise<RpcSttStatus> {
	const stt = ensureSttRuntime(runtimeFor(session));
	stt.emit = emit;
	await setSttRecording(stt);
	return { state: stt.controller.state };
}

/** Reads native microphone/transcription state. */
export async function getRpcSttStatus(session: AgentSession): Promise<RpcSttStatus> {
	return { state: runtimes.get(session)?.stt?.controller.state ?? "idle" };
}

/** Speaks explicit text through the harness speakers, subject to speech.enabled. */
export async function speakRpcText(session: AgentSession, text: string): Promise<RpcSpeechStatus> {
	wireEnhancer(session);
	vocalizer.speak(text);
	return getRpcSpeechStatus(session);
}

/** Stops playback, synthesis, and pending speech rewrites immediately. */
export async function clearRpcSpeech(session: AgentSession): Promise<RpcSpeechStatus> {
	vocalizer.clear();
	return getRpcSpeechStatus(session);
}

/** Lowers harness speech playback while the user is speaking. */
export async function duckRpcSpeech(session: AgentSession): Promise<RpcSpeechStatus> {
	vocalizer.duck();
	return getRpcSpeechStatus(session);
}

/** Restores harness speech playback volume. */
export async function unduckRpcSpeech(session: AgentSession): Promise<RpcSpeechStatus> {
	vocalizer.unduck();
	return getRpcSpeechStatus(session);
}

/** Reads effective speech settings and process-level playback activity. */
export async function getRpcSpeechStatus(session: AgentSession): Promise<RpcSpeechStatus> {
	return {
		enabled: session.settings.get("speech.enabled"),
		mode: session.settings.get("speech.mode"),
		speaking: vocalizer.isSpeaking(),
	};
}

/** Persists the speech settings that control automatic and explicit vocalization. */
export async function applyRpcSpeechSettings(
	session: AgentSession,
	patch: RpcSpeechSettings,
): Promise<RpcSpeechStatus> {
	if (patch.enabled !== undefined) session.settings.set("speech.enabled", patch.enabled);
	if (patch.mode !== undefined) session.settings.set("speech.mode", patch.mode);
	await session.settings.flush();
	return getRpcSpeechStatus(session);
}

/** Applies the same streaming speech side effects as the interactive event controller. */
export function vocalizeRpcSessionEvent(session: AgentSession, event: AgentSessionEvent): void {
	if (event.type === "message_start" && event.message.role === "user") {
		vocalizer.clear();
		return;
	}
	if (!session.settings.get("speech.enabled")) return;
	wireEnhancer(session);

	switch (event.type) {
		case "message_update": {
			const mode = session.settings.get("speech.mode");
			const delta = event.assistantMessageEvent;
			if (delta.type === "text_delta" && (mode === "assistant" || mode === "all")) {
				vocalizer.pushDelta(delta.delta);
			} else if (delta.type === "thinking_delta" && mode === "all") {
				vocalizer.pushDelta(delta.delta);
			}
			break;
		}
		case "message_end":
			if (event.message.role !== "assistant") break;
			if (event.message.stopReason === "aborted") {
				vocalizer.clear();
			} else {
				const mode = session.settings.get("speech.mode");
				if (mode === "assistant" || mode === "all") vocalizer.flush();
			}
			break;
		case "turn_end":
			if (session.settings.get("speech.mode") !== "yield") {
				vocalizer.flush();
				break;
			}
			if (event.message.role !== "assistant" || event.message.stopReason === "aborted") break;
			{
				const text = extractTextContent(event.message);
				if (text) vocalizer.speak(text);
			}
			break;
	}
}

/** Releases native audio resources owned by this RPC session. */
export async function disposeRpcVoice(session: AgentSession): Promise<void> {
	await stopRpcLive(session);
	const runtime = runtimes.get(session);
	runtime?.stt?.controller.dispose();
	vocalizer.unduck();
	vocalizer.clear();
	if (enhancerSession === session) {
		vocalizer.setEnhancer(null);
		enhancerSession = undefined;
	}
	runtimes.delete(session);
}
