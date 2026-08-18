# Session Progress Recovery Design

## Context

SFMI can finish a model run in the sidecar while the App remains on `Syncing status` and does not show the final response. The attached Plan-mode Gemma4 log demonstrates this split: both provider turns returned and the prompt loop logged `exiting loop`, but the UI remained busy.

The App currently depends on the global event stream for message parts and the terminal session status. Its connection starts as `connecting` and becomes `connected` only after receiving `server.connected`. An open stream that never yields that event can remain `connecting` indefinitely. The stale-session watchdog does not run unless the stream is already connected, so it cannot repair the state that most needs repair.

Plan mode makes this failure more visible. A completed plan is commonly stored in the `plan_exit` tool input, and the Plan card renders only when `input.plan` is present. `plan_exit` also creates a pending question before switching to Build. Missing the last part update, the question event, or the idle event can therefore leave Plan with no visible result even though the backend is still running or has already completed.

## Goal

Recover visible session progress, pending interaction requests, and terminal status within approximately 10 seconds of an event-stream gap, assuming the sidecar REST APIs remain responsive, without cancelling or restarting the model run.

## Non-Goals

- Do not impose a model execution timeout. Legitimate responses may take longer than one minute.
- Do not change provider or model behavior.
- Do not add Plan-specific polling or fabricate a Plan when the model did not persist one.
- Do not treat EventV2 ownership as distributed session execution ownership.
- Do not add a new dependency or server protocol endpoint.

## Alternatives

### Plan-only rendering fallback

Always showing a Plan placeholder would hide the missing `input.plan` symptom but would not recover the response, pending question, or stale busy status. It is rejected.

### Polling-only recovery

Polling session state can recover content but leaves the event stream permanently unhealthy and makes `Syncing status` misleading. It is incomplete on its own.

### Event-stream repair plus bounded REST reconciliation

This is the selected approach. Repair the stream when its greeting is missing, and use existing REST state as a fallback for quiet busy sessions. Existing ID- and revision-aware session merge logic remains authoritative for applying fetched content.

## Architecture

The change stays inside the App synchronization layer:

1. `server-sdk.tsx` owns event-stream connection health and retries a stream that does not produce its initial server event within 10 seconds.
2. `server-sync.tsx` owns stale busy-session detection and coordinates authoritative status, message, permission, and question reconciliation.
3. `server-session.ts` continues to own safe message and part hydration. Its existing optimistic-message, touched-entity, delta, generation, and revision protections are reused rather than duplicated.
4. Session UI components remain data-driven. Once hydrated data and idle status reach the store, existing text, tool, Plan, question, and Thinking views update without a Plan-specific rendering branch.

## Event-Stream Health

Each stream attempt starts in `connecting`. The attempt must receive its first event within 10 seconds. If it does not, the App aborts only that event-stream request and starts the existing reconnect loop. This abort signal is not shared with prompt submission or provider execution and must never cancel a session run.

Receiving `server.connected` changes the connection to `connected` and immediately schedules one active-session reconciliation. A normal stream close continues to use the existing `disconnected` and reconnect behavior.

## Stale Session Detection

The existing one-second watchdog remains active whenever at least one local session is non-idle. A busy session is stale when no session event has updated `session_activity` for 10 seconds.

The watchdog must not require `connection() === "connected"`. Event silence while connecting or disconnected is the main recovery case. It coalesces all stale sessions into one active/status request per 10-second window, regardless of how many sessions are open.

Known permission- or question-blocked sessions do not need repeated progress polling. However, request lists are refreshed during recovery so a request whose creation event was missed can still become visible.

## Recovery Data Flow

For each recovery pass:

