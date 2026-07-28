# RPC Protocol Reference

RPC mode runs the coding agent as a newline-delimited JSON protocol over stdio.

- **stdin**: commands (`RpcCommand`), extension UI responses, and host-tool updates/results
- **stdout**: a ready frame, command responses (`RpcResponse`), session/agent events, extension UI requests, host-tool requests/cancellations

Primary implementation:

- `src/modes/rpc/rpc-mode.ts`
- `src/modes/rpc/rpc-types.ts`
- `src/session/agent-session.ts`
- `packages/agent/src/agent.ts`
- `packages/agent/src/agent-loop.ts`

## Startup

```bash
omp --mode rpc [regular CLI options]
```

Behavior notes:

- `@file` CLI arguments are rejected in RPC mode.
- RPC startup sets `PI_NO_TITLE=1`, so `prompt` never starts an implicit title-generation model call. Clients control titles explicitly with `set_session_name` or `generate_title`.
- RPC mode resets workflow-altering `todo.*`, `task.*`, `memory.backend`/`memories.enabled`, `advisor.*`, `async.*`, and `bash.autoBackground.*` settings to their built-in defaults instead of inheriting user overrides.
- The process reads stdin as JSONL (`readJsonl(Bun.stdin.stream())`).
- At startup it writes a `ready` frame before processing commands. The frame advertises supported protocol versions and transport limits.
- When stdin closes, pending host-tool calls and host-URI requests are rejected and the process exits with code `0`.
- Responses/events are written as one JSON object per line.

## Transport and Framing

Protocol v1 frames are a single JSON object followed by `\n`. Every physical JSONL frame is limited to 1 MiB.

The initial ready frame uses protocol v1 and advertises the opt-in lossless transport:

```json
{
  "type": "ready",
  "protocolVersion": 1,
  "supportedProtocolVersions": [1, 2],
  "maxFrameBytes": 1048576,
  "maxReassembledFrameBytes": 67108864
}
```

Clients that support protocol v2 SHOULD immediately send:

```json
{ "id": "protocol-1", "type": "negotiate_protocol", "protocolVersion": 2 }
```

After the success response, oversized stdout objects are emitted losslessly as an uninterrupted sequence of `rpc_chunk` frames. Each chunk carries a base64 segment of the original UTF-8 JSON object:

```json
{
  "type": "rpc_chunk",
  "chunkId": "rpc-1",
  "index": 0,
  "count": 7,
  "byteLength": 1600042,
  "data": "eyJ0eXBlIjoicmVzcG9uc2UiLC4uLn0="
}
```

Clients MUST validate `chunkId`, `index`, `count`, and `byteLength`, reject interleaved or interrupted sequences, enforce the advertised reassembly limit, concatenate decoded bytes in index order, decode them as strict UTF-8, and parse the result as one JSON object. The exported TypeScript `RpcFrameDecoder` implements this validation. The bundled TypeScript and Python `RpcClient` implementations negotiate v2 automatically when the ready frame advertises it.

Legacy clients may ignore the added ready fields and remain on v1. V1 retains its bounded fallback behavior for oversized output. Frames above the v2 reassembly ceiling still fail explicitly; large history APIs should use pagination rather than depending on arbitrarily large logical frames.

### Outbound frame categories (stdout)

The table below names the 18 asynchronous frames and event variants a standalone client must handle. `context_message_added` is an `AgentSessionEvent`; the other rows are RPC side channels in addition to `ready`, command `response` objects, `rpc_chunk` transport frames, host-tool/URI requests, and the builtin `command_output`, `session_info_update`, and `config_update` side channels.

| Frame | Trigger | Client subscription |
| --- | --- | --- |
| `extension_ui_request` | An extension, login flow, collab host, or tool needs host UI. Requests that expect an answer are completed with `extension_ui_response`. | Automatic; use `RpcClient.onExtensionUiRequest`. |
| `extension_error` | An extension event handler throws. | Automatic raw stdout frame; the TypeScript client has no dedicated listener. |
| `available_commands_update` | Emitted once at startup and whenever slash-command metadata changes. | Automatic; use `RpcClient.onAvailableCommandsUpdate`. |
| `prompt_result` | A successfully resolved `prompt` reports whether agent-facing input handled it (`true`) or it completed locally (`false`). Exactly one terminal outcome is emitted and correlated by request `id`; this is distinct from agent lifecycle completion. | Automatic; use `RpcClient.onPromptResult`, and also `onPromptError` when late `prompt` or `abort_and_prompt` scheduling failures must be observed. Use `promptWithResult` or `abortAndPromptWithResult` to retain the acknowledgement request id. |
| `subagent_lifecycle` | A subscribed subagent starts, stops, or changes lifecycle state. | Send `set_subagent_subscription` with `level: "progress"` or `"events"`, then use `RpcClient.onSubagentLifecycle`. |
| `subagent_progress` | A subscribed subagent publishes progress. | Send `set_subagent_subscription` with `level: "progress"` or `"events"`, then use `RpcClient.onSubagentProgress`. |
| `subagent_event` | A subscribed subagent emits its underlying session event. | Send `set_subagent_subscription` with `level: "events"`, then use `RpcClient.onSubagentEvent`. |
| `exec_output` | `bash` or `python` produces an incremental output chunk. | Automatic for those commands; use `RpcClient.onExecOutput` before starting the execution. |
| `settings_update` | Any writer changes a setting's effective value, including `set_setting`, slash commands, and extensions. | Automatic; use `RpcClient.onSettingsUpdate`. |
| `btw_output` | An in-flight `ask_btw` side turn produces text. | Use `RpcClient.onBtwOutput` before `askBtw`; correlate concurrent work by `id`. |
| `idle_recap` | After an agent turn, an idle session with `recap.enabled` waits `recap.idleSeconds` and completes its ephemeral recap turn. | Automatic when enabled in settings; use `RpcClient.onIdleRecap`. |
| `ttsr_generation_event` | `generate_ttsr_rule` streams an `/omfg` draft delta. | Use `RpcClient.onTtsrGenerationEvent` before starting generation; correlate by `id`. |
| `raw_sse_update` | The raw SSE debug capture changes while forwarding is enabled. | Send `subscribe_raw_sse`, listen with `RpcClient.onRawSseUpdate`, and send `unsubscribe_raw_sse` when finished. |
| `mcp_auth_challenge` | An MCP tool call returns `WWW-Authenticate` and blocks pending host input. | Automatic; use `RpcClient.onMcpAuthChallenge`, then answer with `resolve_mcp_auth_challenge`. Omitting `config` rejects the blocked call. |
| `voice_event` | An active realtime or STT controller changes phase/state, reports levels or transcripts, emits a notice, or terminates. | Use `RpcClient.onVoiceEvent` before `start_live`, `start_stt`, or `toggle_stt`. |
| `context_message_added` | The session appends context that the model can act on without adding a normal conversation-history message. | Automatic as part of `AgentSessionEvent`; use `RpcClient.onSessionEvent`. Honor its `display` field. |
| `provider_request_observation` | A subscribed observer snapshots the final `context` or `before_provider_request` provider input after extension rewrites and redaction. | Privileged and off by default. Send `subscribe_provider_request_observations`, listen with `RpcClient.onProviderRequestObservation`, then send `unsubscribe_provider_request_observations`. |
| `extension_ui_cancel` | The server abandons or times out a pending extension UI dialog. | Automatic for pending dialogs; use `RpcClient.onExtensionUiCancel` and close the dialog identified by `targetId`. |

`AgentSessionEvent` remains the primary model/tool stream (`agent_start`, `message_update`, `tool_execution_update`, `agent_end`, compaction/retry events, and related session events). Use `RpcClient.onSessionEvent` for the full session stream or `onEvent` for the core event subset.

