# omp-rpc

Typed Python bindings for the `omp --mode rpc` protocol used by the coding agent.

This package wraps the newline-delimited JSON RPC transport exposed by the CLI and
provides:

- typed command methods for the stable RPC surface
- typed startup options for common `omp --mode rpc` flags such as thinking level,
  tool selection, prompt appends, provider session IDs, and headless session toggles
- typed protocol models for state, bash results, compaction, and session stats
- automatic protocol v2 negotiation, lossless chunk reassembly, and stable message pagination
- a process-backed client that manages request correlation over stdio
- typed per-event listeners plus a typed catch-all notification hook
- helpers for collecting prompt runs and handling extension UI requests in manual or headless mode
- typed host-tool helpers so Python RPC owners can expose custom tools with JSON Schema metadata

## Basic Usage

```python
from omp_rpc import RpcClient

with RpcClient(provider="anthropic", model="claude-sonnet-4-5") as client:
    state = client.get_state()
    print(state.model.id if state.model else "no model")

    turn = client.prompt_and_wait("Reply with just the word hello")
    print(turn.require_assistant_text())
```

The wrapper also exposes the common RPC startup flags directly, so scripts do not
need to build `extra_args` by hand:

```python
from omp_rpc import RpcClient

with RpcClient(
    model="openrouter/anthropic/claude-sonnet-4.6",
    thinking="high",
    no_session=True,
    no_skills=True,
    no_rules=True,
    tools=("read", "edit", "write"),
    append_system_prompt="Focus on reproducible benchmark behavior.",
) as client:
    print(client.get_state().thinking_level)
```

For orchestration hosts, the wrapper also exposes typed event hooks and a simple
way to seed todos before the first prompt:

```python
from omp_rpc import MessageUpdateEvent, RpcClient

def on_message_update(event: MessageUpdateEvent) -> None:
    assistant_event = event.assistant_message_event
    if assistant_event.get("type") == "text_delta":
        print(assistant_event["delta"], end="", flush=True)

with RpcClient(model="openrouter/anthropic/claude-sonnet-4.6", no_session=True) as client:
    client.on_message_update(on_message_update)
    client.set_todos(
        [
            "Map the read and edit tool surface.",
            "Exercise the supported edit paths.",
            "Write concrete findings and gaps.",
        ]
    )
    client.prompt_and_wait("Evaluate the current tool behavior.")
```

`set_todos()` accepts either a flat list of todo strings/items or explicit
phases, and `get_state().todo_phases` returns the typed current todo state.

By default the client runs:

```bash
omp --mode rpc
```

You can also point it at a custom command, which is useful inside this repo while
developing against the Bun entrypoint:

```python
from omp_rpc import RpcClient

with RpcClient(
    command=[
        "bun",
        "packages/coding-agent/src/cli.ts",
        "--mode",
        "rpc",
        "--provider",
        "anthropic",
        "--model",
        "claude-sonnet-4-5",
    ],
) as client:
    print(client.get_state().session_id)
```

## Host-Owned Custom Tools

RPC hosts can expose custom tools to the agent with JSON Schema metadata. The
Python helper keeps the wire format simple while still giving the handler a
typed signature:

```python
from typing import TypedDict

from omp_rpc import RpcClient, host_tool


class EchoArgs(TypedDict):
    message: str


def echo_host(args: EchoArgs, context) -> str:
    context.send_update(f"working:{args['message']}")
    return f"host:{args['message']}"


with RpcClient(
    no_session=True,
    custom_tools=(
        host_tool(
            name="echo_host",
            description="Echo a value from the Python host",
            parameters={
                "type": "object",
                "properties": {"message": {"type": "string"}},
                "required": ["message"],
                "additionalProperties": False,
            },
            execute=echo_host,
        ),
    ),
) as client:
    client.prompt_and_wait("Use the echo_host tool with the value hello")
```

If you want runtime conversion into a richer Python type, pass `decode=` to
`host_tool(...)`. That lets you keep the JSON Schema contract on the wire while
parsing the incoming argument object into a dataclass or model in the handler.

