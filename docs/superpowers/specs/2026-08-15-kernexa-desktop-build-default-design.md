# Kernexa Desktop Build Default Design

## Context

Kernexa Desktop presents a `Build now` question when a Plan agent finishes a plan. Replying to that question resumes server execution with a synthetic Build user message, but the question reply itself does not update the Desktop composer's selected agent. The composer currently relies on later `message.updated` or `message.part.updated` events to call `local.agent.set("build")`. If those events are missed or the session is restored through REST, the persisted session selection can remain Plan and the next prompt can enter Plan again.

The Desktop also has no persisted global agent preference. `LocalProvider` keeps an in-memory `current` agent and persists model-selection state by session inside one workspace. A new draft mounts a new provider, so it falls back to the server-provided agent order. App restart also loses the in-memory choice.

## Goal

When a user successfully submits `Build now` from Kernexa Desktop:

- switch the current task's composer to Build immediately;
- persist Build as the default agent for new tasks in every project and workspace in this Desktop installation;
- retain that default after page reload and app restart; and
- preserve explicit agent selections already stored for existing tasks.

## Non-Goals

- Do not change TUI or other clients.
- Do not update the server's `default_agent` configuration.
- Do not add or regenerate a protocol or SDK field.
- Do not make ordinary Plan/Build selector changes alter the global default.
- Do not synchronize this Desktop preference across machines or user profiles.
- Do not change model or variant persistence semantics.

## Root Cause

The server and Desktop maintain separate state:

1. `plan_exit` receives the question reply and writes a synthetic user message whose agent is Build.
2. The server continues the provider loop as Build, but the question reply response does not carry a mode transition.
3. The Desktop composer reads its agent from `LocalProvider`, not from the active server runner.
4. `LocalProvider` updates after Build approval only through live events. REST hydration does not replay those listeners, and the session restore path intentionally does not overwrite an existing saved selection.
5. New draft providers have no persisted global agent value to inherit.

The fix therefore belongs at the successful Desktop approval boundary and in the Desktop agent preference layer.

## Alternatives

### Update the server global configuration

The legacy server exposes `default_agent`, but this is rejected. Desktop creates sessions and prompts with an explicit local agent, V2 does not consistently hydrate the legacy global configuration into Desktop state, and changing server configuration would affect clients outside the requested Kernexa Desktop scope.

### Keep only an in-memory default

Calling the existing agent setter fixes the current composer and may influence another draft mounted under the same provider. It is rejected because new draft routes mount independent providers and app restart loses the value.

### Persist a Desktop-global agent preference

This is the selected approach. It reuses the existing persistence abstraction, changes no protocol, and separates the new-task default from existing per-session model selections.

## Architecture

The change stays in `packages/app` and has two focused responsibilities.

### Global default ownership

`LocalProvider` owns a small persisted preference containing only the default agent name. It uses `Persist.serverGlobal(serverSDK().scope, "agent-default")`. For Kernexa's local sidecar scope this resolves to the Desktop-global store, which is backed by the existing Electron persistence adapter. It is intentionally separate from the workspace-scoped `model-selection` payload.

The agent selection precedence is:

1. explicit state for the current session or draft;
2. a valid persisted Desktop-global default;
3. the provider's current in-memory selection; and
4. the existing Build/first-visible-agent fallback.

This means an existing task saved as Plan remains Plan, while a new draft without explicit state starts as Build after approval. If the stored agent is unavailable, the normal fallback applies without introducing a migration or error state.

### Approval ownership

`SessionQuestionDock` already owns the reply mutation and is the earliest boundary that knows whether the reply succeeded. On successful reply it identifies a Build approval only when:

- the question is linked to a tool call;
- the submitted first answer is exactly `Build now`; and
- either the linked message part is the `plan_exit` tool or, while that part is not yet hydrated, the request exactly matches the canonical non-custom Plan-exit question and option shape produced by the server.

The canonical-shape fallback closes the original REST/event ordering gap without adding protocol metadata. It must be narrow enough that an unrelated tool question containing an option named `Build now` cannot change the default.

After all conditions match, the Desktop updates the current session selection to Build and writes Build as the global default. The update happens in `onSuccess`, never in `onMutate`, so a rejected or failed reply leaves both values unchanged.

Existing live `message.updated` and completed `plan_exit` listeners remain as current-session reconciliation for server progress. They do not write the global default: replayed or historical server events must not silently change a Desktop preference when this Desktop did not submit the approval.

## Data Flow

1. The user selects `Build now` and submits the Plan exit question.
2. Desktop sends the existing question reply request.
3. The server accepts the reply.
4. The mutation success path verifies the Plan-exit request by its linked part or canonical request shape and confirms that the submitted answer is `Build now`.
5. The current session's existing persisted selection becomes Build.
6. The Desktop-global agent preference becomes Build.
7. The server independently continues its existing synthetic Build turn.
8. A later new-task provider reads the global preference and initializes its composer as Build.

No server event is required for steps 5 or 6, so a silent or reconnecting event stream cannot leave the submitting Desktop in Plan.

## Error Handling and Boundaries

- A failed question reply keeps the current and global agent values unchanged and uses the existing request-failure toast.
- `Keep planning`, dismissal, custom answers, and unrelated questions do not change the global default.
- A missing linked part may use the canonical Plan-exit request shape. A mismatched linked part or noncanonical request does not trigger the special transition.
- Desktop storage uses the existing persistence failure behavior. No new retry or dependency is introduced.
- Explicit agent changes inside an existing task remain session-scoped and take precedence over the global default.

## Verification

Extend the existing Plan question browser regression with a realistic linked `plan_exit` part and a Plan-first agent list so the test cannot pass because Build happens to be the first agent.

The regression must verify:

- submitting `Build now` switches the current composer to Build without injecting a later Build message or completed-part event;
- a canonical recovered Plan-exit question still switches when its linked part has not hydrated yet, while an unrelated `Build now` option does not;
- a failed reply does not switch the current or global selection;
- reloading the current task retains Build;
- opening a new task in another project or workspace starts in Build;
- reloading the new-task route still starts in Build, proving the global value is persisted; and
- an existing task with an explicit Plan selection still opens as Plan.

Run the focused App tests from `packages/app`, followed by the package typecheck and the relevant existing request-dock regression set.

## Acceptance Criteria

- A successful Kernexa Desktop `Build now` submission immediately displays Build in the current composer.
- The next prompt cannot re-enter Plan merely because a live transition event was missed.
- New tasks across Desktop projects and workspaces default to Build.
- The new-task default survives Desktop restart.
- Existing per-task Plan or Build selections remain authoritative for those tasks.
- Failed or non-Build question responses do not change the default.
- No server, protocol, generated SDK, TUI, dependency, model-selection, or variant behavior changes.