#### `exec_output`

All `exec_output` chunks for an execution are queued before its execution `response`; concurrent executions can interleave, so clients correlate streams and responses by `id`. The stream contains raw pre-cap output, while the final result's `output` may be truncated or minimized. Concatenated chunks are therefore not guaranteed to equal the final field.

#### `settings_update`

`settings_update` includes changes made outside `set_setting`, such as `/browser`. Credential paths always carry `value: null`.

#### `context_message_added`

`context_message_added` has shape `{ type: "context_message_added", message: AgentMessage, display: boolean }`. It exposes context the model received and acted on even when that context is not a normal persisted conversation message. A motivating example is the `<system-reminder reason="rule_violation">` injected after a tool call matches a non-interrupting TTSR rule.

Clients MUST preserve the complete `message` bytes for an accurate model-context view, but SHOULD use `display` to decide whether the item belongs in the visible transcript. `display: false` means internal context may be hidden from the conversation renderer; it does not mean the context was absent or ignored by the model.

#### `provider_request_observation`

Provider observation is a privileged diagnostic surface and is OFF by default. Enable it with `subscribe_provider_request_observations` and disable it with `unsubscribe_provider_request_observations`. Every payload is redacted before it crosses the wire.

Frames are correlated by numeric `requestId`. A `stage: "context"` frame carries `messages`; a `stage: "before_provider_request"` frame carries `payload`. Either may include `serializationError`. These observations reveal extension `context` and `before_provider_request` rewrites that never enter message history, so clients MUST NOT treat message history alone as the final provider request.

#### `extension_ui_cancel`

`extension_ui_cancel` has shape `{ type: "extension_ui_cancel", targetId: string, timedOut?: boolean }`. `targetId` names the earlier `extension_ui_request.id`; `timedOut: true` distinguishes deadline expiry from another server-side abort. A client that ignores this frame will leave a dialog open after the server has stopped waiting for it.

### Inbound frame categories (stdin)

1. `RpcCommand`
2. `RpcExtensionUIResponse` (`{ type: "extension_ui_response", ... }`)
3. Host tool updates/results (`host_tool_update`, `host_tool_result`)
4. Host URI results (`host_uri_result`)

## Request/Response Correlation

All commands accept optional `id?: string`.

- If provided, normal command responses echo the same `id`.
- `RpcClient` relies on this for pending-request resolution.

Important edge behavior from runtime:

- Unknown command responses preserve the request `id` when one was provided.
- Parse/handler exceptions in the input loop emit `command: "parse"` with `id: undefined`.
- `prompt` and `abort_and_prompt` return immediate success, then may emit a later error response with the **same** id if async prompt scheduling fails. The TypeScript client exposes both through the typed `onPromptError` subscription. `RpcPromptErrorResponse.command` is `"prompt" | "abort_and_prompt"`; use the `requestId` returned by `promptWithResult()` or `abortAndPromptWithResult()` for correlation. Matched immediate failures remain normal command responses and are not also published to the listener.
- `prompt` success responses may include `data.agentInvoked`. `false` means the prompt completed locally; `true` means agent-facing input handled it but does not guarantee a new agent lifecycle; omitted means the outcome is still resolving. Consumers that need every terminal prompt outcome should subscribe to both `onPromptResult` and `onPromptError`.
- `abort_and_prompt` does not emit `data.agentInvoked` or `prompt_result`; its acknowledgement and possible late scheduling failure are correlated by request id. A late scheduling failure carries `code: "prompt_scheduling_failed"`; run completion remains an agent lifecycle event.

## Command Schema (canonical)

`RpcCommand` is defined in `src/modes/rpc/rpc-types.ts`. The list below covers all 181 command discriminants; referenced TypeScript types are exported from the same module.

### Protocol

- `{ id?, type: "negotiate_protocol", protocolVersion: number }`

Only protocol version `2` is currently negotiable.

### Prompting and editor

- `{ id?, type: "prompt", message: string, images?: ImageContent[], streamingBehavior?: "steer" | "followUp" }`
- `{ id?, type: "steer", message: string, images?: ImageContent[] }`
- `{ id?, type: "follow_up", message: string, images?: ImageContent[] }`
- `{ id?, type: "abort" }`
- `{ id?, type: "abort_and_prompt", message: string, images?: ImageContent[] }`
- `{ id?, type: "ask_btw", question: string }`
- `{ id?, type: "get_last_btw_answer" }`
- `{ id?, type: "cancel_btw" }`
- `{ id?, type: "branch_btw" }`
- `{ id?, type: "complete", lines: string[], cursor: { line: number, column: number } }`
- `{ id?, type: "apply_completion", lines: string[], cursor: { line: number, column: number }, item: RpcCompletionItem }`
- `{ id?, type: "publish_editor_text", text: string }`
- `{ id?, type: "new_session", parentSession?: string }`

`prompt` runs extension `input` hooks before builtin, skill, template, or model dispatch. Prompt text has `@file` mentions expanded server-side; clients MUST NOT repeat that resolution.

`ask_btw` is an ephemeral side turn: text arrives through `btw_output`, the final response contains `{ question, answer, cancelled }`, `cancel_btw` interrupts only the active side turn, and `branch_btw` promotes the retained answer into the main session.

`getEditorText()` in an in-process extension is synchronous. RPC therefore serves it from a server-side cache, not by making a stdio round trip. The host MUST send `publish_editor_text` whenever its local draft changes. Server-issued `set_editor_text` extension requests also update the cache, but otherwise `getEditorText()` remains stale. Extension autocomplete factories participate in both `complete` and `apply_completion`.

#### Completion contract — do not infer a replacement span

`complete` returns `{ items, prefix }`, but `prefix` is match text for display/highlighting, never a replacement span. For a buffer containing `"  /mod"`, the provider may return the same string as `prefix`, while correct application re-anchors at `/` and produces `"  /model "`.

The client MUST send the unchanged buffer, cursor, and selected item to `apply_completion` and use the returned buffer and cursor. It MUST NOT compute or replace a span itself. A failure with `code: "stale_completion"` means the candidate is no longer offered; call `complete` again.

### State and host capabilities

- `{ id?, type: "get_state" }`
- `{ id?, type: "get_available_commands" }`
- `{ id?, type: "get_settings" }`
- `{ id?, type: "set_setting", path: string, value: unknown }`
- `{ id?, type: "get_extensions", cwd?: string }`
- `{ id?, type: "get_repo_status", cwd?: string, includePr?: boolean }`
- `{ id?, type: "get_usage_reports" }`
- `{ id?, type: "set_todos", phases: TodoPhase[] }`
- `{ id?, type: "set_host_tools", tools: RpcHostToolDefinition[] }`
- `{ id?, type: "set_host_uri_schemes", schemes: RpcHostUriSchemeDefinition[] }`
- `{ id?, type: "subscribe_provider_request_observations" }`
- `{ id?, type: "unsubscribe_provider_request_observations" }`
- `{ id?, type: "set_subagent_subscription", level: "off" | "progress" | "events" }`
- `{ id?, type: "get_subagents" }`
- `{ id?, type: "get_subagent_messages", subagentId?: string, sessionFile?: string, fromByte?: number }`

`get_extensions` defaults to the session cwd and removes the secret-bearing `raw` capability field. Setting `disabledExtensions` configures the next boot; it does not unload active tools or hooks. MCP servers are enabled or disabled through `prompt` with `/mcp enable <name>` or `/mcp disable <name>`.

`get_repo_status` defaults to the session cwd. `includePr` defaults to `false` because it may invoke `gh` and perform a network request. `get_usage_reports` returns `{ reports: UsageReport[] }`.

### Settings