## Host-Owned URI Schemes

Hosts can also expose custom URL schemes that behave like virtual files.
Registered schemes are routed through the agent's `read` (and `write`) tools
over the same RPC transport — handlers do the actual I/O on the Python side:

```python
from omp_rpc import RpcClient, host_uri

rows: dict[str, str] = {"42": "id=42\nname=Alice\n"}


def read_row(url: str, _ctx) -> str:
	row_id = url.removeprefix("db://users/")
	return rows[row_id]


def write_row(url: str, content: str, _ctx) -> None:
	row_id = url.removeprefix("db://users/")
	rows[row_id] = content


with RpcClient(
	no_session=True,
	host_uris=(
		host_uri(
			scheme="db",
			description="Virtual db row files",
			read=read_row,
			write=write_row,
		),
	),
) as client:
	client.prompt_and_wait("Read db://users/42 and rewrite it with name=Bob")
```

Schemes registered as read-only (no `write=`) reject `write` calls with a
clear error. The agent's `edit` tool does not target host URIs — hosts that
want mutation expose `write` and the model uses the `write` tool with the
full replacement content.

## Extension UI Requests

Extensions in RPC mode can ask the host for input. Those requests are available as
typed `ExtensionUiRequest` instances. Rich `askDialog` questions and options are
immutable dataclasses, so a host can inspect them before responding:

```python
from omp_rpc import ExtensionAskDialogResultItem, ExtensionAskDialogSubmitResult

request = client.next_ui_request(timeout=5.0)

if request.method == "askDialog":
    assert request.questions is not None
    for question in request.questions:
        print(question.header or question.id, question.question)
        print([option.label for option in question.options])

    question = request.questions[0]
    client.send_ui_ask_dialog_result(
        request.id,
        ExtensionAskDialogSubmitResult(
            results=(
                ExtensionAskDialogResultItem(
                    id=question.id,
                    question=question.question,
                    options=tuple(option.label for option in question.options),
                    multi=question.multi or False,
                    selected_options=(question.options[0].label,),
                ),
            )
        ),
    )
elif request.method == "confirm":
    client.send_ui_confirmation(request.id, True)
elif request.method in {"input", "editor"}:
    client.send_ui_value(request.id, "approved")
```

Use `client.cancel_ui_request(request.id)` instead when the host cannot answer an
interactive request. An ask dialog can also return
`ExtensionAskDialogChatResult()` when the user chooses to continue in chat.

For non-interactive scripts, you can install a default headless policy instead of
handling every request manually:

```python
with RpcClient(model="anthropic/claude-sonnet-4-5") as client:
    client.install_headless_ui()
    turn = client.prompt_and_wait("needs ui-safe automation")
    print(turn.assistant_text)
```

That helper ignores passive UI notifications (`notify`, `setStatus`, `setWidget`,
`setTitle`, `set_editor_text`), answers `confirm` with `False`, always cancels
`askDialog`, and cancels `select`/`input`/`editor` requests unless you provide
explicit values.

## Prompt Outcomes

`prompt()` keeps its fire-and-forget API. Use `prompt_with_result()` when the
server acknowledgement and the correlated terminal outcome are both useful:

```python
acknowledgement = client.prompt_with_result("Run /custom-command")
print(acknowledgement.request_id, acknowledgement.agent_invoked)
```

`agent_invoked` is `True` when the agent-facing input path accepted the prompt,
`False` when it completed locally, and `None` while the outcome is still
resolving. Every successfully acknowledged `prompt` or `abort_and_prompt` then
emits one same-id `PromptResultEvent`; a late scheduling failure instead raises
one correlated `RpcCommandError`. `lifecycle_disposition` is `"none"` when no
run was scheduled, `"current"` when work joined the active run, and `"future"`
when the input owns a queued or newly starting run. `prompt_and_wait()` uses
that server-owned disposition, so a guest follow-up relayed as host steering
waits on the active run without reserving a nonexistent future run, and an
extension-injected send cannot return before its tracked scheduling task
completes or fails.