1. Snapshot the status revision for every locally known session.
2. Fetch the authoritative active map. V1 uses the existing session status endpoint; V2 uses the existing active-session endpoint.
3. Identify locally busy sessions whose activity is at least 10 seconds old.
4. Refresh pending permission and question requests for the directories containing those stale sessions, using the same V1/V2 APIs and normalization already used by directory bootstrap.
5. Force `session.sync(sessionID, { force: true })` for each stale session independently.
6. Merge fetched messages and parts by stable message and part IDs through the existing session store.
7. If the server still reports the session active, retain its non-idle status. The hydration only recovers persisted progress.
8. If the server no longer reports the session active, set it to idle only after hydration succeeds and only if its status revision still matches the snapshot.

The forced sync reloads session information and the current message window, including assistant completion metadata, text, reasoning, tool state, tool input and output, and `plan_exit.input.plan`. It does not clear the timeline first.

## Merge and Concurrency Safety

HTTP recovery can overlap live events. Existing session hydration rules preserve the freshest state:

- optimistic user messages remain until confirmed;
- messages and parts touched by events during the request win over the fetched snapshot;
- accumulated text deltas newer than the fetched base remain intact;
- removals are applied only when the fetched page authoritatively covers them;
- a status revision change prevents an old recovery pass from setting a newly active session to idle.

Each session applies its hydration result independently. A slow or failed hydration for one session must not delay successful recovery for another session. Only one recovery pass may own a given polling window, and existing per-session in-flight deduplication remains in effect.

## Long-Running Responses

Ten seconds is a health-check threshold, not an execution deadline.

- When events continue to arrive, they refresh `session_activity`, so fallback polling does not run.
- When the stream is silent but the server reports the session active, the run stays busy and is never interrupted. Hydration makes any persisted intermediate text or tool progress visible.
- If the provider has not emitted a first token or tool input, there is no content to recover; the UI remains busy.
- When the server later reports the session inactive, final hydration runs before idle is applied.

## Plan Behavior

No Plan-specific response is synthesized.

- A normal persisted Plan text part renders as ordinary assistant text.
- A persisted `plan_exit` tool part renders the Plan card once its hydrated input contains a non-empty `plan` string.
- A missed `question.asked` event is recovered from the pending question list, allowing the user to choose Build or keep planning.
- A completed Plan remains busy while the server is active and becomes idle only after the final message/tool state is hydrated.

## Error Handling

- Active/status failure leaves local state unchanged and retries in a later window.
- Message hydration failure does not set the session idle or delete visible data.
- Permission or question refresh failure does not block message/status recovery; the failed request list is retried later.
- A newer event or run invalidates the older recovery result through generation and status-revision checks.
- Repeated event-stream greeting timeouts retry the event stream without affecting the provider request.

## Verification

### Unit and context tests

- An event stream that opens but does not yield its first event is aborted and retried after 10 seconds.
- A stream that yields `server.connected` before the deadline remains connected and does not trigger the timeout.
- A stale busy session is checked even while the global connection is `connecting`.
- An active stale session hydrates persisted progress and stays busy.
- An inactive stale session hydrates first and then becomes idle when its revision is unchanged.
- A hydration failure leaves the session busy.
- One unresolved session hydration does not prevent another session from becoming idle.
- Recovery refreshes a missed pending question and permission request.

### Plan regression

Extend the existing Plan transition browser coverage so the test drops the terminal part/status events, exposes persisted Plan state through REST, reconnects, and verifies that:

- the Plan text or Plan card appears;
- a pending Build question appears when applicable;
- `Syncing status` and the Thinking row disappear after authoritative completion;
- a run that remains active longer than one minute is not interrupted or marked idle.

## Acceptance Criteria

- With responsive REST APIs, a missed Plan response or completion event is reflected in the UI within approximately 10 seconds of event silence.
- A genuinely active response may run for any duration and is never cancelled by recovery.
- Active sessions retain busy state; inactive sessions become idle only after successful hydration.
- Missed Plan questions, text, tool input, and completion state are restored from server data.
- Recovery works for both V1 and V2 protocols and introduces no new runtime dependency or server endpoint.