Runtime `ui.options` arrive already resolved. `defaultThinkingLevel` includes the full option list, which clients narrow using the model from `get_state`. Arrays and records are validated only at the container level, matching the config file's trust boundary.

There is no separate reset command. A descriptor with `nullable: true` accepts `null` to clear an undefined-default value; otherwise send the descriptor's `default`.

### Work modes

#### Plan mode

- `{ id?, type: "enter_plan_mode", planFilePath?: string, workflow?: "parallel" | "iterative" }`
- `{ id?, type: "pause_plan_mode" }`
- `{ id?, type: "resume_plan_mode" }`
- `{ id?, type: "exit_plan_mode" }`
- `{ id?, type: "get_plan_mode_state" }`
- `{ id?, type: "submit_plan_review", title?: string }`
- `{ id?, type: "approve_plan_proposal", editedContent?: string, strategy?: "execute" | "keep-context" | "compact-context", executionModel?: { provider: string, modelId: string }, thinkingLevel?: ConfiguredThinkingLevel }`
- `{ id?, type: "reject_plan_proposal", feedback?: string }`

Plan commands return `RpcPlanModeSnapshot`, `RpcPlanProposalSnapshot`, or `RpcPlanDecisionResult`. Every plan snapshot includes `paused`. `pause_plan_mode` preserves plan mode as the persisted `plan_paused` session mode and returns `{ enabled: false, paused: true, ... }`; `resume_plan_mode` restores the active plan runtime. Approval may replace the proposal with `editedContent`. `execute` starts a new execution session, `keep-context` executes in the current context, and `compact-context` compacts the current context before execution. `executionModel` and `thinkingLevel` select the execution turn. A collaboration guest cannot use `strategy: "execute"` until it calls `leave_collab_session`; the proposal remains pending and plan mode remains active.

#### Goal and guided-goal modes

- `{ id?, type: "create_goal", objective: string, tokenBudget?: number }`
- `{ id?, type: "pause_goal" }`
- `{ id?, type: "resume_goal" }`
- `{ id?, type: "switch_goal", objective: string, tokenBudget?: number }`
- `{ id?, type: "clear_goal" }`
- `{ id?, type: "set_goal_budget", tokenBudget: number | null }`
- `{ id?, type: "get_goal_state" }`
- `{ id?, type: "begin_guided_goal", initialObjective?: string }` → `{ queued: boolean }`

Goal mode is autonomous. Creating a goal while idle immediately starts its first agent turn; after each completed turn the RPC goal scheduler can submit the next continuation while the goal remains active. A streaming session receives goal context as steering instead. `begin_guided_goal` mirrors the TUI command: it validates preconditions, exposes the `goal` tool, and injects a synthetic kickoff prompt. `queued: true` means that kickoff is a follow-up behind an active turn; `false` means direct submission. The guided interview is normal conversation: clients send answers with `prompt`, and the agent completes it with `goal create`.

#### Vibe and aggregate state

- `{ id?, type: "enter_vibe_mode" }`
- `{ id?, type: "exit_vibe_mode" }`
- `{ id?, type: "get_vibe_mode_state" }`
- `{ id?, type: "get_work_mode_state" }`

Vibe snapshots expose active/ephemeral tools and worker state. `get_work_mode_state` returns the active mode plus plan, goal, and vibe snapshots.

### Runtime control

- `{ id?, type: "enable_loop", prompt: string, action?: "prompt" | "compact" | "reset", count?: number, durationMs?: number }`
- `{ id?, type: "disable_loop" }`
- `{ id?, type: "get_loop_state" }`
- `{ id?, type: "cancel_loop_iteration" }`
- `{ id?, type: "pause_agents" }`
- `{ id?, type: "resume_agents" }`
- `{ id?, type: "get_pause_state" }`
- `{ id?, type: "get_session_tree" }`

Loop state reports `enabled`, `state`, `action`, `prompt`, and an optional iteration or duration limit. `cancel_loop_iteration` pauses future repeats and aborts only the active loop turn. `action: "reset"` starts a new session and is rejected for collaboration guests before the loop is enabled; call `leave_collab_session` first. Other loop actions are unchanged. Pause commands operate on the process-wide agent pause gate.

`get_session_tree` returns `{ leafId, tree }`. Every node's `id` is a valid `navigate_tree.targetId`; clients MUST use these ids rather than deriving targets from messages or labels.

### Subagent control

- `{ id?, type: "get_controllable_agents" }`
- `{ id?, type: "revive_agent", agentId: string }`
- `{ id?, type: "kill_agent", agentId: string }`
- `{ id?, type: "prompt_agent", agentId: string, text: string }`
- `{ id?, type: "spawn_background_agent", work: string }`

`get_controllable_agents` reads the shared Agent Hub registry and includes persisted subagents discovered after a process restart. It returns live and parked status plus session-file identity. `revive_agent`, `kill_agent`, and `prompt_agent` target one registered agent; `spawn_background_agent` dispatches the canonical `/tan` workflow.

### Authoring

#### Advisor and TTSR rules

- `{ id?, type: "get_advisor_config", scope: "project" | "user" }`
- `{ id?, type: "set_advisor_config", scope: "project" | "user", instructions: string | null, advisors: RpcAdvisorConfig[] }`
- `{ id?, type: "generate_ttsr_rule", complaint: string, feedback?: string, previousRule?: string }`
- `{ id?, type: "build_ttsr_rule", name: string, description: string, conditions: string[], scopes: string[], body: string }`
- `{ id?, type: "register_ttsr_rule", scope: "project" | "user", name: string, description: string, conditions: string[], scopes: string[], body: string, overwrite: boolean }`
- `{ id?, type: "get_ttsr_rules" }`
- `{ id?, type: "remove_ttsr_rule", name: string, deletePersisted: boolean }`

Advisor writes update the live merged roster. `build_ttsr_rule` provides manual canonical validation; `generate_ttsr_rule` is the model-backed `/omfg` flow and emits `ttsr_generation_event` deltas. Supplying both `feedback` and `previousRule` requests an amendment. Registration persists and installs a rule in the live TTSR manager; removal can optionally delete its persisted authoring file.

#### Agent definitions

- `{ id?, type: "get_agent_definitions" }`
- `{ id?, type: "get_agent_definition", name: string, scope: ("project" | "user") | null }`
- `{ id?, type: "set_agent_definition", scope: "project" | "user", name: string, content: string, overwrite: boolean }`
- `{ id?, type: "delete_agent_definition", scope: "project" | "user", name: string }`

Passing `scope: null` reads the effective definition. Only project/user definitions are writable or deletable; bundled and extension-owned definitions remain read-only.

#### Hindsight mental models

- `{ id?, type: "get_mental_models", detail: MentalModelDetail }`
- `{ id?, type: "get_mental_model", mentalModelId: string, detail: MentalModelDetail }`
- `{ id?, type: "create_mental_model", name: string, sourceQuery: string, mentalModelId: string | null, tags: string[] | null, maxTokens: number | null, mode: MentalModelMode | null, refreshAfterConsolidation: boolean | null }`
- `{ id?, type: "refresh_mental_model", mentalModelId: string }`
- `{ id?, type: "refresh_auto_mental_models" }`
- `{ id?, type: "get_mental_model_history", mentalModelId: string }`
- `{ id?, type: "seed_mental_models" }`
- `{ id?, type: "delete_mental_model", mentalModelId: string }`
- `{ id?, type: "reload_mental_models" }`

These commands operate on the active Hindsight bank. Bulk refresh and seeding results include successful/queued ids and per-id failures; clients MUST inspect those arrays rather than treating a successful command response as proof that every item succeeded.

### Presentation

- `{ id?, type: "get_theme" }`
- `{ id?, type: "get_keybindings" }`
- `{ id?, type: "get_session_view" }`