`prompt_and_wait()` requires the runtime to advertise the additive
`prompt_result` capability in its ready frame. Against an older runtime that
omits it, the helper raises `RpcCommandError(code="capability_unavailable")`
immediately with an upgrade message instead of hanging. `prompt()`,
`prompt_with_result()`, and unrelated client APIs remain compatible; only the
high-level correlated waiter requires the capability.

`follow_up()` normally reserves a distinct future run before writing the
request. A successful acknowledgement keeps that reservation across the
previous run's `agent_end` / next `agent_start` gap; an immediate rejection
rolls it back. When the response reports `"current"`, the client merges the
request into the active reservation instead. `wait_for_idle()` therefore spans
the correct run without waiting for a future lifecycle that will never start.
`agent_end.isTerminal: false` is exposed as `AgentEndEvent.is_terminal is
False` and does not complete the reservation; the final absent/true value does.

## Long-Running Bash and Python Requests

The execution helpers wait indefinitely for their response by default:

```python
bash_result = client.bash("make release")
python_result = client.python("train_model()")
```

Set `response_timeout` to an optional client-side deadline in seconds:

```python
bash_result = client.bash("make release", response_timeout=120.0)
python_result = client.python("train_model()", response_timeout=120.0)
```

The public signatures are:

```python
client.bash(
    command,
    *,
    exclude_from_context=None,
    use_user_shell=None,
    follow_cwd=None,
    response_timeout=None,
)
client.python(code, *, exclude_from_context=None, response_timeout=None)
```

`response_timeout` is local to the Python client and is never serialized into the RPC command, so it does not stop server-side execution. The client's `request_timeout` still applies to all other request methods.

## Error Handling and Retained History

The client now surfaces more of the transport edge cases that the wire protocol
allows:

- id-less `parse` and unknown-command failures are correlated back to the
  waiting request when they can be matched unambiguously
- correlated late `prompt` / `abort_and_prompt` scheduling failures are treated
  as command failures, not additional protocol errors
- `prompt_and_wait()` or `wait_for_idle()` raises the correlated
  `RpcCommandError` once; a later idle observation neither re-raises nor hangs
- genuinely unmatched background error responses are exposed through
  `client.protocol_errors` and `client.on_protocol_error(...)`
- listener exceptions no longer kill the stdout reader thread; they are exposed
  through `client.listener_errors` and `client.on_listener_error(...)`
- timed-out request ids and already-reported prompt-error ids use separate insertion-ordered tombstone windows capped at 1,024 entries; retained late duplicates stay suppressed without lifetime growth

User callbacks run on one ordered dispatcher generation after reader-side
bookkeeping. Normal `stop()` drains that generation before joining it.
Unexpected EOF or invalid JSON cancels callbacks that have not started, while a
callback already running may finish. Reentrant `stop()` does not self-join, and
the client rejects restart until that dispatcher generation exits. Listener
exceptions retain the same `listener_errors` policy.

For long-lived hosts, retained event and stderr history is bounded by default:

```python
from omp_rpc import RpcClient

with RpcClient(max_event_history=20_000, max_stderr_chunks=256) as client:
    ...
```

If a single prompt streams more events than `max_event_history` allows,
`prompt_and_wait()` raises a clear error so hosts can increase the limit instead
of silently losing earlier events.

Prompt lifecycle collection is intentionally single-flight. Only one of
`prompt_and_wait()`, `wait_for_idle()`, or `collect_events()` may be active at a
time on a client instance. If a host needs concurrent orchestration, use
separate `RpcClient` instances instead of overlapping lifecycle waiters on one
session.

## Text Helpers

`assistant_text()` and `message_text()` now return visible text blocks only.
If a host explicitly needs reasoning text too, use the `*_with_thinking`
helpers:

```python
from omp_rpc import assistant_text, assistant_text_with_thinking

visible = assistant_text(message)
full = assistant_text_with_thinking(message)
```

## Protocol Reference

The canonical wire protocol still lives in the repo at
[`docs/rpc.md`](../../docs/rpc.md).