`get_theme` returns every resolved semantic color and symbol. `get_keybindings` returns `{ keybindings }` entries with action, keys, display text, and optional description. `get_session_view` reports session presentation inputs not already in `get_state`.

### Model and thinking

- `{ id?, type: "set_model", provider: string, modelId: string }`
- `{ id?, type: "set_model_temporary", provider: string, modelId: string, thinkingLevel?: ConfiguredThinkingLevel, ephemeral?: boolean }`
- `{ id?, type: "cycle_model", direction?: "forward" | "backward" }`
- `{ id?, type: "cycle_role_models", roleOrder: string[], direction?: "forward" | "backward" }`
- `{ id?, type: "get_available_models" }`
- `{ id?, type: "get_model_roles" }`
- `{ id?, type: "set_model_role", role: string, model: string, scope: "global" | "project" }`
- `{ id?, type: "clear_model_role", role: string, scope: "global" | "project" }`
- `{ id?, type: "set_thinking_level", level: ThinkingLevel }`
- `{ id?, type: "cycle_thinking_level" }`

`get_model_roles` returns effective role assignments with the supplying layer as `provenance: "runtime" | "overlay" | "project" | "global" | "default"`. Set and clear operations persist one role in the requested global or project layer and return the updated snapshot.

### Queue, compaction, and retry

- `{ id?, type: "set_steering_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_follow_up_mode", mode: "all" | "one-at-a-time" }`
- `{ id?, type: "set_interrupt_mode", mode: "immediate" | "wait" }`
- `{ id?, type: "get_queued_messages" }`
- `{ id?, type: "pop_queued_message" }`
- `{ id?, type: "clear_queue" }`
- `{ id?, type: "compact", customInstructions?: string }`
- `{ id?, type: "set_auto_compaction", enabled: boolean }`
- `{ id?, type: "retry" }`
- `{ id?, type: "set_auto_retry", enabled: boolean }`
- `{ id?, type: "abort_retry" }`

`get_queued_messages` returns the steering and follow-up queues. `pop_queued_message` removes the next restorable message, and `clear_queue` returns the queues after clearing them.

### Shell and Python

- `{ id?, type: "bash", command: string, excludeFromContext?: boolean, useUserShell?: boolean, followCwd?: boolean }`
- `{ id?, type: "abort_bash" }`
- `{ id?, type: "python", code: string, excludeFromContext?: boolean }`
- `{ id?, type: "abort_python" }`

`excludeFromContext` prevents the execution result from entering session context. `bash` uses configured user-shell routing by default; set `useUserShell: false` to disable it. With `followCwd: true`, a successful, non-cancelled command whose `BashResult.workingDir` is absolute reconciles the session cwd to that directory; the default is `false`.

### Session

- `{ id?, type: "get_session_stats" }`
- `{ id?, type: "export_html", outputPath?: string }`
- `{ id?, type: "switch_session", sessionPath: string }`
- `{ id?, type: "get_sessions", scope?: "cwd" | "all", cwd?: string, query?: string, limit?: number }`
- `{ id?, type: "delete_session", sessionPath: string }`
- `{ id?, type: "get_prompt_history", cwd?: string, query?: string, limit?: number }`
- `{ id?, type: "branch", entryId: string }`
- `{ id?, type: "fork" }`
- `{ id?, type: "navigate_tree", targetId: string, summarize?: boolean, customInstructions?: string, allowAskReopen?: boolean, reanswerAskResult?: AgentToolResult<AskToolDetails> }`
- `{ id?, type: "resume_after_ask_reanswer" }`
- `{ id?, type: "get_branch_messages" }`
- `{ id?, type: "get_last_assistant_text" }`
- `{ id?, type: "set_session_name", name: string }`
- `{ id?, type: "generate_title", text: string }`
- `{ id?, type: "handoff", customInstructions?: string }`

`switch_session.sessionPath` accepts an absolute path, a session-id prefix, a session filename prefix, or a partial title. Id and filename-prefix resolution checks the current workspace and then the global session list; if neither matches, partial-title resolution follows the same local-then-global order. No match returns `code: "unknown_session"`. Switching across projects reconciles the live cwd and its cwd-dependent runtime state to the destination session.

`new_session`, `switch_session`, `branch`, and `fork` reconcile work modes around the change. The outgoing session's transient runtime is released without persisting anything — plan and goal give their pre-mode tools and model back, and vibe workers are suspended rather than killed — so the destination hydrates from a clean base and a mode-less target inherits no mode tooling. A change reported as `cancelled: true`, or one that fails before commit, leaves the still-current session operational with its recorded mode, tools, model, hosted collaboration relay, voice capture, and process-local vibe workers intact; hosting, voice, and suspended workers are released only once the change commits. These four commands and deletion of the active session fail with `code: "operation_failed"` while joined as a collaboration guest; call `leave_collab_session` first.

When `switch_session` resolves to the active session file, path identity uses the runtime's platform-aware canonical comparison (including Windows casing and separators). This is a reload, not a destructive switch: RPC rolls the reversible work-mode suspension back, preserves process-local vibe workers and the RPC subagent registry, and keeps session-owned attachments. Switching to a different logical file remains destructive.

A transition that aborts the outgoing provider turn and then fails before commit does not resurrect that cancelled turn. It reconnects the restored session and automatically consumes its restored steering, follow-up, or deferred hidden queue so the session returns to normal operation without a manual prompt.

`get_sessions` defaults to the current cwd and a limit of 100, supports case-insensitive full-text substring filtering, and caps the limit at 1,000. `cwd` selects another workspace when `scope` is not `"all"`. Results are sorted by newest modification time and omit `allMessagesText`.

Deleting the active session uses the canonical drop/new-session path so the live session never points at a deleted file; it may return `code: "cancelled"` if that transition is cancelled. A non-active path not owned by the session index returns `code: "unknown_session"`.

`navigate_tree` returns navigation state including optional ask-reopen/reanswer fields. After a committed historical ask reanswer, send `resume_after_ask_reanswer` once the host has rebuilt its transcript. `generate_title` performs the explicit model call, applies the result to the active session, emits `session_info_update` when applied, and returns `{ title, applied }`. `set_session_name` applies a client-provided title without a model call. Ordinary `prompt` commands never generate or change titles.

Prompt-history search defaults to the session cwd and a limit of 100, clamped to 1–1,000. Entries contain `text`, optional `cwd`, optional `sessionId`, and optional ISO-8601 `at`.

### Messages

- `{ id?, type: "get_messages" }`
- `{ id?, type: "get_messages_page", cursor?: string, limit?: number }`

`get_messages_page` returns a stable chronological page with `messages`, `totalMessages`, and an opaque `nextCursor`. Cursors are bound to the session id, durable leaf, and message count. `session_busy` and `stale_cursor` are machine-readable failure codes. Pages contain at most 256 messages. The bundled clients drain pages automatically and fall back to the legacy `get_messages` snapshot when a page walk becomes busy or stale.

### Login

- `{ id?, type: "get_login_providers" }`
- `{ id?, type: "login", providerId: string }`
- `{ id?, type: "logout", providerId: string, credentialId: number }`
- `{ id?, type: "remove_login_account", providerId: string, credentialId: number }`
- `{ id?, type: "remove_provider_credentials", providerId: string }`

Login flows use `extension_ui_request` for `input` and `open_url`; a provider may request manual input before it produces a URL. The host answers input requests with `extension_ui_response`. `get_login_providers` exposes each account's positive `credentialId`. `logout` and `remove_login_account` remove exactly that account and preserve siblings. `logout` without a valid `credentialId` fails with `code: "credential_id_required"`; this is a breaking change for clients that previously used provider-wide logout. The explicitly destructive `remove_provider_credentials` command removes every stored credential for the provider.

### MCP administration

- `{ id?, type: "mcp_add_server", name: string, config: MCPServerConfig, scope: MCPAddScope }`
- `{ id?, type: "mcp_remove_server", name: string, scope: MCPAddScope }`
- `{ id?, type: "mcp_set_server_enabled", name: string, enabled: boolean }`
- `{ id?, type: "mcp_reload" }`
- `{ id?, type: "mcp_reconnect_server", name: string }`
- `{ id?, type: "mcp_unauth_server", name: string }`
- `{ id?, type: "mcp_begin_reauth", name: string }`
- `{ id?, type: "mcp_complete_reauth", flowId: string, completion?: string }`
- `{ id?, type: "mcp_cancel_reauth", flowId: string }`
- `{ id?, type: "mcp_begin_smithery_login" }`
- `{ id?, type: "mcp_complete_smithery_login", sessionId: string, apiKey?: string }`
- `{ id?, type: "mcp_logout_smithery" }`
- `{ id?, type: "mcp_search_registry", query: string, limit?: number, semantic?: boolean }`
- `{ id?, type: "mcp_deploy_registry_result", result: SmitherySearchResult, scope: MCPAddScope, name?: string, values: Record<string, string> }`

These commands mutate both persisted MCP configuration and the live manager where applicable. Reload performs complete live rediscovery and tool refresh; reconnect and unauth replace one server's live tools. Reauthentication is a proactive begin/complete/cancel flow that returns authorization data instead of opening a browser. Smithery commands cover login, logout, registry search, and deployment of a selected result.

### Diagnostics

- `{ id?, type: "start_cpu_profile" }`
- `{ id?, type: "stop_cpu_profile" }`
- `{ id?, type: "create_heap_profile" }`
- `{ id?, type: "create_support_bundle" }`
- `{ id?, type: "create_work_profile" }`
- `{ id?, type: "get_recent_logs", maxLines?: number, olderDays?: number }`
- `{ id?, type: "get_raw_sse" }`
- `{ id?, type: "subscribe_raw_sse" }`
- `{ id?, type: "unsubscribe_raw_sse" }`
- `{ id?, type: "start_inspector" }`
- `{ id?, type: "get_system_info" }`
- `{ id?, type: "get_startup_warnings" }`
- `{ id?, type: "get_artifacts_directory" }`
- `{ id?, type: "clear_artifact_cache", daysOld?: number }`
- `{ id?, type: "get_mcp_auth_challenges" }`
- `{ id?, type: "resolve_mcp_auth_challenge", challengeId: string, config?: MCPServerConfig }`

Profile, support-bundle, artifacts-directory, and work-profile responses expose their artifact `path`; the inspector returns `{ host, port }`. `get_raw_sse` is a one-shot snapshot, while subscription commands control `raw_sse_update` forwarding. An MCP authentication challenge blocks its tool call until `resolve_mcp_auth_challenge`; omitting `config` deliberately rejects the call.

### Voice

- `{ id?, type: "start_live", voice?: string }`
- `{ id?, type: "stop_live" }`
- `{ id?, type: "get_live_status" }`
- `{ id?, type: "toggle_live_mute" }`
- `{ id?, type: "start_stt" }`
- `{ id?, type: "stop_stt" }`
- `{ id?, type: "toggle_stt" }`
- `{ id?, type: "get_stt_status" }`
- `{ id?, type: "speak_text", text: string }`
- `{ id?, type: "clear_speech" }`
- `{ id?, type: "duck_speech" }`
- `{ id?, type: "unduck_speech" }`
- `{ id?, type: "get_speech_status" }`
- `{ id?, type: "set_speech_settings", enabled?: boolean, mode?: "all" | "assistant" | "yield" }`

Realtime `/live` and harness-side microphone STT emit `voice_event` frames. Speech commands control harness audio playback; automatic assistant vocalization follows the persisted speech settings and the same streamed session events used by the TUI.

### Collaboration

- `{ id?, type: "start_collab_hosting", relayUrl?: string }`
- `{ id?, type: "stop_collab_hosting" }`
- `{ id?, type: "get_collab_status" }`
- `{ id?, type: "join_collab_session", link: string }`
- `{ id?, type: "leave_collab_session" }`

After `join_collab_session` makes the RPC session a guest, `prompt`, `steer`, `follow_up`, `abort`, and `abort_and_prompt` are routed to the authoritative host instead of mutating the local replica. Normal prompt, steer, and follow-up share the collab protocol's host-side steer path. Session-changing entrypoints (`new_session`, `switch_session`, `branch`, `fork`, `branch_btw`, active-session deletion, plan approval with `strategy: "execute"`, and loops with `action: "reset"`) fail with `code: "operation_failed"` and instruct the client to call `leave_collab_session`; deleting a non-active session remains allowed. A guest-routing failure uses `code: "not_guest"`, `"read_only"`, or `"link_unavailable"` so clients need not match error text. Remote host dialog requests reuse `extension_ui_request`.

## Response Schema

All command results use `RpcResponse`:

- Success: `{ id?, type: "response", command: <command>, success: true, data?: ... }`
- Failure: `{ id?, type: "response", command: string, success: false, error: string, code?: string }`

Data payloads are command-specific and defined in `rpc-types.ts`.

### `prompt` payload

`prompt` is acknowledged after the command is accepted, not after a model turn finishes:

```json
{
  "id": "req_1",
  "type": "response",
  "command": "prompt",
  "success": true,
  "data": { "agentInvoked": false }
}
```

`data.agentInvoked: false` is an immediate outcome for local-only prompts, including slash commands that produce output without starting an agent turn. `data.agentInvoked: true` means the agent-facing input path handled the prompt; it does not guarantee a new `agent_start`. Older runtimes may omit `data`; current runtimes always follow with one correlated `prompt_result` when the outcome is known.

`prompt_result` carries that terminal prompt outcome for both values:

```json
[
  { "type": "prompt_result", "id": "req_1", "agentInvoked": false },
  { "type": "prompt_result", "id": "req_2", "agentInvoked": true }
]
```

Local-only slash commands may emit `command_output` frames before their `prompt_result`. They do not emit `agent_end`. A `true` result likewise does not identify a new lifecycle: a steer can join an active run, and an accepted collaboration-guest relay is processed by the authoritative host. Track `agent_start`/`agent_end` separately when the host must wait for a run.

### `get_state` payload

```json
{
  "model": { "provider": "...", "id": "..." },
  "thinkingLevel": "off|minimal|low|medium|high|xhigh|max",
  "isStreaming": false,
  "isCompacting": false,
  "isRetrying": false,
  "isBashRunning": false,
  "isAborting": false,
  "isGeneratingHandoff": false,
  "steeringMode": "all|one-at-a-time",
  "followUpMode": "all|one-at-a-time",
  "interruptMode": "immediate|wait",
  "sessionFile": "...",
  "sessionId": "...",
  "sessionName": "...",
  "autoCompactionEnabled": true,
  "messageCount": 0,
  "queuedMessageCount": 0,
  "todoPhases": [
    {
      "id": "phase-1",
      "name": "Todos",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the tool surface",
          "status": "in_progress"
        }
      ]
    }
  ],
  "systemPrompt": ["..."],
  "dumpTools": [
    {
      "name": "read",
      "description": "Read files and URLs",
      "parameters": {}
    }
  ],
  "contextUsage": {
    "tokens": 1100,
    "contextWindow": 200000,
    "percent": 0.55
  },
  "configWarnings": [],
  "skillWarnings": [
    { "skillPath": "C:\\agent\\skills\\example\\SKILL.md", "message": "..." }
  ]
}
```

`model`, `thinkingLevel`, `sessionFile`, `sessionName`, `systemPrompt`, `dumpTools`, and `contextUsage` are optional. The activity flags are live snapshots; clients should refresh state after transitions instead of deriving them from command acknowledgements alone.

### `get_theme` payload

The maps below are deliberately truncated to representative entries; the real response contains every semantic color token and every symbol key. Color values are hex strings or `null` when the theme defers to the terminal default.

```json
{
  "name": "titanium",
  "isLight": false,
  "colorMode": "truecolor",
  "symbolPreset": "unicode",
  "colorBlindMode": false,
  "colors": {
    "accent": "#7aa2f7",
    "border": null,
    "text": "#c0caf5"
  },
  "symbols": {
    "status.success": "✔",
    "nav.cursor": "❯",
    "icon.model": "⬢"
  },
  "statusLineLuminance": 0.08,
  "accentSurfaceLuminance": 0.24
}
```

### `get_repo_status` payload

```json
{
  "cwd": "C:\\work\\project",
  "vcs": "git",
  "root": "C:\\work\\project",
  "branch": "feature/rpc-ui",
  "detached": false,
  "staged": 1,
  "unstaged": 2,
  "untracked": 3,
  "pr": {
    "number": 123,
    "url": "https://github.com/owner/repo/pull/123"
  }
}
```

Outside a repository, `vcs`, `root`, `branch`, and `pr` are `null`, the counts are zero, and `detached` is `false`. A detached Git checkout has `vcs: "git"`, `branch: null`, and `detached: true`; Jujutsu reports `vcs: "jj"`.

### `get_session_view` payload

```json
{
  "mode": "plan",
  "activeModes": ["plan", "goal"],
  "autoThinking": true,
  "resolvedThinkingLevel": "high",
  "fastMode": false,
  "advisorEnabled": true,
  "advisors": [
    { "name": "security", "status": "running" }
  ],
  "usingSubscription": true,
  "cwd": "C:\\work\\project",
  "projectDir": "C:\\work\\project",
  "activeRepo": {
    "cwd": "C:\\work\\project",
    "relativeRepoRoot": "."
  },
  "worktree": null
}
```

`mode` is the highest-priority active session mode (`plan`, `prewalk`, `goal`, or `vibe`) and may be `null`; `activeModes` contains all active session-owned modes in that precedence order. `resolvedThinkingLevel`, `projectDir`, `activeRepo`, and `worktree` may also be `null`. Advisor status is one of `running`, `paused`, `quota_exhausted`, `error`, or `no_model`.

### `complete` payload

```json
{
  "items": [
    {
      "value": "/model",
      "label": "/model",
      "description": "Select a model"
    }
  ],
  "prefix": "  /mod"
}
```

Each item has `value`, `label`, and optional `description` and `kind`. After choosing an item, send it back with the original `lines` and `cursor` to `apply_completion`; the applied payload is the replacement editor state:

```json
{
  "lines": ["  /model "],
  "cursor": { "line": 0, "column": 9 }
}
```

### `get_settings` payload

`get_settings` returns tab metadata and one descriptor for every schema path. `value` and `default` are always present, using `null` for undefined values and defaults; credential values are also redacted to `null` while `configured` still reports whether a value exists.

```json
{
  "tabs": [
    {
      "id": "appearance",
      "label": "Appearance",
      "icon": "tab.appearance",
      "groups": ["Theme", "Status Line", "Display", "Images"]
    }
  ],
  "settings": [
    {
      "path": "retry.enabled",
      "type": "boolean",
      "value": true,
      "default": true,
      "configured": false,
      "secret": false,
      "nullable": false
    },
    {
      "path": "computer.backend",
      "type": "enum",
      "value": "auto",
      "default": "auto",
      "configured": false,
      "secret": false,
      "nullable": false,
      "values": ["auto", "native"],
      "ui": {
        "tab": "tools",
        "group": "Computer",
        "label": "Computer Backend",
        "description": "Select automatic or explicit platform-native desktop capture and input",
        "options": [
          { "value": "auto", "label": "Auto" },
          { "value": "native", "label": "Native" }
        ]
      }
    },
    {
      "path": "auth.broker.token",
      "type": "string",
      "value": null,
      "default": null,
      "configured": true,
      "secret": true,
      "nullable": true
    },
    {
      "path": "theme.dark",
      "type": "string",
      "value": "titanium",
      "default": "titanium",
      "configured": false,
      "secret": false,
      "nullable": false,
      "ui": {
        "tab": "appearance",
        "group": "Theme",
        "label": "Dark Theme",
        "description": "Theme used when the terminal has a dark background",
        "options": [{ "value": "titanium", "label": "titanium" }]
      }
    },
    {
      "path": "shellMinimizer.legacyFilters",
      "type": "boolean",
      "value": null,
      "default": null,
      "configured": false,
      "secret": false,
      "nullable": true
    }
  ]
}
```

`set_setting` returns `{ path, value, configured }`; credential values are redacted to `null`. Validation failures use `unknown_setting` or `invalid_value`, and a persisted setting whose runtime effect fails uses `effect_failed`.

### `get_sessions` payload

`total` is the filtered count before `limit`; entries omit the full-text-only `allMessagesText` field.

```json
{
  "sessions": [
    {
      "path": "C:\\sessions\\2026-07-27.jsonl",
      "id": "session_123",
      "cwd": "C:\\work\\project",
      "title": "RPC parity",
      "parentSessionPath": "C:\\sessions\\parent.jsonl",
      "created": "2026-07-27T10:00:00.000Z",
      "modified": "2026-07-27T10:30:00.000Z",
      "messageCount": 12,
      "size": 18432,
      "firstMessage": "Document the RPC protocol",
      "status": "completed"
    }
  ],
  "total": 1
}
```

### `set_todos` payload

Replaces the in-memory todo state for the current session and returns the normalized phase list:

```json
{
  "id": "req_2",
  "type": "set_todos",
  "phases": [
    {
      "id": "phase-1",
      "name": "Evaluation",
      "tasks": [
        {
          "id": "task-1",
          "content": "Map the read tool surface",
          "status": "in_progress"
        },
        {
          "id": "task-2",
          "content": "Exercise edit operations",
          "status": "pending"
        }
      ]
    }
  ]
}
```

This is useful for hosts that want to pre-seed a plan before the first prompt.

### `set_host_tools` payload

Replaces the current set of host-owned tools that the RPC server may call back
into over stdio:

```json
{
  "id": "req_3",
  "type": "set_host_tools",
  "tools": [
    {
      "name": "echo_host",
      "label": "Echo Host",
      "description": "Echo a value from the embedding host",
      "parameters": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      }
    }
  ]
}
```

The response payload is:

```json
{
  "toolNames": ["echo_host"]
}
```

These tools are added to the active session tool registry before the next model
call. Re-sending `set_host_tools` replaces the previous host-owned set.

### `set_host_uri_schemes` payload

Replaces the current set of host-owned URL schemes the RPC server should
dispatch reads/writes through:

```json
{
  "id": "req_4",
  "type": "set_host_uri_schemes",
  "schemes": [
    {
      "scheme": "db",
      "description": "Virtual db row files",
      "writable": true,
      "immutable": false
    }
  ]
}
```

The response payload is:

```json
{
  "schemes": ["db"]
}
```

Schemes are case-insensitive on the wire and normalized to lowercase before
the response is sent. Re-sending `set_host_uri_schemes` replaces the entire
previous set — schemes missing from the new list are unregistered.

## UI Reconstruction

### Rebuilding a UI

RPC reports the source data, not every formatted status-line value:

- `get_session_stats` supplies session token counters (`input`, `output`, `reasoning`, `cacheRead`, `cacheWrite`, and `total`), cost, and context usage. A cache-hit percentage is derived from those counters as `cacheRead / (cacheRead + cacheWrite + input)`; it is not a separate wire field.
- Compute token rate from `message_update` usage and timing, and elapsed time from `agent_start`/`agent_end`.
- The TUI's `token_total` includes orchestration input/output in addition to input, output, and cache writes. Those orchestration counters are not exposed by RPC, so an exact orchestration-inclusive total requires the client to track or supply them itself; otherwise display `get_session_stats.tokens.total` as the wire-visible total.
- `hostname` and wall-clock time are inherently local to the client.

`get_session_view` reports modes owned by the session: plan, prewalk, goal, and vibe. Loop state and limits are exposed separately by `get_loop_state`; process-wide pause state comes from `get_pause_state`. Plan snapshots expose the persisted `plan_paused` marker through `paused`; its precise semantics are described under Known non-parity.

Prompt text sent through `prompt` has `@file` mentions resolved and expanded server-side, so clients MUST NOT duplicate path resolution. The startup restriction on `@file` applies only to CLI arguments. Send images as `ImageContent[]` in the prompt payload.

To add client-owned tools, use `set_host_tools` and serve `host_tool_call` / `host_tool_update` / `host_tool_result` as described in [Host Tool Sub-Protocol](#host-tool-sub-protocol). To expose virtual files, register schemes with `set_host_uri_schemes` and implement the frames in [Host URI Sub-Protocol](#host-uri-sub-protocol).

## Event Stream Schema

RPC mode forwards `AgentSessionEvent` objects from `AgentSession.subscribe(...)`.

Common event types:

- `agent_start`, `agent_end`
- `turn_start`, `turn_end`
- `message_start`, `message_update`, `message_end`
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`
- `auto_compaction_start`, `auto_compaction_end`
- `auto_retry_start`, `auto_retry_end`
- `ttsr_triggered`
- `todo_reminder`
- `todo_auto_clear`

- `context_message_added`
Extension runner errors are emitted separately as:

```json
{
  "type": "extension_error",
  "extensionPath": "...",
  "event": "...",
  "error": "..."
}
```

`message_update` includes streaming deltas in `assistantMessageEvent` (text/thinking/toolcall deltas).

`context_message_added` is not interchangeable with `message_start`/`message_end`: it reports model-visible injected context that may never appear in normal message history. See the frame contract above and honor `display` when reconstructing the transcript.

## Prompt/Queue Concurrency and Ordering

This is the most important operational behavior.

### Immediate ack vs completion

`prompt` and `abort_and_prompt` are **acknowledged immediately**:

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
```

That means:

- command acceptance != prompt outcome or run completion
- each prompt outcome arrives in the same-id `prompt_result`
- `prompt_result.agentInvoked: true` means handled input, not necessarily a new lifecycle
- local agent runs are tracked independently through `agent_start` and `agent_end`
- `agent_end.isTerminal: false` marks an intermediate settle whose continuation is already scheduled; only an absent/true `isTerminal` completes the logical run
- `RpcClient.waitForIdle()` returns immediately when no run is active or reserved, and otherwise spans queued follow-up gaps and non-terminal settles
- `RpcClient.promptAndWait()` observes the correlated `prompt_result`; local-only prompts return with events observed through acknowledgement, while agent-invoking prompts wait for their own reservation rather than any earlier `agent_end`

### While streaming

`AgentSession.prompt()` requires `streamingBehavior` during active streaming:

- `"steer"` => queued steering message (interrupt path)
- `"followUp"` => queued follow-up message (post-turn path)

If omitted during streaming, prompt fails. The TypeScript helpers accept the same value as the final optional argument to `prompt()`, `promptWithResult()`, and `promptAndWait()`; using `"followUp"` lets the correlated waiter span the active-run/queued-run gap.

### Background vs ordered dispatch

Most commands are processed in stdin order through one serialized queue. Operations that await cancellable or otherwise long-running work are dispatched in the background so their canceller or control command can overtake them:

- `bash`
- `python`
- `ask_btw`
- `compact`
- `retry`
- `handoff`
- `approve_plan_proposal`
- `reject_plan_proposal`
- `begin_guided_goal`
- `prompt_agent`
- `generate_ttsr_rule`
- `start_live`
- `start_stt`
- `toggle_stt`
- `start_collab_hosting`
- `join_collab_session`
- `mcp_add_server`
- `mcp_set_server_enabled`
- `mcp_reload`
- `mcp_reconnect_server`
- `mcp_unauth_server`
- `mcp_begin_reauth`
- `mcp_complete_reauth`
- `mcp_begin_smithery_login`
- `mcp_complete_smithery_login`
- `mcp_search_registry`
- `mcp_deploy_registry_result`

Responses from those commands can interleave with later ordered responses; clients MUST correlate by `id`. This lets `abort`, `abort_retry`, `cancel_btw`, `abort_bash`, `abort_python`, and `kill_agent` run while their target operation is pending, and lets voice, STT, collaboration, and MCP control commands overtake the corresponding network startup. `extension_ui_response`, host-tool updates/results, and host-URI results bypass the ordered queue as control frames.

### Queue defaults

From `packages/agent/src/agent.ts` defaults:

- `steeringMode`: `"one-at-a-time"`
- `followUpMode`: `"one-at-a-time"`
- `interruptMode`: `"immediate"`

### Mode semantics

- `set_steering_mode` / `set_follow_up_mode`
  - `"one-at-a-time"`: dequeue one queued message per turn
  - `"all"`: dequeue entire queue at once
- `set_interrupt_mode`
  - `"immediate"`: tool execution checks steering between tool calls; pending steering can abort remaining tool calls in the turn
  - `"wait"`: defer steering until turn completion

## Extension UI Sub-Protocol

Extensions in RPC mode use request/response UI frames.

### Known non-parity

- `plan_paused` is a persisted session-mode marker, not a live plan proposal. While paused, snapshots report `enabled: false` and `paused: true`, and `get_work_mode_state.activeMode` is not `"plan"`. The marker survives session switches; clients MUST test `plan.paused` rather than infer pause from `enabled` or `activeMode`.
- Vibe workers owned by the source session are not preserved when switching sessions. The destination session rehydrates its own vibe registry instead.
- Renderer-component members of `ExtensionUIContext` remain terminal-only: `onTerminalInput`, `setFooter`, `setHeader`, `custom`, `getToolsExpanded`/`setToolsExpanded`, and `setEditorComponent`. RPC also ignores the component-factory form of `setWidget`; string-array widgets are supported. These APIs require terminal renderer instances or renderer-owned state. `setWorkingMessage` is supported and emits an extension UI request.
- `registerShortcut` is terminal-only: it binds a key chord directly to a callback rather than registering a named capability. Extensions that need the same substantive action in a headless host use `registerCommand`; the third-party UI chooses its own keybinding. `get_keybindings` remains a read-only view of the effective terminal action map and display strings.

`getEditorText`, extension autocomplete providers, loop control, loop limits, theme access, and working-message updates are not on this list: they have RPC implementations described above, subject to the editor-cache contract.

### Outbound request

`RpcExtensionUIRequest` (`type: "extension_ui_request"`) methods:

- `select`, `confirm`, `input`, `askDialog`, `editor`
- `notify`, `setStatus`, `setWorkingMessage`, `setWidget`, `setTitle`, `set_editor_text`
- `open_url` (emitted by RPC login flows)

Session titles are client-controlled through `set_session_name` and `generate_title`; `prompt` does not generate one implicitly. An applied `generate_title` emits `session_info_update`. Extension `setTitle` UI requests are suppressed by default because many hosts have no terminal-title surface; set `PI_RPC_EMIT_TITLE=1` to emit those requests.

Example:

```json
{
  "type": "extension_ui_request",
  "id": "123",
  "method": "confirm",
  "title": "Confirm",
  "message": "Continue?",
  "timeout": 30000
}
```

### Outbound cancellation

When the server aborts or times out a pending dialog, it emits `{ type: "extension_ui_cancel", targetId: string, timedOut?: boolean }`. The host MUST close the matching `extension_ui_request` surface immediately; a later response for that abandoned request is no longer useful.

### Inbound response

`RpcExtensionUIResponse` (`type: "extension_ui_response"`):

- `{ type: "extension_ui_response", id: string, value: string }`
- `{ type: "extension_ui_response", id: string, confirmed: boolean }`
- `{ type: "extension_ui_response", id: string, result: ExtensionAskDialogResult }`
- `{ type: "extension_ui_response", id: string, cancelled: true, timedOut?: boolean }`

If a dialog has a timeout, RPC mode resolves to a default value when timeout/abort fires.

## Host Tool Sub-Protocol

RPC hosts can expose custom tools to the agent by sending `set_host_tools`, then
serving execution requests over the same transport.

### Outbound request

When the agent wants the host to execute one of those tools, RPC mode emits:

```json
{
  "type": "host_tool_call",
  "id": "host_1",
  "toolCallId": "toolu_123",
  "toolName": "echo_host",
  "arguments": { "message": "hello" }
}
```

If the tool execution is later aborted, RPC mode emits:

```json
{
  "type": "host_tool_cancel",
  "id": "host_cancel_1",
  "targetId": "host_1"
}
```

### Inbound updates and completion

Hosts can optionally stream progress:

```json
{
  "type": "host_tool_update",
  "id": "host_1",
  "partialResult": {
    "content": [{ "type": "text", "text": "working" }]
  }
}
```

Completion uses:

```json
{
  "type": "host_tool_result",
  "id": "host_1",
  "result": {
    "content": [{ "type": "text", "text": "done" }]
  }
}
```

Set top-level `isError: true` on `host_tool_result` to reject the pending host tool call and surface the returned text content as a tool error.

## Host URI Sub-Protocol

RPC hosts can also own custom URL schemes (virtual files). After
`set_host_uri_schemes`, every read of `<scheme>://…` and write of
`<scheme>://…` (when registered as `writable`) is bounced back to the host
over the same transport.

### Outbound request

When a session tool resolves a host-owned URL, RPC mode emits:

```json
{
  "type": "host_uri_request",
  "id": "uri_1",
  "operation": "read",
  "url": "db://users/42"
}
```

Writes look the same with `"operation": "write"` and an additional
`"content": "..."` field carrying the full replacement bytes.

If the request is later aborted (caller cancels, session ends), RPC mode
emits:

```json
{
  "type": "host_uri_cancel",
  "id": "uri_cancel_1",
  "targetId": "uri_1"
}
```

### Inbound result

For successful reads:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "content": "id=42\nname=Alice\n",
  "contentType": "text/plain",
  "notes": ["fresh from cache"],
  "immutable": false
}
```

For successful writes, omit content:

```json
{ "type": "host_uri_result", "id": "uri_1" }
```

To reject the request, set `isError: true` and either populate `error` with
a message or fall back to `content` for textual error surfacing:

```json
{
  "type": "host_uri_result",
  "id": "uri_1",
  "isError": true,
  "error": "row 42 not found"
}
```

### Constraints

- The agent's `edit` tool does not target host URIs. Hosts that want to
  mutate virtual files expose `write` and let the model use the `write` tool
  with replacement content.
- Schemes are global to the process; `set_host_uri_schemes` replaces the
  previous set, unregistering anything not in the new list.
- Schemes are normalized to lowercase before registration.

The TypeScript `RpcClient` makes this sub-protocol usable without raw frame plumbing: call `setHostUriSchemes(...)`, then `registerHostUriHandler(handler)`. The handler receives the `RpcHostUriRequest` and an `AbortSignal`; returning a string or `RpcClientHostUriReadResult` completes a read, returning from a write acknowledges it, and throwing sends an error result. `host_uri_cancel` aborts the signal for the matching request.

## Error Model and Recoverability

### Command-level failures

Failures are `success: false` with string `error`.

```json
{
  "id": "req_2",
  "type": "response",
  "command": "set_model",
  "success": false,
  "error": "Model not found: provider/model"
}
```

### Recoverability expectations

- Most command failures are recoverable; process remains alive.
- Malformed JSONL / parse-loop exceptions emit a `parse` error response and continue reading subsequent lines.
- Empty `set_session_name` is rejected (`Session name cannot be empty`).
- Extension UI responses with unknown `id` are ignored.
- Process termination conditions are stdin close or explicit extension-triggered shutdown after the current command.

## Compact Command Flows

### 1) Prompt and stream

stdin:

```json
{ "id": "req_1", "type": "prompt", "message": "Summarize this repo" }
```

stdout sequence (typical):

```json
{ "id": "req_1", "type": "response", "command": "prompt", "success": true }
{ "type": "agent_start" }
{ "type": "message_update", "assistantMessageEvent": { "type": "text_delta", "delta": "..." }, "message": { "role": "assistant", "content": [] } }
{ "type": "agent_end", "messages": [] }
```

### 2) Prompt during streaming with explicit queue policy

stdin:

```json
{
  "id": "req_2",
  "type": "prompt",
  "message": "Also include risks",
  "streamingBehavior": "followUp"
}
```

### 3) Inspect and tune queue behavior

stdin:

```json
{ "id": "q1", "type": "get_state" }
{ "id": "q2", "type": "set_steering_mode", "mode": "all" }
{ "id": "q3", "type": "set_interrupt_mode", "mode": "wait" }
```

### 4) Extension UI round trip

stdout:

```json
{
  "type": "extension_ui_request",
  "id": "ui_7",
  "method": "input",
  "title": "Branch name",
  "placeholder": "feature/..."
}
```

stdin:

```json
{ "type": "extension_ui_response", "id": "ui_7", "value": "feature/rpc-host" }
```

## Notes on `RpcClient`

`src/modes/rpc/rpc-client.ts` is a convenience wrapper; `rpc-types.ts` remains the protocol definition.

The client spawns `bun <cliPath> --mode rpc`, negotiates protocol v2, correlates responses by generated `req_<n>` ids, exposes `onSessionEvent`/`onEvent` plus the frame-specific listeners named above, and handles registered host-tool calls through `setCustomTools()`. Provider observations require both `subscribeProviderRequestObservations()` and `onProviderRequestObservation()`; extension dialog cancellation uses `onExtensionUiCancel()`.

Typed helpers cover every command group. Host URI support uses `setHostUriSchemes()` plus `registerHostUriHandler()`, which handles request, result, cancellation, and abort signaling internally. Raw stdout handling is required only for `extension_error`, which has no dedicated listener method. For `prompt`, subscribe to both `onPromptResult()` and `onPromptError()` before calling `promptWithResult()` when every terminal outcome is required. For `abort_and_prompt`, `abortAndPromptWithResult()` returns `{ requestId }` and `onPromptError()` publishes a typed same-id `{ command: "abort_and_prompt", success: false, error, code? }` at most once.

`bash()` and `python()` are the exception to the client's 30-second request deadline because server-side execution can legitimately run longer. They wait indefinitely by default; pass `timeoutMs` in the helper options to set a client-side response deadline in milliseconds:

```ts
await client.bash("make release", { timeoutMs: 120_000 });
await client.python("train_model()", { timeoutMs: 120_000 });
```

`timeoutMs` controls only how long the TypeScript client waits. It is not serialized into the RPC command and does not limit server-side execution. Other request helpers keep the 30-second default.
